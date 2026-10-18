import { expect, test } from "bun:test";
import type { EditorRawDocumentDescriptor } from "@shared/editor-document";
import { EditorStreamCodec } from "@shared/editor-stream-codec";
import type { editor } from "monaco-editor/editor/editor.api";
import { EditorFormatBuilder } from "./editor-format";
import { EDITOR_MODEL_BATCH_UNITS, loadEditorRawCandidate } from "./editor-model-loader";
import { editorRawProfile } from "./monaco-profile";

function metadata(bytes: Uint8Array): EditorRawDocumentDescriptor {
	const codec = new EditorStreamCodec("utf-8");
	codec.push(bytes, true);
	return {
		...codec.finish(),
		docId: "d",
		versionHandle: "v",
		target: { deviceId: "local", path: "/file.ts" },
	};
}
function model() {
	let length = 0,
		lines = 1,
		column = 1,
		disposed = false;
	const batches: number[] = [];
	return {
		get disposed() {
			return disposed;
		},
		batches,
		model: {
			setEOL: () => {},
			getValueLength: () => length,
			getLineCount: () => lines,
			getLineMaxColumn: () => column,
			applyEdits: (edits: { text: string }[], undo: boolean) => {
				expect(undo).toBe(false);
				for (const edit of edits) {
					batches.push(edit.text.length);
					length += edit.text.length;
					for (const char of edit.text)
						if (char === "\n") {
							lines++;
							column = 1;
						} else column += char.length;
				}
			},
			dispose: () => {
				disposed = true;
			},
		} as unknown as editor.ITextModel,
	};
}
function decoder() {
	const codec = new EditorStreamCodec("utf-8");
	let disposed = false;
	return {
		get disposed() {
			return disposed;
		},
		dispose: () => {
			disposed = true;
		},
		push: async (bytes: Uint8Array, eof: boolean) => ({
			...codec.push(bytes, eof),
			metadata: eof ? codec.finish() : undefined,
		}),
	};
}
test("candidate explicitly selects LF before the first insertion even when its empty default is CRLF", async () => {
	const bytes = new TextEncoder().encode("a\nb\n"),
		target = model();
	let eol = 1;
	target.model.setEOL = (next) => {
		eol = next;
	};
	const apply = target.model.applyEdits.bind(target.model);
	target.model.applyEdits = ((...args: Parameters<typeof target.model.applyEdits>) => {
		expect(eol).toBe(0);
		return apply(...args);
	}) as typeof target.model.applyEdits;
	const candidate = await loadEditorRawCandidate({
		document: metadata(bytes),
		path: "/file.txt",
		signal: new AbortController().signal,
		decoder: decoder(),
		createModel: async () => target.model,
		read: async (consume) => {
			await consume(bytes, true);
		},
	});
	expect(candidate.model.getValueLength()).toBe(4);
	candidate.model.dispose();
});
test("bounded public applyEdits batches yield without undo, snapshot or attached view", async () => {
	const bytes = new TextEncoder().encode("行😀abc\r\n".repeat(90_000));
	const document = metadata(bytes),
		source = decoder(),
		target = model();
	let yields = 0,
		maxWindow = 0;
	const candidate = await loadEditorRawCandidate({
		document,
		path: "/file.ts",
		signal: new AbortController().signal,
		decoder: source,
		createModel: async () => target.model,
		yield: async () => {
			yields++;
		},
		read: async (consume, credit) => {
			for (let offset = 0; offset < bytes.length; ) {
				const size = Math.min(credit(), bytes.length - offset);
				maxWindow = Math.max(maxWindow, size);
				offset += size;
				await consume(bytes.slice(offset - size, offset), offset === bytes.length);
			}
		},
	});
	expect(target.batches.length).toBeGreaterThan(3);
	expect(target.batches.every((size) => size <= 128 * 1024)).toBe(true);
	expect(target.batches.slice(0, -1).every((size) => size >= EDITOR_MODEL_BATCH_UNITS)).toBe(true);
	expect(candidate.maxQueuedBytes).toBeLessThanOrEqual(256 * 1024);
	expect(yields).toBe(candidate.batches);
	expect(source.disposed).toBe(true);
	expect(maxWindow).toBeLessThanOrEqual(65536);
	expect(target.disposed).toBe(false);
	candidate.model.dispose();
});
for (const failure of [
	"hash",
	"counts",
	"format",
	"incomplete",
	"abort-middle",
	"abort-tail",
] as const)
	test(`candidate rejected without touching old model: ${failure}`, async () => {
		const bytes = new TextEncoder().encode("hello\r\n".repeat(60_000));
		let document = metadata(bytes);
		const source = decoder(),
			target = model(),
			controller = new AbortController();
		if (failure === "hash") document = { ...document, textDigest: "0".repeat(64) };
		if (failure === "counts") document = { ...document, textLength: document.textLength + 1 };
		if (failure === "format") document = { ...document, eolCounts: { LF: 60000, CRLF: 0, CR: 0 } };
		await expect(
			loadEditorRawCandidate({
				document,
				path: "/file.ts",
				signal: controller.signal,
				decoder: source,
				createModel: async () => target.model,
				read: async (consume, credit) => {
					for (let offset = 0; offset < bytes.length; ) {
						const size = Math.min(credit(), bytes.length - offset);
						offset += size;
						const eof = offset === bytes.length;
						await consume(bytes.slice(offset - size, offset), eof && failure !== "incomplete");
						if (failure === "abort-middle" || (failure === "abort-tail" && eof)) controller.abort();
						if (controller.signal.aborted) controller.signal.throwIfAborted();
					}
				},
			}),
		).rejects.toThrow();
		expect(target.disposed).toBe(true);
		expect(source.disposed).toBe(true);
	});
test("20 MiB ASCII credit never degenerates into tiny remote pulls", async () => {
	const bytes = new Uint8Array(20 * 1024 * 1024).fill(65),
		document = metadata(bytes),
		target = model();
	let requests = 0,
		minCredit = Number.POSITIVE_INFINITY;
	const started = performance.now();
	const candidate = await loadEditorRawCandidate({
		document,
		path: "/ascii.txt",
		signal: new AbortController().signal,
		decoder: decoder(),
		createModel: async () => target.model,
		yield: async () => {},
		read: async (consume, credit) => {
			for (let offset = 0; offset < bytes.length; ) {
				const allowance = credit();
				minCredit = Math.min(minCredit, allowance);
				requests++;
				const length = Math.min(allowance, bytes.length - offset);
				offset += length;
				await consume(bytes.slice(offset - length, offset), offset === bytes.length);
			}
		},
	});
	console.info(
		"EDITOR_ASCII_CREDIT",
		JSON.stringify({
			threshold: EDITOR_MODEL_BATCH_UNITS,
			bytes: bytes.length,
			requests,
			minCredit,
			batches: candidate.batches,
			maxQueuedBytes: candidate.maxQueuedBytes,
			loadMs: Math.round(performance.now() - started),
		}),
	);
	expect(requests).toBeLessThanOrEqual(Math.ceil(bytes.length / (32 * 1024)));
	expect(minCredit).toBeGreaterThanOrEqual(16 * 1024 - 16);
	expect(candidate.maxQueuedBytes).toBeLessThanOrEqual(256 * 1024);
	expect(
		target.batches
			.slice(0, -1)
			.every((size) => size >= EDITOR_MODEL_BATCH_UNITS && size <= 128 * 1024),
	).toBe(true);
	candidate.model.dispose();
}, 30_000);

test("preflight profile thresholds precede language loader/model construction", async () => {
	expect(
		editorRawProfile({ textLength: 1024 * 1024, lineCount: 2, maxLineLength: 1 }).plaintext,
	).toBe(true);
	expect(editorRawProfile({ textLength: 10, lineCount: 100000, maxLineLength: 1 }).plaintext).toBe(
		true,
	);
	expect(editorRawProfile({ textLength: 10, lineCount: 2, maxLineLength: 10001 }).plaintext).toBe(
		true,
	);
	const doc = { ...metadata(new TextEncoder().encode("")), lineCount: 1000001 };
	let created = false;
	await expect(
		loadEditorRawCandidate({
			document: doc,
			path: "/file.ts",
			signal: new AbortController().signal,
			createModel: async () => {
				created = true;
				return model().model;
			},
			read: async () => {},
		}),
	).rejects.toThrow("EDITOR_PAGED_REQUIRED");
	expect(created).toBe(false);
});
test("format root stays uniform until mixed and refuses invalid/count-mismatched data", () => {
	const format = new EditorFormatBuilder();
	format.push(Uint8Array.of(2, 2, 2));
	expect(format.finish(3)).toMatchObject({ kind: "uniform", tag: 2, count: 3 });
	format.push(Uint8Array.of(1, 3));
	expect(format.finish(5)).toMatchObject({ kind: "branch", count: 5 });
	expect(() => format.finish(4)).toThrow("EDITOR_FORMAT_MISMATCH");
	expect(() => format.push(Uint8Array.of(4))).toThrow("EDITOR_FORMAT_INVALID");
});
