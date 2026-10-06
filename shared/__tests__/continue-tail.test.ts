/**
 * continue-tail.test.ts — the tail roles that leave the narrator owing a turn.
 *
 * The bug pinned here: an injection (`role: "sys"`) landing last left the reader with NO
 * primary action. Retry requires a `user` tail and Continue required `assistant`, so a
 * Dynamic Spec reminder or a finished background task at the end of the conversation
 * produced a disabled send button — even though every provider's history builder already
 * treats that row as the current turn.
 *
 * `user` staying non-continuable is asserted deliberately: that case belongs to Retry,
 * which re-runs the human turn after deleting what followed it. Letting Continue claim it
 * would silently swap one operation for the other.
 */

import { describe, expect, test } from "bun:test";
import { isInjectionTailRole, tailRoleAllowsContinue } from "../continue-tail";

describe("tailRoleAllowsContinue", () => {
	test("a stalled assistant turn is continuable", () => {
		expect(tailRoleAllowsContinue("assistant")).toBe(true);
	});

	test("an injection row is continuable — it is content the narrator has not answered", () => {
		expect(tailRoleAllowsContinue("sys")).toBe(true);
	});

	test("a user turn is NOT continuable; that is Retry's case", () => {
		expect(tailRoleAllowsContinue("user")).toBe(false);
	});

	test("UI-only and legacy rows are not continuable", () => {
		// `disp` never reaches the model; `system` is the legacy/compact-marker role.
		expect(tailRoleAllowsContinue("disp")).toBe(false);
		expect(tailRoleAllowsContinue("system")).toBe(false);
	});

	test("an absent role is not continuable", () => {
		expect(tailRoleAllowsContinue(null)).toBe(false);
		expect(tailRoleAllowsContinue(undefined)).toBe(false);
	});
});

describe("isInjectionTailRole", () => {
	test("only `sys` is an injection row", () => {
		expect(isInjectionTailRole("sys")).toBe(true);
		expect(isInjectionTailRole("assistant")).toBe(false);
		expect(isInjectionTailRole("user")).toBe(false);
		expect(isInjectionTailRole("system")).toBe(false);
		expect(isInjectionTailRole(null)).toBe(false);
	});
});
