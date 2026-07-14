/**
 * Shared rules for "named narrator" handles (the `@handle` mention target).
 *
 * Used by both backend (validation, storage, mention parsing) and frontend
 * (input validation, the @mention popover) so the two ends never disagree.
 *
 * Design (agreed):
 * - A handle preserves the ORIGINAL case the user typed (e.g. "MyBot", "小明").
 * - Matching and uniqueness are CASE-INSENSITIVE via a folded form (`foldHandle`).
 * - Characters are Unicode letters/digits plus `_` and `-`; must start with a
 *   letter or digit. Length is 2–32 counted in code points (so CJK counts right).
 * - CJK has no word separators, so `@小明帮我看看` is ambiguous. Mention parsing
 *   therefore resolves against the set of REGISTERED handles using longest-match.
 */

/** Min/max handle length, counted in Unicode code points. */
export const MIN_HANDLE_LENGTH = 2;
export const MAX_HANDLE_LENGTH = 32;

/**
 * Single-char class allowed inside a handle: Unicode letters (incl. CJK),
 * Unicode digits, underscore, hyphen. Not anchored — for reuse in scanners.
 */
export const HANDLE_CHAR_CLASS = "[\\p{L}\\p{N}_-]";

/** A handle char must be a letter/digit/_/- (single code point). */
export const HANDLE_CHAR_RE = /[\p{L}\p{N}_-]/u;

/** A handle must START with a letter or digit (not _ or -). */
export const HANDLE_START_RE = /[\p{L}\p{N}]/u;

/** Full-handle validation regex (start char + rest). Not length-checked here. */
const HANDLE_FULL_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

/**
 * Boundary chars that may immediately precede an `@` for it to count as a
 * mention. Includes ASCII punctuation/whitespace and common CJK punctuation so
 * `你好，@小明` works. `@` at string start is always a valid boundary.
 */
const MENTION_BOUNDARY_RE = /[\s(,:;!?，。！？、（【「《]/u;

/** Count a string's length in Unicode code points (so "小明" is 2, not more). */
export function handleLength(s: string): number {
	let n = 0;
	// Iterating a string yields code points (not UTF-16 units).
	for (const _ of s) n++;
	return n;
}

/**
 * Fold a handle to its case-insensitive canonical form for matching + uniqueness.
 * NFC-normalizes first (so composed/decomposed forms compare equal) then
 * lowercases. CJK has no case, so it is unaffected beyond normalization.
 */
export function foldHandle(handle: string): string {
	return handle.normalize("NFC").toLowerCase();
}

/**
 * Validate a handle's shape (characters + start + length). Does NOT trim — the
 * caller should trim first. Returns true when the handle is storable.
 */
export function isValidHandle(handle: string): boolean {
	if (!handle) return false;
	const len = handleLength(handle);
	if (len < MIN_HANDLE_LENGTH || len > MAX_HANDLE_LENGTH) return false;
	return HANDLE_FULL_RE.test(handle);
}

/** Whether `ch` (a single code point string) is a valid mention boundary before `@`. */
function isBoundaryChar(ch: string): boolean {
	return MENTION_BOUNDARY_RE.test(ch);
}

/**
 * Cheap existence check: does the text plausibly contain a mention? Used to
 * short-circuit the (more expensive) candidate-based parse without loading the
 * registered-handle set. Unicode-aware so `@小明` and `@Bob` are NOT dropped.
 *
 * True when some `@` is at a mention boundary and is immediately followed by a
 * valid handle START char (letter/digit). This intentionally over-accepts (it
 * does not verify the handle is registered) — that's the parser's job.
 */
export function hasMentionLike(text: string): boolean {
	if (!text || text.indexOf("@") === -1) return false;
	const chars = [...text];
	for (let i = 0; i < chars.length; i++) {
		if (chars[i] !== "@") continue;
		const prev = i > 0 ? chars[i - 1] : null;
		if (prev !== null && !isBoundaryChar(prev)) continue;
		const next = i + 1 < chars.length ? chars[i + 1] : null;
		if (next !== null && HANDLE_START_RE.test(next)) return true;
	}
	return false;
}

/**
 * Resolve `@`-mentions in `text` against a set of REGISTERED folded handles.
 *
 * Returns the matched folded handles, de-duplicated in first-seen order. For
 * each `@` at a mention boundary, we take up to MAX_HANDLE_LENGTH following
 * handle chars and try the LONGEST prefix that (a) is shape-valid and (b) folds
 * to a registered handle. This resolves the CJK "no separator" ambiguity: with
 * both "小明" and "小明帮" registered, `@小明帮…` matches "小明帮".
 *
 * `foldedHandles` must already contain folded values (see `foldHandle`).
 */
export function extractMentionsWithCandidates(
	text: string,
	foldedHandles: ReadonlySet<string>,
): string[] {
	if (!text || text.indexOf("@") === -1 || foldedHandles.size === 0) return [];
	const chars = [...text];
	const seen = new Set<string>();
	const result: string[] = [];

	for (let i = 0; i < chars.length; i++) {
		if (chars[i] !== "@") continue;
		const prev = i > 0 ? chars[i - 1] : null;
		if (prev !== null && !isBoundaryChar(prev)) continue;

		// Collect the run of handle chars right after '@' (bounded by max length).
		const start = i + 1;
		let end = start;
		while (
			end < chars.length &&
			end - start < MAX_HANDLE_LENGTH &&
			HANDLE_CHAR_RE.test(chars[end])
		) {
			end++;
		}
		if (end === start) continue; // nothing after '@'
		// The first char must be a valid start char (letter/digit).
		if (!HANDLE_START_RE.test(chars[start])) continue;

		// Longest-match: try the longest prefix down to the min length.
		for (let len = end - start; len >= MIN_HANDLE_LENGTH; len--) {
			const candidate = chars.slice(start, start + len).join("");
			// A trailing '-' or '_' is allowed by chars but not a natural boundary;
			// still valid as a handle, so we keep it. Shape check covers start char.
			const folded = foldHandle(candidate);
			if (foldedHandles.has(folded)) {
				if (!seen.has(folded)) {
					seen.add(folded);
					result.push(folded);
				}
				// Advance past the matched handle so we don't re-scan inside it.
				i = start + len - 1;
				break;
			}
		}
	}
	return result;
}
