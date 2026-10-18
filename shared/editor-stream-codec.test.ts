import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import iconv from "iconv-lite";
import { EDITOR_FILE_MAX_BYTES, type EditorRawEncoding } from "./editor-document";
import {
	assertEditorRawMetadata,
	EditorStreamCodec,
	editorRawEncoding,
} from "./editor-stream-codec";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
for (const encoding of ["utf-8", "utf-16le", "utf-16be", "gbk", "gb18030"] as const) {
	for (const bom of encoding.startsWith("utf-") ? [false, true] : [false]) {
		test(`all byte splits: ${encoding} BOM=${bom}`, () => {
			const body = encoding === "gbk" ? "首文\r\n甲\n乙\r尾" : "首\ufeff文\r\n甲\n乙\r尾😀𠀀";
			const source = (bom ? "\ufeff" : "") + body;
			const bytes = iconv.encode(source, encoding);
			for (let split = 0; split <= bytes.length; split++) {
				const codec = new EditorStreamCodec(encoding);
				const a = codec.push(bytes.subarray(0, split));
				const b = codec.push(bytes.subarray(split), true);
				const text = body.replace(/\r\n|\r/g, "\n");
				expect(a.text + b.text).toBe(text);
				const metadata = codec.finish();
				expect(metadata.baseHash).toBe(hash(bytes));
				expect(metadata.textDigest).toBe(hash(text));
				expect(metadata.textLength).toBe(text.length);
				expect(metadata.lineCount).toBe(4);
				expect(metadata.eolCounts).toEqual({ LF: 1, CRLF: 1, CR: 1 });
				expect([...a.tags, ...b.tags]).toEqual([2, 1, 3]);
			}
		});
	}
}
test("one byte feeds preserve only the non-signature UFEFF and final CR", () => {
	const bytes = new TextEncoder().encode("\ufeff\ufeff😀\r\n\r");
	const codec = new EditorStreamCodec("utf-8");
	let text = "";
	for (const byte of bytes) text += codec.push(Uint8Array.of(byte)).text;
	text += codec.push(new Uint8Array(), true).text;
	expect(text).toBe("\ufeff😀\n\n");
	expect(codec.finish().bom).toBe("utf8");
});
for (const [encoding, bytes] of [
	["utf-8", [0x61, 0xe4, 0xb8]],
	["utf-8", [0xed, 0xa0, 0x80]],
	["utf-16le", [0x61, 0, 0xff]],
	["utf-16le", [0, 0xd8]],
	["utf-16be", [0xd8, 0]],
	["gb18030", [0x81, 0x30, 0x81]],
	["gbk", [0x81]],
] as [EditorRawEncoding, number[]][])
	test(`invalid tail ${encoding}:${bytes}`, () => {
		const codec = new EditorStreamCodec(encoding);
		expect(() => codec.push(Uint8Array.from(bytes), true)).toThrow();
	});
test("unsupported encodings are rejected, not silently handled by another browser codec", () => {
	expect(() => new EditorStreamCodec("windows-1252" as EditorRawEncoding)).toThrow(
		"EDITOR_ENCODING_UNSUPPORTED",
	);
});
test("NUL, signature mismatch, oversize and incomplete EOF fail closed", () => {
	expect(() => new EditorStreamCodec("utf-8").push(Uint8Array.of(0), true)).toThrow(
		"EDITOR_BINARY",
	);
	expect(() => new EditorStreamCodec("utf-8").push(Uint8Array.of(0xff, 0xfe, 1), true)).toThrow();
	const codec = new EditorStreamCodec("utf-8");
	const block = new Uint8Array(64 * 1024).fill(65);
	for (let bytes = 0; bytes < EDITOR_FILE_MAX_BYTES; bytes += block.length) codec.push(block);
	expect(() => codec.push(Uint8Array.of(65))).toThrow("EDITOR_RAW_LIMIT");
	expect(() => new EditorStreamCodec("utf-8").finish()).toThrow("EDITOR_CODEC_INCOMPLETE");
});
test("exact raw20MiB succeeds without a source array or full decoded string", () => {
	const codec = new EditorStreamCodec("utf-8");
	const block = new Uint8Array(64 * 1024).fill(65);
	for (let bytes = 0; bytes < EDITOR_FILE_MAX_BYTES; bytes += block.length) codec.push(block);
	codec.push(new Uint8Array(), true);
	const meta = codec.finish();
	expect(meta.sourceBytes).toBe(EDITOR_FILE_MAX_BYTES);
	expect(meta.textLength).toBe(EDITOR_FILE_MAX_BYTES);
	expect(meta.maxLineLength).toBe(EDITOR_FILE_MAX_BYTES);
	expect(() => assertEditorRawMetadata(meta, { ...meta, baseHash: "a".repeat(64) })).toThrow(
		"baseHash",
	);
});
test("BOM-less UTF16 requires a strong alternating sample; legacy is explicit", () => {
	expect(editorRawEncoding(iconv.encode("hello world", "utf16le"))).toBe("utf-16le");
	expect(editorRawEncoding(iconv.encode("hello world", "utf16be"))).toBe("utf-16be");
	expect(editorRawEncoding(iconv.encode(`${"a".repeat(32)}😀\ufeff中`, "utf16le"))).toBe(
		"utf-16le",
	);
	expect(editorRawEncoding(iconv.encode(`${"a".repeat(32)}😀\ufeff中`, "utf16be"))).toBe(
		"utf-16be",
	);
	expect(editorRawEncoding(Uint8Array.of(0x81, 0x40))).toBe("utf-8");
	expect(editorRawEncoding(Uint8Array.of(0x81, 0x40), "gbk")).toBe("gbk");
});
