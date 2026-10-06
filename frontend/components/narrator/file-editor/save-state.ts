/**
 * save-state.ts — the editor's save/conflict state machine.
 *
 * Pure, and separate from the component, because the interesting behaviour here is not
 * rendering: it is what the buffer, the base hash and the dirty flag are allowed to be
 * after each outcome. Getting one of those wrong loses the user's typing or silently
 * re-arms a stale optimistic lock, and neither shows up as an error.
 */

/** sha256-hex of the content the editor loaded; null when creating a new file. */
export type BaseHash = string | null;

export interface EditorState {
	/** What the user currently sees. */
	buffer: string;
	/** The content last known to be on disk, for the dirty comparison and diffs. */
	baseContent: string;
	/** Optimistic-lock token for the next save. */
	baseHash: BaseHash;
	/** A save is in flight; the editor stays editable but must not save twice. */
	saving: boolean;
	/**
	 * The disk content that beat us, when a save was refused as stale.
	 *
	 * Non-null means the conflict UI is showing. The user's buffer is NOT replaced —
	 * that would discard their work in favour of the version they were warned about.
	 */
	conflict: { theirContent: string; theirHash: string } | null;
	/**
	 * A save the server will only perform if the user acknowledges WHERE it lands.
	 *
	 * The path is outside the narrator's workspace and every declared writable
	 * directory, so the server refused once and told us the resolved physical path.
	 * Separate from `error` because it is a question, not a failure: re-sending with
	 * the acknowledgement is expected to succeed, and showing it as an error would
	 * leave the user with no way to proceed.
	 *
	 * Holds the RESOLVED path, not the requested one. That distinction is the whole
	 * point of asking: the two differ exactly when a link redirected the write, which
	 * is the case where consent based on the requested path would be uninformed.
	 */
	confirmation: { physicalPath: string; message: string } | null;
	/** Last save error that was not a conflict or a confirmation request. */
	error: string | null;
}

export function initialEditorState(content: string, hash: BaseHash): EditorState {
	return {
		buffer: content,
		baseContent: content,
		baseHash: hash,
		saving: false,
		conflict: null,
		confirmation: null,
		error: null,
	};
}

/** Whether the buffer differs from what is known to be on disk. */
export function isDirty(state: EditorState): boolean {
	return state.buffer !== state.baseContent;
}

/** Whether a save should be permitted right now. */
export function canSave(state: EditorState): boolean {
	// A conflict does not block saving: resolving it means saving again, deliberately,
	// against the hash that beat us. What blocks is only an in-flight request.
	//
	// A pending confirmation is NOT a save-enabler: the way past it is the explicit
	// acknowledge button, not the save button, so that "confirm writing outside the
	// workspace" cannot be answered by muscle memory on Ctrl+S.
	return !state.saving && (isDirty(state) || state.conflict !== null);
}

/** The user typed. */
export function applyEdit(state: EditorState, buffer: string): EditorState {
	if (buffer === state.buffer) return state;
	// A stale error must not survive the next keystroke — it describes an attempt that
	// no longer corresponds to what is in the buffer.
	//
	// The pending confirmation is dropped for a stronger reason: it was granted for a
	// specific set of bytes, and after a keystroke it would be consent to write
	// content the user never saw described. Re-asking costs one click.
	return { ...state, buffer, error: null, confirmation: null };
}

/** A save request started. */
export function beginSave(state: EditorState): EditorState {
	return { ...state, saving: true, error: null };
}

/**
 * The server refused because the target is outside every writable root, and said it
 * would accept the write if the user acknowledges the resolved path.
 *
 * Distinct from {@link saveFailed} on purpose. Both used to land in `error`, which made
 * a question look like a dead end: the message said "outside the workspace" and the only
 * affordance was to press save again, which produced the same refusal forever.
 */
export function saveNeedsConfirmation(
	state: EditorState,
	physicalPath: string,
	message: string,
): EditorState {
	return {
		...state,
		saving: false,
		confirmation: { physicalPath, message },
		error: null,
	};
}

/** The user declined to write outside the workspace. */
export function dismissConfirmation(state: EditorState): EditorState {
	if (!state.confirmation) return state;
	return { ...state, confirmation: null };
}

/**
 * The save succeeded.
 *
 * `savedContent` is what was SENT, not the current buffer: the user may have typed
 * while the request was in flight, and treating the buffer as the new base would mark
 * those keystrokes as already saved. The dirty flag then stays true, which is correct.
 */
export function saveSucceeded(
	state: EditorState,
	savedContent: string,
	newHash: string,
): EditorState {
	return {
		...state,
		baseContent: savedContent,
		baseHash: newHash,
		saving: false,
		conflict: null,
		// Consumed: the acknowledgement covered this write, not every future one. Leaving
		// it set would silently pre-authorise the next save to the same outside path.
		confirmation: null,
		error: null,
	};
}

/**
 * The save was refused because the file changed underneath.
 *
 * The buffer is deliberately untouched. The base hash is NOT advanced either: doing so
 * would silently authorise the next save to overwrite the other writer's work, which is
 * exactly what the refusal existed to prevent. Advancing it is the user's explicit
 * decision — see {@link resolveConflictKeepingMine}.
 */
export function saveConflicted(
	state: EditorState,
	theirContent: string,
	theirHash: string,
): EditorState {
	return {
		...state,
		saving: false,
		conflict: { theirContent, theirHash },
		confirmation: null,
		error: null,
	};
}

/** The save failed for a reason other than a conflict. */
export function saveFailed(state: EditorState, message: string): EditorState {
	return { ...state, saving: false, error: message, confirmation: null };
}

/**
 * The user chose to keep their version, having seen the other one.
 *
 * Adopts the other writer's hash as the base so the next save passes the lock. This is
 * the ONLY path that may do so, and it must be reachable only from a UI that showed the
 * difference first — otherwise it is just a silent overwrite with extra steps.
 */
export function resolveConflictKeepingMine(state: EditorState): EditorState {
	if (!state.conflict) return state;
	return {
		...state,
		baseHash: state.conflict.theirHash,
		// The other content is now the known disk state, so the buffer is dirty against
		// it — which is true, and what makes the next save a real overwrite.
		baseContent: state.conflict.theirContent,
		conflict: null,
	};
}

/** The user chose to discard their edit and take the version on disk. */
export function resolveConflictTakingTheirs(state: EditorState): EditorState {
	if (!state.conflict) return state;
	return initialEditorState(state.conflict.theirContent, state.conflict.theirHash);
}

/** Reload from disk, discarding local edits. */
export function reloaded(content: string, hash: BaseHash): EditorState {
	return initialEditorState(content, hash);
}
