// Pure experiment diagnostics: never import production settings or account data.
const REDACTED = "[REDACTED]";
const DEFAULT_LIMIT = 1800;
const MAX_INPUT_CHARS = 2_000_000;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_SECRETS = 64;
const MAX_SECRET_CHARS = 4096;
const MAX_TOTAL_SECRET_CHARS = 16_384;
const OMITTED = "[REDACTED: experiment error exceeded the diagnostic budget]";

/** Length of the longest suffix of text that is a prefix of secret (linear time). */
function trailingPrefixLength(text: string, secret: string): number {
	const failure = new Uint32Array(secret.length);
	for (let i = 1, matched = 0; i < secret.length; i++) {
		while (matched && secret[i] !== secret[matched]) matched = failure[matched - 1] ?? 0;
		if (secret[i] === secret[matched]) matched++;
		failure[i] = matched;
	}
	let matched = 0;
	for (let i = Math.max(0, text.length - secret.length); i < text.length; i++) {
		while (matched && text[i] !== secret[matched]) matched = failure[matched - 1] ?? 0;
		if (text[i] === secret[matched]) matched++;
	}
	return matched;
}

function checkBudget(text: string): string {
	if (text.length > MAX_INPUT_CHARS) throw new Error("Diagnostic expansion budget exceeded");
	return text;
}

function redactKnown(text: string, variants: string[]): string {
	// Do this before token replacement: a partial punctuation-bearing key can
	// itself contain token boundaries, and masking its last token first would
	// destroy the evidence that the earlier characters belong to the same key.
	if (!text.endsWith(REDACTED)) {
		let overlap = 0;
		for (const secret of variants) overlap = Math.max(overlap, trailingPrefixLength(text, secret));
		if (overlap) text = text.slice(0, -overlap) + REDACTED;
	}
	// Both diagnostics and known keys have already normalized JSON escapes.
	// Longest-first protects overlapping configured credentials.
	for (const secret of variants) {
		const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// Do not recursively expand markers when a short key matches their text.
		text = checkBudget(text.replace(new RegExp(`\\[REDACTED\\]|${escaped}`, "g"), REDACTED));
	}
	// An upstream can split a credential over separate JSON fields. Only mask
	// whole credential-shaped tokens, not arbitrary substrings of ordinary words.
	// Short standalone fragments are intentionally conservative too: a one-byte
	// field or a cutoff immediately after the first key byte must not expose it.
	text = checkBudget(
		text.replace(/[\p{L}\p{N}_-]+/gu, (token) =>
			token !== "REDACTED" && variants.some((secret) => secret.includes(token)) ? REDACTED : token,
		),
	);
	return text;
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

function decodeJsonEscapes(text: string): string {
	// Diagnostics need not remain valid JSON. Decode one layer for alternate
	// spellings such as \u0066ake, escaped slashes and escaped Bearer whitespace.
	return text.replace(/\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (encoded) => {
		if (encoded[1] === "u") return String.fromCharCode(Number.parseInt(encoded.slice(2), 16));
		return JSON_ESCAPES[encoded[1] ?? ""] ?? encoded;
	});
}

function normalizeJsonEscapes(text: string): string {
	for (let depth = 0; depth < 8; depth++) {
		const decoded = decodeJsonEscapes(text);
		if (decoded === text) return text;
		text = decoded;
	}
	throw new Error("Diagnostic encoding budget exceeded");
}

/**
 * Redact before the final output cutoff. Call with the original diagnostic, not
 * a slice of JSON.stringify(error). Strings and Error objects follow String().
 * Known secrets, JSON escapes, standalone known-secret fragments and Bearer
 * tokens are removed. A possible key prefix at the input boundary is withheld.
 *
 * Work is bounded: 2M input chars; 64 secrets / 16K total chars / 4K each;
 * 8 decoding rounds; 12K output chars. Oversized/unprintable input fails closed, not by slicing
 * an unredacted string. No settings, I/O, account registration or network access.
 */
export function redactExperimentError(
	error: unknown,
	secrets: Iterable<string>,
	limit = DEFAULT_LIMIT,
): string {
	const outputLimit = Number.isFinite(limit)
		? Math.max(0, Math.min(MAX_OUTPUT_CHARS, Math.floor(limit)))
		: DEFAULT_LIMIT;
	if (!outputLimit) return "";
	try {
		let text = String(error);
		if (text.length > MAX_INPUT_CHARS) return OMITTED.slice(0, outputLimit);
		const variants = new Set<string>();
		let count = 0;
		let total = 0;
		for (const secret of secrets) {
			if (++count > MAX_SECRETS) return OMITTED.slice(0, outputLimit);
			if (!secret) continue;
			if (typeof secret !== "string") return OMITTED.slice(0, outputLimit);
			total += secret.length;
			if (secret.length > MAX_SECRET_CHARS || total > MAX_TOTAL_SECRET_CHARS)
				return OMITTED.slice(0, outputLimit);
			variants.add(normalizeJsonEscapes(secret));
		}
		const ordered = [...variants].sort((a, b) => b.length - a.length);
		// Normalize both sides first so fragment matching cannot destroy an
		// escaped Bearer prefix before the unknown credential is recognized.
		text = normalizeJsonEscapes(text);
		// Raw HTTP byte caps can bisect a JSON escape. Withhold the unfinished
		// escape, then let prefix matching protect the preceding key characters.
		const incompleteEscape = /\\(?:u[0-9a-f]{0,3})?$/i.exec(text);
		if (incompleteEscape) text = text.slice(0, incompleteEscape.index);
		text = checkBudget(text.replace(/\bBearer\s+[^\s"'<>\\{},;]+/gi, "Bearer [REDACTED]"));
		text = redactKnown(text, ordered);
		if (incompleteEscape && !text.endsWith(REDACTED)) text += REDACTED;
		return text.slice(0, outputLimit);
	} catch {
		return "[REDACTED: unprintable experiment error]".slice(0, outputLimit);
	}
}
