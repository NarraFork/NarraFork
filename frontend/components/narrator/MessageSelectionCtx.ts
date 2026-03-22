import { createContext, useContext } from "react";

/**
 * Attribute name placed on every selectable content block (ContentViewer / ToolCallCard).
 * Used by the selection logic to enumerate blocks in DOM order.
 */
export const BLOCK_ID_ATTR = "data-block-id";

export interface MessageSelectionState {
	/** Whether multi-select mode is active. */
	selectionMode: boolean;
	/** Set of currently selected block IDs. */
	selectedBlockIds: Set<string>;
	/** The anchor block ID (first swipe). */
	anchorBlockId: string | null;
	/** Exit multi-select mode and clear selection. */
	exitSelection: () => void;
	/** Remove a single block from the selection. Exits selection mode if empty. */
	deselectBlock: (blockId: string) => void;
}

const DEFAULT_STATE: MessageSelectionState = {
	selectionMode: false,
	selectedBlockIds: new Set(),
	anchorBlockId: null,
	exitSelection: () => {},
	deselectBlock: () => {},
};

export const MessageSelectionCtx = createContext<MessageSelectionState>(DEFAULT_STATE);

export function useMessageSelection() {
	return useContext(MessageSelectionCtx);
}

// ---------------------------------------------------------------------------
// DOM helper — resolve all block IDs between anchor and target (inclusive)
// by walking the DOM in document order.
// ---------------------------------------------------------------------------

/**
 * Given a container element, find all elements with `data-block-id` in DOM order,
 * then return the set of block IDs between `anchorId` and `targetId` (inclusive).
 * Returns null if either anchor or target is not found.
 */
export function resolveBlockRange(
	container: HTMLElement,
	anchorId: string,
	targetId: string,
): Set<string> | null {
	const allBlocks = container.querySelectorAll<HTMLElement>(`[${BLOCK_ID_ATTR}]`);
	const ids: string[] = [];
	let anchorIdx = -1;
	let targetIdx = -1;
	for (let i = 0; i < allBlocks.length; i++) {
		const id = allBlocks[i].getAttribute(BLOCK_ID_ATTR) ?? "";
		ids.push(id);
		if (id === anchorId) anchorIdx = i;
		if (id === targetId) targetIdx = i;
	}
	if (anchorIdx === -1 || targetIdx === -1) return null;
	const lo = Math.min(anchorIdx, targetIdx);
	const hi = Math.max(anchorIdx, targetIdx);
	const result = new Set<string>();
	for (let i = lo; i <= hi; i++) {
		result.add(ids[i]);
	}
	return result;
}
