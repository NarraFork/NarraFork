/**
 * EditingMessageCtx.ts — active message-edit registration.
 *
 * Lets the mounted MessageEditorPanel register its submit handler so the parent
 * NarratorPanel can wire the bottom send/retry button to the edit-and-regenerate
 * flow instead of the default action.
 *
 * Kept in its own tiny module (rather than inside MessageBubble) so the editor
 * panel and MessageBubble can both use it without a circular import. MessageBubble
 * re-exports both symbols, so existing importers stay unchanged.
 */

import { createContext } from "react";

export interface EditingMessageState {
	/** Submit the current edit (equivalent to clicking "Save & Retry") */
	submit: () => void;
	/** Whether the edit content is non-empty and submittable */
	canSubmit: boolean;
	/** Prevent duplicate submits while the edit request is in flight. */
	isSubmitting: boolean;
}

export const EditingMessageCtx = createContext<{
	register: (state: EditingMessageState) => void;
	unregister: () => void;
}>({
	register: () => {},
	unregister: () => {},
});
