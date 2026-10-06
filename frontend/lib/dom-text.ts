const BLOCK_BOUNDARY_TAGS = new Set([
	"ADDRESS",
	"ARTICLE",
	"ASIDE",
	"BLOCKQUOTE",
	"DD",
	"DETAILS",
	"DIALOG",
	"DIV",
	"DL",
	"DT",
	"FIELDSET",
	"FIGCAPTION",
	"FIGURE",
	"FOOTER",
	"FORM",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HEADER",
	"HR",
	"LI",
	"MAIN",
	"NAV",
	"OL",
	"P",
	"PRE",
	"SECTION",
	"TABLE",
	"TBODY",
	"TD",
	"TFOOT",
	"TH",
	"THEAD",
	"TR",
	"UL",
]);

function isHiddenElement(element: Element): boolean {
	if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
	const style = window.getComputedStyle(element);
	return (
		style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
	);
}

function isInsideHiddenElement(node: Node, stopAt: Element): boolean {
	let element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	while (element) {
		if (isHiddenElement(element)) return true;
		if (element === stopAt) break;
		element = element.parentElement;
	}
	return false;
}

function isBlockBoundaryElement(element: Element): boolean {
	return BLOCK_BOUNDARY_TAGS.has(element.tagName);
}

export interface TextPreviewResult {
	text: string;
	truncated: boolean;
}

function appendBounded(current: string, value: string, maxChars: number): string {
	if (!value || current.length >= maxChars) return current;
	const remaining = maxChars - current.length;
	return current + (value.length > remaining ? value.slice(0, remaining) : value);
}

function appendBoundedPreview(current: string, value: string, maxChars: number): TextPreviewResult {
	if (!value) return { text: current, truncated: false };
	if (current.length >= maxChars) return { text: current, truncated: true };
	const remaining = maxChars - current.length;
	return {
		text: current + (value.length > remaining ? value.slice(0, remaining) : value),
		truncated: value.length > remaining,
	};
}

function appendLineBoundary(current: string, maxChars: number): string {
	if (!current || current.endsWith("\n")) return current;
	return appendBounded(current, "\n", maxChars);
}

function appendLineBoundaryPreview(current: string, maxChars: number): TextPreviewResult {
	if (!current || current.endsWith("\n")) return { text: current, truncated: false };
	return appendBoundedPreview(current, "\n", maxChars);
}

export function collectElementTextPreviewResult(
	root: Element,
	maxChars: number,
): TextPreviewResult {
	if (maxChars <= 0 || isHiddenElement(root)) return { text: "", truncated: false };
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			if (node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
			return isHiddenElement(node as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
		},
	});
	let result = "";
	let truncated = false;
	while (!truncated) {
		const node = walker.nextNode();
		if (!node) break;
		if (node.nodeType === Node.ELEMENT_NODE) {
			const element = node as Element;
			let appended: TextPreviewResult | null = null;
			if (element.tagName === "BR") {
				appended = appendBoundedPreview(result, "\n", maxChars);
			} else if (isBlockBoundaryElement(element)) {
				appended = appendLineBoundaryPreview(result, maxChars);
			}
			if (appended) {
				result = appended.text;
				truncated = appended.truncated;
			}
			continue;
		}

		const value = node.nodeValue ?? "";
		const appended = appendBoundedPreview(result, value, maxChars);
		result = appended.text;
		truncated = appended.truncated;
	}
	return { text: result, truncated };
}

export function collectElementTextPreview(root: Element, maxChars: number): string {
	return collectElementTextPreviewResult(root, maxChars).text;
}

export function compactWhitespacePreview(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function collectSelectionTextPreview(selection: Selection | null, maxChars: number): string {
	if (!selection || selection.isCollapsed || maxChars <= 0) return "";
	let result = "";

	for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex++) {
		const range = selection.getRangeAt(rangeIndex);
		const ancestor = range.commonAncestorContainer;
		const root =
			ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as Element) : ancestor.parentElement;
		if (!root || isHiddenElement(root)) continue;

		const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
			acceptNode: (node) => {
				if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
				if (node.nodeType === Node.ELEMENT_NODE) {
					return isHiddenElement(node as Element)
						? NodeFilter.FILTER_REJECT
						: NodeFilter.FILTER_ACCEPT;
				}
				return isInsideHiddenElement(node, root)
					? NodeFilter.FILTER_REJECT
					: NodeFilter.FILTER_ACCEPT;
			},
		});

		while (result.length < maxChars) {
			const node = walker.nextNode();
			if (!node) break;
			if (node.nodeType === Node.ELEMENT_NODE) {
				const element = node as Element;
				if (element.tagName === "BR") {
					result = appendBounded(result, "\n", maxChars);
				} else if (isBlockBoundaryElement(element)) {
					result = appendLineBoundary(result, maxChars);
				}
				continue;
			}

			const value = node.nodeValue ?? "";
			if (!value) continue;

			let start = 0;
			let end = value.length;
			if (node === range.startContainer) start = range.startOffset;
			if (node === range.endContainer) end = range.endOffset;
			if (start >= end) continue;

			result = appendBounded(result, value.slice(start, end), maxChars);
		}
		if (result.length >= maxChars) break;
	}

	return result.trim();
}
