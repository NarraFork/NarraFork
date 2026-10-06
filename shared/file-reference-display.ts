import type { FileReference } from "./file-reference";

/** Visible/copyable locator only. Never include a frozen file's hidden body in chat text. */
export function fileReferenceLabel(reference: FileReference): string {
	const selection = reference.selection;
	let range = "";
	if (selection) {
		const { startLineNumber: start, startColumn, endLineNumber: end, endColumn } = selection;
		if (startColumn === 1 && endColumn === 1 && end > start) {
			range = start === end - 1 ? `:${start}` : `:${start}-${end - 1}`;
		} else {
			range = `:${start}:${startColumn}–${end}:${endColumn}`;
		}
	}
	return `${reference.path}${range} · ${reference.deviceId}`;
}
