/**
 * What the host of an outline surface can do beyond navigating it: open a session beside it.
 * The outline page's dock opens the session as a panel next to the outline, a session's dock
 * opens it in its secondary area, a phone navigates to it. Without a host action the control
 * is not shown.
 */
import { createContext, type ReactNode, useContext, useMemo } from "react";

export interface OutlineHostActions {
	/** Open a session (an agent commit's author) beside the outline. */
	openSession?: (narratorId: string) => void;
}

const OutlineHostContext = createContext<OutlineHostActions>({});

export function OutlineHostProvider({
	openSession,
	children,
}: OutlineHostActions & { children: ReactNode }) {
	const value = useMemo(() => ({ openSession }), [openSession]);
	return <OutlineHostContext.Provider value={value}>{children}</OutlineHostContext.Provider>;
}

export function useOutlineHost(): OutlineHostActions {
	return useContext(OutlineHostContext);
}
