import { createContext, useContext } from "react";

export interface StreamingRevealValue {
	/** Number of newly arrived characters in this render frame */
	newCharCount: number;
	/** Whether the text just transitioned from plain-text to markdown rendering.
	 *  When true, the existing text should NOT be animated — only truly new chars. */
	justBecameMd: boolean;
}

const DEFAULT: StreamingRevealValue = { newCharCount: 0, justBecameMd: false };

export const StreamingRevealContext = createContext<StreamingRevealValue>(DEFAULT);

export function useStreamingReveal() {
	return useContext(StreamingRevealContext);
}
