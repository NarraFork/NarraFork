/**
 * vlist-row-actions.ts — Build the per-row MessageContextMenuActions for the
 * vlist interaction layer.
 *
 * The NarratorPanel handlers take (messageId, blockIndex); the context-menu
 * system consumes a parameterless MessageContextMenuActions that already closes
 * over those coordinates. This module bridges the two, mirroring how the
 * chunked path builds ctxActions (MessageBubble.tsx:4837 / MessageRenderer.tsx:158).
 *
 * Pure + DOM-free: it takes the resolved block target (+ the authoritative
 * selection entry's blockIndices for reasoning runs) and the panel handlers,
 * and returns the closed-over actions object.
 *
 * It also builds the CARD-SPECIFIC actions (buildRowToolActions) that the
 * chunked ToolCallCard / SubagentCard add on top of the shared message menu —
 * open child session, detach to background, cancel background task — bound from
 * the row's tool metadata (vlist-tool-meta.ts).
 */

import type { MessageContextMenuActions } from "../MessageContextMenuCtx";
import type { VListToolMeta } from "./vlist-tool-meta";

/**
 * Single-block action handlers, with the same names/signatures as
 * ChunkedMessageList's props (all optional; an absent handler hides the item).
 */
export interface VListRowHandlers {
	onForkFromMessage?: (messageId: string) => void;
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	onClearContextBefore?: (messageId: string) => void;
	onManualSummarize?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void;
	/** Open a child narrator's full session (subagent card / Await-agent card). */
	onViewSubagentSession?: (narratorId: string) => void;
	/** Detach a running subagent to a background task; absent → item hidden. */
	onDetachSubagent?: (narratorId: string) => void;
	/** Cancel a background subagent task; absent → item hidden. */
	onCancelBackgroundTask?: (narratorId: string) => void;
}

/**
 * The card-specific (command-style) actions a row's menu may offer, already
 * bound to that row's tool. Unlike MessageContextMenuActions these are NOT
 * message-level: they act on the row's tool call / child narrator, mirroring the
 * items ToolCallCard / SubagentCard add on top of the shared message menu.
 *
 * Every field is optional; an absent field hides its item, exactly like the
 * chunked path gates on a missing handler or a missing target id.
 */
export interface VListRowToolActions {
	/** "Open full session" / "View session" — the resolved child narrator id. */
	onViewSubagentSession?: () => void;
	/** "Detach to background". */
	onDetachSubagent?: () => void;
	/** "Cancel background task". */
	onCancelBackgroundTask?: () => void;
}

/**
 * Bind the card-specific actions for one row from its tool metadata.
 *
 * Gating mirrors the chunked path:
 *  - view session: a resolved child narrator id (subagent activity, or an
 *    Await({type:"agent"}) whose target resolved) + the panel handler.
 *  - detach: handler + child narrator + not already background + not terminal.
 *  - cancel: handler + child narrator + currently background.
 */
export function buildRowToolActions(
	meta: VListToolMeta | undefined,
	handlers: VListRowHandlers,
): VListRowToolActions {
	const actions: VListRowToolActions = {};
	if (!meta) return actions;

	// A subagent card knows its child directly; an Await-agent card knows it only
	// once the target resolved (an unresolved target has nothing to open).
	const sessionNarratorId = meta.subagentNarratorId ?? meta.awaitAgentNarratorId;
	if (sessionNarratorId && handlers.onViewSubagentSession) {
		actions.onViewSubagentSession = () => handlers.onViewSubagentSession?.(sessionNarratorId);
	}

	// Background lifecycle actions only ever apply to a real child narrator.
	const childNarratorId = meta.subagentNarratorId;
	if (childNarratorId) {
		if (handlers.onDetachSubagent && !meta.isBackground && !meta.isTerminal) {
			actions.onDetachSubagent = () => handlers.onDetachSubagent?.(childNarratorId);
		}
		if (handlers.onCancelBackgroundTask && meta.isBackground && !meta.isTerminal) {
			actions.onCancelBackgroundTask = () => handlers.onCancelBackgroundTask?.(childNarratorId);
		}
	}

	return actions;
}

export interface VListRowActionTarget {
	/** Owning message id (authoritative, from the selection entry when present). */
	messageId: string;
	/** Primary block index of this row. */
	blockIndex: number;
	/**
	 * All original block indices this row represents. A reasoning run merges
	 * several source blocks into one visual card; delete/rollback must act on
	 * each. Defaults to `[blockIndex]` when omitted.
	 */
	blockIndices?: readonly number[];
}

/**
 * Build the closed-over context-menu actions for one row. Only handlers that
 * are present produce an action; the interaction layer renders a menu item only
 * when the corresponding action is defined (same gating as the chunked path).
 *
 * Note: `onEditMessage` is intentionally NOT produced here — inline message
 * editing lives in the renderer's own editing UI (EditingMessageCtx/startEditing),
 * which the vlist pure renderers do not host yet. It is added when that lands.
 */
export function buildRowCtxActions(
	target: VListRowActionTarget,
	handlers: VListRowHandlers,
): MessageContextMenuActions {
	const { messageId } = target;
	const actions: MessageContextMenuActions = { messageId };

	if (handlers.onForkFromMessage) {
		actions.onForkFromMessage = () => handlers.onForkFromMessage?.(messageId);
	}
	if (handlers.onAskInPassing) {
		actions.onAskInPassing = () => handlers.onAskInPassing?.(null, messageId);
	}
	if (handlers.onCompactBeforeMessage) {
		actions.onCompactBeforeMessage = () => handlers.onCompactBeforeMessage?.(messageId);
	}
	if (handlers.onClearContextBefore) {
		actions.onClearContextBefore = () => handlers.onClearContextBefore?.(messageId);
	}
	if (handlers.onManualSummarize) {
		actions.onManualSummarize = () => handlers.onManualSummarize?.(messageId);
	}
	if (handlers.onDeleteBlock) {
		actions.onDeleteBlock = (bi) => handlers.onDeleteBlock?.(messageId, bi);
	}
	if (handlers.onRollbackToBlock) {
		actions.onRollbackToBlock = (bi) => handlers.onRollbackToBlock?.(messageId, bi);
	}

	return actions;
}

/** The block indices a delete action should iterate (reasoning runs span many). */
export function deleteBlockIndices(target: VListRowActionTarget): readonly number[] {
	return target.blockIndices && target.blockIndices.length > 0
		? target.blockIndices
		: [target.blockIndex];
}
