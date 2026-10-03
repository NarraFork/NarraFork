import type { ElementFrame, MeasuredElement } from "./prepared-block";

export const TEXT_PREVIEW_MAX_CHARS = 8192;
export const TEXT_PREVIEW_LINES = 12;
export const TEXT_PREVIEW_BUTTON_GAP = 4;

export interface TextPreview {
	sourceText: string;
	previewText: string;
	charCount: number;
	expanded: boolean;
	clipped: boolean;
	direction: "head" | "tail";
	plainText: boolean;
	bodyHeight: number;
	buttonHeight: number;
	sourceStart: number;
}

/** Slice UTF-16 without splitting a surrogate pair. Work is bounded by the window. */
export function selectTextPreview(
	text: string,
	expanded = false,
	direction: "head" | "tail" = "head",
): { text: string; start: number; truncated: boolean } {
	if (expanded || text.length <= TEXT_PREVIEW_MAX_CHARS) {
		return { text, start: 0, truncated: false };
	}
	let start = direction === "tail" ? text.length - TEXT_PREVIEW_MAX_CHARS : 0;
	let end = direction === "tail" ? text.length : TEXT_PREVIEW_MAX_CHARS;
	if (start > 0 && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) start++;
	if (end < text.length && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end--;
	return { text: text.slice(start, end), start, truncated: true };
}

function isHigh(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}
function isLow(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Visible-only geometry; retained blocks keep their original prepared handles. */
export function constrainTextPreview(
	measured: MeasuredElement,
	input: Omit<TextPreview, "bodyHeight" | "buttonHeight" | "clipped">,
	bodyBudget: number,
	buttonLineHeight: number,
): MeasuredElement {
	// Unknown intrinsic content cannot prove it fits its placeholder. Keep an
	// explicit disclosure path instead of allowing it to grow through the budget.
	const hasUnknown = measured.blocks.some(
		(block) => block.kind === "unknown" && !(block.tag === "katex" && block.intrinsicWidth != null),
	);
	const clipped =
		input.sourceText.length > TEXT_PREVIEW_MAX_CHARS ||
		measured.frame.contentHeight > bodyBudget ||
		hasUnknown;
	const bodyHeight = input.expanded
		? measured.frame.contentHeight
		: Math.min(measured.frame.contentHeight, bodyBudget);
	const buttonHeight = clipped || input.expanded ? buttonLineHeight + TEXT_PREVIEW_BUTTON_GAP : 0;
	const offset =
		!input.expanded && input.direction === "tail"
			? Math.max(0, measured.frame.contentHeight - bodyHeight)
			: 0;
	const blocks: MeasuredElement["blocks"] = [];
	const frames: ElementFrame["blocks"] = [];
	for (const originalFrame of measured.frame.blocks) {
		const top = originalFrame.top - offset;
		if (top >= bodyHeight || top + originalFrame.height <= 0) continue;
		const block = measured.blocks[originalFrame.index];
		if (!block) continue;
		const skipped = Math.max(0, -top);
		frames.push({
			...originalFrame,
			index: blocks.length,
			top: Math.max(0, top),
			height: Math.min(originalFrame.height - skipped, bodyHeight - Math.max(0, top)),
			renderOffset: skipped,
			renderLimited: !input.expanded && clipped,
		});
		blocks.push(block);
	}
	return {
		...measured,
		height: bodyHeight + buttonHeight,
		blocks,
		frame: { ...measured.frame, blocks: frames, contentHeight: bodyHeight },
		textPreview: { ...input, clipped, bodyHeight, buttonHeight },
	};
}
