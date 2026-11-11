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
// GenUI: its body IS the answer (UI drawn in the conversation) or a kit build the
// reader is asked to confirm; folded to a header it would be neither seen nor confirmed.
const PREFER_OPEN_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode", "GenUI"]);

/** True when a tool call should default-open at every LOD (still collapsible). */
export function isPreferOpenTool(
	tool: {
		toolName: string;
		status?: string | null;
		inputJson?: unknown;
		outputJson?: unknown;
		_metadata?: unknown;
	},
	policy?: { compactAuxiliaryContent?: boolean; questionStatus?: string },
): boolean {
	if (policy?.compactAuxiliaryContent) {
		const input = objectValue(tool.inputJson);
		const metadata = objectValue(tool._metadata ?? objectValue(tool.outputJson)._metadata);
		if (tool.toolName === "AskUserQuestion") {
			if (policy.questionStatus === "open") return true;
			if (
				policy.questionStatus &&
				["answered", "dismissed", "withdrawn", "resolved"].includes(policy.questionStatus)
			)
				return false;
			// Async success is only an acknowledgement, never proof of an answer.
			if (Object.keys(objectValue(input.answers)).length > 0) return false;
			if (input.async === true) return true;
			return !isTerminal(tool.status);
		}
		if (tool.toolName === "ExitPlanMode") return !isTerminal(tool.status);
		if (tool.toolName === "GenUI") {
			const action = input.action;
			if (action === "inspect" || action === "kit_status" || action === "create") return false;
			if (action === "render" || action === "show" || action === undefined) return true;
			const kitRequest = objectValue(objectValue(metadata.genUiKit).request);
			return action === "kit_build" && (!isTerminal(tool.status) || kitRequest.state === "pending");
		}
	}
	if (PREFER_OPEN_TOOL_NAMES.has(tool.toolName)) return true;
	// A question wait is an answer surface, not an ordinary task-status card.
	const input = tool.inputJson;
	// Outline Ask also records answers and withdrawals; only new questions are an
	// answer surface. Keep those calls separate from activity traces at every LOD.
	if (tool.toolName === "Ask") {
		return (
			typeof input === "object" &&
			input !== null &&
			"questions" in input &&
			Array.isArray(input.questions) &&
			input.questions.length > 0 &&
			!("withdraw" in input) &&
			!("answered" in input)
		);
	}
	return (
		tool.toolName === "Await" &&
		(tool.status === "running" || tool.status === "executing") &&
		typeof input === "object" &&
		input !== null &&
		"type" in input &&
		input.type === "question"
	);
}

function objectValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isTerminal(status?: string | null): boolean {
	return (
		status != null &&
		["success", "fail", "error", "denied", "cancelled", "interrupted", "completed"].includes(status)
	);
}

/** Category-level twin for measure inputs that carry `category` instead of the name. */
export function prefersOpenToolCategory(category: string | undefined): boolean {
	// Deliberately not `"plan"`: see module doc — EnterPlanMode shares that category.
	return category === "ask";
}
