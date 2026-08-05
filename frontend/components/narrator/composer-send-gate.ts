/**
 * What counts as sendable content in the narrator composer.
 *
 * Attachments are content on their own: an image-only or text-file-only draft is a
 * complete turn (the backend substitutes a "[user sent image(s)]" placeholder and
 * injects an `<attached_files>` hint), so the send path must not require typed text.
 *
 * Centralizing this keeps the three consumers in agreement — the send handler's
 * early return, the send/queue button's disabled state, and the Enter-key binding
 * that would otherwise be stolen by a pending permission prompt.
 */

export interface ComposerContentState {
	/** Raw textarea value; trimmed here so callers cannot forget to. */
	text: string;
	imageCount: number;
	textFileCount: number;
}

/** True when at least one attachment is staged. */
export function hasComposerAttachments(state: ComposerContentState): boolean {
	return state.imageCount > 0 || state.textFileCount > 0;
}

/** True when the composer has typed text (ignoring whitespace-only input). */
export function hasComposerText(state: ComposerContentState): boolean {
	return state.text.trim().length > 0;
}

/**
 * True when the composer holds anything worth sending. This is the single gate for
 * "may this draft be submitted", covering text-only, attachment-only and mixed drafts.
 */
export function hasSendableComposerContent(state: ComposerContentState): boolean {
	return hasComposerText(state) || hasComposerAttachments(state);
}
