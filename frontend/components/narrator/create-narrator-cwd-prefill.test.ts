/**
 * create-narrator-cwd-prefill.test.ts
 *
 * The prefill exists so the cwd field SHOWS where the narrator will actually be
 * created. Its failure mode is silent in both directions:
 *
 *   - fire only on the open transition → the late-arriving settings query is missed,
 *     the field falls back to a placeholder, and an empty submit lands elsewhere;
 *   - fire whenever the field is empty → clearing the input snaps the old value back,
 *     so the user cannot type a different directory.
 *
 * These simulate the render sequence rather than a rendered component, because the
 * bug is entirely about WHICH render the default is available on.
 */

import { describe, expect, it } from "bun:test";
import { type CwdPrefillState, resolveCwdPrefill } from "./create-narrator-cwd-prefill";

/**
 * Replay a render sequence the way the effect does: the flag persists across
 * renders, `setCwd` feeds the next render's value. Returns the final field value
 * plus every write performed.
 */
function replay(
	frames: readonly Partial<CwdPrefillState>[],
	initial: Partial<CwdPrefillState> = {},
): { cwd: string; writes: string[] } {
	let alreadyPrefilled = false;
	let cwd = initial.cwd ?? "";
	const writes: string[] = [];
	for (const frame of frames) {
		const state: CwdPrefillState = {
			opened: frame.opened ?? true,
			alreadyPrefilled,
			initialCwd: frame.initialCwd,
			cwd: frame.cwd ?? cwd,
			defaultProjectDir: frame.defaultProjectDir ?? "",
		};
		cwd = state.cwd;
		const decision = resolveCwdPrefill(state);
		if (decision.kind === "reset") alreadyPrefilled = false;
		if (decision.kind === "markPrefilled") alreadyPrefilled = true;
		if (decision.kind === "prefill") {
			cwd = decision.value;
			writes.push(decision.value);
			alreadyPrefilled = true;
		}
	}
	return { cwd, writes };
}

describe("cwd prefill — settings arrival timing", () => {
	it("fills the field when the default is available on the first render", () => {
		const result = replay([{ defaultProjectDir: "/home/u/projects" }]);
		expect(result.cwd).toBe("/home/u/projects");
	});

	it("still fills it when the settings query resolves LATE", () => {
		// The regression this guards: on a cold start the query is in flight for the
		// first render or two, so `defaultProjectDir` is "". Deciding once on the open
		// transition skipped forever and left only the placeholder.
		const result = replay([
			{ defaultProjectDir: "" },
			{ defaultProjectDir: "" },
			{ defaultProjectDir: "/home/u/projects" },
		]);
		expect(result.cwd).toBe("/home/u/projects");
		expect(result.writes).toEqual(["/home/u/projects"]);
	});

	it("writes exactly once even as later renders keep reporting the default", () => {
		const result = replay([
			{ defaultProjectDir: "/home/u/projects" },
			{ defaultProjectDir: "/home/u/projects" },
			{ defaultProjectDir: "/home/u/projects" },
		]);
		expect(result.writes).toEqual(["/home/u/projects"]);
	});
});

describe("cwd prefill — user intent wins", () => {
	it("does not snap back after the user clears the field", () => {
		const result = replay([
			{ defaultProjectDir: "/home/u/projects" },
			// User clears it, intending to type something else.
			{ cwd: "", defaultProjectDir: "/home/u/projects" },
			{ cwd: "", defaultProjectDir: "/home/u/projects" },
		]);
		expect(result.cwd).toBe("");
		expect(result.writes).toEqual(["/home/u/projects"]);
	});

	it("leaves a value the user typed before settings arrived", () => {
		const result = replay([
			{ cwd: "/srv/work", defaultProjectDir: "" },
			{ cwd: "/srv/work", defaultProjectDir: "/home/u/projects" },
		]);
		expect(result.cwd).toBe("/srv/work");
		expect(result.writes).toEqual([]);
	});

	it("never overrides a caller-supplied entry point", () => {
		const result = replay([
			{ initialCwd: "/repo/chapter", defaultProjectDir: "/home/u/projects" },
			{ initialCwd: "/repo/chapter", defaultProjectDir: "/home/u/projects" },
		]);
		expect(result.writes).toEqual([]);
	});
});

describe("cwd prefill — reopening", () => {
	it("prefills again on the next open after being closed", () => {
		const result = replay([
			{ defaultProjectDir: "/home/u/projects" },
			// Closed, and the field reset by the caller.
			{ opened: false, cwd: "", defaultProjectDir: "/home/u/projects" },
			{ cwd: "", defaultProjectDir: "/home/u/projects" },
		]);
		expect(result.writes).toEqual(["/home/u/projects", "/home/u/projects"]);
	});

	it("does nothing at all while closed", () => {
		const result = replay([{ opened: false, defaultProjectDir: "/home/u/projects" }]);
		expect(result.writes).toEqual([]);
		expect(result.cwd).toBe("");
	});

	it("stays inert when no default is configured", () => {
		const result = replay([{ defaultProjectDir: "" }, { defaultProjectDir: "" }]);
		expect(result.writes).toEqual([]);
		expect(result.cwd).toBe("");
	});
});
