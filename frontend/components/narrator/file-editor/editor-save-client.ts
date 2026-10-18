import {
	EDITOR_IO_TIMEOUT_MS,
	EDITOR_TRANSFER_CHUNK_BYTES,
	EDITOR_UPLOAD_CHUNK_BYTES,
} from "@shared/editor-document";
import { EditorAttemptSpool } from "./editor-attempt-spool";
import type { EditorRawSaveFormat, EditorRawSeal } from "./editor-save-codec";
import type { EditorTextSnapshot } from "./editor-worker-client";
export interface EditorRawSnapshot extends EditorTextSnapshot {
	readonly modelLifetime: string;
	readonly rawFormat: EditorRawSaveFormat;
}
let active = 0,
	started = 0;
export const editorSaveDiagnostics = () => ({
	activeWorkers: active,
	startedWorkers: started,
	limit: 2,
});
export function encodeEditorRawSnapshot(snapshot: EditorRawSnapshot, signal: AbortSignal) {
	return runEditorRawSnapshot(snapshot, signal, true) as Promise<EditorAttemptSpool>;
}
export function inspectEditorRawSnapshot(snapshot: EditorRawSnapshot, signal: AbortSignal) {
	return runEditorRawSnapshot(snapshot, signal, false) as Promise<EditorRawSeal>;
}
async function runEditorRawSnapshot(
	snapshot: EditorRawSnapshot,
	signal: AbortSignal,
	store: boolean,
): Promise<EditorAttemptSpool | EditorRawSeal> {
	if (active >= 2) throw new Error("EDITOR_ENCODER_BUSY");
	signal.throwIfAborted();
	active++;
	let worker: Worker | undefined, spool: EditorAttemptSpool | undefined;
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(EDITOR_IO_TIMEOUT_MS)]);
	try {
		if (store)
			spool = await EditorAttemptSpool.create(
				snapshot.revision,
				snapshot.modelLifetime,
				undefined,
				undefined,
				bounded,
			);
		bounded.throwIfAborted();
		worker = new Worker(new URL("./editor-save.worker.ts", import.meta.url), { type: "module" });
		started++;
		const call = (input: unknown) =>
			new Promise<{ bytes?: Uint8Array<ArrayBuffer>; seal?: EditorRawSeal }>((resolve, reject) => {
				const abort = () => {
					clean();
					reject(bounded.reason);
				};
				const clean = () => {
					bounded.removeEventListener("abort", abort);
					if (worker) {
						worker.onmessage = null;
						worker.onerror = null;
					}
				};
				if (!worker || bounded.aborted) {
					reject(bounded.reason);
					return;
				}
				worker.onmessage = (event) => {
					clean();
					if (event.data.error) reject(new Error(event.data.error));
					else resolve(event.data);
				};
				worker.onerror = (event) => {
					clean();
					reject(new Error(event.message));
				};
				bounded.addEventListener("abort", abort, { once: true });
				worker.postMessage(input);
			});
		await call({ format: snapshot.rawFormat });
		let consumed = 0,
			pending = "",
			inputOffset = 0,
			ended = false;
		// Snapshot readers have no promised minimum chunk size.
		// Batch only one bounded input window, never a full intermediate document.
		const readBatch = () => {
			const parts: string[] = [];
			let length = 0;
			while (length < EDITOR_TRANSFER_CHUNK_BYTES / 2 && !ended) {
				if (inputOffset >= pending.length) {
					const next = snapshot.read();
					if (next === null) {
						ended = true;
						break;
					}
					if (!next.length) throw new Error("EDITOR_SNAPSHOT_LENGTH");
					pending = next;
					inputOffset = 0;
				}
				const count = Math.min(
					pending.length - inputOffset,
					EDITOR_TRANSFER_CHUNK_BYTES / 2 - length,
				);
				parts.push(pending.slice(inputOffset, inputOffset + count));
				inputOffset += count;
				length += count;
			}
			return length ? parts.join("") : null;
		};
		let packed = new Uint8Array(store ? EDITOR_UPLOAD_CHUNK_BYTES : 0),
			packedBytes = 0;
		for (;;) {
			bounded.throwIfAborted();
			const text = readBatch();
			if (text !== null) {
				consumed += text.length;
				if (consumed > snapshot.length) throw new Error("EDITOR_SNAPSHOT_LENGTH");
			} else if (consumed !== snapshot.length) throw new Error("EDITOR_SNAPSHOT_LENGTH");
			const result = await call({ text: text ?? "", eof: text === null });
			if (result.bytes && spool)
				for (let offset = 0; offset < result.bytes.length; ) {
					const count = Math.min(packed.length - packedBytes, result.bytes.length - offset);
					packed.set(result.bytes.subarray(offset, offset + count), packedBytes);
					offset += count;
					packedBytes += count;
					if (packedBytes === packed.length) {
						await spool.append(packed);
						packed = new Uint8Array(EDITOR_UPLOAD_CHUNK_BYTES);
						packedBytes = 0;
					}
				}
			if (text === null) {
				if (!result.seal) throw new Error("EDITOR_ENCODER_INCOMPLETE");
				if (spool && packedBytes) await spool.append(packed.slice(0, packedBytes));
				return spool ? spool.finish(result.seal) : result.seal;
			}
		}
	} catch (error) {
		await spool?.dispose();
		throw error;
	} finally {
		worker?.terminate();
		active--;
	}
}
