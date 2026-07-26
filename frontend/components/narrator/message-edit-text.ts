/**
 * message-edit-text.ts — pure text helpers shared by the message editor and both
 * render paths.
 *
 * Kept in its own dependency-free module (no React, no Mantine) so a caller that
 * only needs to DECIDE whether editing is possible — e.g. the vlist shell, which
 * loads the editor itself lazily — does not pull the editor's module graph in.
 */

/** Hard cap on the text a user message may be edited with. */
export const MAX_USER_MESSAGE_EDIT_CHARS = 200_000;
/** Hard cap on the text an assistant message may be edited with. */
export const MAX_ASSISTANT_MESSAGE_EDIT_CHARS = 100_000;

/**
 * Join a message's text blocks, stopping at `maxChars`. `truncated` means the
 * caller must NOT treat the result as the complete text (the editor refuses to
 * open, and the display path shows a truncation notice instead).
 */
export function collectTextBlocksPreview(
	blocks: Array<{ type?: string; text?: unknown }>,
	maxChars: number,
): { text: string; truncated: boolean } {
	let result = "";
	let truncated = false;
	for (const block of blocks) {
		if (block.type !== "text" || typeof block.text !== "string") continue;
		const separator = result ? "\n\n" : "";
		const remaining = maxChars - result.length - separator.length;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		result += separator;
		if (block.text.length > remaining) {
			result += block.text.slice(0, remaining);
			truncated = true;
			break;
		}
		result += block.text;
	}
	return { text: result, truncated };
}

/**
 * Resolve the initial editor text for a message, applying the role's char cap.
 * `truncated: true` means the message is too large to edit safely — callers show
 * `editMessageTooLarge` and must not open the editor.
 */
export function resolveEditorInitialText(
	blocks: Array<{ type?: string; text?: unknown }>,
	role: "user" | "assistant",
): { text: string; truncated: boolean } {
	const maxChars = role === "user" ? MAX_USER_MESSAGE_EDIT_CHARS : MAX_ASSISTANT_MESSAGE_EDIT_CHARS;
	return collectTextBlocksPreview(blocks, maxChars);
}
