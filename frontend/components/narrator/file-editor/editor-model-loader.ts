import type { EditorRawDocumentDescriptor } from "@shared/editor-document";
import {
	EDITOR_IO_TIMEOUT_MS,
	EDITOR_RAW_WINDOW_BYTES,
	EDITOR_TRANSFER_CHUNK_BYTES,
} from "@shared/editor-document";
import { assertEditorRawMetadata } from "@shared/editor-stream-codec";
import type { editor } from "monaco-editor/editor/editor.api";
import { type EditorFormat, EditorFormatBuilder } from "./editor-format";
import { createEditorLocalId } from "./editor-local-id";
import { type EditorDecodedChunk, EditorStreamDecoder } from "./editor-stream-decoder";
import { loadMonacoLanguage } from "./monaco-languages";
import { loadMonaco } from "./monaco-loader";
import { editorRawProfile } from "./monaco-profile";

// Leave useful decode credit inside the same 256 KiB window. With ASCII this
// flushes at ~112 Ki UTF-16 units; waiting for 120 Ki geometrically shrinks pulls.
export const EDITOR_MODEL_BATCH_UNITS = 96 * 1024;
export interface EditorRawCandidate {
	model: editor.ITextModel;
	format: EditorFormat;
	batches: number;
	maxBatchMs: number;
	maxQueuedBytes: number;
}
interface Decoder {
	readonly ready?: Promise<unknown>;
	push(bytes: Uint8Array<ArrayBuffer>, eof: boolean): Promise<EditorDecodedChunk>;
	dispose(): void;
}
interface LoadOptions {
	document: EditorRawDocumentDescriptor;
	path: string;
	signal: AbortSignal;
	read(
		consume: (bytes: Uint8Array<ArrayBuffer>, eof: boolean) => Promise<void>,
		credit: () => number,
	): Promise<void>;
	createModel?: () => Promise<editor.ITextModel>;
	decoder?: Decoder;
	yield?: () => Promise<void>;
}
/** Profile selection precedes both language loading and empty model construction. */
export async function createRawCandidateModel(document: EditorRawDocumentDescriptor, path: string) {
	const profile = editorRawProfile(document);
	if (profile.paged) throw new Error("EDITOR_PAGED_REQUIRED");
	const api = await loadMonaco();
	const language = profile.plaintext ? "plaintext" : (await loadMonacoLanguage(api, path)).language;
	return api.editor.createModel(
		"",
		language,
		api.Uri.from({
			scheme: "narrafork-editor",
			authority: "candidate",
			path: `/${createEditorLocalId()}`,
		}),
	);
}
/** Public Monaco API only. The candidate is never attached or searched here.
 * 120Ki UTF16 batches (~128Ki) yield after applyEdits(..., false). Remaining
 * application credit includes pending UTF16 plus worst-case raw/decoded/EOL output.
 * Model/format roots are accounted separately as candidate ownership, not transport. */
export async function loadEditorRawCandidate(options: LoadOptions): Promise<EditorRawCandidate> {
	const { document } = options;
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(EDITOR_IO_TIMEOUT_MS)]);
	if (editorRawProfile(document).paged) throw new Error("EDITOR_PAGED_REQUIRED");
	signal.throwIfAborted();
	const model = await (options.createModel?.() ?? createRawCandidateModel(document, options.path));
	let decoder: Decoder | undefined;
	const format = new EditorFormatBuilder();
	let pending = "",
		verified = false,
		batches = 0,
		maxBatchMs = 0,
		maxQueuedBytes = 0;
	const flush = async () => {
		if (!pending) return;
		signal.throwIfAborted();
		const line = model.getLineCount();
		const column = model.getLineMaxColumn(line);
		const started = performance.now();
		model.applyEdits(
			[
				{
					range: {
						startLineNumber: line,
						startColumn: column,
						endLineNumber: line,
						endColumn: column,
					},
					text: pending,
				},
			],
			false,
		);
		maxBatchMs = Math.max(maxBatchMs, performance.now() - started);
		batches++;
		pending = "";
		await (options.yield?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0)));
		signal.throwIfAborted();
	};
	try {
		// Public EndOfLineSequence.LF = 0; do not inherit the platform's CRLF default.
		model.setEOL(0);
		signal.throwIfAborted();
		decoder = options.decoder ?? new EditorStreamDecoder(document.encoding, signal);
		await decoder.ready;
		signal.throwIfAborted();
		await options.read(
			async (bytes, eof) => {
				signal.throwIfAborted();
				const inputBytes = bytes.buffer.byteLength;
				const output = await decoder?.push(bytes, eof);
				if (!output) throw new Error("EDITOR_CODEC_CLOSED");
				const queued =
					inputBytes + output.text.length * 2 + output.tags.byteLength + pending.length * 2;
				if (queued > EDITOR_RAW_WINDOW_BYTES) throw new Error("EDITOR_STREAM_WINDOW");
				maxQueuedBytes = Math.max(maxQueuedBytes, queued);
				pending += output.text;
				format.push(output.tags);
				if (pending.length >= EDITOR_MODEL_BATCH_UNITS || eof) await flush();
				if (eof) {
					if (!output.metadata) throw new Error("EDITOR_RAW_INCOMPLETE");
					assertEditorRawMetadata(document, output.metadata);
					verified = true;
				}
			},
			() =>
				Math.max(
					1,
					Math.min(
						EDITOR_TRANSFER_CHUNK_BYTES,
						Math.floor((EDITOR_RAW_WINDOW_BYTES - pending.length * 2 - 16) / 4),
					),
				),
		);
		signal.throwIfAborted();
		if (
			!verified ||
			model.getValueLength() !== document.textLength ||
			model.getLineCount() !== document.lineCount
		)
			throw new Error("EDITOR_RAW_INCOMPLETE");
		return {
			model,
			format: format.finish(document.lineCount - 1),
			batches,
			maxBatchMs,
			maxQueuedBytes,
		};
	} catch (error) {
		model.dispose();
		throw error;
	} finally {
		decoder?.dispose();
	}
}
