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

/**
 * Whether editing this message needs the revert confirmation dialog.
 *
 * True whenever the edit would destroy something the user cannot see from the
 * editor: a file the rollback would change, or a later message it would delete.
 * When neither exists there is nothing to decide, so the edit submits directly.
 *
 * An absent preview returns true: not knowing what an edit would destroy is not a
 * reason to skip asking. This deliberately replaces the old "is this the last user
 * message?" shortcut, which submitted without a prompt while the server reverted
 * files anyway.
 *
 * Structurally typed rather than importing the API types, to keep this module free
 * of the api/ graph (see the file header).
 */
export function editRevertNeedsConfirm(
	preview:
		| {
				affectedFiles?: unknown[];
				narratorScope?: { files?: unknown[] };
				workspaceScope?: { files?: unknown[] };
				deletedMessageCount?: number;
		  }
		| undefined,
): boolean {
	if (!preview) return true;
	if ((preview.deletedMessageCount ?? 0) > 0) return true;
	// Any scope having files is enough: the dialog lets the user switch between them,
	// so a scope that is not currently selected still represents a real choice.
	return (
		(preview.affectedFiles?.length ?? 0) > 0 ||
		(preview.narratorScope?.files?.length ?? 0) > 0 ||
		(preview.workspaceScope?.files?.length ?? 0) > 0
	);
}
