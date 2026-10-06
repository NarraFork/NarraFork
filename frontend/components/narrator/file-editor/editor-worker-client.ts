import type { DiffLine } from "@shared/pretext-layout/diff-core";
import type { editor } from "monaco-editor";
import { createEditorLocalId } from "./editor-local-id";
import {
	bufferToText,
	type EditDescriptor,
	EDITOR_WORKER_LIMITS as L,
	metadataSize,
	type ReplacePlan,
	type SearchOptions,
	type SearchPage,
	type TextEdit,
	type TextMatch,
	textToBuffer,
	type WorkerCommand,
	type WorkerReady,
	type WorkerReply,
	type WorkerRequest,
	type WorkerValue,
} from "./editor-worker-protocol";

export interface EditorTextSnapshot {
	readonly revision: number;
	readonly alternativeVersionId: number;
	readonly length: number;
	/** Single-pass, bounded reader over the immutable Monaco snapshot. */
	read(): string | null;
}
export function captureEditorSnapshot(model: editor.ITextModel): EditorTextSnapshot {
	const revision = model.getVersionId();
	const alternativeVersionId = model.getAlternativeVersionId();
	const length = model.getValueLength();
	if (length > L.textLength) throw new Error("EDITOR_TEXT_LIMIT");
	const snapshot = model.createSnapshot(false);
	let pending = "";
	let offset = 0;
	return Object.freeze({
		revision,
		alternativeVersionId,
		length,
		read(): string | null {
			if (offset >= pending.length) {
				pending = snapshot.read() ?? "";
				offset = 0;
			}
			if (!pending) return null;
			const chunk = pending.slice(offset, offset + L.chunkBytes / 2);
			offset += chunk.length;
			return chunk;
		},
	});
}

const aborted = () => new DOMException("Operation cancelled", "AbortError");
interface Slot {
	worker: Worker | null;
	busy: boolean;
	docId: string;
	revision: number;
	length: number;
	reserved: number;
}
interface PendingTask<T = unknown> {
	key: string;
	bytes: number;
	signal?: AbortSignal;
	run: (slot: Slot, channel: WorkerChannel) => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
	removeAbort?: () => void;
}
function resetSlot(slot: Slot): void {
	slot.worker?.terminate();
	slot.worker = null;
	slot.docId = "";
	slot.revision = -1;
	slot.length = 0;
}

/** Exactly two application-owned workers, two queued jobs, aggregate 128MiB reservation. */
class EditorWorkerPool {
	private slots: Slot[] = Array.from({ length: L.workers }, () => ({
		worker: null,
		busy: false,
		docId: "",
		revision: -1,
		length: 0,
		reserved: 0,
	}));
	private queue: PendingTask[] = [];
	run<T>(
		key: string,
		bytes: number,
		signal: AbortSignal | undefined,
		run: PendingTask<T>["run"],
	): Promise<T> {
		if (signal?.aborted) return Promise.reject(aborted());
		if (bytes > L.mirrorBytes) return Promise.reject(new Error("EDITOR_MEMORY_LIMIT"));
		return new Promise<T>((resolve, reject) => {
			const old = this.queue.findIndex((task) => task.key === key);
			if (old >= 0) {
				const [task] = this.queue.splice(old, 1);
				task.removeAbort?.();
				task.reject(aborted());
			}
			if (this.queue.length >= L.queue) {
				reject(new Error("EDITOR_WORKER_BUSY"));
				return;
			}
			const task = { key, bytes, signal, run, resolve, reject } as PendingTask;
			const cancel = () => {
				const index = this.queue.indexOf(task);
				if (index >= 0) {
					this.queue.splice(index, 1);
					task.removeAbort?.();
					reject(aborted());
				}
			};
			signal?.addEventListener("abort", cancel, { once: true });
			task.removeAbort = () => signal?.removeEventListener("abort", cancel);
			this.queue.push(task);
			this.drain();
		});
	}
	diagnostics() {
		return {
			slots: this.slots.map(({ busy, docId, revision, length, reserved }) => ({
				busy,
				docId,
				revision,
				length,
				reserved,
			})),
			queued: this.queue.map(({ key, bytes }) => ({ key, bytes })),
		};
	}
	release(docId: string): void {
		for (const slot of this.slots) if (!slot.busy && slot.docId === docId) resetSlot(slot);
	}
	private drain(): void {
		for (let index = 0; index < this.queue.length; ) {
			const task = this.queue[index];
			const slot =
				this.slots.find((entry) => !entry.busy && entry.docId === task.key) ??
				this.slots.find((entry) => !entry.busy);
			if (!slot) return;
			let otherBytes = this.slots
				.filter((entry) => entry !== slot)
				.reduce((sum, entry) => sum + (entry.busy ? entry.reserved : entry.length * 2), 0);
			if (otherBytes + task.bytes > L.mirrorBytes) {
				for (const other of this.slots) if (other !== slot && !other.busy) resetSlot(other);
				otherBytes = this.slots
					.filter((entry) => entry !== slot && entry.busy)
					.reduce((sum, entry) => sum + entry.reserved, 0);
			}
			if (otherBytes + task.bytes > L.mirrorBytes) {
				index++;
				continue;
			}
			this.queue.splice(index, 1);
			task.removeAbort?.();
			slot.busy = true;
			slot.reserved = task.bytes;
			try {
				const starting = slot.worker === null;
				slot.worker ??= new Worker(new URL("./editor-text.worker.ts", import.meta.url), {
					type: "module",
				});
				const channel = new WorkerChannel(
					slot.worker,
					() => resetSlot(slot),
					task.signal,
					starting,
				);
				const finish = () => {
					channel.dispose();
					slot.busy = false;
					slot.reserved = 0;
				};
				void task.run(slot, channel).then(
					(value) => {
						finish();
						task.resolve(value);
						this.drain();
					},
					(error) => {
						resetSlot(slot);
						finish();
						task.reject(error);
						this.drain();
					},
				);
			} catch (error) {
				resetSlot(slot);
				slot.busy = false;
				slot.reserved = 0;
				task.reject(error);
			}
		}
	}
}
const pool = new EditorWorkerPool();
const activeChannels = new Set<WorkerChannel>();
const completedChannels: ReturnType<WorkerChannel["diagnostics"]>[] = [];

/** Bounded correlation metadata only: never includes document text, queries or file paths. */
export function getEditorWorkerDiagnostics() {
	return {
		pool: pool.diagnostics(),
		active: Array.from(activeChannels, (channel) => channel.diagnostics()),
		completed: completedChannels.slice(),
	};
}

export class WorkerChannel {
	private jobId = createEditorLocalId();
	private seq = 0;
	private replySeq = 0;
	private pending = new Map<
		number,
		{
			request: WorkerRequest;
			resolve: (value: WorkerValue) => void;
			reject: (error: unknown) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private readonly startedAt = performance.now();
	private phase = "startup";
	private phaseAt = this.startedAt;
	private phaseDurations: Record<string, number> = {};
	private mirrorWorker = { decodeMs: 0, buildMs: 0, chunks: 0 };
	private clientWorkMs = { snapshotRead: 0, utf16Encode: 0, yield: 0 };
	private ignoredReplies = 0;
	private startup: Promise<void> | null = null;
	private startupResolve?: () => void;
	private startupReject?: (error: Error) => void;
	private failure: Error | null = null;
	private timer: ReturnType<typeof setTimeout>;
	private onAbort = () => this.fail(aborted());
	constructor(
		private worker: Worker,
		private terminate: () => void,
		private signal?: AbortSignal,
		awaitReady = false,
	) {
		if (awaitReady)
			this.startup = new Promise<void>((resolve, reject) => {
				this.startupResolve = resolve;
				this.startupReject = reject;
			});
		activeChannels.add(this);
		worker.addEventListener("message", this.onMessage);
		worker.addEventListener("error", this.onError);
		signal?.addEventListener("abort", this.onAbort, { once: true });
		this.timer = setTimeout(() => this.fail(new Error("EDITOR_EXPORT_TIMEOUT")), L.exportTimeout);
		if (signal?.aborted) this.onAbort();
	}
	private onError = () => this.fail(new Error("EDITOR_WORKER_ERROR"));
	private onMessage = (event: MessageEvent<WorkerReply | WorkerReady>) => {
		const reply = event.data;
		if ("type" in reply) {
			if (
				reply.type !== "ready" ||
				reply.docId !== "$worker" ||
				reply.jobId !== "$startup" ||
				reply.revision !== 0 ||
				reply.seq !== 0
			) {
				this.fail(new Error("EDITOR_PROTOCOL"));
				return;
			}
			this.startup = null;
			this.startupResolve?.();
			this.startupResolve = undefined;
			this.startupReject = undefined;
			return;
		}
		if (reply.jobId !== this.jobId) {
			this.ignoredReplies++;
			return;
		}
		const pending = this.pending.get(reply.seq);
		if (
			!pending ||
			reply.docId !== pending.request.docId ||
			reply.revision !== pending.request.revision
		)
			return;
		if (reply.seq !== this.replySeq++) {
			this.fail(new Error("EDITOR_PROTOCOL"));
			return;
		}
		this.pending.delete(reply.seq);
		clearTimeout(pending.timer);
		if (!reply.ok) {
			pending.reject(new Error(reply.error));
			this.fail(new Error(reply.error));
		} else if (
			reply.value instanceof ArrayBuffer
				? reply.value.byteLength > L.chunkBytes
				: metadataSize(reply) > L.metadataBytes
		) {
			pending.reject(new Error("EDITOR_PROTOCOL"));
			this.fail(new Error("EDITOR_PROTOCOL"));
		} else {
			if (reply.value && typeof reply.value === "object" && "mirrorStats" in reply.value) {
				this.mirrorWorker.decodeMs += reply.value.mirrorStats.decodeMs;
				this.mirrorWorker.buildMs += reply.value.mirrorStats.buildMs;
				this.mirrorWorker.chunks += reply.value.mirrorStats.chunks;
			}
			pending.resolve(reply.value);
		}
	};
	request<T extends WorkerValue>(
		docId: string,
		revision: number,
		command: WorkerCommand,
		timeout: number = L.exportTimeout,
	): Promise<T> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.startup)
			return this.startup.then(() => this.request<T>(docId, revision, command, timeout));
		const phase =
			command.type === "begin" || command.type === "edit" || command.type === "commit"
				? "mirror"
				: command.type === "search" || command.type === "replace"
					? "search"
					: command.type === "parameter"
						? "query-setup"
						: command.type === "output" || command.type === "descriptors"
							? "result"
							: command.type === "hash" || command.type === "encode" || command.type === "diff"
								? command.type
								: this.phase;
		if (phase !== this.phase) {
			const now = performance.now();
			this.phaseDurations[this.phase] = (this.phaseDurations[this.phase] ?? 0) + now - this.phaseAt;
			this.phase = phase;
			this.phaseAt = now;
		}
		const request = {
			...command,
			docId,
			revision,
			jobId: this.jobId,
			seq: this.seq++,
		} as WorkerRequest;
		if (
			metadataSize(command.type === "chunk" ? { ...request, data: undefined } : request) >
			L.metadataBytes
		)
			return Promise.reject(new Error("EDITOR_METADATA_LIMIT"));
		if (command.type === "chunk" && command.data.byteLength > L.chunkBytes)
			return Promise.reject(new Error("EDITOR_PROTOCOL"));
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() =>
					this.fail(
						new Error(
							timeout === L.searchTimeout ? "EDITOR_SEARCH_TIMEOUT" : "EDITOR_EXPORT_TIMEOUT",
						),
					),
				timeout,
			);
			this.pending.set(request.seq, {
				request,
				resolve: resolve as (value: WorkerValue) => void,
				reject,
				timer,
			});
			try {
				this.worker.postMessage(request, command.type === "chunk" ? [command.data] : []);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error("EDITOR_WORKER_ERROR"));
			}
		});
	}
	recordClientWork(kind: "snapshotRead" | "utf16Encode" | "yield", ms: number): void {
		this.clientWorkMs[kind] += ms;
	}
	diagnostics() {
		return {
			jobId: this.jobId,
			ageMs: Math.round(performance.now() - this.startedAt),
			sent: this.seq,
			acknowledged: this.replySeq,
			ignoredReplies: this.ignoredReplies,
			failure: this.failure?.message ?? null,
			phase: this.phase,
			waitingForReady: this.startup !== null,
			mirrorWorker: { ...this.mirrorWorker },
			clientWorkMs: { ...this.clientWorkMs },
			phaseMs: {
				...this.phaseDurations,
				[this.phase]: (this.phaseDurations[this.phase] ?? 0) + performance.now() - this.phaseAt,
			},
			pending: Array.from(this.pending.values())
				.slice(0, L.inFlight)
				.map(({ request }) => ({
					type: request.type,
					docId: request.docId,
					revision: request.revision,
					seq: request.seq,
				})),
		};
	}
	private fail(error: Error): void {
		if (this.failure) return;
		if (error.message.endsWith("_TIMEOUT"))
			console.warn("[editor-worker] task timed out", this.diagnostics());
		this.failure = error;
		this.startupReject?.(error);
		this.startupReject = undefined;
		this.startupResolve = undefined;
		this.terminate();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
	dispose(): void {
		if (activeChannels.delete(this)) {
			completedChannels.push(this.diagnostics());
			if (completedChannels.length > 16) completedChannels.shift();
		}
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.onAbort);
		this.worker.removeEventListener("message", this.onMessage);
		this.worker.removeEventListener("error", this.onError);
	}
}

async function sendReader(
	channel: WorkerChannel,
	docId: string,
	revision: number,
	read: () => string | null,
): Promise<void> {
	let yieldAt = performance.now();
	let ended = false;
	const inFlight = new Set<Promise<void>>();
	while (!ended || inFlight.size) {
		while (!ended && inFlight.size < L.inFlight) {
			const readAt = performance.now();
			const chunk = read();
			channel.recordClientWork("snapshotRead", performance.now() - readAt);
			if (chunk === null) {
				ended = true;
				break;
			}
			const encodeAt = performance.now();
			const data = textToBuffer(chunk);
			channel.recordClientWork("utf16Encode", performance.now() - encodeAt);
			const pending: Promise<void> = channel
				.request(docId, revision, { type: "chunk", data })
				.then(() => {
					inFlight.delete(pending);
				});
			inFlight.add(pending);
		}
		if (!inFlight.size) return;
		// Refill the same bounded window after each ACK, not after the slowest of four.
		// No more than four binary messages can be waiting for acknowledgements.
		await Promise.race(inFlight);
		if (performance.now() - yieldAt >= 8) {
			const start = performance.now();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			channel.recordClientWork("yield", performance.now() - start);
			yieldAt = performance.now();
		}
	}
}
async function sendSnapshot(
	channel: WorkerChannel,
	docId: string,
	snapshot: EditorTextSnapshot,
): Promise<void> {
	await channel.request(docId, snapshot.revision, {
		type: "begin",
		mode: "snapshot",
		baseRevision: -1,
		length: snapshot.length,
	});
	await sendReader(channel, docId, snapshot.revision, () => snapshot.read());
	await channel.request(docId, snapshot.revision, { type: "commit" });
}
async function receiveOutput(
	channel: WorkerChannel,
	docId: string,
	revision: number,
	count: number,
): Promise<ArrayBuffer[]> {
	if (!Number.isSafeInteger(count) || count < 0 || count > L.utf8Bytes)
		throw new Error("EDITOR_PROTOCOL");
	const buffers: ArrayBuffer[] = [];
	let bytes = 0;
	for (let index = 0; index < count; index += L.inFlight) {
		const batch = await Promise.all(
			Array.from({ length: Math.min(L.inFlight, count - index) }, (_, n) =>
				channel.request<ArrayBuffer>(docId, revision, { type: "output", index: index + n }),
			),
		);
		for (const buffer of batch) {
			bytes += buffer.byteLength;
			if (bytes > L.utf8Bytes) throw new Error("EDITOR_UTF8_LIMIT");
			buffers.push(buffer);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	return buffers;
}

const encodedSnapshotHashes = new WeakMap<Blob, string>();
export function getEncodedEditorSnapshotHash(blob: Blob): string | null {
	return encodedSnapshotHashes.get(blob) ?? null;
}

export function encodeEditorSnapshot(
	snapshot: EditorTextSnapshot,
	signal?: AbortSignal,
): Promise<Blob> {
	const docId = `export-${createEditorLocalId()}`;
	return pool.run(docId, Math.max(1024, snapshot.length * 6), signal, async (slot, channel) => {
		await sendSnapshot(channel, docId, snapshot);
		const result = await channel.request<{ chunks: number; bytes: number; digest: string }>(
			docId,
			snapshot.revision,
			{ type: "encode" },
		);
		const buffers = await receiveOutput(channel, docId, snapshot.revision, result.chunks);
		const blob = new Blob(buffers, { type: "application/octet-stream" });
		if (
			blob.size !== result.bytes ||
			blob.size > L.utf8Bytes ||
			!/^[a-f0-9]{64}$/.test(result.digest)
		)
			throw new Error("EDITOR_PROTOCOL");
		encodedSnapshotHashes.set(blob, result.digest);
		resetSlot(slot);
		return blob;
	});
}

export function hashEditorSnapshot(
	snapshot: EditorTextSnapshot,
	signal?: AbortSignal,
): Promise<string> {
	const docId = `hash-${createEditorLocalId()}`;
	return pool.run(docId, Math.max(1024, snapshot.length * 4), signal, async (slot, channel) => {
		await sendSnapshot(channel, docId, snapshot);
		const digest = await channel.request<string>(docId, snapshot.revision, { type: "hash" });
		if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("EDITOR_PROTOCOL");
		resetSlot(slot);
		return digest;
	});
}

export interface EditorConflictDiff {
	lines: DiffLine[];
	truncated: boolean;
}

/** Bounded conflict preview only; never use this truncated projection as saved content. */
export function computeEditorConflictDiff(
	oldText: string,
	newText: string,
	signal?: AbortSignal,
): Promise<EditorConflictDiff> {
	if (oldText.length > L.conflictInputLength || newText.length > L.conflictInputLength)
		return Promise.reject(new Error("EDITOR_TEXT_LIMIT"));
	const docId = `diff-${createEditorLocalId()}`;
	let part = 0;
	const snapshot: EditorTextSnapshot = {
		revision: 1,
		alternativeVersionId: 1,
		length: oldText.length + newText.length,
		read: () => {
			part++;
			return part === 1 ? oldText : part === 2 ? newText : null;
		},
	};
	return pool.run(docId, 8 * 1024 * 1024, signal, async (slot, channel) => {
		await sendSnapshot(channel, docId, snapshot);
		const result = await channel.request<{ chunks: number; bytes: number }>(
			docId,
			1,
			{ type: "diff", split: oldText.length },
			L.searchTimeout,
		);
		if (result.bytes > L.conflictOutputBytes) throw new Error("EDITOR_PROTOCOL");
		const buffers = await receiveOutput(channel, docId, 1, result.chunks);
		const blob = new Blob(buffers);
		if (blob.size !== result.bytes) throw new Error("EDITOR_PROTOCOL");
		const diff = JSON.parse(await blob.text()) as EditorConflictDiff;
		if (
			!Array.isArray(diff.lines) ||
			diff.lines.length > L.conflictLines ||
			typeof diff.truncated !== "boolean"
		)
			throw new Error("EDITOR_PROTOCOL");
		if (signal?.aborted) throw aborted();
		resetSlot(slot);
		return diff;
	});
}

interface ChangeBatch {
	revision: number;
	baseRevision: number;
	length: number;
	edits: TextEdit[];
}
export class EditorSearchClient {
	private readonly docId = `search-${createEditorLocalId()}`;
	private pending: ChangeBatch[] = [];
	private pendingLength = 0;
	private lastRevision: number;
	private disposed = false;
	private readonly lifecycle = new AbortController();
	private listener: { dispose(): void };
	constructor(private model: editor.ITextModel) {
		this.lastRevision = model.getVersionId();
		this.listener = model.onDidChangeContent((event) => {
			const edits = event.changes
				.map((change) => ({
					offset: change.rangeOffset,
					length: change.rangeLength,
					text: change.text,
				}))
				.sort((a, b) => a.offset - b.offset);
			this.pending.push({
				revision: event.versionId,
				baseRevision: this.lastRevision,
				length: model.getValueLength(),
				edits,
			});
			this.lastRevision = event.versionId;
			this.pendingLength += edits.reduce((sum, edit) => sum + edit.text.length + 32, 0);
			if (
				this.pendingLength > L.textLength ||
				this.pending.length > 1000 ||
				event.isFlush ||
				event.isEolChange
			) {
				this.pending = [];
				this.pendingLength = 0;
			}
		});
	}
	private async sync(slot: Slot, channel: WorkerChannel): Promise<number> {
		if (this.disposed || this.model.isDisposed()) throw aborted();
		const revision = this.model.getVersionId();
		if (slot.docId === this.docId && slot.revision === revision) return revision;
		const changes = this.pending.filter(
			(change) => change.revision > slot.revision && change.revision <= revision,
		);
		if (slot.docId !== this.docId || !changes.length || changes[0].baseRevision !== slot.revision) {
			const snapshot = captureEditorSnapshot(this.model);
			await sendSnapshot(channel, this.docId, snapshot);
			slot.revision = snapshot.revision;
			slot.length = snapshot.length;
		} else {
			for (const change of changes) {
				await channel.request(this.docId, change.revision, {
					type: "begin",
					mode: "changes",
					baseRevision: change.baseRevision,
					length: change.length,
				});
				for (const edit of change.edits) {
					await channel.request(this.docId, change.revision, {
						type: "edit",
						edit: { offset: edit.offset, length: edit.length, textLength: edit.text.length },
					});
					let offset = 0;
					await sendReader(channel, this.docId, change.revision, () => {
						if (offset >= edit.text.length) return null;
						const chunk = edit.text.slice(offset, offset + L.chunkBytes / 2);
						offset += chunk.length;
						return chunk;
					});
				}
				await channel.request(this.docId, change.revision, { type: "commit" });
				slot.revision = change.revision;
				slot.length = change.length;
			}
		}
		slot.docId = this.docId;
		this.pending = this.pending.filter((change) => change.revision > slot.revision);
		this.pendingLength = this.pending.reduce(
			(sum, change) => sum + change.edits.reduce((size, edit) => size + edit.text.length + 32, 0),
			0,
		);
		return slot.revision;
	}
	private run<T>(
		signal: AbortSignal | undefined,
		action: (channel: WorkerChannel, revision: number) => Promise<T>,
	): Promise<T> {
		signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
		const revision = this.model.getVersionId();
		return pool.run(
			this.docId,
			Math.max(1024, this.model.getValueLength() * 6),
			signal,
			async (slot, channel) => {
				const synced = await this.sync(slot, channel);
				if (synced !== revision) throw new Error("EDITOR_STALE");
				const result = await action(channel, synced);
				if (
					this.disposed ||
					this.model.isDisposed() ||
					this.model.getVersionId() !== synced ||
					signal?.aborted
				)
					throw new Error("EDITOR_STALE");
				return result;
			},
		);
	}
	private async parameter(
		channel: WorkerChannel,
		revision: number,
		name: "query" | "replacement",
		text: string,
	): Promise<void> {
		if (text.length > L.queryLength) throw new Error("EDITOR_QUERY_LIMIT");
		await channel.request(this.docId, revision, { type: "parameter", name, length: text.length });
		await channel.request(this.docId, revision, { type: "chunk", data: textToBuffer(text) });
	}
	search(
		options: SearchOptions,
		anchor = 0,
		backwards = false,
		signal?: AbortSignal,
	): Promise<SearchPage> {
		return this.run(signal, async (channel, revision) => {
			await this.parameter(channel, revision, "query", options.query);
			return channel.request<SearchPage>(
				this.docId,
				revision,
				{ type: "search", options: { ...options, query: "" }, anchor, backwards, selectAll: false },
				L.searchTimeout,
			);
		});
	}
	async selectAll(options: SearchOptions, signal?: AbortSignal): Promise<TextMatch[]> {
		return this.run(signal, async (channel, revision) => {
			await this.parameter(channel, revision, "query", options.query);
			const result = await channel.request<{
				count: number;
				length: number;
				utf8Bytes: number;
				chunks: number;
			}>(
				this.docId,
				revision,
				{
					type: "search",
					options: { ...options, query: "" },
					anchor: 0,
					backwards: false,
					selectAll: true,
				},
				L.searchTimeout,
			);
			if (result.count > L.selectAll) throw new Error("EDITOR_SELECT_LIMIT");
			return this.descriptors(channel, revision, result.count);
		});
	}
	private async descriptors(
		channel: WorkerChannel,
		revision: number,
		count: number,
	): Promise<EditDescriptor[]> {
		const edits: EditDescriptor[] = [];
		for (let start = 0; start < count; start += 128)
			edits.push(
				...(await channel.request<EditDescriptor[]>(this.docId, revision, {
					type: "descriptors",
					start,
				})),
			);
		if (edits.length !== count) throw new Error("EDITOR_PROTOCOL");
		return edits;
	}
	replace(
		options: SearchOptions,
		replacement: string,
		all: boolean,
		anchor = 0,
		signal?: AbortSignal,
	): Promise<ReplacePlan> {
		return this.run(signal, async (channel, revision) => {
			await this.parameter(channel, revision, "query", options.query);
			await this.parameter(channel, revision, "replacement", replacement);
			const result = await channel.request<{
				count: number;
				length: number;
				utf8Bytes: number;
				chunks: number;
			}>(
				this.docId,
				revision,
				{ type: "replace", options: { ...options, query: "" }, replacement: "", all, anchor },
				L.searchTimeout,
			);
			if (
				result.count > L.replaceAll ||
				result.length > L.textLength ||
				result.utf8Bytes > L.utf8Bytes
			)
				throw new Error("EDITOR_REPLACE_LIMIT");
			const descriptors = await this.descriptors(channel, revision, result.count);
			const buffers = await receiveOutput(channel, this.docId, revision, result.chunks);
			const texts: string[] = [];
			let yieldAt = performance.now();
			for (let index = 0; index < buffers.length; index++) {
				if (signal?.aborted) throw aborted();
				texts.push(bufferToText(buffers[index]));
				buffers[index] = new ArrayBuffer(0);
				if (performance.now() - yieldAt >= 8) {
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
					yieldAt = performance.now();
				}
			}
			let chunk = 0;
			let offset = 0;
			const edits: TextEdit[] = [];
			for (const descriptor of descriptors) {
				if (signal?.aborted) throw aborted();
				let remaining = descriptor.textLength;
				const parts: string[] = [];
				while (remaining) {
					if (chunk >= texts.length) throw new Error("EDITOR_PROTOCOL");
					const part = texts[chunk].slice(offset, offset + remaining);
					parts.push(part);
					remaining -= part.length;
					offset += part.length;
					if (offset === texts[chunk].length) {
						offset = 0;
						chunk++;
					}
				}
				edits.push({ offset: descriptor.offset, length: descriptor.length, text: parts.join("") });
				if (performance.now() - yieldAt >= 8) {
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
					yieldAt = performance.now();
				}
			}
			if (chunk !== texts.length || offset) throw new Error("EDITOR_PROTOCOL");
			return { revision, edits, length: result.length, utf8Bytes: result.utf8Bytes };
		});
	}
	dispose(): void {
		this.disposed = true;
		this.lifecycle.abort();
		this.listener.dispose();
		this.pending = [];
		pool.release(this.docId);
	}
}

/** One executeEdits call and explicit undo stops; stale/readonly plans never mutate a model. */
export function applyEditorReplacePlan(
	instance: editor.IStandaloneCodeEditor,
	plan: ReplacePlan,
	readOnly: boolean,
): void {
	const model = instance.getModel();
	if (!model || model.isDisposed() || model.getVersionId() !== plan.revision)
		throw new Error("EDITOR_STALE");
	if (readOnly || instance.getRawOptions().readOnly) throw new Error("EDITOR_READ_ONLY");
	if (
		plan.edits.length > L.replaceAll ||
		plan.length > L.textLength ||
		plan.utf8Bytes > L.utf8Bytes
	)
		throw new Error("EDITOR_REPLACE_LIMIT");
	let end = 0;
	let length = model.getValueLength();
	const edits = plan.edits.map((edit) => {
		if (
			!Number.isSafeInteger(edit.offset) ||
			!Number.isSafeInteger(edit.length) ||
			edit.offset < end ||
			edit.length < 0 ||
			edit.offset + edit.length > model.getValueLength()
		)
			throw new Error("EDITOR_PROTOCOL");
		end = edit.offset + edit.length;
		length += edit.text.length - edit.length;
		const start = model.getPositionAt(edit.offset);
		const stop = model.getPositionAt(end);
		return {
			range: {
				startLineNumber: start.lineNumber,
				startColumn: start.column,
				endLineNumber: stop.lineNumber,
				endColumn: stop.column,
			},
			text: edit.text,
			forceMoveMarkers: true,
		};
	});
	if (length !== plan.length || length < 0 || length > L.textLength)
		throw new Error("EDITOR_TEXT_LIMIT");
	if (!edits.length) return;
	instance.pushUndoStop();
	if (!instance.executeEdits("narrafork.search", edits)) throw new Error("EDITOR_REPLACE_FAILED");
	instance.pushUndoStop();
}
