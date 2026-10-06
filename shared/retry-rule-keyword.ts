/**
 * retry-rule-keyword.ts — normalize the text a custom retry rule matches against.
 *
 * An error card in the narrator timeline shows a *decorated* string, not the raw
 * provider message:
 *   - `narrator-executor` prefixes the loop's failure with `Error: `
 *   - `narrator-persistence` stores the card's plain-text form as `[Error] …`
 *
 * The retry-rule matcher, however, only ever sees the RAW provider message
 * (`err.message`, nested `error.message`, serialized error fields). So a keyword
 * copied out of the visible card — which is exactly what the "mark as retryable"
 * dialog prefills — could never match: `"Error: stream error …".includes()` is
 * tested against a haystack that starts at `stream error …`.
 *
 * Stripping the display prefix on BOTH sides (dialog prefill and match time)
 * fixes new rules and revives already-saved broken ones without asking the user
 * to re-enter anything.
 */

/**
 * Remove the timeline's error-card decoration from a rule keyword / error text.
 *
 * Handles the prefixes in the order they are applied, and repeats while more
 * remain, so the stored double form (`[Error] Error: …`) collapses too. Matching
 * is case-insensitive because the value may come from either the rendered card or
 * a hand-typed rule.
 *
 * Returns the input trimmed when nothing was stripped. A value that is *only* a
 * prefix (e.g. `"Error:"`) collapses to an empty string; callers decide whether
 * that means "no keyword condition".
 */
export function stripErrorDisplayPrefix(value: string): string {
	let result = value.trim();
	// Bounded loop: each iteration must consume at least one prefix or stop.
	for (;;) {
		const lower = result.toLowerCase();
		if (lower.startsWith("[error]")) {
			result = result.slice("[error]".length).trimStart();
			continue;
		}
		if (lower.startsWith("error:")) {
			result = result.slice("error:".length).trimStart();
			continue;
		}
		return result;
	}
}
