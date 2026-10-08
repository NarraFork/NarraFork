/** Kept dependency-free so permission gates never load the preview compiler. */
export const INTELLIGENT_UI_TOOL_NAME = "IntelligentUI";
export const INTELLIGENT_UI_ACTIONS = ["create", "show"] as const;
export type IntelligentUiToolAction = (typeof INTELLIGENT_UI_ACTIONS)[number];

/** Unknown/future actions remain mutating until explicitly classified. */
export function isIntelligentUiReadAction(action: unknown): boolean {
	return action === "show";
}
