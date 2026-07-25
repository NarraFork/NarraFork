/**
 * trace-row-menu.ts — Bind a folded trace row's message-level menu actions.
 *
 * The panel exposes handlers keyed by (messageId, blockIndex); the context-menu
 * system consumes a parameterless MessageContextMenuActions that already closes
 * over those coordinates. This bridges the two for trace rows, mirroring exactly
 * how the chunked path builds `ctxActions` for an expanded card
 * (MessageRenderer.tsx:158-181) — including using the message's `messageUuid`
 * (not its id) for fork, which is what onForkFromMessage expects.
 *
 * Pure + DOM-free so both render paths can share it.
 */

import type { MessageContextMenuActions } from "./MessageContextMenuCtx";

/**
 * Panel handlers a trace row may bind. Names/signatures match the chunked
 * renderer's props; an absent handler hides the corresponding menu item.
 */
export interface TraceRowHandlers {
	onForkFromMessage?: (messageUuid: string) => void;
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	onClearContextBefore?: (messageId: string) => void;
	onManualSummarize?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void;
}

/** The owning message coordinates a row's actions close over. */
export interface TraceRowActionTarget {
	messageId: string;
	/** Message UUID — required by fork (absent → no fork item), like the card path. */
	messageUuid?: string | null;
}

/**
 * Build the closed-over message actions for one trace row. Only handlers that
 * are present (and whose required ids exist) produce an action, so the menu
 * gating matches the expanded card exactly.
 */
export function buildTraceRowActions(
	target: TraceRowActionTarget,
	handlers: TraceRowHandlers,
): MessageContextMenuActions {
	const { messageId, messageUuid } = target;
	const actions: MessageContextMenuActions = { messageId };
	if (!messageId) return actions;

	if (messageUuid && handlers.onForkFromMessage) {
		actions.onForkFromMessage = () => handlers.onForkFromMessage?.(messageUuid);
	}
	if (handlers.onAskInPassing) {
		actions.onAskInPassing = () => handlers.onAskInPassing?.(messageUuid ?? null, messageId);
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
		actions.onDeleteBlock = (blockIndex: number) => handlers.onDeleteBlock?.(messageId, blockIndex);
	}
	if (handlers.onRollbackToBlock) {
		actions.onRollbackToBlock = (blockIndex: number) =>
			handlers.onRollbackToBlock?.(messageId, blockIndex);
	}
	return actions;
}
