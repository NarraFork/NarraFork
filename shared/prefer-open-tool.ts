/**
 * Tools whose card detail is OPERATIONAL content the reader must see or act on.
 *
 * Unlike `lodExempt` (running / streaming / pending permission / pinned tasks),
 * these cards are only DEFAULT-EXPANDED: a reader fold still wins. They also stay
 * out of the L1/L2 activity fold so the form/question/plan is not reduced to a
 * trace row the reader has to hunt for.
 *
 * Name-based on purpose: category `"plan"` also covers `EnterPlanMode`, which
 * carries little operational body and must not inherit ExitPlanMode's always-open
 * default. Measure's category twin therefore stays `"ask"` only — the adapter
 * stamps `preferOpen` from the tool NAME.
 */
const PREFER_OPEN_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** True when a tool call should default-open at every LOD (still collapsible). */
export function isPreferOpenTool(tool: {
	toolName: string;
	status?: string | null;
	inputJson?: unknown;
}): boolean {
	if (PREFER_OPEN_TOOL_NAMES.has(tool.toolName)) return true;
	// A question wait is an answer surface, not an ordinary task-status card.
	const input = tool.inputJson;
	return (
		tool.toolName === "Await" &&
		(tool.status === "running" || tool.status === "executing") &&
		typeof input === "object" &&
		input !== null &&
		"type" in input &&
		input.type === "question"
	);
}

/** Category-level twin for measure inputs that carry `category` instead of the name. */
export function prefersOpenToolCategory(category: string | undefined): boolean {
	// Deliberately not `"plan"`: see module doc — EnterPlanMode shares that category.
	return category === "ask";
}
