/**
 * Run storage directory walks only in filesystem workers, with bounded concurrency.
 * A failed worker is never replaced with a walk on the server thread. Failed
 * candidates enter a short cooldown before another request can retry isolation.
 */

import { Worker } from "node:worker_threads";
import { compiledWorkerSpecifiers, workerEntryFromSpecifier } from "../compiled-worker";
import { hotSafe } from "../hot-safe";
import { logger } from "../logger";
import { isCompiledRuntime } from "../runtime-target";
import {
	DIR_SCAN_MAX_DEPTH,
	DIR_SCAN_MAX_ENTRIES,
	DirectoryMeasureAbortedError,
	type DirectoryTreeMeasurement,
	type MeasureDirectoryTreesOptions,
} from "./protocol";

export { DirectoryMeasureAbortedError };

const CONCURRENCY = 4;
const READY_TIMEOUT_MS = 5_000;
/** A multi-million-entry tree can take minutes. This only bounds a wedged worker. */
const MEASURE_TIMEOUT_MS = 15 * 60 * 1000;
const RETRY_COOLDOWN_MS = 5_000;

export class FsScanWorkerUnavailableError extends Error {
	constructor(cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`Filesystem scan worker unavailable: ${reason}`, { cause });
		this.name = "FsScanWorkerUnavailableError";
	}
}

interface FsScanGate {
	active: number;
	waiters: Array<() => void>;
	unavailableError?: FsScanWorkerUnavailableError;
	retryAfter?: number;
	resolvedSpecifier?: string;
}

function gate(): FsScanGate {
	return hotSafe<FsScanGate>("narrafork.fsScan.gate", () => ({
		active: 0,
		waiters: [],
	}));
}

export function fsScanWorkerSpecifierCandidates(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return compiledWorkerSpecifiers(
		"lib/fs-scan-worker/fs-scan-worker-entry.ts",
		"./fs-scan-worker-entry.ts",
		moduleUrl,
		compiled,
	);
}

async function withSlot<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) throw new DirectoryMeasureAbortedError();
	const current = gate();
	if (current.active >= CONCURRENCY) {
		await new Promise<void>((resolve, reject) => {
			const resume = () => {
				signal?.removeEventListener("abort", onAbort);
				// Reserve the slot before resolving, so a new caller cannot take it.
				current.active++;
				resolve();
			};
			const onAbort = () => {
				const index = current.waiters.indexOf(resume);
				if (index !== -1) current.waiters.splice(index, 1);
				reject(new DirectoryMeasureAbortedError());
			};
			current.waiters.push(resume);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	} else {
		current.active++;
	}
	try {
		if (signal?.aborted) throw new DirectoryMeasureAbortedError();
		return await run();
	} finally {
		current.active--;
		current.waiters.shift()?.();
	}
}

interface WorkerResultMessage {
	type: "result";
	requestId: string;
	roots: unknown;
}

interface WorkerProgressMessage {
	type: "progress";
	requestId: string;
	entriesScanned: number;
	sizeBytes: number;
}

interface WorkerErrorMessage {
	type: "error";
	requestId: string;
	message: string;
	aborted?: boolean;
}

function validMeasurements(value: unknown, count: number): value is DirectoryTreeMeasurement[] {
	return (
		Array.isArray(value) &&
		value.length === count &&
		value.every(
			(entry) =>
				entry &&
				typeof entry === "object" &&
				Number.isFinite(entry.sizeBytes) &&
				entry.sizeBytes >= 0 &&
				Number.isSafeInteger(entry.entriesScanned) &&
				entry.entriesScanned >= 0 &&
				typeof entry.truncated === "boolean",
		)
	);
}

function measureInWorker(
	specifier: string,
	roots: string[],
	options: MeasureDirectoryTreesOptions,
): Promise<DirectoryTreeMeasurement[]> {
	const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const maxEntries = options.maxEntries ?? DIR_SCAN_MAX_ENTRIES;
	const maxDepth = options.maxDepth ?? DIR_SCAN_MAX_DEPTH;
	return new Promise((resolve, reject) => {
		const worker = new Worker(workerEntryFromSpecifier(specifier));
		let settled = false;
		let ready = false;
		let measureTimer: ReturnType<typeof setTimeout> | undefined;
		const readyTimer = setTimeout(
			() => finish(new Error("filesystem scan worker did not become ready")),
			READY_TIMEOUT_MS,
		);

		const finish = (error?: unknown, result?: DirectoryTreeMeasurement[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(readyTimer);
			clearTimeout(measureTimer);
			options.signal?.removeEventListener("abort", onAbort);
			void worker.terminate().catch(() => {});
			if (error) reject(error);
			else if (result) resolve(result);
			else reject(new Error("filesystem scan worker returned no measurements"));
		};

		const onAbort = () => {
			try {
				worker.postMessage({ type: "cancel", requestId });
			} catch {
				// The worker is already gone.
			}
			finish(new DirectoryMeasureAbortedError());
		};

		if (options.signal) {
			if (options.signal.aborted) {
				finish(new DirectoryMeasureAbortedError());
				return;
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		worker.once("error", (error) => finish(error));
		worker.once("exit", (code) => {
			finish(new Error(`filesystem scan worker exited before completing (code ${code})`));
		});
		worker.on("message", (message: { type?: string }) => {
			if (settled) return;
			if (!ready) {
				if (message?.type !== "ready") {
					finish(new Error("filesystem scan worker sent no ready handshake"));
					return;
				}
				ready = true;
				clearTimeout(readyTimer);
				measureTimer = setTimeout(
					() => finish(new Error("filesystem scan worker timed out")),
					MEASURE_TIMEOUT_MS,
				);
				try {
					worker.postMessage({
						type: "measure",
						requestId,
						roots,
						maxEntries,
						maxDepth,
					});
				} catch (error) {
					finish(error);
				}
				return;
			}
			if (message?.type === "progress") {
				const progress = message as WorkerProgressMessage;
				if (progress.requestId === requestId) {
					options.onProgress?.({
						entriesScanned: progress.entriesScanned,
						sizeBytes: progress.sizeBytes,
					});
				}
				return;
			}
			if (message?.type === "result") {
				const result = message as WorkerResultMessage;
				if (result.requestId !== requestId) return;
				if (!validMeasurements(result.roots, roots.length)) {
					finish(new Error("filesystem scan worker returned invalid measurements"));
				} else {
					finish(undefined, result.roots);
				}
				return;
			}
			if (message?.type === "error") {
				const failure = message as WorkerErrorMessage;
				if (failure.requestId !== requestId) return;
				finish(
					failure.aborted
						? new DirectoryMeasureAbortedError()
						: new Error(failure.message || "filesystem scan worker failed"),
				);
			}
		});
	});
}

async function measureWithWorkers(
	roots: string[],
	options: MeasureDirectoryTreesOptions,
): Promise<DirectoryTreeMeasurement[]> {
	const current = gate();
	if (current.unavailableError && Date.now() < (current.retryAfter ?? 0)) {
		throw current.unavailableError;
	}

	const candidates = current.resolvedSpecifier
		? [current.resolvedSpecifier]
		: fsScanWorkerSpecifierCandidates();
	const failures: unknown[] = [];
	for (const specifier of candidates) {
		if (options.signal?.aborted) throw new DirectoryMeasureAbortedError();
		try {
			const result = await measureInWorker(specifier, roots, options);
			current.resolvedSpecifier = specifier;
			current.unavailableError = undefined;
			current.retryAfter = undefined;
			return result;
		} catch (error) {
			if (options.signal?.aborted) throw new DirectoryMeasureAbortedError();
			if (error instanceof DirectoryMeasureAbortedError) throw error;
			failures.push(error);
		}
	}
	current.resolvedSpecifier = undefined;
	const lastError = failures.at(-1);
	const error = new FsScanWorkerUnavailableError(
		failures.length > 1
			? new AggregateError(
					failures,
					lastError instanceof Error ? lastError.message : String(lastError),
				)
			: (lastError ?? new Error("no filesystem scan worker candidates")),
	);
	current.unavailableError = error;
	current.retryAfter = Date.now() + RETRY_COOLDOWN_MS;
	logger.warn("Filesystem scan worker unavailable; directory measurement failed", {
		reason: error.message,
	});
	throw error;
}

export async function measureDirectoriesOffThread(
	roots: string[],
	options: MeasureDirectoryTreesOptions = {},
): Promise<DirectoryTreeMeasurement[]> {
	if (options.signal?.aborted) throw new DirectoryMeasureAbortedError();
	if (roots.length === 0) return [];
	return withSlot(() => measureWithWorkers(roots, options), options.signal);
}
