import { sha256 } from "@noble/hashes/sha2.js";
import {
	createDiffDocument,
	type DiffLine,
	projectDiffDocument,
} from "@shared/pretext-layout/diff-core";
import { EditorText, encodeText, replaceText, searchText } from "./editor-search-engine";
import {
	bufferToText,
	type EditDescriptor,
	EDITOR_WORKER_LIMITS as L,
	metadataSize,
	type TextEdit,
	textToBuffer,
	validateEnvelope,
	type WorkerReady,
	type WorkerReply,
	type WorkerRequest,
	type WorkerValue,
} from "./editor-worker-protocol";

/** Exported runtime is also exercised through a real Worker in integration tests. */
export class EditorWorkerRuntime {
	private document: EditorText | null = null;
	private docId = "";
	private revision = -1;
	private jobId = "";
	private sequence = -1;
	private transaction: {
		mode: "snapshot" | "changes";
		length: number;
		chunks: string[];
		edits: TextEdit[];
		current?: EditDescriptor;
		received: number;
		decodeMs: number;
		chunkCount: number;
	} | null = null;
	private output: ArrayBuffer[] = [];
	private descriptors: EditDescriptor[] = [];
	private parameters: Partial<Record<"query" | "replacement", string>> = {};
	private parameter: { name: "query" | "replacement"; length: number } | null = null;

	async handle(message: WorkerRequest): Promise<WorkerReply> {
		const envelope = {
			docId: message.docId,
			revision: message.revision,
			jobId: message.jobId,
			seq: message.seq,
		};
		try {
			validateEnvelope(message);
			const metadata = message.type === "chunk" ? { ...message, data: undefined } : message;
			if (metadataSize(metadata) > L.metadataBytes) throw new Error("EDITOR_METADATA_LIMIT");
			if (message.jobId !== this.jobId) {
				if (message.seq !== 0 || this.transaction) throw new Error("EDITOR_PROTOCOL");
				this.jobId = message.jobId;
				this.sequence = -1;
				this.output = [];
				this.descriptors = [];
				this.parameters = {};
				this.parameter = null;
			}
			if (message.seq !== this.sequence + 1) throw new Error("EDITOR_PROTOCOL");
			this.sequence = message.seq;
			let value: WorkerValue = null;
			if (message.type === "begin") {
				if (
					this.transaction ||
					!Number.isSafeInteger(message.length) ||
					message.length < 0 ||
					message.length > L.textLength
				)
					throw new Error("EDITOR_TEXT_LIMIT");
				if (
					message.mode === "changes" &&
					(!this.document ||
						this.docId !== message.docId ||
						this.revision !== message.baseRevision ||
						message.revision <= message.baseRevision)
				)
					throw new Error("EDITOR_STALE");
				if (message.mode === "snapshot") this.document = null;
				this.docId = message.docId;
				this.revision = message.revision;
				this.transaction = {
					mode: message.mode,
					length: message.length,
					chunks: [],
					edits: [],
					received: 0,
					decodeMs: 0,
					chunkCount: 0,
				};
			} else {
				if (message.docId !== this.docId || message.revision !== this.revision)
					throw new Error("EDITOR_STALE");
				switch (message.type) {
					case "parameter": {
						if (
							this.transaction ||
							this.parameter ||
							!Number.isSafeInteger(message.length) ||
							message.length < 0 ||
							message.length > L.queryLength
						)
							throw new Error("EDITOR_PROTOCOL");
						this.parameter = { name: message.name, length: message.length };
						break;
					}
					case "edit": {
						const tx = this.transaction;
						if (!tx || tx.mode !== "changes") throw new Error("EDITOR_PROTOCOL");
						this.finishEdit();
						if (
							!Number.isSafeInteger(message.edit.textLength) ||
							message.edit.textLength < 0 ||
							message.edit.textLength > L.textLength ||
							tx.edits.length >= L.replaceAll
						)
							throw new Error("EDITOR_TEXT_LIMIT");
						tx.current = message.edit;
						break;
					}
					case "chunk": {
						if (this.parameter) {
							const text = bufferToText(message.data);
							if (text.length !== this.parameter.length) throw new Error("EDITOR_PROTOCOL");
							this.parameters[this.parameter.name] = text;
							this.parameter = null;
							break;
						}
						const tx = this.transaction;
						if (!tx || (tx.mode === "changes" && !tx.current)) throw new Error("EDITOR_PROTOCOL");
						const decodeAt = performance.now();
						const text = bufferToText(message.data);
						tx.decodeMs += performance.now() - decodeAt;
						tx.chunkCount++;
						tx.received += text.length;
						if (tx.received > L.textLength) throw new Error("EDITOR_TEXT_LIMIT");
						tx.chunks.push(text);
						break;
					}
					case "commit": {
						const tx = this.transaction;
						if (!tx) throw new Error("EDITOR_PROTOCOL");
						const buildAt = performance.now();
						this.finishEdit();
						const document =
							tx.mode === "snapshot" ? new EditorText(tx.chunks) : this.document?.apply(tx.edits);
						if (!document || document.length !== tx.length) throw new Error("EDITOR_PROTOCOL");
						this.document = document;
						this.transaction = null;
						value = {
							mirrorStats: {
								decodeMs: tx.decodeMs,
								buildMs: performance.now() - buildAt,
								chunks: tx.chunkCount,
							},
						};
						break;
					}
					case "search": {
						if (!this.document || this.transaction) throw new Error("EDITOR_PROTOCOL");
						const page = await searchText(
							this.document,
							{ ...message.options, query: this.parameters.query ?? message.options.query },
							message.anchor,
							message.backwards,
							message.selectAll,
						);
						if (message.selectAll) {
							this.descriptors = page.matches.map((match) => ({ ...match, textLength: 0 }));
							value = { count: page.count, length: this.document.length, utf8Bytes: 0, chunks: 0 };
						} else value = page;
						break;
					}
					case "replace": {
						if (!this.document || this.transaction) throw new Error("EDITOR_PROTOCOL");
						const plan = await replaceText(
							this.document,
							{ ...message.options, query: this.parameters.query ?? message.options.query },
							this.parameters.replacement ?? message.replacement,
							message.all,
							message.anchor,
							this.revision,
						);
						this.descriptors = plan.edits.map(({ offset, length, text }) => ({
							offset,
							length,
							textLength: text.length,
						}));
						let pending = "";
						for (const edit of plan.edits) {
							for (let i = 0; i < edit.text.length; i += L.chunkBytes / 2) {
								pending += edit.text.slice(i, i + L.chunkBytes / 2);
								if (pending.length >= L.chunkBytes / 2) {
									this.output.push(textToBuffer(pending.slice(0, L.chunkBytes / 2)));
									pending = pending.slice(L.chunkBytes / 2);
								}
							}
						}
						if (pending) this.output.push(textToBuffer(pending));
						value = {
							count: plan.edits.length,
							length: plan.length,
							utf8Bytes: plan.utf8Bytes,
							chunks: this.output.length,
						};
						break;
					}
					case "diff": {
						if (
							!this.document ||
							this.transaction ||
							!Number.isSafeInteger(message.split) ||
							message.split < 0 ||
							message.split > L.conflictInputLength ||
							this.document.length - message.split < 0 ||
							this.document.length - message.split > L.conflictInputLength
						)
							throw new Error("EDITOR_TEXT_LIMIT");
						const oldText = this.document.sliceChunks(0, message.split).join("");
						const newText = this.document.sliceChunks(message.split, this.document.length).join("");
						const document = createDiffDocument({ oldText, newText });
						const projection = projectDiffDocument(document, {
							startRow: 0,
							limit: L.conflictLines,
						});
						const lines: DiffLine[] = [];
						let truncated =
							document.truncated ||
							projection.truncated ||
							/[^\r\n]{4001}/.test(oldText) ||
							/[^\r\n]{4001}/.test(newText);
						let bytes = 64;
						for (const projected of projection.lines) {
							const { type, content, wordChanges, oldLineNo, newLineNo } = projected;
							const line = { type, content, wordChanges, oldLineNo, newLineNo };
							bytes += metadataSize(line) + 1;
							if (bytes > L.conflictOutputBytes) {
								truncated = true;
								break;
							}
							lines.push(line);
						}
						const encoded = new TextEncoder().encode(JSON.stringify({ lines, truncated }));
						this.output = [];
						for (let offset = 0; offset < encoded.length; offset += L.chunkBytes)
							this.output.push(encoded.slice(offset, offset + L.chunkBytes).buffer);
						value = { chunks: this.output.length, bytes: encoded.length };
						break;
					}
					case "hash": {
						if (!this.document || this.transaction) throw new Error("EDITOR_PROTOCOL");
						const hash = sha256.create();
						await encodeText(this.document, false, (chunk) => {
							hash.update(chunk);
						});
						value = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join(
							"",
						);
						break;
					}
					case "encode": {
						if (!this.document || this.transaction) throw new Error("EDITOR_PROTOCOL");
						const hash = sha256.create();
						const result = await encodeText(this.document, true, (chunk) => {
							hash.update(chunk);
						});
						this.output = result.chunks.map((chunk) => chunk.buffer as ArrayBuffer);
						value = {
							chunks: this.output.length,
							bytes: result.bytes,
							digest: Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join(
								"",
							),
						};
						break;
					}
					case "descriptors": {
						if (!Number.isSafeInteger(message.start) || message.start < 0)
							throw new Error("EDITOR_PROTOCOL");
						value = this.descriptors.slice(message.start, message.start + 128);
						break;
					}
					case "output": {
						const data = this.output[message.index];
						if (!data || data.byteLength > L.chunkBytes) throw new Error("EDITOR_PROTOCOL");
						value = data;
						this.output[message.index] = new ArrayBuffer(0);
						break;
					}
					default:
						throw new Error("EDITOR_PROTOCOL");
				}
			}
			if (
				!(value instanceof ArrayBuffer) &&
				metadataSize({ ...envelope, ok: true, value }) > L.metadataBytes
			)
				throw new Error("EDITOR_METADATA_LIMIT");
			return { ...envelope, ok: true, value };
		} catch (error) {
			return {
				...envelope,
				ok: false,
				error: error instanceof Error ? error.message : "EDITOR_PROTOCOL",
			};
		}
	}
	private finishEdit(): void {
		const tx = this.transaction;
		if (!tx?.current) return;
		const text = tx.chunks.join("");
		if (text.length !== tx.current.textLength) throw new Error("EDITOR_PROTOCOL");
		tx.edits.push({ offset: tx.current.offset, length: tx.current.length, text });
		tx.chunks = [];
		tx.current = undefined;
	}
}

// A main-thread import can test the runtime without installing a global message handler.
const workerScope = globalThis as unknown as {
	document?: unknown;
	postMessage?: (message: WorkerReply | WorkerReady, transfer: Transferable[]) => void;
	onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};
if (typeof workerScope.postMessage === "function" && typeof workerScope.document === "undefined") {
	const runtime = new EditorWorkerRuntime();
	let serial = Promise.resolve();
	workerScope.onmessage = (event) => {
		serial = serial.then(async () => {
			const reply = await runtime.handle(event.data);
			workerScope.postMessage?.(
				reply,
				reply.ok && reply.value instanceof ArrayBuffer ? [reply.value] : [],
			);
		});
	};
	workerScope.postMessage(
		{ type: "ready", docId: "$worker", revision: 0, jobId: "$startup", seq: 0 },
		[],
	);
}
