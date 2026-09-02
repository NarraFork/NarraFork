/**
 * The editor's save/conflict state machine.
 *
 * Every case here is one where a wrong answer costs the user data without reporting
 * anything: adopting the buffer as the saved base while a keystroke was in flight,
 * replacing the buffer with the version that beat it, or advancing the optimistic lock
 * on a conflict — which turns the next save into the silent overwrite the refusal
 * existed to prevent.
 */

import { describe, expect, it } from "bun:test";
import {
	applyEdit,
	beginSave,
	canSave,
	dismissConfirmation,
	initialEditorState,
	isDirty,
	resolveConflictKeepingMine,
	resolveConflictTakingTheirs,
	saveConflicted,
	saveFailed,
	saveNeedsConfirmation,
	saveSucceeded,
} from "./save-state";

const loaded = () => initialEditorState("v1\n", "hash-v1");

describe("dirty tracking", () => {
	it("starts clean", () => {
		expect(isDirty(loaded())).toBe(false);
	});

	it("becomes dirty on an edit and clean again when typed back", () => {
		const edited = applyEdit(loaded(), "v2\n");
		expect(isDirty(edited)).toBe(true);
		expect(isDirty(applyEdit(edited, "v1\n"))).toBe(false);
	});

	it("is identity-stable when the buffer did not change", () => {
		const state = loaded();
		expect(applyEdit(state, "v1\n")).toBe(state);
	});
});

describe("canSave", () => {
	it("refuses while a save is in flight", () => {
		expect(canSave(beginSave(applyEdit(loaded(), "v2\n")))).toBe(false);
	});

	it("refuses when nothing changed", () => {
		expect(canSave(loaded())).toBe(false);
	});

	it("permits saving while a conflict is showing", () => {
		// Resolving a conflict means saving again, deliberately. Blocking it would leave
		// the user with a dialog and no way out.
		const conflicted = saveConflicted(loaded(), "theirs\n", "hash-theirs");
		expect(canSave(conflicted)).toBe(true);
	});
});

describe("a successful save", () => {
	it("bases on what was SENT, not the current buffer", () => {
		// The regression this prevents: the user typed while the request was in flight, and
		// adopting the buffer as the new base marks those keystrokes as already saved —
		// so they are never written and the editor claims to be clean.
		let state = applyEdit(loaded(), "sent\n");
		state = beginSave(state);
		state = applyEdit(state, "sent + typed while saving\n");
		state = saveSucceeded(state, "sent\n", "hash-sent");

		expect(state.baseContent).toBe("sent\n");
		expect(state.buffer).toBe("sent + typed while saving\n");
		expect(isDirty(state)).toBe(true);
	});

	it("advances the optimistic lock", () => {
		const state = saveSucceeded(beginSave(applyEdit(loaded(), "v2\n")), "v2\n", "hash-v2");

		expect(state.baseHash).toBe("hash-v2");
		expect(state.saving).toBe(false);
	});

	it("clears a previous conflict", () => {
		let state = saveConflicted(loaded(), "theirs\n", "hash-theirs");
		state = saveSucceeded(state, "mine\n", "hash-mine");

		expect(state.conflict).toBeNull();
	});
});

describe("a conflicted save", () => {
	it("never replaces the user's buffer", () => {
		// Replacing it would discard the very work the user was warned about.
		let state = applyEdit(loaded(), "mine\n");
		state = saveConflicted(beginSave(state), "theirs\n", "hash-theirs");

		expect(state.buffer).toBe("mine\n");
		expect(state.conflict?.theirContent).toBe("theirs\n");
	});

	it("does NOT advance the base hash", () => {
		// The decisive case: advancing it would authorise the next save to overwrite the
		// other writer silently, defeating the refusal entirely.
		const state = saveConflicted(
			beginSave(applyEdit(loaded(), "mine\n")),
			"theirs\n",
			"hash-theirs",
		);

		expect(state.baseHash).toBe("hash-v1");
	});

	it("is not reported as an error", () => {
		// A conflict is an outcome with its own UI, not a failure message.
		const state = saveConflicted(loaded(), "theirs\n", "hash-theirs");
		expect(state.error).toBeNull();
	});
});

describe("resolving a conflict", () => {
	it("keeping mine adopts their hash so the next save passes the lock", () => {
		let state = applyEdit(loaded(), "mine\n");
		state = saveConflicted(state, "theirs\n", "hash-theirs");
		state = resolveConflictKeepingMine(state);

		expect(state.baseHash).toBe("hash-theirs");
		expect(state.buffer).toBe("mine\n");
		// Dirty against the newly-known disk state, which is what makes the next save a
		// real, intended overwrite.
		expect(isDirty(state)).toBe(true);
		expect(state.conflict).toBeNull();
	});

	it("taking theirs discards the local edit entirely", () => {
		let state = applyEdit(loaded(), "mine\n");
		state = saveConflicted(state, "theirs\n", "hash-theirs");
		state = resolveConflictTakingTheirs(state);

		expect(state.buffer).toBe("theirs\n");
		expect(state.baseHash).toBe("hash-theirs");
		expect(isDirty(state)).toBe(false);
	});

	it("is a no-op when there is no conflict", () => {
		const state = loaded();
		expect(resolveConflictKeepingMine(state)).toBe(state);
		expect(resolveConflictTakingTheirs(state)).toBe(state);
	});
});

/**
 * The outside-workspace confirmation.
 *
 * The server answers both a stale lock and an outside-roots refusal with 409, and the
 * first version of this editor put both into `error`. That turned a question into a dead
 * end: the message said "outside the workspace" and the only affordance was to press
 * save again, which produced the identical refusal forever — so the whole
 * `confirmOutsideRoots` path on the server was unreachable from the UI.
 */
describe("a save that needs confirmation", () => {
	const pending = () =>
		saveNeedsConfirmation(
			beginSave(applyEdit(loaded(), "mine\n")),
			"/etc/somewhere/real.conf",
			"outside the workspace",
		);

	it("is not an error, and holds the resolved path to show", () => {
		const state = pending();

		expect(state.error).toBeNull();
		expect(state.saving).toBe(false);
		expect(state.confirmation?.physicalPath).toBe("/etc/somewhere/real.conf");
	});

	it("keeps the buffer intact so accepting writes what the user wrote", () => {
		expect(pending().buffer).toBe("mine\n");
	});

	it("is dropped by the next keystroke", () => {
		// The acknowledgement was given for a specific set of bytes. Carrying it across an
		// edit would make it consent to content whose description the user never saw.
		expect(applyEdit(pending(), "different\n").confirmation).toBeNull();
	});

	it("is consumed by a successful save, not left standing", () => {
		// Leaving it set would silently pre-authorise every later save to the same outside
		// path, which is the opposite of asking once per write.
		const state = saveSucceeded(pending(), "mine\n", "hash-mine");
		expect(state.confirmation).toBeNull();
	});

	it("is cleared when the outcome turns out to be a conflict instead", () => {
		// Both are 409s. Showing the confirmation banner alongside the conflict diff would
		// present two mutually exclusive questions at once.
		const state = saveConflicted(pending(), "theirs\n", "hash-theirs");
		expect(state.confirmation).toBeNull();
		expect(state.conflict).not.toBeNull();
	});

	it("is cleared by a plain failure", () => {
		expect(saveFailed(pending(), "disk full").confirmation).toBeNull();
	});

	it("can be declined, leaving the edit to retry", () => {
		const state = dismissConfirmation(pending());

		expect(state.confirmation).toBeNull();
		expect(state.buffer).toBe("mine\n");
		expect(isDirty(state)).toBe(true);
	});

	it("declining is a no-op when nothing is pending", () => {
		const state = loaded();
		expect(dismissConfirmation(state)).toBe(state);
	});

	it("does NOT by itself make the save button live", () => {
		// The way past a confirmation is the acknowledge button, which sends
		// `confirmOutsideRoots`. If a pending confirmation also enabled plain saving,
		// Ctrl+S would re-send the unacknowledged request and the user would learn that
		// pressing save twice is how you dismiss the warning.
		const clean = saveNeedsConfirmation(loaded(), "/etc/x.conf", "outside");
		expect(canSave(clean)).toBe(false);
	});
});

describe("a failed save", () => {
	it("records the message and stops saving", () => {
		const state = saveFailed(beginSave(applyEdit(loaded(), "v2\n")), "disk full");

		expect(state.error).toBe("disk full");
		expect(state.saving).toBe(false);
		// The edit is still there to retry with.
		expect(state.buffer).toBe("v2\n");
	});

	it("clears the error on the next keystroke", () => {
		// The message described an attempt that no longer matches the buffer.
		const failed = saveFailed(beginSave(applyEdit(loaded(), "v2\n")), "disk full");
		expect(applyEdit(failed, "v3\n").error).toBeNull();
	});
});
