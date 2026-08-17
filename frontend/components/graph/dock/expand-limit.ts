/**
 * How many graph nodes may host a live dockview surface at once.
 *
 * Each expanded node costs a dockview instance, its shell ResizeObserver, a
 * splitview, plus every panel's live session (a narrator WebSocket subscription,
 * an xterm attached to a PTY, a browser session). Those are not free the way a
 * collapsed node's Card is, so the canvas needs a ceiling rather than letting a
 * user open twenty and wonder why panning stutters.
 *
 * The decision is a pure function so "over the limit" cannot silently decay into
 * "do nothing" — the caller has to handle a named outcome.
 */

/** Maximum number of simultaneously expanded nodes. */
export const MAX_EXPANDED_NODES = 4;

export type ExpandRequest =
	/** Expand this node; it was not expanded before. */
	| { action: "expand" }
	/** Collapse this node; it was already expanded. */
	| { action: "collapse" }
	/**
	 * Refuse to expand: the limit is reached. `limit` is echoed back so the
	 * caller can render a message without importing the constant.
	 */
	| { action: "refuse"; reason: "limit"; limit: number };

/**
 * Decide what toggling `chapterId` should do.
 *
 * Collapsing is always allowed — it only frees resources, and refusing it would
 * strand a user at the limit with no way down.
 */
export function resolveExpandRequest(
	expanded: ReadonlySet<string>,
	chapterId: string,
	limit: number = MAX_EXPANDED_NODES,
): ExpandRequest {
	if (expanded.has(chapterId)) return { action: "collapse" };
	if (expanded.size >= limit) return { action: "refuse", reason: "limit", limit };
	return { action: "expand" };
}
