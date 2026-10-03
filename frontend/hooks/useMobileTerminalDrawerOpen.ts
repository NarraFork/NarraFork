import { useCallback } from "react";

export interface MobileTerminalDrawerOpenOptions {
	terminalSupported: boolean;
	hasRunningTerminal: boolean;
	createTerminal: (data: { name: string }) => void;
	openDrawer: () => void;
}

/** Depend on the stable action, not the mutation observer's changing result object. */
export function useMobileTerminalDrawerOpen({
	terminalSupported,
	hasRunningTerminal,
	createTerminal,
	openDrawer,
}: MobileTerminalDrawerOpenOptions): () => void {
	return useCallback(() => {
		if (terminalSupported && !hasRunningTerminal) createTerminal({ name: "Terminal 1" });
		openDrawer();
	}, [terminalSupported, hasRunningTerminal, createTerminal, openDrawer]);
}
