import { createContext, type ReactNode, useContext } from "react";

/** Detaches the message list from its bottom-follow state. Provided by the
 *  message list so deeply nested blocks (e.g. a ContentViewer) can release the
 *  follow loop before scrolling away from the bottom. */
const DetachFromBottomCtx = createContext<(() => void) | null>(null);

export function DetachFromBottomProvider({
	value,
	children,
}: {
	value: (() => void) | null;
	children: ReactNode;
}) {
	return <DetachFromBottomCtx.Provider value={value}>{children}</DetachFromBottomCtx.Provider>;
}

export function useDetachFromBottom(): () => void {
	return useContext(DetachFromBottomCtx) ?? (() => {});
}
