import { settings } from "@server/lib/settings";
import iconv from "iconv-lite";
import jschardet from "jschardet";

/**
 * Encoding-aware file reading.
 * When `settings.agent.legacyEncoding` is enabled, detects the file encoding
 * (e.g. GBK, Shift_JIS) and decodes accordingly. Otherwise falls back to
 * Bun's default UTF-8 `.text()`.
 *
 * Returns `{ text, encoding }` so callers can write back in the same encoding.
 */
/** Minimum confidence from jschardet to trust the detected encoding. */
const CONFIDENCE_THRESHOLD = 0.7;

export async function readFileText(path: string): Promise<{ text: string; encoding: string }> {
	const file = Bun.file(path);

	if (!settings.agent.legacyEncoding) {
		return { text: await file.text(), encoding: "utf-8" };
	}

	const buffer = Buffer.from(await file.arrayBuffer());
	const detected = jschardet.detect(buffer);
	const encoding =
		detected.confidence >= CONFIDENCE_THRESHOLD ? normalizeEncoding(detected.encoding) : "utf-8";
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

/** Normalize encoding names from jschardet to iconv-lite compatible names */
function normalizeEncoding(enc: string | null): string {
	if (!enc) return "utf-8";
	const lower = enc.toLowerCase();
	// jschardet may return these aliases
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
