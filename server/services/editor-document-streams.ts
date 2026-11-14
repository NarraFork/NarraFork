import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { Worker } from "node:worker_threads";
import {
	EDITOR_IO_TIMEOUT_MS,
	EDITOR_RAW_WINDOW_BYTES,
	EDITOR_TRANSFER_CHUNK_BYTES,
	type EditorRawEncoding,
	type EditorRawMetadata,
} from "../../shared/editor-document";
import type {
	EditorRawReadChunk,
	EditorRawReadChunkRequest,
	EditorRawReadClose,
	EditorRawReadOpen,
} from "../../shared/editor-provider-contracts";
import { editorRawEncoding } from "../../shared/editor-stream-codec";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { WorkerCleanupError, type WorkerHandle } from "../lib/worker-runtime/lifecycle";
import { TaskQueue, TaskQueueError } from "../lib/worker-runtime/queue";
import type { StreamWorkerRequest, StreamWorkerResult } from "./editor-document-stream-worker";

export interface EditorRemoteRawSource {
	open(signal: AbortSignal): Promise<EditorRawReadOpen>;
	chunk(input: EditorRawReadChunkRequest, signal: AbortSignal): Promise<EditorRawReadChunk>;
	close(input: EditorRawReadClose): Promise<void>;
}
type WorkerSlot = {
	worker?: Worker;
	handle?: WorkerHandle<Worker>;
	closing?: Promise<void>;
	ready: Promise<void>;
	exited: Promise<void>;
	failure?: Error;
	pending: Map<number, { resolve(value: StreamWorkerResult): void; reject(error: unknown): void }>;
};
// JSON/base64 and worker decoding coexist during remote preflight. Smaller RPC
// credit includes those copies in the same 256KiB application window.
const REMOTE_RAW_CHUNK_BYTES = 16 * 1024;
// Body publication alone may assemble two sequential peer frames inside the
// caller's existing credit. No larger JSON RPC, preflight batch or read-ahead.
// Conservative live Host copies: 5 * (base64(16KiB) + 8KiB envelope) for wire +
// full UTF16 JSON + parsed UTF16 base64; 2 * 16KiB decode copies; 2 * 32KiB for
// assembly + HTTP body = 248,504 bytes < the unchanged 256KiB stream window.
// The browser's existing requested-byte/text/format credit is unchanged.
const REMOTE_BODY_PUBLISH_BYTES = 2 * REMOTE_RAW_CHUNK_BYTES;
const streamError = (message: string, status = 409) => new AppError(message, status, message);
function remoteChunkBytes(chunk: EditorRawReadChunk, maxBytes: number) {
	if (
		!Number.isSafeInteger(chunk.bytes) ||
		chunk.bytes < 0 ||
		chunk.bytes > maxBytes ||
		typeof chunk.dataB64 !== "string" ||
		chunk.dataB64.length > Math.ceil(maxBytes / 3) * 4
	)
		throw streamError("EDITOR_STREAM_INVALID");
	const bytes = Uint8Array.from(Buffer.from(chunk.dataB64, "base64"));
	if (bytes.length !== chunk.bytes || (!bytes.length && !chunk.eof))
		throw streamError("EDITOR_STREAM_INVALID");
	return bytes;
}

/** Two long-lived, affinity-bound source workers; WorkerHandle owns their real exit. */
export class EditorSourceWorkers {
	private slots: (WorkerSlot | undefined)[] = [];
	onExit?: (slot: WorkerSlot) => void;
	private sequence = 0;
	private next = 0;
	private readonly shutdown = new AbortController();
	private closing?: Promise<void>;
	constructor(
		private specifiers = compiledWorkerSpecifiers(
			"services/editor-document-stream-worker.ts",
			"./editor-document-stream-worker.ts",
			import.meta.url,
		),
		private readonly budget = { readyMs: 5000, ackMs: EDITOR_IO_TIMEOUT_MS },
	) {}
	assign(): WorkerSlot {
		return this.slot(this.next++ % 2);
	}
	private fail(slot: WorkerSlot, error: unknown) {
		slot.failure ??= error instanceof Error ? error : streamError("EDITOR_WORKER_FAILED", 503);
		for (const request of slot.pending.values()) request.reject(slot.failure);
		slot.pending.clear();
	}
	private retire(slot: WorkerSlot): Promise<void> {
		slot.closing ??= (async () => {
			await slot.ready.catch(() => {});
			try {
				await slot.handle?.close();
			} finally {
				// Failed terminate is still a live slot; never replace it before an observed exit.
				await slot.exited;
			}
		})();
		return slot.closing;
	}
	private slot(index: number): WorkerSlot {
		if (this.shutdown.signal.aborted) throw streamError("EDITOR_WORKER_CLOSED", 503);
		if (index !== 0 && index !== 1) throw streamError("EDITOR_STREAM_INVALID", 422);
		if (this.slots[index]) return this.slots[index];
		let confirmExit!: () => void;
		const exited = new Promise<void>((resolve) => {
			confirmExit = resolve;
		});
		const slot: WorkerSlot = { ready: Promise.resolve(), exited, pending: new Map() };
		const finishExit = () => {
			this.fail(slot, streamError("EDITOR_WORKER_CLOSED", 503));
			confirmExit();
			if (this.slots[index] === slot) this.slots[index] = undefined;
			this.onExit?.(slot);
		};
		this.slots[index] = slot;
		slot.ready = connectCompiledWorker(this.specifiers, {
			signal: this.shutdown.signal,
			timeoutMs: this.budget.readyMs,
		})
			.then(({ worker, handle }) => {
				slot.worker = worker;
				slot.handle = handle;
				void handle.exited.then(finishExit);
				worker.on("message", (message) => {
					if (message?.ready) return;
					const request = slot.pending.get(message?.id);
					slot.pending.delete(message?.id);
					if (message?.error)
						request?.reject(
							Object.assign(streamError(message.error), message.code ? { code: message.code } : {}),
						);
					else request?.resolve(message?.result);
				});
				const failed = (error: unknown) => {
					this.fail(slot, error);
					void this.retire(slot).catch(() => {});
				};
				worker.on("error", failed);
				worker.on("messageerror", failed);
			})
			.catch((error) => {
				this.fail(slot, error);
				if (error instanceof WorkerCleanupError) {
					// The connector failed to stop a startup probe. Keep its physical slot pinned.
					slot.handle = error.handle as WorkerHandle<Worker>;
					void slot.handle.exited.then(finishExit);
				} else finishExit();
				throw slot.failure;
			});
		void slot.ready.catch(() => {});
		return slot;
	}
	async run(owner: number | WorkerSlot, request: StreamWorkerRequest): Promise<StreamWorkerResult> {
		const slot = typeof owner === "number" ? this.slot(owner) : owner;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await slot.ready;
			if (slot.failure) throw slot.failure;
			if (slot.pending.size >= 32) throw streamError("EDITOR_BUSY", 429);
			const id = ++this.sequence;
			return await new Promise<StreamWorkerResult>((resolve, reject) => {
				slot.pending.set(id, { resolve, reject });
				// Independent of the stream/consumer deadline: close ACKs also need a watchdog.
				timer = setTimeout(() => {
					this.fail(slot, streamError("EDITOR_WORKER_TIMEOUT", 408));
					void this.retire(slot).catch(() => {});
				}, this.budget.ackMs);
				timer.unref();
				try {
					slot.worker?.postMessage({ id, request });
				} catch (error) {
					this.fail(slot, error);
					void this.retire(slot).catch(() => {});
				}
			});
		} catch (error) {
			if (request.action !== "close") throw error;
			// Even a close-specific protocol error is not an ACK proving the borrowed FD idle.
			this.fail(slot, error);
			void this.retire(slot).catch(() => {});
			await slot.exited;
			return {};
		} finally {
			clearTimeout(timer);
		}
	}
	async counters() {
		return Promise.all(
			[0, 1].map(
				async (index) => (await this.run(index, { action: "diagnostics", stream: "" })).counters,
			),
		);
	}
	get count() {
		return this.slots.filter(Boolean).length;
	}
	dispose(): Promise<void> {
		if (this.closing) return this.closing;
		this.shutdown.abort(streamError("EDITOR_WORKER_CLOSED", 503));
		for (const slot of this.slots)
			if (slot) this.fail(slot, streamError("EDITOR_WORKER_CLOSED", 503));
		this.closing = Promise.all(
			this.slots.flatMap((slot) => (slot ? [this.retire(slot)] : [])),
		).then(() => {});
		return this.closing;
	}
}

type Permit = { signal: AbortSignal; release(): void };
type ActiveRead = {
	owner: string;
	userId: string;
	id: string;
	worker: WorkerSlot;
	offset: number;
	busy: boolean;
	closed?: boolean;
	eof?: boolean;
	permit: Permit;
	file?: FileHandle;
	openingFile?: Promise<void>;
	fileClose?: Promise<void>;
	remote?: EditorRemoteRawSource;
	remoteOpen?: EditorRawReadOpen;
	openingRemote?: Promise<EditorRawReadOpen>;
	close(): Promise<void>;
	touch(): void;
};
/** Pull RPC is the credit: the browser requests the next offset only AFTER consuming
 * codec output into the candidate. HTTP/TCP prefetch cannot initiate another read.
 * A stream reserves 256KiB for raw+UTF16+EOL transport, 8 streams reserve 2MiB;
 * this application window is NOT a process/Monaco/HTTP memory bound. */
export class EditorDocumentStreams {
	readonly workers: EditorSourceWorkers;
	private readonly admission = new TaskQueue({
		concurrency: 8,
		maxQueued: 64,
		maxActivePerKey: 2,
		maxQueuedPerKey: 8,
	});
	private readonly scopes = new Set<{ owner: string; controller: AbortController }>();
	private reads = new Map<string, ActiveRead>();
	private disposed = false;
	private closing?: Promise<void>;
	/** Explicit deadlines are a fixture seam; production uses the fixed transfer budgets. */
	constructor(
		workers = new EditorSourceWorkers(),
		private readonly budget = { deadlineMs: EDITOR_IO_TIMEOUT_MS, idleMs: 10_000 },
	) {
		this.workers = workers;
		workers.onExit = (slot) => {
			for (const read of this.reads.values())
				if (read.worker === slot) void read.close().catch(() => {});
		};
	}
	get diagnostics() {
		return {
			active: this.admission.stats.active,
			queued: this.admission.stats.queued,
			streams: this.reads.size,
			windowBytes: this.admission.stats.active * EDITOR_RAW_WINDOW_BYTES,
			workers: this.workers.count,
		};
	}
	private async acquire(
		userId: string,
		external: AbortSignal | undefined,
		owner: string,
	): Promise<Permit> {
		if (this.disposed) throw streamError("EDITOR_STREAM_CLOSED");
		external?.throwIfAborted();
		const scope = { owner, controller: new AbortController() };
		this.scopes.add(scope);
		try {
			const permit = await this.admission.acquire({
				key: userId,
				deadlineAt: Date.now() + this.budget.deadlineMs,
				signal: external
					? AbortSignal.any([external, scope.controller.signal])
					: scope.controller.signal,
			});
			const controller = new AbortController();
			const abort = () =>
				controller.abort(
					permit.signal.reason instanceof TaskQueueError || external?.aborted
						? streamError("EDITOR_TIMEOUT", 408)
						: permit.signal.reason,
				);
			permit.signal.addEventListener("abort", abort, { once: true });
			if (permit.signal.aborted) abort();
			return {
				signal: controller.signal,
				release: () => {
					permit.signal.removeEventListener("abort", abort);
					this.scopes.delete(scope);
					permit.release();
				},
			};
		} catch (error) {
			this.scopes.delete(scope);
			if (error instanceof TaskQueueError) {
				if (error.code === "TASK_QUEUE_FULL") throw streamError("EDITOR_BUSY", 429);
				if (error.code === "TASK_QUEUE_TIMEOUT") throw streamError("EDITOR_TIMEOUT", 408);
			}
			throw error;
		}
	}
	async open(
		userId: string,
		owner: string,
		path: string | EditorRemoteRawSource,
		encoding?: EditorRawEncoding,
		expected?: EditorRawMetadata,
		signal?: AbortSignal,
		preflightOnly = false,
	) {
		const started = performance.now();
		const permit = await this.acquire(userId, signal, owner);
		const id = randomUUID();
		let worker: WorkerSlot;
		try {
			permit.signal.throwIfAborted();
			if (this.disposed) throw streamError("EDITOR_STREAM_CLOSED");
			worker = this.workers.assign();
		} catch (error) {
			permit.release();
			throw error;
		}
		let idle: ReturnType<typeof setTimeout> | undefined;
		let closed = false;
		let closing: Promise<void> | undefined;
		const read: ActiveRead = {
			owner,
			userId,
			id,
			worker,
			offset: 0,
			busy: false,
			permit,
			touch: () => {
				clearTimeout(idle);
				idle = setTimeout(() => {
					void read.close().catch(() => {});
				}, this.budget.idleMs);
				idle.unref();
			},
			close: () =>
				(closing ??= (async () => {
					closed = true;
					read.closed = true;
					clearTimeout(idle);
					permit.signal.removeEventListener("abort", onAbort);
					await this.workers.run(worker, { action: "close", stream: id });
					await closeReadFile(read);
					await read.openingRemote?.catch(() => {});
					if (read.remoteOpen)
						await read.remote?.close({ readId: read.remoteOpen.readId, abort: !read.eof });
					// Cleanup failures retain the read/permit as evidence, never count as freed credit.
					this.reads.delete(id);
					permit.release();
					const elapsedMs = Math.round(performance.now() - started);
					try {
						if (elapsedMs >= 1000)
							logger.warn("Slow editor raw source lifecycle (includes consumer wait)", {
								elapsedMs,
								kind: preflightOnly ? "preflight" : "body",
								remote: !!read.remote,
								bodyBytes: read.offset,
								eof: !!read.eof,
							});
					} catch {
						// Diagnostics cannot change the consumer's result or resource accounting.
					}
				})()),
		};
		const onAbort = () => {
			void read.close().catch(() => {});
		};
		permit.signal.addEventListener("abort", onAbort, { once: true });
		this.reads.set(id, read);
		const openRemote = async (source: EditorRemoteRawSource) => {
			read.openingRemote = source.open(permit.signal).then((opened) => {
				read.remoteOpen = opened;
				return opened;
			});
			const opened = await read.openingRemote;
			if (closed || permit.signal.aborted) throw streamError("EDITOR_STREAM_CLOSED");
			return opened;
		};
		try {
			await worker.ready;
			if (worker.failure) throw worker.failure;
			permit.signal.throwIfAborted();
			let metadata: EditorRawMetadata | undefined;
			if (typeof path === "string") {
				read.openingFile = open(
					path,
					constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
				).then((file) => {
					read.file = file;
				});
				await read.openingFile;
				const file = read.file;
				if (closed || permit.signal.aborted || worker.failure || !file)
					throw streamError("EDITOR_STREAM_CLOSED");
				metadata = (
					await this.workers.run(worker, {
						action: "open",
						stream: id,
						path,
						fd: file.fd,
						encoding,
						expected,
					})
				).metadata;
			} else {
				read.remote = path;
				read.remoteOpen = await openRemote(path);
				if (expected) {
					metadata = expected;
					if (
						read.remoteOpen.rawDigest !== metadata.baseHash ||
						read.remoteOpen.totalBytes !== metadata.sourceBytes
					)
						throw streamError("EDITOR_SOURCE_CHANGED");
				} else {
					let offset = 0;
					for (;;) {
						permit.signal.throwIfAborted();
						const chunk = await path.chunk(
							{
								readId: read.remoteOpen.readId,
								offset,
								maxBytes: REMOTE_RAW_CHUNK_BYTES,
								timeoutMs: 10_000,
							},
							permit.signal,
						);
						if (
							chunk.offset !== offset ||
							chunk.sourceGeneration !== read.remoteOpen.sourceGeneration
						)
							throw streamError("EDITOR_SOURCE_CHANGED");
						const bytes = remoteChunkBytes(chunk, REMOTE_RAW_CHUNK_BYTES);
						if (offset === 0)
							await this.workers.run(worker, {
								action: "codec-open",
								stream: id,
								encoding: editorRawEncoding(bytes, encoding),
							});
						metadata = (
							await this.workers.run(worker, {
								action: "codec-chunk",
								stream: id,
								bytes,
								eof: chunk.eof,
							})
						).metadata;
						offset += bytes.length;
						if (chunk.eof) break;
					}
					if (
						!metadata ||
						metadata.baseHash !== read.remoteOpen.rawDigest ||
						metadata.sourceBytes !== read.remoteOpen.totalBytes
					)
						throw streamError("EDITOR_SOURCE_CHANGED");
					await path.close({ readId: read.remoteOpen.readId, abort: false });
					read.remoteOpen = undefined;
					if (!preflightOnly) {
						read.remoteOpen = await openRemote(path);
						if (
							read.remoteOpen.rawDigest !== metadata.baseHash ||
							read.remoteOpen.totalBytes !== metadata.sourceBytes
						)
							throw streamError("EDITOR_SOURCE_CHANGED");
					}
				}
			}
			permit.signal.throwIfAborted();
			if (closed || !metadata) throw streamError("EDITOR_STREAM_CLOSED");
			read.touch();
			return { readId: id, metadata };
		} catch (error) {
			await read.close();
			throw error;
		}
	}
	async metadata(
		userId: string,
		path: string | EditorRemoteRawSource,
		encoding?: EditorRawEncoding,
		signal?: AbortSignal,
		owner = "preflight",
	) {
		const source = await this.open(userId, owner, path, encoding, undefined, signal, true);
		await this.close(owner, source.readId);
		return source.metadata;
	}
	async chunk(owner: string, readId: string, offset: number, maxBytes: number) {
		const read = this.reads.get(readId);
		if (!read || read.closed || read.eof || read.owner !== owner)
			throw streamError("EDITOR_STREAM_CLOSED", 410);
		if (
			read.busy ||
			offset !== read.offset ||
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 1 ||
			maxBytes > EDITOR_TRANSFER_CHUNK_BYTES
		)
			throw streamError("EDITOR_STREAM_INVALID", 422);
		read.busy = true;
		try {
			read.permit.signal.throwIfAborted();
			let result: { bytes?: Uint8Array; eof?: boolean };
			if (read.remote && read.remoteOpen) {
				const bytes = new Uint8Array(Math.min(maxBytes, REMOTE_BODY_PUBLISH_BYTES));
				let used = 0,
					eof = false;
				for (let frame = 0; frame < 2 && used < bytes.length; frame++) {
					read.permit.signal.throwIfAborted();
					if (closedRead(this.reads, read)) throw streamError("EDITOR_STREAM_CLOSED");
					const credit = Math.min(bytes.length - used, REMOTE_RAW_CHUNK_BYTES);
					const chunk = await read.remote.chunk(
						{
							readId: read.remoteOpen.readId,
							offset: offset + used,
							maxBytes: credit,
							timeoutMs: 10_000,
						},
						read.permit.signal,
					);
					read.permit.signal.throwIfAborted();
					if (closedRead(this.reads, read)) throw streamError("EDITOR_STREAM_CLOSED");
					const part = remoteChunkBytes(chunk, credit);
					if (
						chunk.offset !== offset + used ||
						chunk.sourceGeneration !== read.remoteOpen.sourceGeneration
					)
						throw streamError("EDITOR_SOURCE_CHANGED");
					bytes.set(part, used);
					used += part.length;
					eof = chunk.eof;
					if (eof) break;
				}
				// A second-frame failure reaches the existing close-on-error path without
				// publishing the first frame or advancing the reusable stream offset.
				result = { bytes: bytes.subarray(0, used), eof };
			} else
				result = await this.workers.run(read.worker, {
					action: "read",
					stream: readId,
					offset,
					maxBytes,
				});
			read.permit.signal.throwIfAborted();
			if (closedRead(this.reads, read)) throw streamError("EDITOR_STREAM_CLOSED");
			read.offset += result.bytes?.length ?? 0;
			// EOF is not a consumer close or a worker close ACK. Both parent FD and
			// application window remain owned until close/idle/deadline joins cleanup.
			read.eof = !!result.eof;
			read.touch();
			return result;
		} catch (error) {
			await read.close();
			throw error;
		} finally {
			read.busy = false;
		}
	}
	async close(owner: string, id: string) {
		const read = this.reads.get(id);
		if (read?.owner === owner) await read.close();
	}
	async closeOwner(owner: string) {
		for (const scope of this.scopes)
			if (scope.owner === owner) scope.controller.abort(streamError("EDITOR_STREAM_CLOSED"));
		await Promise.all(
			[...this.reads.values()].filter((read) => read.owner === owner).map((read) => read.close()),
		);
	}
	dispose(): Promise<void> {
		if (this.closing) return this.closing;
		this.disposed = true;
		const drained = this.admission.close(streamError("EDITOR_STREAM_CLOSED"));
		for (const scope of this.scopes) scope.controller.abort(streamError("EDITOR_STREAM_CLOSED"));
		this.closing = (async () => {
			const cleanup = await Promise.allSettled(
				[...this.reads.values()].map((read) => read.close()),
			);
			await this.workers.dispose();
			const failure = cleanup.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
			// Includes admissions/open calls that were pending when the read snapshot was taken.
			await drained;
		})();
		return this.closing;
	}
}
function closeReadFile(read: ActiveRead): Promise<void> {
	read.fileClose ??= (async () => {
		await read.openingFile?.catch(() => {});
		const file = read.file;
		await file?.close();
		read.file = undefined;
	})();
	return read.fileClose;
}
function closedRead(reads: Map<string, ActiveRead>, read: ActiveRead) {
	return read.closed || reads.get(read.id) !== read;
}
