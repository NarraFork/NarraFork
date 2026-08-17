/**
 * vlist-spec-task-live.ts — which Dynamic Spec task row is describing work happening
 * RIGHT NOW.
 *
 * ## The bug this exists to close
 *
 * A spec task row carries a RECORDED status. `role: "doing"` means "this was the task
 * in progress when this digest was written", and every digest ever injected keeps that
 * word forever. The renderers used to animate on the status alone, so scrolling back
 * through a session showed a dozen task bubbles all spinning at once, each claiming to
 * be active — and the tool-call task board did the same for every historical
 * `spec://tasks.json` write.
 *
 * The chunked path never had this problem: `SpecTasksDetail` gates its spinner on
 * `isThinking && isLatestTasksCard`. This module is that same rule for the exact vlist,
 * kept pure and in one place because THREE surfaces need it (the framed injection
 * bubble, a standalone tasks card, and a tasks card drilled into from a folded trace).
 *
 * Two identities, because the two surfaces are addressed differently:
 *   - a task-board CARD is addressed by tool-use id (the pin the fold exemption and the
 *     chunked spinner already share — see `vlist-spec-tasks-pin.ts`);
 *   - an injection BUBBLE has no tool call at all, so it is addressed by its spec key,
 *     resolved as "the last spec-task bubble in the document".
 *
 * Both are gated by the caller on the narrator actually running: a settled session's
 * newest row is history too.
 */

/** Structural minimum of a laid-out item these helpers read. */
export interface SpecTaskLiveItemLike {
	spec: {
		key: string;
		kind: string;
		data?: unknown;
	};
	/**
	 * The measured element. Typed as `unknown` because only ONE kind is consulted: a
	 * measured tool card carries `toolUseId`, every other kind carries nothing of the
	 * sort, and narrowing to a card-shaped type here would force each caller to cast
	 * the whole heterogeneous item list.
	 */
	measured?: unknown;
}

/** The tool-use id of a measured tool card, or null for every other element kind. */
function measuredToolUseId(measured: unknown): string | null {
	if (!measured || typeof measured !== "object") return null;
	const id = (measured as { toolUseId?: unknown }).toolUseId;
	return typeof id === "string" && id.length > 0 ? id : null;
}

/** True when a spec's data carries a framed `spec-task` payload. */
function isSpecTaskBubbleSpec(spec: SpecTaskLiveItemLike["spec"]): boolean {
	if (spec.kind !== "injection-bubble") return false;
	const data = spec.data;
	if (!data || typeof data !== "object") return false;
	const payload = (data as { payload?: unknown }).payload;
	if (!payload || typeof payload !== "object") return false;
	return (payload as { kind?: unknown }).kind === "spec-task";
}

/**
 * The spec key of the LAST framed spec-task bubble in a laid-out document, or null.
 *
 * The item list is in document order, so the last match is the newest injection. Both
 * producers land here: the turn-end continuation (one task) and the periodic digest
 * (the whole open list) share the `spec-task` payload, and whichever came last is the
 * one whose `doing` row is still true.
 */
export function findLatestSpecTaskBubbleKey(items: readonly SpecTaskLiveItemLike[]): string | null {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item && isSpecTaskBubbleSpec(item.spec)) return item.spec.key;
	}
	return null;
}

/** The two live identities, resolved once per document build. */
export interface SpecTaskLiveGate {
	/** Spec key of the newest framed spec-task bubble, or null when nothing is live. */
	bubbleKey: string | null;
	/** Tool-use id of the newest `spec://tasks.json` card, or null when nothing is live. */
	toolUseId: string | null;
}

/**
 * Resolve the gate for a document.
 *
 * `active` is the narrator's own state: a settled session has NO live task row, even
 * though its last digest still says `doing`. That single term is what keeps a finished
 * conversation quiet, so it is applied here rather than at each call site.
 */
export function resolveSpecTaskLiveGate(
	items: readonly SpecTaskLiveItemLike[],
	active: boolean,
	latestSpecTasksToolUseId: string | null | undefined,
): SpecTaskLiveGate {
	if (!active) return { bubbleKey: null, toolUseId: null };
	return {
		bubbleKey: findLatestSpecTaskBubbleKey(items),
		toolUseId: latestSpecTasksToolUseId ?? null,
	};
}

/**
 * Whether THIS item's spec-task rows may animate.
 *
 * A tool card is matched by tool-use id (read off the measured card, the same value
 * the pin uses) and a bubble by spec key. Everything else is false — including a
 * bubble that merely happens to share a key prefix.
 */
export function isSpecTaskLiveItem(item: SpecTaskLiveItemLike, gate: SpecTaskLiveGate): boolean {
	if (gate.bubbleKey !== null && item.spec.key === gate.bubbleKey) return true;
	if (gate.toolUseId === null) return false;
	return measuredToolUseId(item.measured) === gate.toolUseId;
}
