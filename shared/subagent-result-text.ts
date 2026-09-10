/**
 * subagent-result-text.ts — the ONE rule turning a subagent tool call's
 * `outputJson` into the conclusion text its card shows.
 *
 * WHY THIS EXISTS
 * A subagent's result is not always a bare string. The runner writes a plain
 * string in some paths and a `{_text, _metadata}` envelope in others (the
 * `_metadata` carries `execDurationMs` and friends), and field-level projection
 * can additionally wrap the text in a `{_truncated, preview, fullLength}` leaf.
 * Measured on a real database, 43% of `Agent`/`Task` rows were the object form.
 *
 * The chunked card (SubagentCard.tsx) had this rule; the vlist adapter only
 * accepted `typeof outputJson === "string"`, so on every object-form row the
 * card silently rendered NO result at all — the reader saw a finished subagent
 * with an empty conclusion. That divergence is exactly what a shared rule
 * prevents, so both paths now call in here.
 *
 * The `<subagent_id>` prefix is stripped: it is addressing metadata the runner
 * prepends so the model can reply to the child, never something a reader wants
 * to see. `<background_task_id>` stays available to the card's launch-notice
 * classifier; it must be rendered as a compact notice, not as result markdown.
 */

import { readLeafText, stringifyForDisplay } from "./pretext-layout/tool-io-projection";

/**
 * Character ceiling on the extracted text.
 *
 * Generous (a conclusion is meant to be read in full) but bounded, so a
 * pathological output cannot hand a render/measure path an unbounded string.
 */
export const MAX_SUBAGENT_RESULT_TEXT_CHARS = 120_000;

const SUBAGENT_ID_RE = /<subagent_id>[^<]*<\/subagent_id>/g;

/** Recognize only a leading runner envelope, never tags quoted in a result body. */
export function readBackgroundTaskId(text: string): string | undefined {
	return /^\s*<background_task_id>([^<\r\n]+)<\/background_task_id>(?:\s|$)/.exec(text)?.[1];
}

/** Await may prepend a status line before the runner's addressing envelope. */
export function stripAwaitAgentEnvelope(text: string): string {
	return text
		.replace(
			/^(\s*(?:Agent [^\r\n]+ status: [^\r\n]+\r?\n\s*)?)<subagent_id>[^<\r\n]*<\/subagent_id>\s*/,
			"$1",
		)
		.trim();
}

function capText(text: string, maxChars: number): string {
	return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Extract the readable body of a subagent tool call's output.
 *
 * Accepted shapes, in the order they are probed:
 *  1. bare string
 *  2. `{_text}` envelope — checked BEFORE the generic leaf read, and itself
 *     unwrapped when the text is a truncated leaf, so an envelope whose body was
 *     cut shows the preview instead of the literal `{"_text":"…` dump
 *  3. a truncated leaf at the root (a projected bare-string output)
 *  4. an array of `{text}` content blocks
 *  5. anything else → a display-safe JSON dump
 */
export function parseSubagentOutputText(output: unknown): string {
	if (typeof output === "string") return capText(output, MAX_SUBAGENT_RESULT_TEXT_CHARS);
	if (!output || typeof output !== "object") return "";
	const record = output as Record<string, unknown>;
	const textField = readLeafText(record._text);
	if (textField !== undefined) return capText(textField, MAX_SUBAGENT_RESULT_TEXT_CHARS);
	const leaf = readLeafText(record);
	if (leaf !== undefined) return capText(leaf, MAX_SUBAGENT_RESULT_TEXT_CHARS);
	if (Array.isArray(output)) {
		return capText(
			output
				.map((block) =>
					block &&
					typeof block === "object" &&
					typeof (block as { text?: unknown }).text === "string"
						? ((block as { text: string }).text ?? "")
						: "",
				)
				.filter(Boolean)
				.join("\n"),
			MAX_SUBAGENT_RESULT_TEXT_CHARS,
		);
	}
	return capText(stringifyForDisplay(output), MAX_SUBAGENT_RESULT_TEXT_CHARS);
}

/** Drop the runner's `<subagent_id>` addressing tag(s) from a result body. */
export function stripSubagentIdTag(text: string): string {
	return text.replace(SUBAGENT_ID_RE, "").trim();
}

/**
 * The result text a subagent card renders: {@link parseSubagentOutputText} with
 * the `<subagent_id>` tag stripped. Returns `""` when the output carries nothing.
 */
export function subagentResultText(output: unknown): string {
	return stripSubagentIdTag(parseSubagentOutputText(output));
}
