import { expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { EditorBom, EditorRawEncoding } from "@shared/editor-document";
import { EditorStreamCodec } from "@shared/editor-stream-codec";
import { encode } from "iconv-lite";
import { EditorFormatBuilder } from "./editor-format";
import { uniformEols } from "./editor-format-rope";
import { EditorSaveCodec } from "./editor-save-codec";

for (const encoding of ["utf-8", "utf-16le", "utf-16be", "gbk", "gb18030"] as EditorRawEncoding[]) {
	const boms: EditorBom[] = [
		"none",
		...(encoding.startsWith("utf")
			? [
					encoding === "utf-8"
						? ("utf8" as const)
						: encoding === "utf-16le"
							? ("utf16le" as const)
							: ("utf16be" as const),
				]
			: []),
	];
	for (const bom of boms)
		for (const eol of ["\n", "\r\n", "\r", "mixed"])
			test(`single pass ${encoding}/${bom}/${JSON.stringify(eol)} byte identity at every snapshot boundary`, async () => {
				const text = encoding === "gbk" ? "中文?\r\nx\ry\nz" : "中文🙂\r\nx\ufeff\ry\nz";
				const originalText = eol === "mixed" ? text : text.replace(/\r\n|\r|\n/g, eol);
				const source = Uint8Array.from(
					encode((bom === "none" ? "" : "\ufeff") + originalText, encoding),
				);
				for (let rawSplit = 0; rawSplit <= source.length; rawSplit++) {
					const decoder = new EditorStreamCodec(encoding),
						format = new EditorFormatBuilder();
					const first = decoder.push(source.subarray(0, rawSplit)),
						last = decoder.push(source.subarray(rawSplit), true);
					format.push(first.tags);
					format.push(last.tags);
					const normalized = first.text + last.text,
						metadata = decoder.finish(),
						root = format.finish(metadata.lineCount - 1);
					for (let split = 0; split <= normalized.length; split++) {
						const encoder = await EditorSaveCodec.create({ encoding, bom, root });
						const a = encoder.push(normalized.slice(0, split)),
							b = encoder.push(normalized.slice(split), true);
						const bytes = new Uint8Array(a.length + b.length);
						bytes.set(a);
						bytes.set(b, a.length);
						expect(bytes).toEqual(source);
						const seal = encoder.finish();
						expect(seal.rawDigest).toBe(metadata.baseHash);
						expect(seal.textDigest).toBe(metadata.textDigest);
					}
				}
			});
}
test("empty documents, signature-only files and body U+FEFF preserve exactly one file signature", async () => {
	for (const encoding of ["utf-8", "utf-16le", "utf-16be"] as const)
		for (const text of ["", "\ufeff", "\ufeff\ufeff"]) {
			const bytes = Uint8Array.from(encode(text, encoding)),
				decoder = new EditorStreamCodec(encoding),
				decoded = decoder.push(bytes, true),
				metadata = decoder.finish();
			const codec = await EditorSaveCodec.create({
				root: uniformEols(1, 0),
				encoding,
				bom: metadata.bom,
			});
			expect(codec.push(decoded.text, true)).toEqual(bytes);
			expect(codec.finish().rawDigest).toBe(metadata.baseHash);
		}
});
test("a newly inserted leading U+FEFF cannot silently change a BOM-less file signature", async () => {
	for (const encoding of ["utf-8", "utf-16le", "utf-16be"] as const) {
		const codec = await EditorSaveCodec.create({ root: uniformEols(1, 0), encoding, bom: "none" });
		expect(() => codec.push("\ufeffbody", true)).toThrow("EDITOR_ENCODING_SIGNATURE");
		expect(() => codec.finish()).toThrow("EDITOR_ENCODER_INCOMPLETE");
	}
});
test("GBK cannot silently substitute or switch UTF8, invalid Unicode never completes", async () => {
	for (const text of ["🙂", "\ud800", "\udc00", "\ud800x"]) {
		const codec = await EditorSaveCodec.create({
			root: uniformEols(1, 0),
			encoding: "gbk",
			bom: "none",
		});
		expect(() => codec.push(text, true)).toThrow();
		expect(() => codec.finish()).toThrow("EDITOR_ENCODER_INCOMPLETE");
	}
});
test("output growth over 20MiB fails before seal and exact boundary succeeds", async () => {
	const codec = await EditorSaveCodec.create({
		root: uniformEols(1, 0),
		encoding: "utf-16le",
		bom: "none",
	});
	for (let i = 0; i < 320; i++) codec.push("x".repeat(32768));
	expect(() => codec.push("x", true)).toThrow("EDITOR_RAW_LIMIT");
	const exact = await EditorSaveCodec.create({
		root: uniformEols(1, 0),
		encoding: "utf-8",
		bom: "none",
	});
	for (let i = 0; i < 320; i++) exact.push("x".repeat(65536));
	exact.push("", true);
	expect(exact.finish().bytes).toBe(20 * 1024 * 1024);
});
test("format digest distinguishes identical LF model text with different separators", async () => {
	const a = await EditorSaveCodec.create({
			root: uniformEols(1, 1),
			encoding: "utf-8",
			bom: "none",
		}),
		b = await EditorSaveCodec.create({ root: uniformEols(2, 1), encoding: "utf-8", bom: "none" });
	a.push("x\ny", true);
	b.push("x\ny", true);
	const left = a.finish(),
		right = b.finish();
	expect(left.textDigest).toBe(right.textDigest);
	expect(left.rawDigest).not.toBe(right.rawDigest);
	expect(left.formatDigest).toBe(bytesToHex(sha256(Uint8Array.of(1))));
});
