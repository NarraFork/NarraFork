import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { Worker } from "node:worker_threads";
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
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { editorWorkerEntryPoint, editorWorkerSpecifierCandidates } from "./editor-document-jobs";
import type { StreamWorkerRequest, StreamWorkerResult } from "./editor-document-stream-worker";

export interface EditorRemoteRawSource {
	open(signal: AbortSignal): Promise<EditorRawReadOpen>;
	chunk(input: EditorRawReadChunkRequest, signal: AbortSignal): Promise<EditorRawReadChunk>;
	close(input: EditorRawReadClose): Promise<void>;
}
type WorkerSlot = {
	worker: Worker;
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

/** Two reusable source workers, independent of the metadata/commit IO permits. */
export class EditorSourceWorkers {
	private slots: (WorkerSlot | undefined)[] = [];
	onExit?: (slot: WorkerSlot) => void;
	private sequence = 0;
	private next = 0;
	constructor(
		private specifiers = editorWorkerSpecifierCandidates().map((path) =>
			path.replace("editor-document-worker", "editor-document-stream-worker"),
		),
	) {}
	assign(): WorkerSlot {
		return this.slot(this.next++ % 2);
	}
	private slot(index: number): WorkerSlot {
		if (this.slots[index]) return this.slots[index];
		const pending: WorkerSlot["pending"] = new Map();
		const worker = new Worker(editorWorkerEntryPoint(this.specifiers[0]));
		let timer: ReturnType<typeof setTimeout>;
		let rejectReady!: (error: Error) => void;
		let confirmExit!: () => void;
		const exited = new Promise<void>((resolve) => {
			confirmExit = resolve;
		});
		const ready = new Promise<void>((resolve, reject) => {
			rejectReady = reject;
			timer = setTimeout(() => {
				fail(streamError("EDITOR_WORKER_READY_TIMEOUT", 503));
				void worker.terminate();
			}, 5000);
			worker.on("message", (message) => {
				if (message.ready) {
					clearTimeout(timer);
					resolve();
					return;
				}
				const request = pending.get(message.id);
				pending.delete(message.id);
				if (message.error)
					request?.reject(
						Object.assign(streamError(message.error), message.code ? { code: message.code } : {}),
					);
				else request?.resolve(message.result);
			});
		});
		const slot: WorkerSlot = { worker, ready, exited, pending };
		const fail = (error: Error) => {
			slot.failure ??= error;
			clearTimeout(timer);
			rejectReady(slot.failure);
			for (const request of pending.values()) request.reject(slot.failure);
			pending.clear();
		};
		worker.on("error", (error) => {
			fail(error instanceof Error ? error : streamError("EDITOR_WORKER_FAILED", 503));
			void worker.terminate();
		});
		worker.on("exit", () => {
			fail(streamError("EDITOR_WORKER_CLOSED", 503));
			confirmExit();
			if (this.slots[index] === slot) this.slots[index] = undefined;
			this.onExit?.(slot);
		});
		this.slots[index] = slot;
		return slot;
	}
	async run(owner: number | WorkerSlot, request: StreamWorkerRequest): Promise<StreamWorkerResult> {
		const slot = typeof owner === "number" ? this.slot(owner) : owner;
		try {
			await slot.ready;
			if (slot.failure) throw slot.failure;
			const id = ++this.sequence;
			return await new Promise<StreamWorkerResult>((resolve, reject) => {
				slot.pending.set(id, { resolve, reject });
				try {
					slot.worker.postMessage({ id, request });
				} catch (error) {
					slot.pending.delete(id);
					reject(error);
				}
			});
		} catch (error) {
			if (request.action !== "close" || !slot.failure) throw error;
			// Cover failures both before dispatch and while close was awaiting its ACK.
			await slot.exited;
			return {};
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
	async dispose() {
		await Promise.all(this.slots.map((slot) => slot?.worker.terminate()));
		this.slots = [];
	}
}

type Permit = { signal: AbortSignal; release(): void };
type Waiting = { userId: string; owner: string; start(): void; abort(): void };
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
	close(): Promise<void>;
	touch(): void;
};
/** Pull RPC is the credit: the browser requests the next offset only AFTER consuming
 * codec output into the candidate. HTTP/TCP prefetch cannot initiate another read.
 * A stream reserves 256KiB for raw+UTF16+EOL transport, 8 streams reserve 2MiB;
 * this application window is NOT a process/Monaco/HTTP memory bound. */
export class EditorDocumentStreams {
	readonly workers: EditorSourceWorkers;
	private users = new Map<string, number>();
	private queue: Waiting[] = [];
	private active = 0;
	private reads = new Map<string, ActiveRead>();
	private lastUser = "";
	private disposed = false;
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
			active: this.active,
			queued: this.queue.length,
			streams: this.reads.size,
			windowBytes: this.active * EDITOR_RAW_WINDOW_BYTES,
			workers: this.workers.count,
		};
	}
	private pump() {
		if (this.disposed) return;
		while (this.active < 8) {
			let index = this.queue.findIndex(
				(entry) => entry.userId !== this.lastUser && (this.users.get(entry.userId) ?? 0) < 2,
			);
			if (index < 0)
				index = this.queue.findIndex((entry) => (this.users.get(entry.userId) ?? 0) < 2);
			if (index < 0) break;
			this.queue.splice(index, 1)[0].start();
		}
	}
	private acquire(
		userId: string,
		external: AbortSignal | undefined,
		owner: string,
	): Promise<Permit> {
		if (this.disposed) return Promise.reject(streamError("EDITOR_STREAM_CLOSED"));
		if (external?.aborted) return Promise.reject(external.reason);
		if (
			this.queue.length >= 64 ||
			this.queue.filter((entry) => entry.userId === userId).length >= 8
		)
			return Promise.reject(streamError("EDITOR_BUSY", 429));
		return new Promise((resolve, reject) => {
			const controller = new AbortController();
			let admitted = false,
				released = false;
			const release = () => {
				if (released) return;
				released = true;
				clearTimeout(timer);
				external?.removeEventListener("abort", entry.abort);
				const index = this.queue.indexOf(entry);
				if (index >= 0) this.queue.splice(index, 1);
				if (admitted) {
					this.active--;
					const count = (this.users.get(userId) ?? 1) - 1;
					if (count) this.users.set(userId, count);
					else this.users.delete(userId);
				}
				this.pump();
			};
			const entry: Waiting = {
				userId,
				owner,
				start: () => {
					admitted = true;
					this.active++;
					this.users.set(userId, (this.users.get(userId) ?? 0) + 1);
					this.lastUser = userId;
					resolve({ signal: controller.signal, release });
				},
				abort: () => {
					controller.abort(streamError("EDITOR_TIMEOUT", 408));
					if (!admitted) {
						release();
						reject(controller.signal.reason);
					}
				},
			};
			const timer = setTimeout(entry.abort, this.budget.deadlineMs);
			timer.unref();
			external?.addEventListener("abort", entry.abort, { once: true });
			this.queue.push(entry);
			this.pump();
		});
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
					try {
						await this.workers.run(worker, { action: "close", stream: id });
					} finally {
						try {
							await closeReadFile(read);
							if (read.remoteOpen)
								await read.remote?.close({ readId: read.remoteOpen.readId, abort: !read.eof });
						} finally {
							this.reads.delete(id);
							permit.release();
							const elapsedMs = Math.round(performance.now() - started);
							if (elapsedMs >= 1000)
								logger.warn("Slow editor raw source lifecycle (includes consumer wait)", {
									elapsedMs,
									kind: preflightOnly ? "preflight" : "body",
									remote: !!read.remote,
									bodyBytes: read.offset,
									eof: !!read.eof,
								});
						}
					}
				})()),
		};
		const onAbort = () => {
			void read.close().catch(() => {});
		};
		permit.signal.addEventListener("abort", onAbort, { once: true });
		this.reads.set(id, read);
		const openRemote = async (source: EditorRemoteRawSource) => {
			const opened = await source.open(permit.signal);
			if (closed || permit.signal.aborted) {
				await source.close({ readId: opened.readId, abort: true });
				throw streamError("EDITOR_STREAM_CLOSED");
			}
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
			if (result.eof) await closeReadFile(read);
			// The parent/executor closes the FD at verified EOF. Keep the window
			// until the real consumer ACKs with close (or its idle/deadline expires).
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
		for (const entry of this.queue.filter((entry) => entry.owner === owner)) entry.abort();
		await Promise.all(
			[...this.reads.values()].filter((read) => read.owner === owner).map((read) => read.close()),
		);
	}
	async dispose() {
		this.disposed = true;
		for (const entry of [...this.queue]) entry.abort();
		await Promise.all([...this.reads.values()].map((read) => read.close()));
		await this.workers.dispose();
	}
}
function closeReadFile(read: ActiveRead): Promise<void> {
	read.fileClose ??= (async () => {
		await read.openingFile?.catch(() => {});
		const file = read.file;
		read.file = undefined;
		await file?.close();
	})();
	return read.fileClose;
}
function closedRead(reads: Map<string, ActiveRead>, read: ActiveRead) {
	return read.closed || reads.get(read.id) !== read;
}
