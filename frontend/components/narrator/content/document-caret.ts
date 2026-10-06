interface NativeCaret {
	offsetNode: Node;
	offset: number;
}
type CaretDocument = Document & {
	caretPositionFromPoint?: (x: number, y: number) => NativeCaret | null;
	caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function sourceElement(node: Node, root: HTMLElement): HTMLElement | null {
	const element = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
	const source = element?.closest<HTMLElement>("[data-source-start][data-source-end]") ?? null;
	return source && root.contains(source) ? source : null;
}

/** Native glyph/Bidi/grapheme hit testing runs only for a user gesture on bounded visible DOM. */
export function nativeDocumentCaretOffset(
	root: HTMLElement,
	x: number,
	y: number,
): number | undefined {
	const document = root.ownerDocument as CaretDocument;
	let caret: NativeCaret | undefined;
	try {
		const point = document.caretPositionFromPoint?.(x, y);
		if (point) caret = point;
		else {
			const range = document.caretRangeFromPoint?.(x, y);
			if (range) caret = { offsetNode: range.startContainer, offset: range.startOffset };
		}
	} catch {
		return undefined;
	}
	if (!caret || !root.contains(caret.offsetNode)) return undefined;
	const element = sourceElement(caret.offsetNode, root);
	if (!element) return undefined;
	const start = Number(element.dataset.sourceStart);
	const end = Number(element.dataset.sourceEnd);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
	if (caret.offsetNode.nodeType === 3) return Math.max(start, Math.min(end, start + caret.offset));
	const child = caret.offsetNode.childNodes[caret.offset];
	const childSource = child ? sourceElement(child, root) : null;
	if (childSource && childSource !== element) return Number(childSource.dataset.sourceStart);
	return caret.offset === 0 ? start : end;
}
