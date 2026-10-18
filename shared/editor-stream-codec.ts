import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
	EDITOR_DOCUMENT_MAX_CHARS,
	EDITOR_FILE_MAX_BYTES,
	EDITOR_TRANSFER_MAX_BYTES,
	type EditorBom,
	type EditorRawEncoding,
	type EditorRawMetadata,
} from "./editor-document";

export function editorSignature(bytes: Uint8Array): EditorBom {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf8";
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16be";
	return "none";
}
/** Conservative sniff, not a whole-file charset guess. Legacy needs an explicit hint.
 * BOM-less UTF16 is accepted only with a strong ASCII/NUL alternating sample. */
export function editorRawEncoding(sample: Uint8Array, hint?: EditorRawEncoding): EditorRawEncoding {
	const bom = editorSignature(sample);
	const signed = { utf8: "utf-8", utf16le: "utf-16le", utf16be: "utf-16be" } as const;
	if (bom !== "none") {
		if (hint && hint !== signed[bom]) throw new Error("EDITOR_ENCODING_SIGNATURE");
		return signed[bom];
	}
	if (hint) return hint;
	let even = 0,
		odd = 0;
	for (let i = 0; i < sample.length; i++) if (sample[i] === 0) i % 2 ? odd++ : even++;
	if (sample.length >= 8) {
		// A low surrogate (e.g. emoji) or U+4E00 can itself contain a zero byte.
		// Keep the strong orientation signal without requiring an ASCII-only sample.
		const contrary = Math.max(1, sample.length * 0.01);
		if (odd > sample.length * 0.3 && even <= contrary) return "utf-16le";
		if (even > sample.length * 0.3 && odd <= contrary) return "utf-16be";
	}
	return "utf-8";
}

/** One bounded input -> one bounded output. No retained source or decoded body.
 * EOL tags: 1 LF, 2 CRLF, 3 CR. Only the leading encoding signature is removed. */
export class EditorStreamCodec {
	private raw = sha256.create();
	private textHash = sha256.create();
	private decoder: TextDecoder;
	private prefix: number[] = [];
	private started = false;
	private firstText = true;
	private cr = false;
	private ended = false;
	private bytes = 0;
	private length = 0;
	private utf8 = 0;
	private lineLength = 0;
	private longest = 0;
	private counts = { LF: 0, CRLF: 0, CR: 0 };
	private bom: EditorBom = "none";
	constructor(
		readonly encoding: EditorRawEncoding,
		private readonly onDecoded?: (text: string) => void,
	) {
		if (!["utf-8", "utf-16le", "utf-16be", "gbk", "gb18030"].includes(encoding))
			throw new Error("EDITOR_ENCODING_UNSUPPORTED");
		this.decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
	}
	push(bytes: Uint8Array, eof = false): { text: string; tags: Uint8Array } {
		if (this.ended) throw new Error("EDITOR_CODEC_CLOSED");
		this.bytes += bytes.length;
		if (this.bytes > EDITOR_FILE_MAX_BYTES) throw new Error("EDITOR_RAW_LIMIT");
		this.raw.update(bytes);
		let decoded = "";
		if (!this.started) {
			let offset = 0;
			while (this.prefix.length < 3 && offset < bytes.length) this.prefix.push(bytes[offset++]);
			if (this.prefix.length < 3 && !eof) return { text: "", tags: new Uint8Array() };
			const prefix = Uint8Array.from(this.prefix);
			this.bom = editorSignature(prefix);
			editorRawEncoding(prefix, this.encoding);
			decoded = this.decoder.decode(prefix, { stream: true });
			this.prefix = [];
			this.started = true;
			bytes = bytes.subarray(offset);
		}
		decoded += this.decoder.decode(bytes, { stream: !eof });
		if (decoded && this.firstText) {
			this.firstText = false;
			if (this.bom !== "none") {
				if (decoded.charCodeAt(0) !== 0xfeff) throw new Error("EDITOR_ENCODING_SIGNATURE");
				decoded = decoded.slice(1);
			}
		}
		if (decoded.includes("\0")) throw new Error("EDITOR_BINARY");
		this.onDecoded?.(decoded);
		const parts: string[] = [];
		const tags: number[] = [];
		let start = 0;
		const newline = (kind: keyof typeof this.counts) => {
			this.counts[kind]++;
			tags.push(kind === "LF" ? 1 : kind === "CRLF" ? 2 : 3);
			parts.push("\n");
		};
		if (this.cr) {
			if (decoded[0] === "\n") {
				newline("CRLF");
				start = 1;
			} else if (decoded || eof) newline("CR");
			this.cr = !decoded && !eof;
		}
		for (let i = start; i < decoded.length; i++) {
			if (decoded[i] !== "\r" && decoded[i] !== "\n") continue;
			parts.push(decoded.slice(start, i));
			if (decoded[i] === "\n") newline("LF");
			else if (decoded[i + 1] === "\n") {
				newline("CRLF");
				i++;
			} else if (i + 1 < decoded.length || eof) newline("CR");
			else this.cr = true;
			start = i + 1;
		}
		parts.push(decoded.slice(start));
		const text = parts.join("");
		this.length += text.length;
		if (this.length > EDITOR_DOCUMENT_MAX_CHARS) throw new Error("EDITOR_TEXT_LIMIT");
		const utf8 = new TextEncoder().encode(text);
		this.utf8 += utf8.length;
		if (this.utf8 > EDITOR_TRANSFER_MAX_BYTES) throw new Error("EDITOR_TRANSFER_LIMIT");
		this.textHash.update(utf8);
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 10) {
				this.longest = Math.max(this.longest, this.lineLength);
				this.lineLength = 0;
			} else this.lineLength++;
		}
		this.ended = eof;
		return { text, tags: Uint8Array.from(tags) };
	}
	finish(): EditorRawMetadata {
		if (!this.ended) throw new Error("EDITOR_CODEC_INCOMPLETE");
		const { LF, CRLF, CR } = this.counts;
		const preferredEol = CRLF > 0 && CRLF >= LF && CRLF >= CR ? "CRLF" : CR > LF ? "CR" : "LF";
		return {
			protocol: "raw-v2",
			hashKind: "raw-sha256",
			formatVersion: 1,
			baseHash: bytesToHex(this.raw.digest()),
			textDigest: bytesToHex(this.textHash.digest()),
			encoding: this.encoding,
			bom: this.bom,
			sourceBytes: this.bytes,
			utf8Bytes: this.utf8,
			textLength: this.length,
			lineCount: LF + CRLF + CR + 1,
			maxLineLength: Math.max(this.longest, this.lineLength),
			eolCounts: { ...this.counts },
			preferredEol,
			eol: preferredEol,
		};
	}
}

export function assertEditorRawMetadata(
	expected: EditorRawMetadata,
	actual: EditorRawMetadata,
): void {
	for (const key of [
		"protocol",
		"hashKind",
		"formatVersion",
		"baseHash",
		"textDigest",
		"encoding",
		"bom",
		"sourceBytes",
		"utf8Bytes",
		"textLength",
		"lineCount",
		"maxLineLength",
		"preferredEol",
	] as const)
		if (expected[key] !== actual[key]) throw new Error(`EDITOR_RAW_MISMATCH:${key}`);
	for (const key of ["LF", "CRLF", "CR"] as const)
		if (expected.eolCounts[key] !== actual.eolCounts[key])
			throw new Error("EDITOR_FORMAT_MISMATCH");
}
