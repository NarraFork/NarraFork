import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	TEXT_DOCUMENT_PACKET_BYTES,
	TEXT_DOCUMENT_PAGE_CHARS,
	type TextDocumentRange,
	type TextDocumentRef,
	type TextDocumentSource,
	type TextDocumentStreamUpdate,
} from "@shared/pretext-layout/text-document";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { getNarraforkHome } from "../lib/narrafork-home";

export const TOOL_INPUT_SOURCE_MEMORY_BYTES = 256 * 1024;
export const TOOL_INPUT_GLOBAL_MEMORY_BYTES = 16 * 1024 * 1024;
export const TOOL_INPUT_WRITE_QUEUE_BYTES = 256 * 1024;
export const TOOL_INPUT_READ_TIMEOUT_MS = 10_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const FILE_PATTERN = /^nf-tool-input-[a-f0-9-]+\.utf16$/;

type PersistedRangeReader = (
	source: TextDocumentSource,
	offset: number,
	limit: number,
	signal?: AbortSignal,
) => Promise<{ text: string; length: number }>;

export interface HistoricalWriteDocumentReference {
	toolCallId: string;
	messageId: string;
	executionAttempt: number;
}
export interface HistoricalWriteDocumentIdentity extends HistoricalWriteDocumentReference {
	/** Actual row author (COW refs may authorize a different reading narrator). */
	narratorId: string;
	toolUseId: string;
	toolName: string;
}
type HistoricalChunkSink = (text: string, offset: number) => Promise<void>;

export function parseHistoricalWriteDocumentReference(query: {
	toolCallId?: string;
	messageId?: string;
	executionAttempt?: string;
}): HistoricalWriteDocumentReference {
	const executionAttempt = Number(query.executionAttempt);
	for (const id of [query.toolCallId, query.messageId]) {
		if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
			throw sourceError("TEXT_DOCUMENT_EXACT_IDENTITY_REQUIRED", 400);
	}
	if (!Number.isSafeInteger(executionAttempt) || executionAttempt < 0)
		throw sourceError("TEXT_DOCUMENT_EXACT_IDENTITY_REQUIRED", 400);
	return {
		toolCallId: query.toolCallId as string,
		messageId: query.messageId as string,
		executionAttempt,
	};
}

interface SourceState {
	ref: TextDocumentRef;
	/** Session and request/occurrence identity are never inferred from provider toolUseId. */
	occurrence: string;
	chunks: Array<{ offset: number; text: string }>;
	memoryBytes: number;
	file?: FileHandle;
	path?: string;
	tail: Promise<void>;
	closed: boolean;
	persisted: boolean;
	lastReadAt: number;
	recoverable: boolean;
	readers: number;
}

export interface ToolInputStreamSourceOptions {
	directory?: string;
	memoryBytes?: number;
	globalMemoryBytes?: number;
	queueBytes?: number;
	readTimeoutMs?: number;
	/** Only trusted bounded readers may take over a source; the production singleton retains raw storage. */
	readPersisted?: PersistedRangeReader;
	loadHistoricalIdentity?: (
		narratorId: string,
		toolUseId: string,
		reference: HistoricalWriteDocumentReference,
	) => Promise<HistoricalWriteDocumentIdentity>;
	streamHistorical?: (
		identity: HistoricalWriteDocumentIdentity,
		sink: HistoricalChunkSink,
		signal: AbortSignal,
	) => Promise<void>;
	/** Injectable asynchronous writer allows queue/backpressure tests without real user data. */
	write?: (file: FileHandle, bytes: Buffer, position: number) => Promise<void>;
	slowLog?: (metadata: { refId: string; elapsedMs: number; length: number }) => void;
}

function sourceError(code: string, status = 409): AppError {
	return new AppError("Text document source unavailable", status, code);
}

/** Shared JWT/share parser. Worst-case JSON escaping of 8Ki UTF16 still fits a 64KiB packet. */
export function parseTextDocumentRangeQuery(query: { offset?: string; limit?: string }): {
	offset: number;
	limit: number;
} {
	const offset = query.offset === undefined ? 0 : Number(query.offset);
	const limit = query.limit === undefined ? TEXT_DOCUMENT_PAGE_CHARS : Number(query.limit);
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1)
		throw sourceError("TEXT_DOCUMENT_INVALID_RANGE", 400);
	return { offset, limit: Math.min(limit, TEXT_DOCUMENT_PAGE_CHARS) };
}

async function writeAll(file: FileHandle, bytes: Buffer, position: number): Promise<void> {
	let written = 0;
	while (written < bytes.length) {
		const result = await file.write(bytes, written, bytes.length - written, position + written);
		if (!result.bytesWritten) throw sourceError("TEXT_DOCUMENT_WRITE_FAILED", 503);
		written += result.bytesWritten;
	}
}

// The SQLite row limit is below this worker input ceiling. It is a resource refusal, never truncation.
// The HTTP/WS main thread never reads input_json/output_json or parses historical field bodies.
export const HISTORICAL_WRITE_INPUT_MAX_BYTES = 1024 * 1024 * 1024;
const HISTORICAL_WRITE_WORKER_PROGRAM = `
const { parentPort, workerData } = require("node:worker_threads");
const { Database } = require("bun:sqlite");
const fail = (code) => { const error = new Error(code); error.documentCode = code; throw error; };
(async () => {
 let database;
 try {
  const identity = workerData.identity;
  database = new Database(workerData.databasePath, { readonly: true });
  database.run("PRAGMA busy_timeout = 0");
  const bindings = [identity.toolCallId, identity.messageId, identity.toolUseId, identity.narratorId, identity.executionAttempt];
  const where = "id = ? AND message_id = ? AND tool_use_id = ? AND narrator_id = ? AND execution_attempt = ? AND tool_name = 'Write'";
  const metadata = database.query("SELECT octet_length(input_json) AS bytes FROM narrator_tool_calls WHERE " + where + " LIMIT 1").get(...bindings);
  if (!metadata) fail("TEXT_DOCUMENT_NOT_FOUND");
  if (metadata.bytes > workerData.maxInputBytes) fail("TEXT_DOCUMENT_WORKER_INPUT_LIMIT");
  let row = database.query("SELECT input_json FROM narrator_tool_calls WHERE " + where + " LIMIT 1").get(...bindings);
  if (!row) fail("TEXT_DOCUMENT_NOT_FOUND");
  database.close(); database = undefined;
  let input = JSON.parse(row.input_json); row = undefined;
  const text = input && input.content; input = undefined;
  if (typeof text !== "string") fail("TEXT_DOCUMENT_NOT_WRITE_CONTENT");
  for (let offset = 0; offset < text.length; offset += workerData.pageChars) {
   const delta = text.slice(offset, offset + workerData.pageChars);
   const ack = new Promise((resolve, reject) => parentPort.once("message", (message) => {
    if (message && message.type === "ack" && message.offset === offset) resolve();
    else reject(new Error("invalid acknowledgement"));
   }));
   parentPort.postMessage({ type: "chunk", offset, text: delta });
   await ack;
  }
  parentPort.postMessage({ type: "done", length: text.length });
 } catch (error) {
  const code = error && typeof error.documentCode === "string" ? error.documentCode : "TEXT_DOCUMENT_WORKER_FAILED";
  parentPort.postMessage({ type: "error", code });
 } finally { if (database) database.close(); parentPort.close(); }
})();
`;

/** Eval uses a constant program, not caller code; it works in compiled Bun without extra bundle entries. */
export async function streamHistoricalWriteContent(
	databasePath: string,
	identity: HistoricalWriteDocumentIdentity,
	sink: HistoricalChunkSink,
	signal: AbortSignal,
	timeoutMs = TOOL_INPUT_READ_TIMEOUT_MS,
): Promise<void> {
	signal.throwIfAborted();
	const thread = new Worker(HISTORICAL_WRITE_WORKER_PROGRAM, {
		eval: true,
		workerData: {
			databasePath,
			identity,
			maxInputBytes: HISTORICAL_WRITE_INPUT_MAX_BYTES,
			pageChars: TEXT_DOCUMENT_PAGE_CHARS,
		},
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	let offset = 0;
	let settled = false;
	try {
		await new Promise<void>((resolve, reject) => {
			const refuse = (error: unknown) => {
				if (!settled) {
					settled = true;
					reject(error);
				}
			};
			abort = () => refuse(signal.reason ?? sourceError("TEXT_DOCUMENT_CANCELLED", 408));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) return abort();
			timer = setTimeout(() => refuse(sourceError("TEXT_DOCUMENT_READ_TIMEOUT", 408)), timeoutMs);
			thread.once("error", () => refuse(sourceError("TEXT_DOCUMENT_WORKER_FAILED", 503)));
			thread.once("exit", () => {
				if (!settled) refuse(sourceError("TEXT_DOCUMENT_WORKER_FAILED", 503));
			});
			thread.on("message", (message: unknown) => {
				if (settled) return;
				if (!message || typeof message !== "object" || !("type" in message)) {
					refuse(sourceError("TEXT_DOCUMENT_WORKER_PROTOCOL", 503));
					return;
				}
				const packet = message as {
					type: string;
					offset?: number;
					text?: string;
					length?: number;
					code?: string;
				};
				if (packet.type === "chunk") {
					if (
						typeof packet.text !== "string" ||
						packet.text.length > TEXT_DOCUMENT_PAGE_CHARS ||
						packet.offset !== offset ||
						Buffer.byteLength(JSON.stringify(packet)) > TEXT_DOCUMENT_PACKET_BYTES
					) {
						refuse(sourceError("TEXT_DOCUMENT_WORKER_PROTOCOL", 503));
						return;
					}
					const start = offset;
					const text = packet.text;
					// One page in flight. Producer cannot enqueue the next page until storage accepts this page.
					void sink(text, start).then(() => {
						if (settled) return;
						offset += text.length;
						thread.postMessage({ type: "ack", offset: start });
					}, refuse);
				} else if (packet.type === "done" && packet.length === offset) {
					settled = true;
					resolve();
				} else if (packet.type === "error") {
					const code = packet.code?.startsWith("TEXT_DOCUMENT_")
						? packet.code
						: "TEXT_DOCUMENT_WORKER_FAILED";
					refuse(sourceError(code, code === "TEXT_DOCUMENT_NOT_FOUND" ? 404 : 503));
				} else refuse(sourceError("TEXT_DOCUMENT_WORKER_PROTOCOL", 503));
			});
		});
	} finally {
		if (timer) clearTimeout(timer);
		if (abort) signal.removeEventListener("abort", abort);
		await thread.terminate().catch(() => {});
	}
}

/** No database access or filesystem work at construction; tests can inject an isolated directory. */
export class ToolInputStreamSourceService {
	private readonly sources = new Map<string, SourceState>();
	private memoryUsed = 0;
	private queuedBytes = 0;
	private readonly directory: string;
	private directoryReady?: Promise<void>;
	private writeTail: Promise<void> = Promise.resolve();
	private lastCleanupAt = 0;
	private readonly historicalAliases = new Map<string, string>();
	private readonly historicalJobs = new Map<string, Promise<TextDocumentRef>>();
	private historicalTail: Promise<void> = Promise.resolve();
	private historicalQueued = 0;
	private readonly historicalGenerations = new Map<string, { value: number }>();
	private readonly historicalControls = new Map<
		string,
		{
			generationKey: string;
			generation: { value: number };
			controller: AbortController;
		}
	>();
	private readonly currentInputLanes = new Map<string, string>();

	private historicalGeneration(reference: HistoricalWriteDocumentReference) {
		const key = JSON.stringify([
			reference.toolCallId,
			reference.messageId,
			reference.executionAttempt,
		]);
		let generation = this.historicalGenerations.get(key);
		if (!generation) {
			generation = { value: 0 };
			this.historicalGenerations.set(key, generation);
		}
		// Generation tokens held by in-flight builds survive map eviction through their controller record.
		if (this.historicalGenerations.size > 4096) {
			const active = new Set(
				[...this.historicalControls.values()].map((entry) => entry.generationKey),
			);
			for (const oldKey of this.historicalGenerations.keys()) {
				if (oldKey !== key && !active.has(oldKey)) {
					this.historicalGenerations.delete(oldKey);
					break;
				}
			}
		}
		return { key, generation };
	}

	/** Only the current live occurrence may drain WS deltas; historical refs remain range-readable. */
	isCurrentInputLane(narratorId: string, refId: string, epoch: string): boolean {
		const state = this.sources.get(refId);
		if (
			!state ||
			state.closed ||
			state.ref.epoch !== epoch ||
			state.ref.source?.narratorId !== narratorId
		)
			return false;
		return (
			this.currentInputLanes.get(
				JSON.stringify([narratorId, state.ref.source.toolUseId, state.ref.source.field]),
			) === refId
		);
	}
	private readonly sourceBudget: number;
	private readonly globalBudget: number;
	private readonly queueBudget: number;

	constructor(private readonly options: ToolInputStreamSourceOptions = {}) {
		this.directory = options.directory ?? join(getNarraforkHome(), "tool-input-streams");
		this.sourceBudget = options.memoryBytes ?? TOOL_INPUT_SOURCE_MEMORY_BYTES;
		this.globalBudget = options.globalMemoryBytes ?? TOOL_INPUT_GLOBAL_MEMORY_BYTES;
		this.queueBudget = Math.max(2, options.queueBytes ?? TOOL_INPUT_WRITE_QUEUE_BYTES);
	}

	private async historicalIdentity(
		narratorId: string,
		toolUseId: string,
		reference: HistoricalWriteDocumentReference,
	): Promise<HistoricalWriteDocumentIdentity> {
		let row: HistoricalWriteDocumentIdentity;
		if (this.options.loadHistoricalIdentity)
			row = await this.options.loadHistoricalIdentity(narratorId, toolUseId, reference);
		else {
			// Reuses the exact direct-ref/COW/verified child lineage selector, never fuzzy provider-id lookup.
			const { narratorService } = await import("./narrator-service");
			const metadata = await narratorService.getToolCallPreviewMetadata(
				narratorId,
				toolUseId,
				reference,
			);
			row = {
				toolCallId: metadata.id,
				messageId: metadata.messageId,
				narratorId: metadata.narratorId,
				toolUseId: metadata.toolUseId,
				toolName: metadata.toolName,
				executionAttempt: metadata.executionAttempt,
			};
		}
		if (
			row.toolCallId !== reference.toolCallId ||
			row.messageId !== reference.messageId ||
			row.executionAttempt !== reference.executionAttempt ||
			row.toolUseId !== toolUseId ||
			row.toolName !== "Write"
		)
			throw sourceError("TEXT_DOCUMENT_IDENTITY_CHANGED", 404);
		return row;
	}

	/** Historical recovery: one bounded-metadata authorization and one off-main-thread JSON parse. */
	async ensureWriteDocumentSource(
		narratorId: string,
		toolUseId: string,
		reference: HistoricalWriteDocumentReference,
		signal?: AbortSignal,
	): Promise<TextDocumentRef> {
		if (
			!reference.toolCallId ||
			!reference.messageId ||
			!Number.isSafeInteger(reference.executionAttempt) ||
			reference.executionAttempt < 0 ||
			[reference.toolCallId, reference.messageId, toolUseId, narratorId].some(
				(id) => id.length > 128,
			)
		)
			throw sourceError("TEXT_DOCUMENT_EXACT_IDENTITY_REQUIRED", 400);
		signal?.throwIfAborted();
		const identity = await this.historicalIdentity(narratorId, toolUseId, reference);
		signal?.throwIfAborted();
		const key = JSON.stringify([
			narratorId,
			toolUseId,
			reference.toolCallId,
			reference.messageId,
			reference.executionAttempt,
		]);
		const existing = this.historicalAliases.get(key);
		if (existing && this.sources.has(existing)) return this.descriptor(existing);
		if (existing) this.historicalAliases.delete(key);
		const joined = this.historicalJobs.get(key);
		if (joined) return this.waitForHistoricalJob(joined, signal);
		if (this.historicalQueued >= 16) throw sourceError("TEXT_DOCUMENT_HISTORY_QUEUE_LIMIT", 429);
		this.historicalQueued++;
		const previous = this.historicalTail;
		let release!: () => void;
		this.historicalTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		const controller = new AbortController();
		const { key: generationKey, generation } = this.historicalGeneration(reference);
		const startedGeneration = generation.value;
		this.historicalControls.set(key, { generationKey, generation, controller });
		const abort = () =>
			controller.abort(signal?.reason ?? sourceError("TEXT_DOCUMENT_CANCELLED", 408));
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(
			() => controller.abort(sourceError("TEXT_DOCUMENT_READ_TIMEOUT", 408)),
			this.options.readTimeoutMs ?? TOOL_INPUT_READ_TIMEOUT_MS,
		);
		const start = Date.now();
		const job = (async () => {
			let refId: string | undefined;
			try {
				await previous;
				controller.signal.throwIfAborted();
				const ref = this.create(
					{ narratorId, toolUseId, field: "content", ...reference },
					`history/${identity.narratorId}/${identity.messageId}/${identity.toolCallId}/${identity.executionAttempt}`,
				);
				refId = ref.id;
				const sink: HistoricalChunkSink = async (text, offset) => {
					controller.signal.throwIfAborted();
					await this.append(ref.id, text, offset);
				};
				if (this.options.streamHistorical)
					await this.options.streamHistorical(identity, sink, controller.signal);
				else {
					const { activeDatabaseBackend } = await import("../db");
					if (activeDatabaseBackend !== "sqlite")
						throw sourceError("TEXT_DOCUMENT_WORKER_BACKEND_UNSUPPORTED", 503);
					const { getDbPath } = await import("../db/connection");
					await streamHistoricalWriteContent(
						getDbPath(),
						identity,
						sink,
						controller.signal,
						this.options.readTimeoutMs ?? TOOL_INPUT_READ_TIMEOUT_MS,
					);
				}
				controller.signal.throwIfAborted();
				// Visibility/attempt can change while a worker reads: refuse publication of stale authority.
				await this.historicalIdentity(narratorId, toolUseId, reference);
				controller.signal.throwIfAborted();
				if (generation.value !== startedGeneration)
					throw sourceError("TEXT_DOCUMENT_HISTORY_CHANGED");
				await this.append(ref.id, "", undefined, true);
				// Sealing also yields to the write tail. No await may separate the final fence from publication.
				controller.signal.throwIfAborted();
				if (generation.value !== startedGeneration)
					throw sourceError("TEXT_DOCUMENT_HISTORY_CHANGED");
				this.require(ref.id).recoverable = true;
				this.historicalAliases.set(key, ref.id);
				return this.descriptor(ref.id);
			} catch (error) {
				if (refId) await this.discard(refId);
				throw error;
			} finally {
				release();
				this.historicalQueued--;
				this.historicalJobs.delete(key);
				this.historicalControls.delete(key);
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				const elapsedMs = Date.now() - start;
				if (elapsedMs >= 1000)
					this.options.slowLog?.({
						refId: refId ?? "history",
						elapsedMs,
						length: refId ? (this.sources.get(refId)?.ref.length ?? 0) : 0,
					});
			}
		})();
		this.historicalJobs.set(key, job);
		return this.waitForHistoricalJob(job, controller.signal);
	}

	private async waitForHistoricalJob(
		job: Promise<TextDocumentRef>,
		signal?: AbortSignal,
	): Promise<TextDocumentRef> {
		if (!signal) return job;
		let abort: (() => void) | undefined;
		try {
			return await Promise.race([
				job,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(signal.reason ?? sourceError("TEXT_DOCUMENT_CANCELLED", 408));
					signal.addEventListener("abort", abort, { once: true });
					if (signal.aborted) abort();
				}),
			]);
		} finally {
			if (abort) signal.removeEventListener("abort", abort);
		}
	}

	get usage() {
		return {
			memoryBytes: this.memoryUsed,
			queueBytes: this.queuedBytes,
			sources: this.sources.size,
		};
	}

	create(source: TextDocumentSource, occurrence: string): TextDocumentRef {
		if (Date.now() - this.lastCleanupAt > 60 * 60 * 1000) {
			this.lastCleanupAt = Date.now();
			void this.cleanupExpired().catch(() => {});
		}
		if (this.sources.size >= 4096) {
			// Durable aliases are a cache, not admission debt. Never evict an active decoded field/reader.
			let oldest: SourceState | undefined;
			for (const candidate of this.sources.values()) {
				if (
					!candidate.recoverable ||
					!candidate.ref.complete ||
					candidate.readers > 0 ||
					candidate.closed
				)
					continue;
				if (!oldest || candidate.lastReadAt < oldest.lastReadAt) oldest = candidate;
			}
			if (!oldest) throw sourceError("TEXT_DOCUMENT_SOURCE_LIMIT", 503);
			const evicted = oldest;
			evicted.closed = true;
			this.sources.delete(evicted.ref.id);
			if (evicted.ref.source) {
				const lane = JSON.stringify([
					evicted.ref.source.narratorId,
					evicted.ref.source.toolUseId,
					evicted.ref.source.field,
				]);
				if (this.currentInputLanes.get(lane) === evicted.ref.id)
					this.currentInputLanes.delete(lane);
			}
			for (const [key, id] of this.historicalAliases)
				if (id === evicted.ref.id) this.historicalAliases.delete(key);
			void evicted.tail.then(() => this.releaseStorage(evicted)).catch(() => {});
		}
		if (!occurrence || source.field !== "content" || !source.narratorId || !source.toolUseId)
			throw sourceError("TEXT_DOCUMENT_INVALID_SOURCE", 400);
		// Keep descriptor overhead and serialized frame overhead independently bounded.
		if (Object.values(source).some((value) => typeof value === "string" && value.length > 128))
			throw sourceError("TEXT_DOCUMENT_INVALID_SOURCE", 400);
		const ref: TextDocumentRef = {
			id: randomUUID(),
			epoch: randomUUID(),
			revision: 0,
			length: 0,
			complete: false,
			originKnown: true,
			source: { ...source },
		};
		this.sources.set(ref.id, {
			ref,
			occurrence,
			chunks: [],
			memoryBytes: 0,
			tail: Promise.resolve(),
			closed: false,
			persisted: false,
			lastReadAt: Date.now(),
			recoverable: false,
			readers: 0,
		});
		if (!occurrence.startsWith("history/"))
			this.currentInputLanes.set(
				JSON.stringify([source.narratorId, source.toolUseId, source.field]),
				ref.id,
			);
		return this.descriptor(ref.id);
	}

	descriptor(refId: string): TextDocumentRef {
		const state = this.require(refId);
		if (!state.ref.source) throw sourceError("TEXT_DOCUMENT_INVALID_SOURCE");
		return { ...state.ref, source: { ...state.ref.source } };
	}

	private require(refId: string, narratorId?: string): SourceState {
		const state = this.sources.get(refId);
		// Scope is exact self, never parent-summary access. Routes authorize the narrator separately.
		if (
			!state ||
			state.closed ||
			(narratorId !== undefined && state.ref.source?.narratorId !== narratorId)
		)
			throw sourceError("TEXT_DOCUMENT_NOT_FOUND", 404);
		return state;
	}

	private async ensureDirectory(): Promise<void> {
		this.directoryReady ??= (async () => {
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			// Only our expired files in this dedicated directory, never recurse or remove the directory.
			for (const name of await readdir(this.directory)) {
				if (!FILE_PATTERN.test(name)) continue;
				const path = join(this.directory, name);
				try {
					const info = await stat(path);
					if (info.isFile() && Date.now() - info.mtimeMs > RETENTION_MS) await unlink(path);
				} catch {
					/* A concurrent cleanup may already have removed the expired file. */
				}
			}
		})();
		await this.directoryReady;
	}

	/** Global serial writer admits at most queueBudget bytes; callers await admission, no delta drops. */
	private async write(state: SourceState, text: string, offset: number): Promise<void> {
		const previous = this.writeTail;
		let release!: () => void;
		this.writeTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			for (let start = 0; start < text.length; start += Math.floor(this.queueBudget / 2)) {
				const piece = text.slice(start, start + Math.floor(this.queueBudget / 2));
				// UTF16LE preserves individual surrogate halves unlike UTF8 encoding.
				const bytes = Buffer.from(piece, "utf16le");
				this.queuedBytes = bytes.length;
				if (!state.file) throw sourceError("TEXT_DOCUMENT_WRITE_FAILED", 503);
				await (this.options.write ?? writeAll)(state.file, bytes, (offset + start) * 2);
			}
		} finally {
			this.queuedBytes = 0;
			release();
		}
	}

	private async spill(state: SourceState): Promise<void> {
		await this.ensureDirectory();
		const path = join(this.directory, `nf-tool-input-${state.ref.id}.utf16`);
		const file = await open(path, "wx+", 0o600);
		state.file = file;
		state.path = path;
		try {
			for (const chunk of state.chunks) await this.write(state, chunk.text, chunk.offset);
			this.memoryUsed -= state.memoryBytes;
			state.memoryBytes = 0;
			state.chunks = [];
		} catch (error) {
			state.file = undefined;
			state.path = undefined;
			await file.close();
			await unlink(path).catch(() => {});
			throw error;
		}
	}

	append(
		refId: string,
		delta: string,
		offset?: number,
		complete = false,
	): Promise<TextDocumentStreamUpdate> {
		const state = this.require(refId);
		const operation = state.tail.then(async () => {
			const start = offset ?? state.ref.length; // Compatibility with older decoded-field events.
			if (!Number.isSafeInteger(start) || start < 0 || start > state.ref.length)
				throw sourceError("TEXT_DOCUMENT_OFFSET_GAP");
			const overlap = Math.min(delta.length, state.ref.length - start);
			for (let at = 0; at < overlap; at += TEXT_DOCUMENT_PAGE_CHARS) {
				const size = Math.min(TEXT_DOCUMENT_PAGE_CHARS, overlap - at);
				if ((await this.readText(state, start + at, size)) !== delta.slice(at, at + size))
					throw sourceError("TEXT_DOCUMENT_OFFSET_CONFLICT");
			}
			if (state.ref.complete && start + delta.length > state.ref.length)
				throw sourceError("TEXT_DOCUMENT_ALREADY_COMPLETE");
			const text = delta.slice(overlap);
			if (text.length) {
				if (
					!state.file &&
					(state.memoryBytes + text.length * 2 > this.sourceBudget ||
						this.memoryUsed + text.length * 2 > this.globalBudget)
				)
					await this.spill(state);
				if (state.file) await this.write(state, text, state.ref.length);
				else {
					// Coalesce small chunks into bounded pages so tiny deltas cannot grow metadata without bound.
					let consumed = 0;
					while (consumed < text.length) {
						const last = state.chunks.at(-1);
						const count = Math.min(
							TEXT_DOCUMENT_PAGE_CHARS - (last?.text.length ?? 0),
							text.length - consumed,
						);
						if (last && count > 0) {
							last.text += text.slice(consumed, consumed + count);
							consumed += count;
						} else {
							const piece = text.slice(consumed, consumed + TEXT_DOCUMENT_PAGE_CHARS);
							state.chunks.push({ offset: state.ref.length + consumed, text: piece });
							consumed += piece.length;
						}
					}
					state.memoryBytes += text.length * 2;
					this.memoryUsed += text.length * 2;
				}
				state.ref.length += text.length;
			}
			if (text.length || (complete && !state.ref.complete)) state.ref.revision++;
			state.ref.complete ||= complete;
			state.lastReadAt = Date.now();
			return { ref: this.descriptor(refId), offset: start };
		});
		state.tail = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}

	private async readText(
		state: SourceState,
		offset: number,
		limit: number,
		signal?: AbortSignal,
	): Promise<string> {
		if (signal?.aborted) throw signal.reason ?? sourceError("TEXT_DOCUMENT_CANCELLED", 408);
		if (state.persisted) {
			if (!this.options.readPersisted || !state.ref.source)
				throw sourceError("TEXT_DOCUMENT_INVALID_SOURCE");
			const result = await this.options.readPersisted(state.ref.source, offset, limit, signal);
			if (result.length !== state.ref.length) throw sourceError("TEXT_DOCUMENT_PERSISTED_CHANGED");
			return result.text;
		}
		if (state.file) {
			const bytes = Buffer.alloc(limit * 2);
			let read = 0;
			while (read < bytes.length) {
				const result = await state.file.read(bytes, read, bytes.length - read, offset * 2 + read);
				if (!result.bytesRead) break;
				read += result.bytesRead;
				if (signal?.aborted) throw signal.reason ?? sourceError("TEXT_DOCUMENT_CANCELLED", 408);
			}
			if (read !== bytes.length) throw sourceError("TEXT_DOCUMENT_SHORT_READ", 503);
			return bytes.toString("utf16le");
		}
		let text = "";
		for (const chunk of state.chunks) {
			if (chunk.offset >= offset + limit) break;
			if (chunk.offset + chunk.text.length <= offset) continue;
			text += chunk.text.slice(Math.max(0, offset - chunk.offset), offset + limit - chunk.offset);
		}
		return text;
	}

	async getTextDocumentRange(
		narratorId: string,
		refId: string,
		offset = 0,
		limit = TEXT_DOCUMENT_PAGE_CHARS,
		signal?: AbortSignal,
	): Promise<TextDocumentRange> {
		const state = this.require(refId, narratorId);
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1)
			throw sourceError("TEXT_DOCUMENT_INVALID_RANGE", 400);
		const start = Date.now();
		state.lastReadAt = start;
		state.readers++;
		const controller = new AbortController();
		let rejectStopped!: (reason: unknown) => void;
		const stopped = new Promise<never>((_resolve, reject) => {
			rejectStopped = reject;
		});
		const abort = () => {
			controller.abort(signal?.reason ?? sourceError("TEXT_DOCUMENT_READ_TIMEOUT", 408));
			rejectStopped(controller.signal.reason);
		};
		const timer = setTimeout(abort, this.options.readTimeoutMs ?? TOOL_INPUT_READ_TIMEOUT_MS);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (signal?.aborted) abort();
			return await Promise.race([
				(async () => {
					await state.tail;
					this.require(refId, narratorId);
					if (offset > state.ref.length) throw sourceError("TEXT_DOCUMENT_OFFSET_GAP");
					const count = Math.min(limit, TEXT_DOCUMENT_PAGE_CHARS, state.ref.length - offset);
					const ref = this.descriptor(refId);
					const text = await this.readText(state, offset, count, controller.signal);
					const range = { ref, offset, text };
					if (Buffer.byteLength(JSON.stringify(range)) > TEXT_DOCUMENT_PACKET_BYTES)
						throw sourceError("TEXT_DOCUMENT_PACKET_LIMIT", 413);
					state.lastReadAt = Date.now();
					return range;
				})(),
				stopped,
			]);
		} finally {
			state.readers--;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			const elapsedMs = Date.now() - start;
			if (elapsedMs >= 1000) this.options.slowLog?.({ refId, elapsedMs, length: state.ref.length });
		}
	}

	/** Commit exact row identity only AFTER final input persistence; never release before read-through works. */
	private async probePersisted(source: TextDocumentSource, length: number) {
		const reader = this.options.readPersisted;
		if (!reader) throw sourceError("TEXT_DOCUMENT_INVALID_SOURCE");
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				reader(source, 0, Math.min(1, length), controller.signal),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						controller.abort(sourceError("TEXT_DOCUMENT_READ_TIMEOUT", 408));
						reject(controller.signal.reason);
					}, this.options.readTimeoutMs ?? TOOL_INPUT_READ_TIMEOUT_MS);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async matches(refId: string, content: string): Promise<boolean> {
		const state = this.require(refId);
		await state.tail;
		if (state.ref.length !== content.length) return false;
		for (let offset = 0; offset < content.length; offset += TEXT_DOCUMENT_PAGE_CHARS) {
			const limit = Math.min(TEXT_DOCUMENT_PAGE_CHARS, content.length - offset);
			if ((await this.readText(state, offset, limit)) !== content.slice(offset, offset + limit))
				return false;
		}
		return true;
	}

	private invalidateHistoricalIdentity(
		alias: Pick<TextDocumentSource, "toolCallId" | "messageId" | "executionAttempt">,
	): void {
		if (!alias.toolCallId || !alias.messageId) return;
		if (alias.executionAttempt !== undefined) {
			const generationKey = JSON.stringify([
				alias.toolCallId,
				alias.messageId,
				alias.executionAttempt,
			]);
			const generation = this.historicalGenerations.get(generationKey);
			if (generation) generation.value++;
			for (const control of this.historicalControls.values()) {
				if (control.generationKey !== generationKey) continue;
				if (control.generation !== generation) control.generation.value++;
				control.controller.abort(sourceError("TEXT_DOCUMENT_HISTORY_CHANGED"));
			}
		}
		for (const [key, id] of this.historicalAliases) {
			const old = this.sources.get(id)?.ref.source;
			if (
				old?.toolCallId === alias.toolCallId &&
				old.messageId === alias.messageId &&
				old.executionAttempt === alias.executionAttempt
			)
				this.historicalAliases.delete(key);
		}
	}

	async handoff(
		refId: string,
		alias: Pick<TextDocumentSource, "toolCallId" | "messageId" | "executionAttempt">,
		finalLength: number,
		allowRelease = true,
	): Promise<TextDocumentRef> {
		// Persistence may already have changed the row. Fence old rebuilds synchronously, even if
		// this source is missing, its write tail stalls, or final-length validation later fails.
		this.invalidateHistoricalIdentity(alias);
		const state = this.require(refId);
		await state.tail;
		if (!alias.toolCallId || !alias.messageId || finalLength !== state.ref.length)
			throw sourceError("TEXT_DOCUMENT_HANDOFF_MISMATCH");
		if (!state.ref.source) throw sourceError("TEXT_DOCUMENT_INVALID_SOURCE");
		state.ref.source = { ...state.ref.source, ...alias };

		state.ref.complete = true;
		state.recoverable ||= allowRelease;
		state.ref.revision++;
		// Existing row-detail read-through parses the full JSON field. Keep large spill files so an
		// 8Ki range request never materializes a multi-MiB SQLite field on the HTTP main thread.
		if (
			allowRelease &&
			this.options.readPersisted &&
			finalLength * 2 <= TOOL_INPUT_SOURCE_MEMORY_BYTES
		) {
			try {
				const probe = await this.probePersisted(state.ref.source, finalLength);
				if (
					probe.length === finalLength &&
					probe.text === (await this.readText(state, 0, Math.min(1, finalLength)))
				) {
					state.persisted = true;
					await this.releaseStorage(state);
				}
			} catch {
				/* Bounded detail can reject huge input: retain the complete spill instead. */
			}
		}
		return this.descriptor(refId);
	}

	private async releaseStorage(state: SourceState): Promise<void> {
		this.memoryUsed -= state.memoryBytes;
		state.memoryBytes = 0;
		state.chunks = [];
		if (state.file) await state.file.close();
		if (state.path) await unlink(state.path).catch(() => {});
		state.file = undefined;
		state.path = undefined;
	}

	async discard(refId: string): Promise<void> {
		const state = this.sources.get(refId);
		if (!state) return;
		state.closed = true;
		await state.tail;
		await this.releaseStorage(state);
		this.sources.delete(refId);
		if (state.ref.source) {
			const lane = JSON.stringify([
				state.ref.source.narratorId,
				state.ref.source.toolUseId,
				state.ref.source.field,
			]);
			if (this.currentInputLanes.get(lane) === refId) this.currentInputLanes.delete(lane);
		}
		for (const [key, id] of this.historicalAliases)
			if (id === refId) this.historicalAliases.delete(key);
	}

	/** Session shutdown drops uncommitted occurrences only; durable aliases remain range-readable. */
	async discardUnpersisted(narratorId: string): Promise<void> {
		await Promise.all(
			[...this.sources.values()]
				.filter(
					(state) => state.ref.source?.narratorId === narratorId && !state.ref.source.toolCallId,
				)
				.map((state) => this.discard(state.ref.id)),
		);
	}

	async cleanupExpired(now = Date.now()): Promise<void> {
		await Promise.all(
			[...this.sources.values()]
				// Active/uncommitted raw fields are not TTL caches: only their explicit lifecycle may drop them.
				.filter(
					(state) =>
						state.recoverable &&
						state.readers === 0 &&
						state.ref.source?.toolCallId &&
						state.ref.complete &&
						now - state.lastReadAt > RETENTION_MS,
				)
				.map((state) => this.discard(state.ref.id)),
		);
	}
}

export const toolInputStreamSource = hotSafe(
	"toolInputStreamSource",
	() =>
		new ToolInputStreamSourceService({
			// A short content field does not imply a small row (output/other input metadata may be huge).
			// Retain bounded raw memory/spill; historical regeneration reads ONLY input_json in a Worker.
			slowLog: (metadata) => {
				void import("../lib/logger").then(({ logger }) =>
					logger.warn("Slow text document read", metadata),
				);
			},
		}),
);
