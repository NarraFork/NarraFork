import { createContext, useContext } from "react";

export interface MessageContextMenuActions {
	/** The message ID this context belongs to (used by multi-select to map blockId → messageId). */
	messageId?: string;
	onForkFromMessage?: () => void;
	onAskInPassing?: () => void;
	onCompactBeforeMessage?: () => void;
	onClearContextBefore?: () => void;
	onManualSummarize?: () => void;
	onDeleteBlock?: (blockIndex: number) => Promise<void> | void;
	onRollbackToBlock?: (blockIndex: number) => void;
	onEditMessage?: () => void;
	/** Queue-control actions use the mailbox row id, not the canonical message id. */
	onCancelQueued?: () => void;
	onRetryQueued?: () => void;
	onJumpToSource?: () => void;
	onRetryCompact?: () => void;
	onDismissFailedCompact?: () => void;
}

export const MessageContextMenuCtx = createContext<MessageContextMenuActions>({});

export function useMessageContextMenu() {
	return useContext(MessageContextMenuCtx);
}
