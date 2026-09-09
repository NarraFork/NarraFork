/**
 * vlist-jump-target.ts — Resolve a jump target to a top-level seq coordinate.
 *
 * A jump arrives as opaque ids: `msg-<messageId>`, a bare message id, or a tool
 * use id (a tool-only assistant turn has no `msg-` node of its own). When the
 * target is inside the loaded window the layout index answers directly and no
 * network call is needed. This module covers the other case — a target in history
 * the exact list has not loaded yet — where the window has to be extended upward
 * before anything can be revealed, and extending it requires knowing WHERE the
 * target sits in the narrator's seq space.
 *
 * Mirrors the chunked path's `resolveTargetSeq`, with the fetchers injected so the
 * resolution order (message first, tool call second, next candidate on failure) is
 * testable without a server.
 */

import type { PretextLayoutIndex } from "@shared/pretext-layout/index";

/** Prefer an exact tool row over the first row of its owning assistant message. */
export function jumpTargetItemIndex(index: PretextLayoutIndex, target: string): number | undefined {
	const id = jumpTargetMessageId(target);
	return index.itemByKey(`tool-${id}`)?.index ?? index.itemIndicesForSourceMessageId(id)[0];
}

/** Center inside this viewport only; native scrollIntoView also moves ancestors. */
export function jumpTargetScrollTop(viewport: HTMLElement, target: HTMLElement): number {
	const viewportRect = viewport.getBoundingClientRect();
	const targetRect = target.getBoundingClientRect();
	// Rects are visual pixels under classic graph zoom; scroll metrics are layout
	// pixels. offsetHeight includes borders (and scrollbars), just like the rect.
	const measuredScale = viewport.offsetHeight ? viewportRect.height / viewport.offsetHeight : 1;
	const scale = Number.isFinite(measuredScale) && measuredScale > 0 ? measuredScale : 1;
	return Math.max(
		0,
		Math.min(
			viewport.scrollHeight - viewport.clientHeight,
			viewport.scrollTop +
				(targetRect.top - viewportRect.top) / scale -
				viewport.clientTop -
				(viewport.clientHeight - targetRect.height / scale) / 2,
		),
	);
}

/** Look only inside this list: docked sessions can render the same message ids. */
export function mountedJumpTarget(
	root: HTMLElement,
	domIds: readonly string[],
	targetIds: readonly string[],
): HTMLElement | null {
	for (const target of targetIds) {
		const key = `tool-${jumpTargetMessageId(target)}`;
		const row = root.querySelector<HTMLElement>(`[data-nf-row-key="${CSS.escape(key)}"]`);
		if (row) return row;
	}
	const candidates = [
		...domIds,
		...targetIds.flatMap((target) => [target, `msg-${jumpTargetMessageId(target)}`]),
	];
	for (const id of candidates) {
		const element = root.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
		if (element) return element.closest<HTMLElement>("[data-nf-row-key]") ?? element;
	}
	return null;
}

/** Resolve a message id to its top-level ref seq (`getMessageLocation`). */
export type JumpMessageLocationFetcher = (messageId: string) => Promise<{
	seq: number;
	topLevelMessageId?: string;
}>;

/** Resolve a tool use id to the message that owns it (`getToolCallDetail`). */
export type JumpToolMessageFetcher = (toolUseId: string) => Promise<{ messageId?: string }>;

export interface ResolvedJumpTarget {
	/** Top-level ref seq the loaded window must cover for this target. */
	seq: number;
	/**
	 * The TOP-LEVEL message that renders the target. For a message nested in a
	 * subagent tree this is an ancestor, not the target itself, which is why it is
	 * reported separately: it is the id the layout index can actually locate.
	 */
	topLevelMessageId?: string;
}

/** Strip the `msg-` DOM-id prefix a caller may have passed instead of a raw id. */
export function jumpTargetMessageId(target: string): string {
	return target.startsWith("msg-") ? target.slice(4) : target;
}

/**
 * Try each candidate id in order, first as a message id and then as a tool use id,
 * returning the first that resolves. Rejections are swallowed per attempt on
 * purpose: an unknown id is the NORMAL case here (a tool use id is not a message
 * id, and vice versa), so a failure only means "try the next interpretation".
 * Returns null when nothing resolved.
 */
export async function resolveJumpTargetSeq(
	targetIds: readonly string[],
	fetchers: {
		fetchMessageLocation: JumpMessageLocationFetcher;
		fetchToolMessage: JumpToolMessageFetcher;
	},
): Promise<ResolvedJumpTarget | null> {
	for (const target of targetIds) {
		const messageId = jumpTargetMessageId(target);
		if (!messageId) continue;
		const direct = await locate(messageId, fetchers.fetchMessageLocation);
		if (direct) return direct;
		let ownerMessageId: string | undefined;
		try {
			ownerMessageId = (await fetchers.fetchToolMessage(messageId)).messageId;
		} catch {
			// Not a tool use id either; fall through to the next candidate.
		}
		if (!ownerMessageId || ownerMessageId === messageId) continue;
		const viaTool = await locate(ownerMessageId, fetchers.fetchMessageLocation);
		if (viaTool) return viaTool;
	}
	return null;
}

async function locate(
	messageId: string,
	fetchMessageLocation: JumpMessageLocationFetcher,
): Promise<ResolvedJumpTarget | null> {
	try {
		const location = await fetchMessageLocation(messageId);
		if (!Number.isFinite(location.seq)) return null;
		return { seq: location.seq, topLevelMessageId: location.topLevelMessageId };
	} catch {
		return null;
	}
}
