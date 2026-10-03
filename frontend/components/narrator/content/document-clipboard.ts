import { textDocumentStore } from "@frontend/lib/text-document-store";
import type { TextDocumentRef } from "@shared/pretext-layout/text-document";
import { readCurrentDocumentRange } from "./document-range-recovery";

/** Construct the promised ClipboardItem during the gesture (Safari's activation window). */
export function copyDocument(
	ref: TextDocumentRef,
	range?: { start: number; end: number },
): Promise<void> {
	const start = range?.start ?? 0;
	const end = range?.end ?? textDocumentStore.getSnapshot(ref.id)?.length ?? ref.length;
	const text = () => readCurrentDocumentRange(ref.id, start, range?.end);
	try {
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
		return Promise.reject(new Error("Clipboard API unavailable"));
	} catch (error) {
		return Promise.reject(error);
	}
}
