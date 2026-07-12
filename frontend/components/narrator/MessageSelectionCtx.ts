import { createContext, useContext } from "react";
import { collectElementTextPreviewResult } from "../../lib/dom-text";

/**
 * Attribute name placed on every selectable content block (ContentViewer / ToolCallCard).
 * Used by the selection logic to enumerate blocks in DOM order.
 */
export const BLOCK_ID_ATTR = "data-block-id";
/** Optional comma-separated original indices represented by one merged visual block. */
export const BLOCK_INDICES_ATTR = "data-block-indices";

/** Attribute placed on interactive islands that must not trigger message-block selection. */
export const MESSAGE_SELECTION_IGNORE_ATTR = "data-message-selection-ignore";

const MESSAGE_SELECTION_IGNORE_SELECTOR = [
	`[${MESSAGE_SELECTION_IGNORE_ATTR}]`,
	"input",
	"textarea",
	"select",
	"button",
	"a",
	"label",
	"[contenteditable='true']",
	"[role='button']",
	"[role='checkbox']",
	"[role='radio']",
	"[role='textbox']",
	"[role='option']",
	"[role='switch']",
	"[role='menuitem']",
	".mantine-Menu-dropdown",
	".mantine-Combobox-dropdown",
	".mantine-Modal-root",
].join(", ");

/** Return true when a click target belongs to an interactive area, not selectable content. */
export function shouldIgnoreMessageBlockSelection(target: EventTarget | null): boolean {
	return target instanceof Element && !!target.closest(MESSAGE_SELECTION_IGNORE_SELECTOR);
}

/**
 * When set to a non-null string, nested ContentViewers should NOT register
 * their own block ID for multi-select. The value is the parent ToolCallCard's
 * blockId, used as the swipe anchor when the nested viewer's menu is revealed.
 */
export const NestedBlockCtx = createContext<string | null>(null);

export interface BlockMeta {
	blockId: string;
	messageId: string;
	blockIndex: number;
}

export interface CollectedSelectedText {
	text: string;
	truncated: boolean;
}

export type MaybePromise<T> = T | Promise<T>;

export interface MessageSelectionResolver {
	resolveRange?: (anchorBlockId: string, targetBlockId: string) => MaybePromise<Set<string> | null>;
	resolveSelectedMeta?: (selectedIds: Set<string>) => BlockMeta[];
	resolveSelectedMessageIds?: (selectedIds: Set<string>) => string[];
	collectSelectedText?: (selectedIds: Set<string>) => CollectedSelectedText;
}

export interface MessageSelectionState {
	selectionMode: boolean;
	selectedBlockIds: Set<string>;
	anchorBlockId: string | null;
	exitSelection: () => void;
	deselectBlock: (blockId: string) => void;
	toggleBlock: (blockId: string) => void;
	rangeSelectTo: (blockId: string) => void;
}

export const MAX_COLLECTED_SELECTED_TEXT_CHARS = 200_000;

export function makeMessageBlockSelectionId(messageId: string, blockIndex: number): string {
	return `msg-${messageId}-${blockIndex}`;
}

export function parseMessageBlockIndices(value: string | null | undefined): number[] {
	if (!value) return [];
	const indices = new Set<number>();
	for (const part of value.split(",")) {
		const index = Number(part.trim());
		if (Number.isInteger(index) && index >= 0) indices.add(index);
	}
	return [...indices].sort((a, b) => a - b);
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
		const mergedIndices = parseMessageBlockIndices(el.getAttribute(BLOCK_INDICES_ATTR));
		const blockIndices = mergedIndices.length > 0 ? mergedIndices : [Number(blockIndexStr)];
		for (const blockIndex of blockIndices) {
			if (!Number.isInteger(blockIndex) || blockIndex < 0) continue;
			result.push({ blockId, messageId, blockIndex });
		}
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
 * For `cv-*` blocks, uses the `handleRegistry` via `data-cv-id` if available.
 * Otherwise, falls back to bounded DOM text traversal instead of materializing `innerText`.
 */
export function collectSelectedText(
	container: HTMLElement,
	selectedIds: Set<string>,
	handleRegistry?: Map<number, { getContent?: () => string }>,
): CollectedSelectedText {
	const allBlocks = container.querySelectorAll<HTMLElement>(`[${BLOCK_ID_ATTR}]`);
	const parts: string[] = [];
	let remaining = MAX_COLLECTED_SELECTED_TEXT_CHARS;
	let truncated = false;
	for (const el of allBlocks) {
		const blockId = el.getAttribute(BLOCK_ID_ATTR);
		if (!blockId || !selectedIds.has(blockId)) continue;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		let text: string | undefined;
		let fallbackTruncated = false;
		// Try handleRegistry for ContentViewer blocks
		if (blockId.startsWith("cv-") && handleRegistry) {
			const cvId = el.getAttribute("data-cv-id");
			if (cvId != null) {
				const handle = handleRegistry.get(Number(cvId));
				text = handle?.getContent?.();
			}
		}
		if (!text) {
			const preview = collectElementTextPreviewResult(el, remaining);
			text = preview.text;
			fallbackTruncated = preview.truncated;
		}
		if (!text) {
			if (fallbackTruncated) {
				truncated = true;
				break;
			}
			continue;
		}

		let start = 0;
		let end = text.length;
		while (start < end && /\s/.test(text[start])) start++;
		while (end > start && /\s/.test(text[end - 1])) end--;
		if (start >= end) {
			if (fallbackTruncated) {
				truncated = true;
				break;
			}
			continue;
		}

		const separator = parts.length > 0 ? "\n\n" : "";
		const available = remaining - separator.length;
		if (available <= 0) {
			truncated = true;
			break;
		}
		parts.push(separator);
		const textLength = end - start;
		if (textLength > available) {
			parts.push(text.slice(start, start + available));
			truncated = true;
			break;
		}
		parts.push(text.slice(start, end));
		remaining -= separator.length + textLength;
		if (fallbackTruncated) {
			truncated = true;
			break;
		}
	}
	return { text: parts.join(""), truncated };
}
