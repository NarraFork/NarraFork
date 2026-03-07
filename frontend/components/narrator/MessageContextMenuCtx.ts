import { createContext, useContext } from "react";

export interface MessageContextMenuActions {
	onForkFromMessage?: () => void;
	onCompactBeforeMessage?: () => void;
	onDeleteBlock?: (blockIndex: number) => void;
}

export const MessageContextMenuCtx = createContext<MessageContextMenuActions>({});

export function useMessageContextMenu() {
	return useContext(MessageContextMenuCtx);
}
