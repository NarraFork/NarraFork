/**
 * create-narrator-plan-mode-prefill.test.ts
 *
 * The switch exists so the user can SEE and CHOOSE whether the new narrator
 * starts in plan mode. Its failure mode is silent in both directions:
 *
 *   - never adopting the instance default → the switch shows off while an
 *     untouched submit still creates a plan-mode narrator;
 *   - omitting the field when the switch is off → the server's
 *     `input.startInPlanMode ?? defaultStartInPlanMode` re-imposes the default
 *     over a deliberate uncheck.
 *
 * These simulate the render sequence rather than a rendered component, because
 * the bug is entirely about WHICH render the default is available on and whether
 * the user's flip is still honored after it lands.
 */

import { describe, expect, it } from "bun:test";
import {
	resolveStartInPlanModePrefill,
	type StartInPlanModePrefillState,
	shouldSendStartInPlanMode,
} from "./create-narrator-plan-mode-prefill";

/**
 * Replay a render sequence the way the effect does: the flags persist across
 * renders. Returns the final switch value, every write performed, and whether
 * the last settled frame would send an explicit boolean on submit.
 */
function replay(
	frames: readonly Partial<StartInPlanModePrefillState>[],
	initial: Partial<StartInPlanModePrefillState> = {},
): { value: boolean; writes: boolean[]; sendExplicit: boolean } {
	let userTouched = initial.userTouched ?? false;
	let alreadyPrefilled = initial.alreadyPrefilled ?? false;
	let value = initial.value ?? false;
	const writes: boolean[] = [];
	let lastKnown = false;
	for (const frame of frames) {
		const state: StartInPlanModePrefillState = {
			opened: frame.opened ?? true,
			userTouched,
			alreadyPrefilled,
			value: frame.value ?? value,
			settingsKnown: frame.settingsKnown ?? lastKnown,
			defaultStartInPlanMode: frame.defaultStartInPlanMode ?? false,
		};
		value = state.value;
		lastKnown = state.settingsKnown;
		if (frame.userTouched !== undefined) userTouched = frame.userTouched;
		const decision = resolveStartInPlanModePrefill(state);
		if (decision.kind === "reset") {
			userTouched = false;
			alreadyPrefilled = false;
		}
		if (decision.kind === "markPrefilled") alreadyPrefilled = true;
		if (decision.kind === "prefill") {
			value = decision.value;
			writes.push(decision.value);
			alreadyPrefilled = true;
		}
	}
	return {
		value,
		writes,
		sendExplicit: shouldSendStartInPlanMode({ userTouched, settingsKnown: lastKnown }),
	};
}

describe("plan-mode switch prefill — settings arrival timing", () => {
	it("adopts the instance default when settings are available on the first render", () => {
		const result = replay([{ settingsKnown: true, defaultStartInPlanMode: true }]);
		expect(result.value).toBe(true);
		expect(result.writes).toEqual([true]);
	});

	it("still adopts when the settings query resolves LATE", () => {
		// Cold start: the query is in flight for the first render or two. Deciding
		// once on the open transition would leave the switch off forever while the
		// server still applies the default — the "switch lied" failure.
		const result = replay([
			{ settingsKnown: false },
			{ settingsKnown: false },
			{ settingsKnown: true, defaultStartInPlanMode: true },
		]);
		expect(result.value).toBe(true);
		expect(result.writes).toEqual([true]);
		expect(result.sendExplicit).toBe(true);
	});

	it("writes exactly once even as later renders keep reporting the default", () => {
		const result = replay([
			{ settingsKnown: true, defaultStartInPlanMode: true },
			{ settingsKnown: true, defaultStartInPlanMode: true },
			{ settingsKnown: true, defaultStartInPlanMode: true },
		]);
		expect(result.writes).toEqual([true]);
	});
});

describe("plan-mode switch prefill — user intent wins", () => {
	it("does not re-impose the default after the user unchecks a prefilled-on switch", () => {
		// THE regression: settings on → prefill on → user turns it off → submit
		// must say false. Omitting the field would let the server restore true.
		const result = replay([
			{ settingsKnown: true, defaultStartInPlanMode: true },
			{ settingsKnown: true, defaultStartInPlanMode: true, value: false, userTouched: true },
			{ settingsKnown: true, defaultStartInPlanMode: true, value: false, userTouched: true },
		]);
		expect(result.value).toBe(false);
		expect(result.writes).toEqual([true]); // only the prefill write; never the uncheck
		expect(result.sendExplicit).toBe(true);
	});

	it("keeps a flip the user made BEFORE settings arrived", () => {
		const result = replay([
			{ settingsKnown: false, value: true, userTouched: true },
			{ settingsKnown: true, defaultStartInPlanMode: false, value: true, userTouched: true },
		]);
		expect(result.value).toBe(true);
		expect(result.writes).toEqual([]);
		expect(result.sendExplicit).toBe(true);
	});

	it("honors a deliberate off against a default-off setting as an explicit false", () => {
		const result = replay([
			{ settingsKnown: true, defaultStartInPlanMode: false, value: false, userTouched: true },
		]);
		expect(result.value).toBe(false);
		expect(result.sendExplicit).toBe(true);
	});
});

describe("plan-mode switch prefill — submit payload", () => {
	it("sends an explicit boolean once the switch reflects the known default", () => {
		const result = replay([{ settingsKnown: true, defaultStartInPlanMode: true }]);
		expect(result.sendExplicit).toBe(true);
		expect(result.value).toBe(true);
	});

	it("omits the field only while settings are unknown and the user never touched the switch", () => {
		// Server then applies `defaultStartInPlanMode`, which is the documented
		// "follow settings" path and matches what the placeholder switch implies.
		const result = replay([{ settingsKnown: false }, { settingsKnown: false }]);
		expect(result.sendExplicit).toBe(false);
		expect(result.value).toBe(false);
	});

	it("sends as soon as the user flips the switch, even if settings never arrive", () => {
		const result = replay([{ settingsKnown: false, value: true, userTouched: true }]);
		expect(result.sendExplicit).toBe(true);
		expect(result.value).toBe(true);
	});
});

describe("plan-mode switch prefill — reopening", () => {
	it("prefills again on the next open after being closed", () => {
		const result = replay([
			{ settingsKnown: true, defaultStartInPlanMode: true },
			{ opened: false, value: false, settingsKnown: true, defaultStartInPlanMode: true },
			{ settingsKnown: true, defaultStartInPlanMode: true, value: false },
		]);
		expect(result.writes).toEqual([true, true]);
		expect(result.value).toBe(true);
	});

	it("does nothing at all while closed", () => {
		const result = replay([{ opened: false, settingsKnown: true, defaultStartInPlanMode: true }]);
		expect(result.writes).toEqual([]);
		expect(result.value).toBe(false);
	});

	it("stays inert when the default is off and the user never touches it", () => {
		const result = replay([
			{ settingsKnown: true, defaultStartInPlanMode: false },
			{ settingsKnown: true, defaultStartInPlanMode: false },
		]);
		expect(result.writes).toEqual([]);
		expect(result.value).toBe(false);
		// Settings known → explicit false, so a later default flip cannot surprise
		// this submit either.
		expect(result.sendExplicit).toBe(true);
	});
});
