/**
 * source-slice.ts — brace-matched source extraction for the vlist's source-text
 * guards.
 *
 * Several guards assert on a REGION of PretextExactMessageList.tsx (a hook's
 * option object, a callback body) because what they protect is a wiring rule that
 * has no runtime surface: an option that must be the bucketed height, a capture
 * that must not read the DOM. To do that they have to cut the region out of the
 * file first.
 *
 * They used to cut it with `source.indexOf("\n\t});", start)` — i.e. by assuming
 * the construct sits at exactly one tab of indentation. That assumption broke the
 * moment the shell was re-indented (the component moved one level deeper), and it
 * broke in TWO different ways, neither of which says "your guard is confused":
 *
 *   - the sentinel is not found at all → `-1` → the slice is empty and the
 *     assertions fail with an unrelated-looking message;
 *   - worse, the sentinel matches a LATER, shallower construct → the slice runs
 *     past the region into unrelated code, and the guard then reports a violation
 *     that exists somewhere it was never meant to look (this is how the fold guard
 *     started claiming `getBoundingClientRect` was in the capture body).
 *
 * A guard that fails for a reason unrelated to what it guards is worse than no
 * guard: the next person re-anchors it to whatever makes it pass. Matching braces
 * is indentation-independent, so re-formatting the shell can no longer break it.
 */

const OPENERS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };

/**
 * The source from `anchor` through the end of the bracketed group that `anchor`
 * opens, brace-matched (string and comment aware).
 *
 * `anchor` must be a literal that ENDS with the opening bracket of the region —
 * e.g. `"usePretextDocument(narratorId, {"`. Returns null when the anchor is
 * absent or its group is unterminated, so a caller can fail with a message about
 * the ANCHOR rather than about the assertion that follows.
 */
export function sliceBracketedRegion(source: string, anchor: string): string | null {
	const start = source.indexOf(anchor);
	if (start < 0) return null;
	const open = anchor.at(-1);
	if (!open || !OPENERS[open]) return null;

	let depth = 0;
	let index = start + anchor.length - 1;
	let quote: string | null = null;
	let comment: "line" | "block" | null = null;
	for (; index < source.length; index++) {
		const ch = source[index] as string;
		const next = source[index + 1];
		if (comment === "line") {
			if (ch === "\n") comment = null;
			continue;
		}
		if (comment === "block") {
			if (ch === "*" && next === "/") {
				comment = null;
				index++;
			}
			continue;
		}
		if (quote) {
			// Template literals can nest `${…}` containing braces, but the guards only
			// need balance, and a template's own braces are balanced too — so skipping
			// the whole literal is safe as long as escapes are honoured.
			if (ch === "\\") {
				index++;
				continue;
			}
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			comment = "line";
			index++;
			continue;
		}
		if (ch === "/" && next === "*") {
			comment = "block";
			index++;
			continue;
		}
		if (OPENERS[ch]) {
			depth++;
			continue;
		}
		if (ch === ")" || ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) return source.slice(start, index + 1);
		}
	}
	return null;
}
