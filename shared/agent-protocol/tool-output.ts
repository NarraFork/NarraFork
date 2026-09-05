/**
 * tool-output.ts — normalize a persisted tool result to the text a model reads.
 *
 * Lived in `sidecar.ts` until the side-car channel was retired, purely because that
 * file happened to be where the history builders already imported from. It has nothing
 * to do with injected content: every provider's `buildHistory` needs it to turn a
 * `narrator_tool_calls.outputJson` value back into a string, and that is all it does.
 */

/**
 * Coerce a stored tool output to text.
 *
 * Three shapes reach this, in order of how often:
 *   - a plain string — the normal case, returned untouched
 *   - `{ _text: "…" }` — the wrapper some tools use to carry text plus metadata
 *   - anything else — serialized, because a model can still read JSON, whereas
 *     `[object Object]` tells it nothing
 *
 * `null`/`undefined` become `""` rather than the string "null": an absent output is an
 * empty one, and a literal "null" in a tool result reads as a value the tool returned.
 */
export function outputToText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const maybeText = (value as { _text?: unknown })._text;
		if (typeof maybeText === "string") return maybeText;
	}
	return value == null ? "" : JSON.stringify(value);
}
