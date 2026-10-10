import { copyTextToClipboard } from "@frontend/lib/clipboard";
import { textDocumentStore } from "@frontend/lib/text-document-store";
import type { TextDocumentRef } from "@shared/pretext-layout/text-document";
import { readCurrentDocumentRange } from "./document-range-recovery";

function isSecureClipboardContext(): boolean {
	return typeof window === "undefined" || window.isSecureContext !== false;
}

/**
 * Construct the promised ClipboardItem during the gesture (Safari's activation window).
 *
 * Non-secure contexts (plain-HTTP private deployments) cannot use `navigator.clipboard`;
 * those resolve the range and fall back to `copyTextToClipboard` (`execCommand`).
 * A rejected Clipboard API call still propagates so callers can report a real failure
 * instead of a silent half-copy.
 */
export function copyDocument(
	ref: TextDocumentRef,
	range?: { start: number; end: number },
): Promise<void> {
	const start = range?.start ?? 0;
	const end = range?.end ?? textDocumentStore.getSnapshot(ref.id)?.length ?? ref.length;
	const text = () => readCurrentDocumentRange(ref.id, start, range?.end);
	try {
		// Plain HTTP: skip the Clipboard API entirely (it is absent or throws there).
		if (!isSecureClipboardContext()) {
			return text().then((value) => copyTextToClipboard(value));
		}
		// Already available raw bytes can use the synchronous gesture's native text path.
		const cached = textDocumentStore.peekRange(ref.id, start, end);
		if (cached !== undefined && navigator.clipboard?.writeText)
			return navigator.clipboard.writeText(cached);
		if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
			const blob = text().then((value) => new Blob([value], { type: "text/plain" }));
			return navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
		}
		if (navigator.clipboard?.writeText)
			return text().then((value) => navigator.clipboard.writeText(value));
		// Secure context but the Clipboard API is missing — use the selection fallback.
		return text().then((value) => copyTextToClipboard(value));
	} catch (error) {
		return Promise.reject(error);
	}
}
