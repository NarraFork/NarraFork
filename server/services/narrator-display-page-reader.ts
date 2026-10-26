import type { Database } from "bun:sqlite";
import {
	DISPLAY_FIXTURE_LIMITS,
	DISPLAY_PAGE_LIMITS,
	type DisplayPageMessagesParams,
	type DisplayPageMessagesResult,
	type NarratorDisplayMessage,
	validateDisplayPageRequest,
} from "../lib/db-worker/display-page-protocol";
import { runReadTask, WorkersUnavailableError } from "../lib/db-worker/pool";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { blockReadsEnabled } from "./narrator-block-scans";

export type { NarratorDisplayMessage } from "../lib/db-worker/display-page-protocol";

/**
 * PostgreSQL composition seam, deliberately independent of SQLite and DB bootstrap.
 * Implementations must read RAW JSON and project it OFF MAIN (worker/subprocess),
 * bound raw/row/output bytes BEFORE returning and honor the absolute deadline/signal.
 * A normal PG ORM JSON decoder on the HTTP thread is NOT an implementation of this port.
 */
export interface NarratorDisplayPagePort {
	readonly execution: "off-main";
	readMessages(
		request: DisplayPageMessagesParams,
		options: { signal: AbortSignal },
	): Promise<DisplayPageMessagesResult>;
}

/** Production PG port pinned to the startup configuration URL (never environment reparsing). */
export function createPostgresNarratorDisplayPagePort(url: string): NarratorDisplayPagePort {
	return {
		execution: "off-main",
		async readMessages(request, { signal }) {
			try {
				if (typeof url !== "string" || url.length > 8192) throw new Error();
				const parsed = new URL(url);
				if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error();
			} catch {
				throw unavailable("invalid PostgreSQL connection configuration");
			}
			return runReadTask<DisplayPageMessagesResult>(
				url,
				{ ...request, kind: "displayPageMessagesPostgres" },
				{
					signal,
					timeoutMs: Math.max(1, request.deadlineAt - Date.now()),
				},
			);
		},
	};
}

export type NarratorDisplayPageSource =
	| { backend: "sqlite"; dbPath: string }
	| { backend: "postgres"; port?: NarratorDisplayPagePort }
	| { backend: "memory-fixture"; sqlite: Database };

export interface NarratorDisplayReadOptions {
	ioBudget: number;
	/** May lower, never increase, the raw-byte admission ceiling. */
	maxRawBytes?: number;
	signal?: AbortSignal;
	/** May lower, never increase, the hard total deadline. */
	timeoutMs?: number;
}

interface SlotWaiter {
	start: () => void;
}
const slots = () =>
	hotSafe("narrafork.displayPageReader.slots", () => ({
		active: 0,
		queue: [] as SlotWaiter[],
	}));

function unavailable(reason: string): AppError {
	return new AppError(
		`History display reader unavailable (${reason}); no main-thread raw JSON fallback is permitted.`,
		503,
		"DISPLAY_PAGE_READER_UNAVAILABLE",
	);
}

async function withDisplaySlot<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
	const state = slots();
	if (signal.aborted) throw signal.reason;
	if (state.active >= DISPLAY_PAGE_LIMITS.concurrency) {
		if (state.queue.length >= DISPLAY_PAGE_LIMITS.maxPending)
			throw new AppError(
				"History display reader queue is full; retry later.",
				503,
				"DISPLAY_PAGE_READER_BUSY",
			);
		await new Promise<void>((resolve, reject) => {
			const remove = () => {
				const index = state.queue.indexOf(waiter);
				if (index !== -1) state.queue.splice(index, 1);
			};
			const abort = () => {
				remove();
				reject(signal.reason);
			};
			const waiter: SlotWaiter = {
				start: () => {
					signal.removeEventListener("abort", abort);
					resolve();
				},
			};
			signal.addEventListener("abort", abort, { once: true });
			state.queue.push(waiter);
		});
	} else {
		state.active++;
	}
	// A dequeued waiter already owns its predecessor's slot. Check after await:
	// cancellation between dequeue and resumption must release that reservation.
	try {
		if (signal.aborted) throw signal.reason;
		return await execute();
	} finally {
		const next = state.queue.shift();
		if (next) next.start();
		else state.active--;
	}
}

function validatePortResult(
	result: DisplayPageMessagesResult,
	request: DisplayPageMessagesParams,
): void {
	if (
		!result ||
		!Array.isArray(result.messages) ||
		result.messages.length !== request.messageIds.length ||
		!Number.isSafeInteger(result.rawBytes) ||
		result.rawBytes < 0 ||
		result.rawBytes > (request.maxRawBytes ?? DISPLAY_PAGE_LIMITS.maxRawBytes) ||
		!Number.isSafeInteger(result.outputBytes) ||
		result.outputBytes < 2 ||
		result.outputBytes > DISPLAY_PAGE_LIMITS.maxOutputBytes
	)
		throw unavailable("invalid or over-budget port response");
	let rows = result.messages.length;
	for (const [index, message] of result.messages.entries()) {
		if (message.id !== request.messageIds[index] || !Array.isArray(message.toolCalls))
			throw unavailable("port returned an unexpected message");
		rows += message.toolCalls.length;
		if (rows > DISPLAY_PAGE_LIMITS.maxRows) throw unavailable("port returned too many tools");
		for (const tool of message.toolCalls) {
			if (tool.messageId !== message.id)
				throw unavailable("port returned an unexpected tool binding");
		}
	}
	// Do NOT stringify/parse the result here to recheck bytes. That would put the
	// expensive decoding/projection back on the main thread. The internal port
	// supplies the worker's bounded result plus its byte accounting.
}

function mapReadError(error: unknown): Error {
	if (error instanceof AppError) return error;
	if (error instanceof WorkersUnavailableError) return unavailable(error.reason);
	const code = error && typeof error === "object" && "code" in error ? error.code : null;
	const message = error instanceof Error ? error.message : "History display read failed";
	switch (code) {
		case "DB_READ_TASK_TIMEOUT":
			return new AppError(
				"History display read exceeded its total deadline",
				504,
				"DISPLAY_PAGE_DEADLINE",
			);
		case "DISPLAY_PAGE_BUDGET_EXCEEDED":
			return new AppError(message, 413, code);
		case "DISPLAY_PAGE_REFERENCES_CHANGED":
			return new AppError(message, 409, code);
		case "DISPLAY_PAGE_INVALID_INPUT":
			return new AppError(message, 400, code);
		case "DISPLAY_PAGE_INVALID_JSON":
			return new AppError(message, 500, code);
		case "DISPLAY_PAGE_DEADLINE":
			return new AppError(message, 504, code);
		case "DISPLAY_PAGE_CANCELLED":
			return new AppError(message, 499, code);
		case "DISPLAY_PAGE_READER_UNAVAILABLE":
			return new AppError(message, 503, code);
		default:
			// The client sees a generic 503; keep the real cause in the server log.
			logger.warn("History display read failed", {
				error: message,
				...(code !== null && code !== undefined && { code: String(code) }),
			});
			return unavailable("read failed");
	}
}

/**
 * Load ONLY caller-authorized canonical message IDs for display. Authorization,
 * parent/owner binding and final narrator messageVersion checks remain the caller's job.
 * seq is not stored on a message: the caller MUST attach its own authorized ref seq map.
 */
export async function readNarratorDisplayMessages(
	source: NarratorDisplayPageSource,
	authorizedMessageIds: readonly string[],
	options: NarratorDisplayReadOptions,
): Promise<NarratorDisplayMessage[]> {
	const startedAt = Date.now();
	const fixture = source.backend === "memory-fixture";
	const limits = fixture ? DISPLAY_FIXTURE_LIMITS : DISPLAY_PAGE_LIMITS;
	if (!Array.isArray(authorizedMessageIds) || authorizedMessageIds.length > limits.maxInputIds)
		throw new AppError("Too many history display message IDs", 400, "DISPLAY_PAGE_INVALID_INPUT");
	const timeoutMs = options.timeoutMs ?? DISPLAY_PAGE_LIMITS.timeoutMs;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new AppError("Invalid history display deadline", 400, "DISPLAY_PAGE_INVALID_INPUT");
	const request: DisplayPageMessagesParams = {
		kind: "displayPageMessages",
		messageIds: [...authorizedMessageIds],
		ioBudget: options.ioBudget,
		...(options.maxRawBytes !== undefined && { maxRawBytes: options.maxRawBytes }),
		deadlineAt: startedAt + Math.min(timeoutMs, DISPLAY_PAGE_LIMITS.timeoutMs),
		// PostgreSQL is still written in the legacy shape only.
		...(source.backend !== "postgres" && blockReadsEnabled() && { bodiesFromBlocks: true }),
	};
	try {
		validateDisplayPageRequest(request, limits);
	} catch (error) {
		throw mapReadError(error);
	}
	if (options.signal?.aborted)
		throw new AppError("History display read was cancelled", 499, "DISPLAY_PAGE_CANCELLED");
	if (request.messageIds.length === 0) return [];
	const controller = new AbortController();
	const onAbort = () =>
		controller.abort(
			new AppError("History display read was cancelled", 499, "DISPLAY_PAGE_CANCELLED"),
		);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const abortDeadline = () =>
		controller.abort(
			new AppError(
				"History display read exceeded its total deadline",
				504,
				"DISPLAY_PAGE_DEADLINE",
			),
		);
	const assertSuccessfulSettlement = () => {
		// AbortController keeps the FIRST reason: an earlier explicit cancel stays 499.
		controller.signal.throwIfAborted();
		if (Date.now() >= request.deadlineAt) {
			abortDeadline();
			controller.signal.throwIfAborted();
		}
	};
	const timer = setTimeout(abortDeadline, request.deadlineAt - Date.now());
	const cancelled = new Promise<never>((_resolve, reject) => {
		controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
			once: true,
		});
	});
	let rawBytes = 0;
	let outputBytes = 0;
	try {
		const execution = withDisplaySlot(controller.signal, async () => {
			let result: DisplayPageMessagesResult;
			if (source.backend === "sqlite") {
				if (!source.dbPath || source.dbPath === ":memory:")
					throw unavailable("SQLite file is not readable by a worker");
				result = await runReadTask<DisplayPageMessagesResult>(source.dbPath, request, {
					signal: controller.signal,
					timeoutMs: Math.max(1, request.deadlineAt - Date.now()),
				});
			} else if (source.backend === "postgres") {
				if (!source.port || source.port.execution !== "off-main")
					throw unavailable("PostgreSQL display port is not configured");
				result = await source.port.readMessages(request, { signal: controller.signal });
			} else {
				if (process.env.NODE_ENV !== "test" || source.sqlite.filename !== ":memory:")
					throw unavailable("memory fixture exception is test-only");
				const { runDisplayPageQuery } = await import("../lib/db-worker/display-page-query");
				result = runDisplayPageQuery(source.sqlite, request, DISPLAY_FIXTURE_LIMITS);
			}
			assertSuccessfulSettlement();
			validatePortResult(result, request);
			rawBytes = result.rawBytes;
			outputBytes = result.outputBytes;
			return result.messages;
		});
		const messages = await Promise.race([execution, cancelled]);
		// Timer callbacks can be delayed; successful delivery still obeys the absolute cutoff.
		assertSuccessfulSettlement();
		return messages;
	} catch (error) {
		throw mapReadError(controller.signal.aborted ? controller.signal.reason : error);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		const durationMs = Date.now() - startedAt;
		if (durationMs > 250)
			logger.warn("Slow history display page read", {
				durationMs,
				backend: source.backend,
				messageCount: request.messageIds.length,
				rawBytes,
				outputBytes,
			});
	}
}

/** Explicit bounded fixture escape hatch. Never used for production worker failures. */
export function readDisplayFixtureMessages(
	sqlite: Database,
	authorizedMessageIds: readonly string[],
	options: NarratorDisplayReadOptions,
): Promise<NarratorDisplayMessage[]> {
	return readNarratorDisplayMessages(
		{ backend: "memory-fixture", sqlite },
		authorizedMessageIds,
		options,
	);
}
