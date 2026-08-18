/**
 * content-disposition.ts — build a safe `Content-Disposition: attachment` header.
 *
 * The filename comes from the filesystem (or, worse, from a path a caller passed
 * in), so it can carry CJK, quotes, or control characters. All three are header
 * problems rather than cosmetic ones:
 *
 *   - CR/LF would let a filename inject additional response headers;
 *   - a double quote would terminate the quoted `filename` early;
 *   - non-ASCII bytes are not representable in the plain `filename` parameter.
 *
 * So two names are emitted, exactly as `shares.ts` and the narrator export
 * already do: a conservative ASCII `filename` for old clients, and an RFC 5987
 * `filename*` carrying the real name. Path separators are dropped, because the
 * value becomes a filename on the client and must not be able to express a path.
 */

/** Fallback used when nothing usable survives sanitization. */
const FALLBACK_NAME = "download";

/**
 * Control characters, quotes, path separators, and the header's own parameter
 * delimiters (`;` `,`).
 *
 * The delimiters matter even though they sit inside a quoted string, where RFC
 * 9110 permits them: a client that splits the header on `;` before unquoting —
 * which is the common shortcut, including in this repo's own
 * `parseContentDispositionFileName` — would read a name containing one as a
 * truncated name plus a bogus parameter.
 *
 * Matching control characters is the whole point here, hence the suppression.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the intent
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f"'\\/:*?<>|;,]/g;

/** Negated printable ASCII range, so control characters are excluded by construction. */
const NON_ASCII_PRINTABLE = /[^\x20-\x7e]/g;

/**
 * Reduce an arbitrary path or filename to a bare, header-safe file name.
 *
 * Exported for tests and for callers that need the name itself (not the header).
 */
export function sanitizeAttachmentFileName(rawName: string | null | undefined): string {
	const base = (rawName ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
	const cleaned = base.replace(UNSAFE_NAME_CHARS, "").trim();
	if (!cleaned || cleaned === "." || cleaned === "..") return FALLBACK_NAME;
	// Bounded so a pathological 4 KB filename cannot bloat the header.
	return cleaned.slice(0, 120);
}

/**
 * Build the full header value for downloading `rawName` as an attachment.
 *
 * The ASCII fallback replaces non-representable characters with `_` rather than
 * deleting them, so a fully-CJK name still yields something with the right
 * extension (`报告.json` → `__.json`) instead of collapsing to `download`.
 */
export function buildAttachmentDisposition(rawName: string | null | undefined): string {
	const utf8 = sanitizeAttachmentFileName(rawName);
	const ascii = utf8.replace(NON_ASCII_PRINTABLE, "_") || FALLBACK_NAME;
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`;
}
