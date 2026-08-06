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

import type { RevertScope } from "../../../lib/api/narrators";
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
	/**
	 * Enter inline edit mode for this row's message. Injected by the shell (it
	 * owns the editing row state); absent → the item is hidden.
	 */
	onEditMessage?: (messageId: string) => void;
	/**
	 * Persist an edited USER message and regenerate from there (optionally
	 * rolling the worktree back). Same signature as ChunkedMessageList's prop;
	 * absent → user messages are not editable.
	 */
	onEditAndRegenerate?: (
		messageId: string,
		newContent: string,
		revertOpts: { skipRevert: boolean; scope?: RevertScope },
		opts?: {
			keepImageIds: string[];
			newImages: File[];
			keepTextFilePaths: string[];
			newTextFiles: File[];
		},
	) => Promise<boolean>;
	/** Persist edited ASSISTANT text without truncating later messages. */
	onEditAssistantMessage?: (messageId: string, newContent: string) => void;
	/** Restore an edited assistant message to its original text. */
	onRestoreAssistantMessage?: (messageId: string) => void;
	/** Open a child narrator's full session (subagent card / Await-agent card). */
	onViewSubagentSession?: (narratorId: string) => void;
	/** Detach a running subagent to a background task; absent → item hidden. */
	onDetachSubagent?: (narratorId: string) => void;
	/** Cancel a background subagent task; absent → item hidden. */
	onCancelBackgroundTask?: (narratorId: string) => void;
	/**
	 * Open a file-oriented tool's path in a read-only dock panel. Supplied only by
	 * hosts that own a dockview surface (focus page / workspace); absent → item
	 * hidden, exactly like the standalone narrator embed.
	 */
	onOpenFilePanel?: (filePath: string) => void;
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
	/** "Open in panel" — a file-oriented tool's path, bound to the dock host. */
	onOpenFilePanel?: () => void;
}

/**
 * Bind the card-specific actions for one row from its tool metadata.
 *
 * Gating mirrors the chunked path:
 *  - view session: a resolved child narrator id (subagent activity, or an
 *    Await({type:"agent"}) whose target resolved) + the panel handler.
 *  - detach: handler + child narrator + not already background + not terminal.
 *  - cancel: handler + child narrator + currently background.
 *  - open in panel: handler + a file-oriented tool that carries a path.
 */
export function buildRowToolActions(
	meta: VListToolMeta | undefined,
	handlers: VListRowHandlers,
): VListRowToolActions {
	const actions: VListRowToolActions = {};
	if (!meta) return actions;

	// File viewer: any Read / Write / Edit with a path (the panel shows the file's
	// current on-disk content, so a write is as valid an entry point as a read).
	const filePath = meta.filePath;
	if (meta.isFileTool && filePath && handlers.onOpenFilePanel) {
		actions.onOpenFilePanel = () => handlers.onOpenFilePanel?.(filePath);
	}

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
	/**
	 * Whether this row's message may be edited (resolved by the shell through
	 * `resolveVListEditTarget`). `false` hides the edit item even when the handler
	 * exists; omitted is treated as editable so existing callers are unaffected.
	 */
	editable?: boolean;
}

/**
 * Build the closed-over context-menu actions for one row. Only handlers that
 * are present produce an action; the interaction layer renders a menu item only
 * when the corresponding action is defined (same gating as the chunked path).
 *
 * `onEditMessage` is produced when the row's message is editable (see
 * `vlist-edit-target.ts`) and the shell supplied the handler. Unlike the chunked
 * path — where MessageBubble hosts its own editor — the shell owns the editing
 * row state and swaps the row body for the shared MessageEditorPanel.
 *
 * "View original" (for an edited message) deliberately does NOT go through here:
 * it is not part of the shared `MessageContextMenuActions` contract, so the shell
 * passes it straight to VListRowInteraction as its own prop, leaving the chunked
 * path's shared context untouched.
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
	if (target.editable !== false && handlers.onEditMessage) {
		actions.onEditMessage = () => handlers.onEditMessage?.(messageId);
	}

	return actions;
}

/** The block indices a delete action should iterate (reasoning runs span many). */
export function deleteBlockIndices(target: VListRowActionTarget): readonly number[] {
	return target.blockIndices && target.blockIndices.length > 0
		? target.blockIndices
		: [target.blockIndex];
}
