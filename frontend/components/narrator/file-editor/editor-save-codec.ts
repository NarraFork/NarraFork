import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	EDITOR_DOCUMENT_MAX_CHARS,
	EDITOR_FILE_MAX_BYTES,
	type EditorBom,
	type EditorRawEncoding,
	type EditorRawSeal,
} from "@shared/editor-document";
import { editorSignature } from "@shared/editor-stream-codec";
import { editorEolText } from "./editor-format";
import { type EolRoot, eolTags } from "./editor-format-rope";

export interface EditorRawSaveFormat {
	root: EolRoot;
	encoding: EditorRawEncoding;
	bom: EditorBom;
}
export type { EditorRawSeal } from "@shared/editor-document";
/** Worker-only: immutable snapshot input, no search mirror, one bounded output at a time. */
export class EditorSaveCodec {
	private raw = sha256.create();
	private text = sha256.create();
	private format = sha256.create();
	private tags: Generator<1 | 2 | 3>;
	private high = "";
	private signaturePrefix: number[] | undefined = [];
	private length = 0;
	private newlines = 0;
	private bytes = 0;
	private started = false;
	private ended = false;
	private encoder?: { write(text: string): Uint8Array; end(): Uint8Array | undefined };
	private constructor(readonly source: EditorRawSaveFormat) {
		this.tags = eolTags(source.root);
	}
	static async create(source: EditorRawSaveFormat) {
		const codec = new EditorSaveCodec(source);
		const expected = { utf8: "utf-8", utf16le: "utf-16le", utf16be: "utf-16be" } as const;
		if (source.bom !== "none" && expected[source.bom] !== source.encoding)
			throw new Error("EDITOR_ENCODING_SIGNATURE");
		if (source.encoding === "gbk" || source.encoding === "gb18030") {
			// iconv-lite is already a shipped dependency. Its Buffer shim stays in this Worker.
			const { getEncoder } = await import("iconv-lite");
			codec.encoder = getEncoder(source.encoding, { addBOM: false });
		}
		return codec;
	}
	push(input: string, eof = false): Uint8Array<ArrayBuffer> {
		if (this.ended || input.length > 64 * 1024) throw new Error("EDITOR_ENCODER_INPUT");
		this.length += input.length;
		if (this.length > EDITOR_DOCUMENT_MAX_CHARS) throw new Error("EDITOR_TEXT_LIMIT");
		input = this.high + input;
		this.high = "";
		if (
			!eof &&
			input.length &&
			input.charCodeAt(input.length - 1) >= 0xd800 &&
			input.charCodeAt(input.length - 1) <= 0xdbff
		) {
			this.high = input.slice(-1);
			input = input.slice(0, -1);
		}
		for (let i = 0; i < input.length; i++) {
			const unit = input.charCodeAt(i);
			if (unit === 0 || unit === 13) throw new Error("EDITOR_ENCODER_TEXT");
			if (unit >= 0xd800 && unit <= 0xdbff) {
				const low = input.charCodeAt(++i);
				if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error("EDITOR_INVALID_UNICODE");
			} else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("EDITOR_INVALID_UNICODE");
		}
		this.text.update(new TextEncoder().encode(input));
		const tags = new Uint8Array(input.length);
		let tagCount = 0;
		const restored = input.replace(/\n/g, () => {
			const next = this.tags.next();
			if (next.done) throw new Error("EDITOR_FORMAT_MISMATCH");
			this.newlines++;
			tags[tagCount++] = next.value;
			return editorEolText(next.value);
		});
		this.format.update(tags.subarray(0, tagCount));
		let text = restored;
		if (!this.started) {
			this.started = true;
			if (this.source.bom !== "none") text = `\ufeff${text}`;
		}
		let output: Uint8Array<ArrayBuffer>;
		if (this.encoder) output = Uint8Array.from(this.encoder.write(text));
		else if (this.source.encoding === "utf-8") output = new TextEncoder().encode(text);
		else {
			output = new Uint8Array(text.length * 2);
			const view = new DataView(output.buffer);
			for (let i = 0; i < text.length; i++)
				view.setUint16(i * 2, text.charCodeAt(i), this.source.encoding === "utf-16le");
		}
		// Reject lossy '?' substitution and differences between WHATWG and legacy maps.
		if (
			new TextDecoder(this.source.encoding, { fatal: true, ignoreBOM: true }).decode(output) !==
			text
		)
			throw new Error("EDITOR_ENCODING_UNREPRESENTABLE");
		if (this.signaturePrefix) {
			for (let i = 0; i < output.length && this.signaturePrefix.length < 3; i++)
				this.signaturePrefix.push(output[i]);
			if (this.signaturePrefix.length === 3 || eof) {
				// A newly inserted leading U+FEFF cannot silently turn a BOM-less file
				// into a signed file (or disappear as text when the result is decoded).
				if (editorSignature(Uint8Array.from(this.signaturePrefix)) !== this.source.bom)
					throw new Error("EDITOR_ENCODING_SIGNATURE");
				this.signaturePrefix = undefined;
			}
		}
		this.bytes += output.length;
		if (this.bytes > EDITOR_FILE_MAX_BYTES) throw new Error("EDITOR_RAW_LIMIT");
		this.raw.update(output);
		if (eof) {
			if (
				this.high ||
				!this.tags.next().done ||
				this.newlines !== this.source.root.count ||
				this.encoder?.end()?.length
			)
				throw new Error("EDITOR_FORMAT_MISMATCH");
			this.ended = true;
		}
		return output;
	}
	finish(): EditorRawSeal {
		if (!this.ended) throw new Error("EDITOR_ENCODER_INCOMPLETE");
		return {
			protocol: "raw-v2",
			hashKind: "raw-sha256",
			bytes: this.bytes,
			rawDigest: bytesToHex(this.raw.digest()),
			textDigest: bytesToHex(this.text.digest()),
			formatDigest: bytesToHex(this.format.digest()),
			textLength: this.length,
			newlines: this.newlines,
		};
	}
}
