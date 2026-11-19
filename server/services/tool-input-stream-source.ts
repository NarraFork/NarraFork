import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
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
import { TaskQueue, TaskQueueError } from "../lib/worker-runtime/queue";
import {
	closeHistoricalWriteWorkers,
	HistoricalWriteWorkerRuntime,
} from "./tool-input-stream-source-worker";

export {
	HISTORICAL_WRITE_INPUT_MAX_BYTES,
	streamHistoricalWriteContent,
} from "./tool-input-stream-source-worker";

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
	/** Bounded durable-marker probe; injected only by the production singleton. */
	isPayloadCleared?: (toolCallId: string, executionAttempt?: number) => Promise<boolean>;
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
	slowLog?: (metadata: { elapsedMs: number; length: number }) => void;
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
	readonly historicalWorkerRuntimeVersion = 1;
	private readonly historicalQueue = new TaskQueue({
		concurrency: 1,
		maxQueued: 15,
		maxQueuedBytes: 256 * 1024,
	});
	private historicalRuntime?: HistoricalWriteWorkerRuntime;
	private historicalClosed = false;
	private historicalClosing?: Promise<void>;
	private historicalCleanupFailure?: unknown;
	private readonly historicalGenerations = new Map<string, { value: number }>();
	private readonly historicalControls = new Map<
		string,
		{
			generationKey: string;
			generation: { value: number };
			controller: AbortController;
			subscribers: number;
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
			if (metadata.payloadCleared) throw sourceError("TEXT_DOCUMENT_HISTORY_CLEARED", 410);
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
		if (this.historicalClosed) throw sourceError("TEXT_DOCUMENT_HISTORY_CLOSED", 503);
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
		if (this.historicalClosed) throw sourceError("TEXT_DOCUMENT_HISTORY_CLOSED", 503);
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
		if (joined) return this.waitForHistoricalJob(key, joined, signal);
		const controller = new AbortController();
		const { key: generationKey, generation } = this.historicalGeneration(reference);
		const startedGeneration = generation.value;
		this.historicalControls.set(key, { generationKey, generation, controller, subscribers: 0 });
		const timer = setTimeout(
			() => controller.abort(sourceError("TEXT_DOCUMENT_READ_TIMEOUT", 408)),
			this.options.readTimeoutMs ?? TOOL_INPUT_READ_TIMEOUT_MS,
		);
		const start = Date.now();
		let refId: string | undefined;
		const job = this.historicalQueue
			.run(
				async () => {
					try {
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
							this.historicalRuntime ??= new HistoricalWriteWorkerRuntime();
							await this.historicalRuntime.stream(
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
						if (refId) {
							try {
								await this.discard(refId);
							} catch (cleanupError) {
								// An unconfirmed FD close is not freed capacity. Permanently stop admission;
								// retain its source/alias owner as evidence rather than silently clearing it.
								this.historicalCleanupFailure ??= cleanupError;
								this.historicalClosed = true;
								void this.historicalQueue.close(cleanupError);
								for (const control of this.historicalControls.values())
									control.controller.abort(cleanupError);
								throw cleanupError;
							}
						}
						throw error;
					}
				},
				{ signal: controller.signal, deadlineAt: Infinity, bytes: key.length * 2 },
			)
			.catch((error) => {
				if (error instanceof TaskQueueError && error.code === "TASK_QUEUE_FULL")
					throw sourceError("TEXT_DOCUMENT_HISTORY_QUEUE_LIMIT", 429);
				throw error;
			})
			.finally(() => {
				this.historicalJobs.delete(key);
				this.historicalControls.delete(key);
				clearTimeout(timer);
				const elapsedMs = Date.now() - start;
				if (elapsedMs >= 1000) {
					try {
						this.options.slowLog?.({
							elapsedMs,
							length: refId ? (this.sources.get(refId)?.ref.length ?? 0) : 0,
						});
					} catch {
						/* A diagnostic sink cannot change publication/cleanup results. */
					}
				}
			});
		this.historicalJobs.set(key, job);
		return this.waitForHistoricalJob(key, job, signal);
	}

	private async waitForHistoricalJob(
		key: string,
		job: Promise<TextDocumentRef>,
		signal?: AbortSignal,
	): Promise<TextDocumentRef> {
		const control = this.historicalControls.get(key);
		if (!control) return job;
		control.subscribers++;
		const combined = signal
			? AbortSignal.any([signal, control.controller.signal])
			: control.controller.signal;
		let abort: (() => void) | undefined;
		try {
			return await Promise.race([
				job,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(combined.reason ?? sourceError("TEXT_DOCUMENT_CANCELLED", 408));
					combined.addEventListener("abort", abort, { once: true });
					if (combined.aborted) abort();
				}),
			]);
		} finally {
			if (abort) combined.removeEventListener("abort", abort);
			control.subscribers--;
			if (control.subscribers === 0 && signal?.aborted)
				control.controller.abort(signal.reason ?? sourceError("TEXT_DOCUMENT_CANCELLED", 408));
		}
	}

	/** Stop historical admission, drain partial-source cleanup and wait for real Worker exits.
	 * Persisted aliases, raw sources and their storage owner are deliberately not destroyed. */
	closeHistoricalWorkers(): Promise<void> {
		if (this.historicalClosing) return this.historicalClosing;
		this.historicalClosed = true;
		const reason = sourceError("TEXT_DOCUMENT_HISTORY_CLOSED", 503);
		const drained = this.historicalQueue.close(reason);
		for (const control of this.historicalControls.values()) control.controller.abort(reason);
		this.historicalClosing = (async () => {
			const stopped = this.historicalRuntime?.close();
			const outcomes = await Promise.allSettled([
				drained,
				stopped,
				Promise.allSettled([...this.historicalJobs.values()]),
			]);
			for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
			if (this.historicalCleanupFailure) throw this.historicalCleanupFailure;
		})();
		return this.historicalClosing;
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
					this.require(refId, narratorId);
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
			if (elapsedMs >= 1000) {
				try {
					this.options.slowLog?.({ elapsedMs, length: state.ref.length });
				} catch {
					/* Diagnostics cannot replace a read or its cleanup outcome. */
				}
			}
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
		this.require(refId);
		if (
			alias.toolCallId &&
			(await this.options.isPayloadCleared?.(alias.toolCallId, alias.executionAttempt))
		) {
			await this.discard(refId);
			throw sourceError("TEXT_DOCUMENT_HISTORY_CLEARED", 410);
		}
		this.require(refId);
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

	/** Revoke original/spilled copies synchronously, then remove their files asynchronously. */
	async clearRetainedToolPayload(alias: HistoricalWriteDocumentReference): Promise<void> {
		this.invalidateHistoricalIdentity(alias);
		const ids: string[] = [];
		for (const [id, state] of this.sources) {
			if (
				state.ref.source?.toolCallId !== alias.toolCallId ||
				state.ref.source.messageId !== alias.messageId ||
				state.ref.source.executionAttempt !== alias.executionAttempt
			)
				continue;
			state.closed = true;
			ids.push(id);
		}
		await Promise.all(ids.map((id) => this.discard(id)));
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
			isPayloadCleared: async (toolCallId, executionAttempt) => {
				const { sqlite, activeDatabaseBackend } = await import("../db");
				if (activeDatabaseBackend !== "sqlite") return false;
				const { CLEARED_TOOL_OUTPUT_SQL } = await import("./narrator-block-sync");
				const row = sqlite
					.query<{ cleared: number; attempt: number }, [string]>(
						`SELECT (${CLEARED_TOOL_OUTPUT_SQL}) AS cleared, execution_attempt AS attempt FROM narrator_tool_calls WHERE id = ?`,
					)
					.get(toolCallId);
				return (
					!row ||
					!!row.cleared ||
					(executionAttempt !== undefined && row.attempt !== executionAttempt)
				);
			},
			// A short content field does not imply a small row (output/other input metadata may be huge).
			// Retain bounded raw memory/spill; historical regeneration reads ONLY input_json in a Worker.
			slowLog: (metadata) => {
				void import("../lib/logger")
					.then(({ logger }) => logger.warn("Slow text document read", metadata))
					.catch(() => {});
			},
		}),
);

// An old hot-pinned instance has no evidence of owned Handles. Preserve its data and fail closed;
// counting zero workers or replacing the instance would silently orphan its old resources.
if (toolInputStreamSource.historicalWorkerRuntimeVersion !== 1)
	throw new Error(
		"Historical Write worker ownership predates this runtime; manually restart NarraFork",
	);

export async function closeToolInputHistoricalWorkers(): Promise<void> {
	const outcomes = await Promise.allSettled([
		toolInputStreamSource.closeHistoricalWorkers(),
		closeHistoricalWriteWorkers(),
	]);
	for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
}
