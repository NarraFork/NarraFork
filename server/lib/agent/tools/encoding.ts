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
	const results = chardet.analyse(buffer);
	const best = results[0];
	const encoding =
		best && best.confidence >= CONFIDENCE_THRESHOLD ? normalizeEncoding(best.name) : "utf-8";
	const text = iconv.decode(buffer, encoding);
	return { text, encoding };
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
