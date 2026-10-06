/**
 * vlist-exact-document.ts — the shell's document-lifecycle decisions.
 *
 * Extracted from `PretextExactMessageList.tsx` unchanged. These answer questions about
 * the LOADED DOCUMENT rather than about geometry: did a reconnect batch advance the
 * revision, must the document be rebuilt, is a layout renderable yet, and where does a
 * catch-up resume from.
 *
 * They are pure and separately testable, which matters because the failure modes are
 * quiet: a wrong revision delta does not throw, it makes the list stop noticing new
 * messages (or rebuild on every one).
 */

import type { TreeMessage } from "@frontend/lib/api/types";
import type { CatchUpCursor } from "@shared/narrator-catch-up";
import type { PretextLayoutIndex } from "@shared/pretext-layout";
import { resolveExactReloadDecision } from "./vlist-reload-policy";

/**
 * Resolve the revision deltas for one reconnect catch-up batch.
 *
 * A batch emits one message revision even when it carries multiple top-level
 * messages. Only a batch with at least one locally applied top-level message
 * advances the applied revision; the other cases preserve the existing
 * initial-sync/orphan/subagent behavior.
 */
export function resolveExactCatchUpRevisionDelta(input: {
	initialSync: boolean;
	topLevelCount: number;
	applied: boolean;
	orphanChildrenCount: number;
	subagentActivitiesCount: number;
}): { messageRevisionDelta: 0 | 1; appliedRevisionDelta: 0 | 1 } {
	const shouldBump =
		input.applied ||
		input.topLevelCount > 0 ||
		(!input.initialSync && (input.orphanChildrenCount > 0 || input.subagentActivitiesCount > 0));
	return {
		messageRevisionDelta: shouldBump ? 1 : 0,
		appliedRevisionDelta: input.applied ? 1 : 0,
	};
}

/**
 * Thin boolean view of {@link resolveExactReloadDecision}, retained so existing
 * callers/tests keep a stable entry point. The shell itself uses the full decision
 * because it also needs the `deferred` flag to drive the unread affordance.
 */
export function shouldReloadExactDocument(
	messageRevision: number,
	appliedRevision: number,
	hasIndex: boolean,
	pinnedToBottom: boolean,
): boolean {
	return resolveExactReloadDecision({
		messageRevision,
		appliedRevision,
		hasIndex,
		pinnedToBottom,
	}).reload;
}

export function hasRenderableExactLayout(
	index: PretextLayoutIndex | undefined,
	renderItemCount: number,
	manifestItemCount: number,
): boolean {
	return !!index && renderItemCount === manifestItemCount;
}

/**
 * True when the message carries a compact / segment_compact marker block.
 *
 * These markers get the full set of in-place treatments the other structural
 * inserts do not: a tail one is appended, a mid-window one is placed by
 * `insertMessage`, and its status flip (compacting → compacted/failed) is
 * applied through the live-patch channel. Everything else that restructures
 * the document (ask_in_passing, context_cleared) still answers the reload.
 */
export function isCompactMarkerMessage(message: TreeMessage | undefined): boolean {
	const blocks = message?.contentJson;
	if (!Array.isArray(blocks)) return false;
	for (const block of blocks) {
		const type = (block as { type?: unknown } | null)?.type;
		if (type === "compact" || type === "segment_compact") return true;
	}
	return false;
}

export function buildExactCatchUpCursor(
	messages: readonly { id?: unknown }[],
): CatchUpCursor | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const id = messages[index]?.id;
		if (typeof id === "string" && id.length > 0) return { parentLastMessageId: id };
	}
	return undefined;
}

export function buildExactMessageSnapshot(
	messages: readonly { id?: unknown }[],
	messageVersion: number | undefined,
) {
	if (messageVersion == null) return undefined;
	return { cursor: buildExactCatchUpCursor(messages), messageVersion };
}
