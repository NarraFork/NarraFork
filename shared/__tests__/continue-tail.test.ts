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
import {
	isInjectionTailRole,
	isNonTurnHostRow,
	isNonTurnInjectionRow,
	isRebaselineNoticeRow,
	tailRoleAllowsContinue,
} from "../continue-tail";

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

describe("isNonTurnInjectionRow", () => {
	const note = (source: string) => ({ type: "system_injection", source, modelText: "note" });

	test("the team conversion notes are informational, not a turn", () => {
		expect(isNonTurnInjectionRow("sys", [note("team_upgrade")])).toBe(true);
		expect(isNonTurnInjectionRow("sys", [note("team_disband")])).toBe(true);
	});

	test("other injections still hand the narrator the next turn", () => {
		expect(isNonTurnInjectionRow("sys", [note("bg_agent")])).toBe(false);
		expect(isNonTurnInjectionRow("sys", [note("team_upgrade"), note("bg_agent")])).toBe(false);
		expect(isNonTurnInjectionRow("sys", [{ type: "text", text: "x" }])).toBe(false);
		expect(isNonTurnInjectionRow("sys", [note("team_upgrade"), { type: "text", text: "x" }])).toBe(
			false,
		);
		expect(isNonTurnInjectionRow("sys", [])).toBe(false);
	});

	test("only sys rows qualify", () => {
		expect(isNonTurnInjectionRow("user", [note("team_upgrade")])).toBe(false);
		expect(isNonTurnInjectionRow("assistant", [note("team_upgrade")])).toBe(false);
	});
});

describe("isRebaselineNoticeRow / isNonTurnHostRow", () => {
	const notice = { type: "tool_loaded", toolName: "Team", toolNames: ["Team"], rebaseline: true };

	test("the host-written rebaseline notice is no turn; a typed /load is", () => {
		expect(isRebaselineNoticeRow("user", [notice])).toBe(true);
		expect(isNonTurnHostRow("user", [notice])).toBe(true);
		expect(isRebaselineNoticeRow("user", [{ ...notice, rebaseline: undefined }])).toBe(false);
		expect(isRebaselineNoticeRow("user", [notice, { type: "text", text: "hi" }])).toBe(false);
		expect(isRebaselineNoticeRow("assistant", [notice])).toBe(false);
	});

	test("the conversion notes are host rows too; other injections are not", () => {
		const note = (source: string) => ({ type: "system_injection", source });
		expect(isNonTurnHostRow("sys", [note("team_upgrade")])).toBe(true);
		expect(isNonTurnHostRow("sys", [note("bg_agent")])).toBe(false);
		expect(isNonTurnHostRow("user", [{ type: "text", text: "go" }])).toBe(false);
	});
});
