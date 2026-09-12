/**
 * trace-row-menu.ts — Bind a folded trace row's message-level menu actions.
 *
 * The panel exposes handlers keyed by (messageId, blockIndex); the context-menu
 * system consumes a parameterless MessageContextMenuActions that already closes
 * over those coordinates. This bridges the two for trace rows, mirroring exactly
 * how the chunked path builds `ctxActions` for an expanded card
 * (MessageRenderer.tsx:158-181) — including forking by the message's local id
 * (not its SDK uuid, which only assistant messages carry).
 *
 * Pure + DOM-free so both render paths can share it.
 */

import type { MessageContextMenuActions } from "./message/MessageContextMenuCtx";

/**
 * Panel handlers a trace row may bind. Names/signatures match the chunked
 * renderer's props; an absent handler hides the corresponding menu item.
 */
export interface TraceRowHandlers {
	onForkFromMessage?: (messageId: string) => void;
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	onClearContextBefore?: (messageId: string) => void;
	onManualSummarize?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void;
}

/**
 * Subagent lifecycle handlers a folded row's menu may offer, on top of the
 * message-level ones. They act on a CHILD NARRATOR rather than a message, so
 * they are not part of `MessageContextMenuActions`; the panel owns the capability
 * gating and the api calls, and an absent handler hides its item.
 *
 * Deliberately a separate bag from `TraceRowHandlers`: those bind per message,
 * these are passed through unchanged to every row.
 */
export interface TraceRowSubagentHandlers {
	/** Open a child narrator's session (subagent + resolved Await-agent rows). */
	onViewSubagentSession?: (narratorId: string) => void;
	/** Detach a running subagent to a background task. */
	onDetachSubagent?: (narratorId: string) => void;
	/** Cancel a background subagent task. */
	onCancelBackgroundTask?: (narratorId: string) => void;
	/**
	 * Open a file-oriented tool's path in a read-only dock panel. Like the
	 * subagent handlers it acts on the ROW's tool rather than on a message, and it
	 * is only supplied by hosts that own a dockview surface — absent → item hidden.
	 */
	onOpenFilePanel?: (filePath: string) => void;
}

/** The owning message coordinates a row's actions close over. */
export interface TraceRowActionTarget {
	messageId: string;
	/** SDK message uuid — optional context for ask-in-passing (fork uses the id). */
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

	if (handlers.onForkFromMessage) {
		actions.onForkFromMessage = () => handlers.onForkFromMessage?.(messageId);
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
