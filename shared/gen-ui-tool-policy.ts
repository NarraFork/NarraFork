/** Kept dependency-free so permission gates never load the preview compiler. */
export const GEN_UI_TOOL_NAME = "GenUI";
export const GEN_UI_ACTIONS = [
	"create",
	"show",
	"render",
	"inspect",
	"kit_status",
	"kit_build",
] as const;
export type GenUiToolAction = (typeof GEN_UI_ACTIONS)[number];

/**
 * Actions that write nothing to the workspace. `render` only displays markup carried in
 * its own input. Unknown/future actions remain mutating until explicitly classified.
 */
export function isGenUiReadAction(action: unknown): boolean {
	return action === "show" || action === "render" || action === "kit_status";
}

/** Inline card heights. Fixed per size so the chat can lay rows out without measuring. */
export const GEN_UI_INLINE_HEIGHTS = Object.freeze({ sm: 240, md: 400, lg: 580 });
export type GenUiInlineSize = keyof typeof GEN_UI_INLINE_HEIGHTS;

export function readGenUiInlineSize(value: unknown): GenUiInlineSize {
	return value === "sm" || value === "lg" ? value : "md";
}

/**
 * How the agent loop reads a call's arguments while the model is still writing them:
 * `short` fields are extracted whole, `large` ones are forwarded delta by delta. `source`
 * is the UI itself; the short fields decide the card's kind and height before it starts.
 */
export const GEN_UI_STREAM_FIELDS = Object.freeze({
	short: ["action", "title", "size"],
	large: ["source"],
});
