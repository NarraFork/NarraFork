import { StringDecoder } from "node:string_decoder";
import { IS_WINDOWS } from "@server/lib/platform";
import { settings } from "@server/lib/settings";
import chardet from "chardet";
import iconv from "iconv-lite";

/**
 * Encoding-aware file reading.
 * When `settings.agent.legacyEncoding` is enabled, detects the file encoding
 * (e.g. GBK, Shift_JIS) and decodes accordingly. Otherwise falls back to
 * Bun's default UTF-8 `.text()`.
 *
 * Returns `{ text, encoding }` so callers can write back in the same encoding.
 */
/** Minimum confidence from chardet to trust the detected encoding (0–100). */
const CONFIDENCE_THRESHOLD = 70;

export async function readFileText(path: string): Promise<{ text: string; encoding: string }> {
	const file = Bun.file(path);

	if (!settings.agent.legacyEncoding) {
		return { text: await file.text(), encoding: "utf-8" };
	}

	const buffer = Buffer.from(await file.arrayBuffer());
	return decodeFileBytes(buffer);
}

/**
 * Decode already-read file bytes into text, applying the same charset detection
 * as {@link readFileText}. Used by tools that obtain bytes from an execution
 * backend (local or remote) so encoding handling stays identical regardless of
 * where the file physically lives.
 */
export function decodeFileBytes(bytes: Uint8Array): { text: string; encoding: string } {
	if (!settings.agent.legacyEncoding) {
		return { text: new TextDecoder().decode(bytes), encoding: "utf-8" };
	}
	const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	const results = chardet.analyse(buffer);
	const best = results[0];
	const encoding =
		best && best.confidence >= CONFIDENCE_THRESHOLD ? normalizeEncoding(best.name) : "utf-8";
	const text = iconv.decode(buffer, encoding);
	return { text, encoding };
}

/**
 * Decode bytes using an encoding the caller already knows, without sniffing.
 *
 * The counterpart to {@link decodeFileBytes} for a round trip that spans two
 * requests: the human file editor is told an encoding when it opens a file and
 * echoes it back on save. Re-detecting at that point would be wrong rather than
 * merely redundant — detection runs on the bytes, and on save the interesting bytes
 * are the ones about to be replaced, so a file's encoding could silently change
 * because the new text sniffed differently.
 *
 * Unknown or unsupported names fall back to UTF-8 instead of throwing: the name
 * arrives from a client, and a bad one must not turn a save into a 500.
 */
export function decodeFileBytesAs(bytes: Uint8Array, encoding: string): string {
	if (isUtf8(encoding)) return new TextDecoder().decode(bytes);
	const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	if (!iconv.encodingExists(encoding)) return new TextDecoder().decode(buffer);
	return iconv.decode(buffer, encoding);
}

/**
 * Encode text back to bytes using the same rules as {@link writeFileText}.
 * Returns UTF-8 bytes unless legacy encoding is enabled and the target encoding
 * is non-UTF-8.
 */
export function encodeFileBytes(content: string, encoding = "utf-8"): Uint8Array {
	if (!settings.agent.legacyEncoding || isUtf8(encoding)) {
		return new TextEncoder().encode(content);
	}
	return iconv.encode(content, encoding);
}

/**
 * Encode text to bytes in a named encoding, regardless of `agent.legacyEncoding`.
 *
 * {@link encodeFileBytes} deliberately ignores a non-UTF-8 encoding when that setting
 * is off, because for the AGENT tools the setting is the switch that decides whether
 * legacy charsets are handled at all. That trade does not transfer to a person saving
 * a file they opened in the browser: the file's encoding is a property of the file,
 * not of a preference, and writing UTF-8 over a GBK file destroys it whichever way
 * the setting happens to be set.
 *
 * Falls back to UTF-8 for a name iconv does not know, matching
 * {@link decodeFileBytesAs} so the pair cannot disagree about what a bad name means.
 */
export function encodeFileBytesAs(content: string, encoding: string): Uint8Array {
	if (isUtf8(encoding)) return new TextEncoder().encode(content);
	if (!iconv.encodingExists(encoding)) return new TextEncoder().encode(content);
	return iconv.encode(content, encoding);
}

/**
 * Sniff the encoding of already-read bytes, ignoring `agent.legacyEncoding`.
 *
 * Same reasoning as {@link encodeFileBytesAs}: a human editor must know the real
 * encoding of the file it is about to overwrite even when the agent-facing legacy
 * switch is off, because the alternative is a silent destructive save.
 *
 * Returns `"utf-8"` whenever detection is not confident, so an ambiguous file is
 * treated as the modern default rather than guessed into a legacy charset.
 */
export function detectFileEncoding(bytes: Uint8Array): string {
	const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	const best = chardet.analyse(buffer)[0];
	if (!best || best.confidence < CONFIDENCE_THRESHOLD) return "utf-8";
	const name = normalizeEncoding(best.name);
	return iconv.encodingExists(name) ? name : "utf-8";
}

/** Bytes inspected when sniffing for binary content. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Heuristic binary check, matching what git does: a NUL byte within the first
 * few KB means the content is not text.
 *
 * Callers that persist file contents as TEXT must consult this first. Decoding
 * binary bytes into a string and later re-encoding them does not round-trip, so
 * such files can only be restored from a byte-exact source (a git tree object),
 * never from a stored text snapshot.
 */
export function looksBinary(bytes: Uint8Array): boolean {
	const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
	for (let i = 0; i < limit; i++) {
		if (bytes[i] === 0) return true;
	}
	return false;
}

/**
 * Encoding-aware file writing.
 * When legacy encoding is enabled and the encoding is not UTF-8, encodes the
 * content back to the original encoding before writing.
 */
export async function writeFileText(
	path: string,
	content: string,
	encoding = "utf-8",
): Promise<void> {
	if (!settings.agent.legacyEncoding || isUtf8(encoding)) {
		await Bun.write(path, content);
		return;
	}

	const encoded = iconv.encode(content, encoding);
	await Bun.write(path, encoded);
}

/** Normalize encoding names from chardet to iconv-lite compatible names */
function normalizeEncoding(enc: string | null): string {
	if (!enc) return "utf-8";
	const lower = enc.toLowerCase();
	// chardet may return these aliases
	const map: Record<string, string> = {
		"utf-8": "utf-8",
		ascii: "utf-8",
		"windows-1252": "windows-1252",
		"iso-8859-1": "iso-8859-1",
		gb2312: "gbk",
		gb18030: "gb18030",
		big5: "big5",
		"euc-jp": "euc-jp",
		shift_jis: "shift_jis",
		"euc-kr": "euc-kr",
		"iso-2022-jp": "iso-2022-jp",
	};
	return map[lower] ?? lower;
}

function isUtf8(encoding: string): boolean {
	const lower = encoding.toLowerCase();
	return lower === "utf-8" || lower === "utf8" || lower === "ascii";
}

/**
 * Streaming decoder for child-process stdout/stderr.
 *
 * Problem: native Windows CLIs (e.g. .NET tools) write redirected output in the
 * system OEM code page (cp936/GBK on Chinese Windows), not UTF-8. Decoding those
 * bytes as UTF-8 produces replacement characters (锟斤拷 / �).
 *
 * Behaviour:
 *   - When charset auto-detection is disabled (see {@link shouldAutoDetectShellEncoding}),
 *     this is a thin wrapper over `StringDecoder("utf-8")` — identical to the old behaviour.
 *   - When enabled, the decoder buffers the first chunks until it has enough bytes
 *     (or the stream ends) to run chardet once. If a confident non-UTF-8 encoding is
 *     detected, all output (buffered + subsequent) is decoded with iconv-lite using
 *     that fixed encoding. Otherwise it falls back to streaming UTF-8 decoding.
 *
 * The detected encoding is locked in after the first detection so live output and the
 * final buffer stay consistent and we never re-run chardet per chunk.
 */
export interface StreamDecoder {
	/** Decode a chunk, returning whatever text can be emitted so far. */
	write(chunk: Buffer): string;
	/** Flush any buffered/partial bytes at end of stream. */
	end(): string;
}

/** Buffer at least this many bytes before running chardet (unless the stream ends first). */
const DETECT_MIN_BYTES = 256;

/**
 * Whether shell output should be charset-auto-detected.
 *
 * Enabled when the user turns on `legacyEncoding`, OR automatically on Windows
 * (where the OEM console code page is the common source of garbled CLI output).
 */
export function shouldAutoDetectShellEncoding(): boolean {
	return settings.agent.legacyEncoding || IS_WINDOWS;
}

export function createStreamDecoder(): StreamDecoder {
	// Fast path: plain UTF-8 streaming, no detection overhead.
	if (!shouldAutoDetectShellEncoding()) {
		const utf8 = new StringDecoder("utf-8");
		return {
			write: (chunk) => utf8.write(chunk),
			end: () => utf8.end(),
		};
	}

	let detected: string | null = null;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	// iconv-lite stream decoder, created once the encoding is locked in.
	let iconvDecoder: ReturnType<typeof iconv.getDecoder> | null = null;
	const utf8 = new StringDecoder("utf-8");

	/** Run chardet on buffered bytes and lock in a decoder. */
	const detect = (): string => {
		const buf = Buffer.concat(pending);
		pending = [];
		pendingBytes = 0;

		const results = chardet.analyse(buf);
		const best = results[0];
		const name =
			best && best.confidence >= CONFIDENCE_THRESHOLD ? normalizeEncoding(best.name) : "utf-8";
		detected = name;

		if (isUtf8(name)) {
			// Stream the buffered bytes through the UTF-8 decoder (handles split multibyte).
			return utf8.write(buf);
		}
		iconvDecoder = iconv.getDecoder(name);
		return iconvDecoder.write(buf);
	};

	return {
		write(chunk: Buffer): string {
			if (detected) {
				if (iconvDecoder) return iconvDecoder.write(chunk);
				return utf8.write(chunk);
			}
			pending.push(chunk);
			pendingBytes += chunk.byteLength;
			if (pendingBytes >= DETECT_MIN_BYTES) return detect();
			return "";
		},
		end(): string {
			let out = "";
			if (!detected) {
				if (pendingBytes > 0) {
					out += detect();
				} else {
					detected = "utf-8";
				}
			}
			out += iconvDecoder ? iconvDecoder.end() : utf8.end();
			return out;
		},
	};
}
