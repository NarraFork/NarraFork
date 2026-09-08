/** Communication is conversation content, never a foldable activity/tool row. */
export function isCommunicationTool(tool: { toolName: string; inputJson?: unknown }): boolean {
	if (tool.toolName === "Send") return true;
	if (tool.toolName !== "TeamStatus") return false;
	const input = objectValue(tool.inputJson);
	const settled = objectValue(input._streamingFields);
	const action =
		input._streamingFieldName === "action" && Object.hasOwn(input, "_streamingFieldValue")
			? input._streamingFieldValue
			: Object.hasOwn(settled, "action")
				? settled.action
				: input.action;
	return action === "send" || action === "broadcast";
}

/** Inline parsing budget, shared by the adapter and defensive measure entry point. */
export const COMMUNICATION_PREVIEW_MAX_CHARS = 8 * 1024;
export const COMMUNICATION_PREVIEW_MAX_LINES = 120;

/**
 * Keep a bounded prefix without splitting the full input into lines. At most 8Ki
 * UTF-16 code units are scanned, including for a multi-megabyte single-line input.
 * CRLF is one line boundary; lone CR and LF each count as one boundary.
 */
export function limitCommunicationPreview(text: string): { text: string; truncated: boolean } {
	let end = Math.min(text.length, COMMUNICATION_PREVIEW_MAX_CHARS);
	let lines = 1;
	for (let index = 0; index < end; index++) {
		const char = text.charCodeAt(index);
		if (char !== 10 && char !== 13) continue;
		if (lines === COMMUNICATION_PREVIEW_MAX_LINES) {
			end = index;
			break;
		}
		lines++;
		if (char === 13 && text.charCodeAt(index + 1) === 10) index++;
	}
	// Do not leave a replacement glyph at a character-budget boundary in an emoji.
	if (end < text.length && end > 0) {
		const last = text.charCodeAt(end - 1);
		if (last >= 0xd800 && last <= 0xdbff) end--;
	}
	return { text: text.slice(0, end), truncated: end < text.length };
}

function objectValue(value: unknown): Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
