import { describe, expect, test } from "bun:test";
import {
	fastModeOverrideFromLegacyInput,
	legacyFastModeMirror,
	resolveFastMode,
	resolveFastModeForUser,
	resolveSubagentActingUserId,
} from "../fast-mode";

describe("resolveFastMode", () => {
	test("inherit follows the user default, so changing the default reaches existing narrators", () => {
		expect(resolveFastMode("inherit", true)).toBe(true);
		expect(resolveFastMode("inherit", false)).toBe(false);
	});

	test("an explicit choice wins over the default in both directions", () => {
		expect(resolveFastMode("on", false)).toBe(true);
		expect(resolveFastMode("off", true)).toBe(false);
	});

	test("unknown/legacy values degrade to inherit rather than silently enabling priority", () => {
		expect(resolveFastMode(null, false)).toBe(false);
		expect(resolveFastMode(undefined, true)).toBe(true);
		expect(resolveFastMode("bogus", true)).toBe(true);
	});
});

describe("legacyFastModeMirror", () => {
	test("mirrors only an explicit opt-in, so inherit never looks pinned to old readers", () => {
		expect(legacyFastModeMirror("on")).toBe(true);
		expect(legacyFastModeMirror("off")).toBe(false);
		expect(legacyFastModeMirror("inherit")).toBe(false);
	});
});

describe("fastModeOverrideFromLegacyInput", () => {
	test("an omitted legacy boolean means inherit, not off", () => {
		expect(fastModeOverrideFromLegacyInput(undefined, undefined)).toBe("inherit");
	});

	test("a legacy boolean pins the session so old clients keep their explicit intent", () => {
		expect(fastModeOverrideFromLegacyInput(undefined, true)).toBe("on");
		expect(fastModeOverrideFromLegacyInput(undefined, false)).toBe("off");
	});

	test("an explicit override takes precedence over the legacy boolean", () => {
		expect(fastModeOverrideFromLegacyInput("inherit", true)).toBe("inherit");
		expect(fastModeOverrideFromLegacyInput("off", true)).toBe("off");
	});
});

describe("resolveSubagentActingUserId", () => {
	test("the turn's own user wins when the run carries one", () => {
		expect(resolveSubagentActingUserId("user-turn", "user-parent")).toBe("user-turn");
	});

	// Recovery/detached restarts start a subagent with no triggering user; without
	// this fallback an "inherit" fast-mode preference silently resolved to off.
	test("falls back to the parent session user when the run has none", () => {
		expect(resolveSubagentActingUserId(null, "user-parent")).toBe("user-parent");
		expect(resolveSubagentActingUserId(undefined, "user-parent")).toBe("user-parent");
	});

	test("stays anonymous only when neither side knows the user", () => {
		expect(resolveSubagentActingUserId(null, null)).toBeNull();
		expect(resolveSubagentActingUserId(undefined, undefined)).toBeNull();
	});
});

describe("resolveFastModeForUser", () => {
	// A pinned override must not need a user at all — the gateway paths pass null.
	test("resolves a pinned override without consulting any user preference", async () => {
		expect(await resolveFastModeForUser("on", null)).toBe(true);
		expect(await resolveFastModeForUser("off", null)).toBe(false);
	});

	test("inherit with no acting user falls back to disabled", async () => {
		expect(await resolveFastModeForUser("inherit", null)).toBe(false);
		expect(await resolveFastModeForUser("inherit", undefined)).toBe(false);
	});
});
