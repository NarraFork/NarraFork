import { createContext, useContext } from "react";

export interface MessageContextMenuActions {
	onBranchFromMessage?: () => void;
	onForkFromMessage?: () => void;
	onCompactBeforeMessage?: () => void;
	onDeleteMessage?: () => void;
}

export const MessageContextMenuCtx = createContext<MessageContextMenuActions>({});

export function useMessageContextMenu() {
	return useContext(MessageContextMenuCtx);
}
