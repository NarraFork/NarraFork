import { createContext, useContext } from "react";

/**
 * Attribute name placed on every selectable content block (ContentViewer / ToolCallCard).
 * Used by the selection logic to enumerate blocks in DOM order.
 */
export const BLOCK_ID_ATTR = "data-block-id";

/**
 * When set to a non-null string, nested ContentViewers should NOT register
 * their own block ID for multi-select. The value is the parent ToolCallCard's
 * blockId, used as the swipe anchor when the nested viewer's menu is revealed.
 */
export const NestedBlockCtx = createContext<string | null>(null);

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
	/** Toggle a single block (Ctrl/Cmd+Click). Enters selection mode if not active. */
	toggleBlock: (blockId: string) => void;
	/** Range-select from anchor to target (Shift+Click). */
	rangeSelectTo: (blockId: string) => void;
}

const DEFAULT_STATE: MessageSelectionState = {
	selectionMode: false,
	selectedBlockIds: new Set(),
	anchorBlockId: null,
	exitSelection: () => {},
	deselectBlock: () => {},
	toggleBlock: () => {},
	rangeSelectTo: () => {},
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

// ---------------------------------------------------------------------------
// DOM helpers for batch operations — extract metadata from selected blocks.
// ---------------------------------------------------------------------------

export interface BlockMeta {
	blockId: string;
	messageId: string;
	blockIndex: number;
}

/**
 * Walk the container's `[data-block-id]` elements in DOM order and return
 * metadata for every block whose ID is in `selectedIds`.
 * Only blocks that carry both `data-message-id` and `data-block-index` are included.
 */
export function resolveSelectedBlockMeta(
	container: HTMLElement,
	selectedIds: Set<string>,
): BlockMeta[] {
	const allBlocks = container.querySelectorAll<HTMLElement>(`[${BLOCK_ID_ATTR}]`);
	const result: BlockMeta[] = [];
	for (const el of allBlocks) {
		const blockId = el.getAttribute(BLOCK_ID_ATTR);
		if (!blockId || !selectedIds.has(blockId)) continue;
		const messageId = el.getAttribute("data-message-id");
		const blockIndexStr = el.getAttribute("data-block-index");
		if (!messageId || blockIndexStr == null) continue;
		result.push({ blockId, messageId, blockIndex: Number(blockIndexStr) });
	}
	return result;
}

/**
 * Extract deduplicated message IDs from selected blocks in DOM order.
 * Unlike resolveSelectedBlockMeta, this does NOT require data-block-index,
 * and walks up the DOM to find the nearest data-message-id ancestor when
 * the block itself doesn't carry one (e.g. nested ContentViewer blocks).
 */
export function resolveSelectedMessageIds(
	container: HTMLElement,
	selectedIds: Set<string>,
): string[] {
	const allBlocks = container.querySelectorAll<HTMLElement>(`[${BLOCK_ID_ATTR}]`);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const el of allBlocks) {
		const blockId = el.getAttribute(BLOCK_ID_ATTR);
		if (!blockId || !selectedIds.has(blockId)) continue;
		// Try the element itself, then walk up to find the nearest message ID
		let messageId = el.getAttribute("data-message-id");
		if (!messageId) {
			let parent = el.parentElement;
			while (parent && parent !== container) {
				messageId = parent.getAttribute("data-message-id");
				if (messageId) break;
				parent = parent.parentElement;
			}
		}
		if (messageId && !seen.has(messageId)) {
			seen.add(messageId);
			result.push(messageId);
		}
	}
	return result;
}

/**
 * Collect the visible text content of all selected blocks in DOM order.
 * For `cv-*` blocks, uses the `handleRegistry` via `data-cv-id` if available,
 * otherwise falls back to `innerText`.
 * For `tc-*` blocks, uses `innerText`.
 */
export function collectSelectedText(
	container: HTMLElement,
	selectedIds: Set<string>,
	handleRegistry?: Map<number, { getContent?: () => string }>,
): string {
	const allBlocks = container.querySelectorAll<HTMLElement>(`[${BLOCK_ID_ATTR}]`);
	const parts: string[] = [];
	for (const el of allBlocks) {
		const blockId = el.getAttribute(BLOCK_ID_ATTR);
		if (!blockId || !selectedIds.has(blockId)) continue;
		let text: string | undefined;
		// Try handleRegistry for ContentViewer blocks
		if (blockId.startsWith("cv-") && handleRegistry) {
			const cvId = el.getAttribute("data-cv-id");
			if (cvId != null) {
				const handle = handleRegistry.get(Number(cvId));
				text = handle?.getContent?.();
			}
		}
		if (!text) {
			text = el.innerText;
		}
		if (text?.trim()) {
			parts.push(text.trim());
		}
	}
	return parts.join("\n\n");
}
