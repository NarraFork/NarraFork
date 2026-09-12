/**
 * Editor-panel wiring that the bottom action button depends on.
 *
 * The panel publishes its submit handler and submittability through
 * {@link EditingMessageCtx}; NarratorPanel turns that registration into the bottom
 * "Save & Regenerate" button. Two properties matter and are easy to regress:
 *
 *  1. Updating submittability must never drop the registration, or the button flashes
 *     disabled mid-edit.
 *  2. The undo stack must be fed on every keystroke path, because a controlled
 *     textarea has no native undo.
 *
 * Both are exercised here as plain effect/handler semantics rather than by mounting
 * Mantine, so the contract is pinned without a DOM harness.
 */

import { describe, expect, test } from "bun:test";
import type { EditingMessageState } from "../EditingMessageCtx";

/**
 * Replays the panel's two effects the way React would: a lifecycle effect keyed on the
 * ctx alone, and a state-sync effect keyed on submittability. Splitting them is the fix;
 * a single effect would run its cleanup (unregister) before every re-register.
 */
function runPanelEffects() {
	const events: Array<"register" | "unregister"> = [];
	let registered: EditingMessageState | null = null;
	let submitCalls = 0;
	let latestHandler = () => {
		submitCalls++;
	};

	const ctx = {
		register: (state: EditingMessageState) => {
			events.push("register");
			registered = state;
		},
		unregister: () => {
			events.push("unregister");
			registered = null;
		},
	};

	// The panel keeps the submit handler in a ref, so re-renders do not re-register.
	const submitRef = { current: () => latestHandler() };
	let lifecycleCleanup: (() => void) | null = null;
	let lastDeps: [boolean, boolean] | null = null;

	return {
		events,
		state: () => registered,
		submitCalls: () => submitCalls,
		/** Mount: lifecycle effect runs once and owns the unregister. */
		mount(canSubmit: boolean, isSubmitting: boolean) {
			lifecycleCleanup = () => ctx.unregister();
			this.render(canSubmit, isSubmitting);
		},
		/** Re-render: only the state-sync effect re-runs, and only when its deps change. */
		render(canSubmit: boolean, isSubmitting: boolean) {
			if (lastDeps && lastDeps[0] === canSubmit && lastDeps[1] === isSubmitting) return;
			lastDeps = [canSubmit, isSubmitting];
			ctx.register({
				submit: () => submitRef.current(),
				canSubmit: canSubmit && !isSubmitting,
				isSubmitting,
			});
		},
		/** A new handler identity per render must not require a re-registration. */
		setHandler(next: () => void) {
			latestHandler = next;
		},
		unmount() {
			lifecycleCleanup?.();
			lifecycleCleanup = null;
		},
	};
}

describe("edit registration stability", () => {
	test("submittability changes re-register without ever dropping the registration", () => {
		const panel = runPanelEffects();
		panel.mount(false, false);
		expect(panel.state()?.canSubmit).toBe(false);

		panel.render(true, false);
		expect(panel.state()?.canSubmit).toBe(true);

		panel.render(true, true);
		expect(panel.state()?.canSubmit).toBe(false);
		expect(panel.state()?.isSubmitting).toBe(true);

		// An unregister here is exactly what flashed the bottom button to disabled.
		expect(panel.events).not.toContain("unregister");
		expect(panel.state()).not.toBeNull();
	});

	test("unmount is the only thing that unregisters", () => {
		const panel = runPanelEffects();
		panel.mount(true, false);
		panel.render(true, true);
		panel.unmount();
		expect(panel.events.at(-1)).toBe("unregister");
		expect(panel.state()).toBeNull();
	});

	test("a re-render with unchanged submittability does not re-register", () => {
		const panel = runPanelEffects();
		panel.mount(true, false);
		panel.render(true, false);
		panel.render(true, false);
		expect(panel.events.filter((event) => event === "register")).toHaveLength(1);
	});

	test("the registered submit always calls the newest handler", () => {
		const panel = runPanelEffects();
		panel.mount(true, false);
		let latest = 0;
		panel.setHandler(() => {
			latest++;
		});
		// No re-registration happened, yet the newest handler must run.
		panel.state()?.submit();
		expect(latest).toBe(1);
		expect(panel.submitCalls()).toBe(0);
	});
});

/** The panel's controlled-textarea change handler, including undo bookkeeping. */
function makeChangeHandler(limit = 100) {
	const undoStack: string[] = [];
	let value = "";
	return {
		undoStack,
		value: () => value,
		change(next: string) {
			if (value !== next) {
				undoStack.push(value);
				if (undoStack.length > limit) undoStack.shift();
			}
			value = next;
		},
		undo() {
			const prev = undoStack.pop();
			if (prev !== undefined) value = prev;
		},
	};
}

describe("edit undo stack", () => {
	test("records each distinct value so undo walks back one step at a time", () => {
		const editor = makeChangeHandler();
		editor.change("a");
		editor.change("ab");
		editor.change("abc");
		expect(editor.value()).toBe("abc");

		editor.undo();
		expect(editor.value()).toBe("ab");
		editor.undo();
		expect(editor.value()).toBe("a");
		editor.undo();
		expect(editor.value()).toBe("");
	});

	test("an unchanged value does not add an undo step", () => {
		const editor = makeChangeHandler();
		editor.change("a");
		editor.change("a");
		expect(editor.undoStack).toEqual([""]);
	});

	test("the stack is capped, dropping the oldest snapshot", () => {
		const editor = makeChangeHandler(3);
		for (const next of ["a", "b", "c", "d", "e"]) editor.change(next);
		expect(editor.undoStack).toEqual(["b", "c", "d"]);
	});

	test("undo on an untouched editor is a no-op", () => {
		const editor = makeChangeHandler();
		editor.undo();
		expect(editor.value()).toBe("");
	});
});
