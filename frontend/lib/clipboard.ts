function createLegacyCopyElement(text: string): HTMLInputElement | HTMLTextAreaElement {
	const element = text.includes("\n")
		? document.createElement("textarea")
		: document.createElement("input");
	if (element instanceof HTMLInputElement) element.type = "text";
	element.value = text;
	element.readOnly = true;
	element.tabIndex = -1;
	element.setAttribute("aria-hidden", "true");
	Object.assign(element.style, {
		position: "fixed",
		left: "-9999px",
		top: "0",
		opacity: "0",
		pointerEvents: "none",
	});
	return element;
}

function focusWithoutScrolling(element: HTMLElement): void {
	try {
		element.focus({ preventScroll: true });
	} catch {
		element.focus();
	}
}

function copyTextWithSelection(text: string): void {
	if (typeof document === "undefined" || !document.body) {
		throw new Error("Document is not available for clipboard fallback");
	}
	if (typeof document.execCommand !== "function") {
		throw new Error("Clipboard copy is not supported");
	}

	const activeElement =
		typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	const activeSelectionElement =
		activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement
			? activeElement
			: null;
	const activeSelection =
		activeSelectionElement?.selectionStart != null && activeSelectionElement.selectionEnd != null
			? {
					start: activeSelectionElement.selectionStart,
					end: activeSelectionElement.selectionEnd,
					direction: activeSelectionElement.selectionDirection,
				}
			: null;
	const selection = typeof window !== "undefined" ? window.getSelection?.() : null;
	const ranges = selection
		? Array.from({ length: selection.rangeCount }, (_, index) =>
				selection.getRangeAt(index).cloneRange(),
			)
		: [];
	const element = createLegacyCopyElement(text);

	try {
		document.body.appendChild(element);
		focusWithoutScrolling(element);
		element.select();
		element.setSelectionRange(0, element.value.length);
		if (!document.execCommand("copy")) {
			throw new Error("Clipboard copy command failed");
		}
	} finally {
		element.remove();
		if (activeElement?.isConnected) {
			try {
				focusWithoutScrolling(activeElement);
				if (activeSelection && activeSelectionElement) {
					activeSelectionElement.setSelectionRange(
						activeSelection.start,
						activeSelection.end,
						activeSelection.direction ?? undefined,
					);
				}
			} catch {
				// Focus restoration is best-effort and must not turn a successful copy into a failure.
			}
		}
		if (selection && ranges.length > 0) {
			try {
				selection.removeAllRanges();
				for (const range of ranges) selection.addRange(range);
			} catch {
				// The original selection may reference nodes removed while the copy was running.
			}
		}
	}
}

function canUseClipboardApi(): boolean {
	return (
		typeof navigator !== "undefined" &&
		typeof navigator.clipboard?.writeText === "function" &&
		(typeof window === "undefined" || window.isSecureContext !== false)
	);
}

/**
 * Copies text with Clipboard API when available and falls back to a temporary
 * selected form control for plain HTTP and other non-secure contexts.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
	if (!canUseClipboardApi()) {
		copyTextWithSelection(text);
		return;
	}

	try {
		await navigator.clipboard.writeText(text);
	} catch {
		copyTextWithSelection(text);
	}
}
