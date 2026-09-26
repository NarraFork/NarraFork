/** Subagent-only reference: resolve against the current parent at run time, never a snapshot. */
export const FOLLOW_PARENT_MODEL = "__parent__";

/**
 * What a `__parent__` subagent actually resolved to on its latest run.
 *
 * The stored selection only says "follow the parent"; the allowed model pool can
 * still reject the parent's model, in which case the child runs on the pool's
 * first entry. Without this the UI keeps saying "follow parent" while the child
 * silently runs something else.
 */
export interface SubagentModelInheritance {
	/** `parent`: the parent's model was allowed. `pool-fallback`: it was not. */
	source: "parent" | "pool-fallback";
	/** The pool-authorized reference the child runs on. */
	model: string;
	/** The parent's model that was followed or rejected. */
	parentModel: string;
	/** Pool that made the decision; absent when no pool restricts this type. */
	poolKey?: string;
	/**
	 * The parent's own reasoning-effort override. A child with no override of its
	 * own (and no fixed pool tier) follows it; absent means the parent follows the
	 * global default, and so does the child.
	 */
	parentReasoningEffort?: string;
}

export function isSubagentModelInheritance(value: unknown): value is SubagentModelInheritance {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		(v.source === "parent" || v.source === "pool-fallback") &&
		typeof v.model === "string" &&
		typeof v.parentModel === "string" &&
		(v.poolKey === undefined || typeof v.poolKey === "string") &&
		(v.parentReasoningEffort === undefined || typeof v.parentReasoningEffort === "string")
	);
}
