/**
 * agent-id-display.ts — shorten a raw agent/task nanoid for display.
 *
 * The server now labels agents by alias everywhere it talks to the model, and
 * ships that label as `metadata.targetLabel`. But two cases still hand the UI a
 * raw id: a call whose metadata predates this change, and a model that addressed
 * an agent by its full nanoid on purpose. Printing 21 opaque characters in a
 * header is what made `Await agent: UscgG1vLFnxzyKyaUOIfR` unreadable, so those
 * cases fall back to a prefix and keep the full value in a tooltip.
 *
 * Aliases (`run-tests`), short ids, and anything containing a separator are
 * returned untouched — only values that actually look like a generated id are
 * shortened.
 */

/** nanoid alphabet used by `@server/lib/id` (URL-safe: A–Za–z0–9_-). */
const NANOID_LIKE = /^[A-Za-z0-9_-]{12,}$/;

/** How much of a raw id to keep — enough to stay distinguishable at a glance. */
const DISPLAY_PREFIX_CHARS = 8;

/**
 * True when `value` looks like a generated id rather than a human-chosen alias.
 *
 * Slugified aliases can also be long and use `-`, so length alone is not enough:
 * a value is treated as an id only when it has no separator run and mixes cases
 * or digits the way a nanoid does. `run-tests-2` stays intact; `UscgG1vLFnxzy…`
 * does not.
 */
export function looksLikeGeneratedId(value: string): boolean {
	if (!NANOID_LIKE.test(value)) return false;
	// A slug is lowercase words joined by single dashes; a nanoid is not.
	if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return false;
	return true;
}

/** Display form of an agent/task selector: aliases as-is, raw ids truncated. */
export function formatAgentIdForDisplay(value: string | null | undefined): string {
	const trimmed = value?.trim();
	if (!trimmed) return "";
	if (!looksLikeGeneratedId(trimmed)) return trimmed;
	return `${trimmed.slice(0, DISPLAY_PREFIX_CHARS)}…`;
}

/**
 * The label to show for an Await/Send target: the server-resolved label when
 * present, else a shortened form of whatever selector the model used.
 */
export function agentTargetDisplay(
	label: string | null | undefined,
	fallbackSelector: string | null | undefined,
): string {
	const resolved = label?.trim();
	if (resolved) return formatAgentIdForDisplay(resolved);
	return formatAgentIdForDisplay(fallbackSelector);
}
