/**
 * no_proxy rule write validation: what an admin may persist through
 * `PATCH /api/settings`.
 */

import { describe, expect, test } from "bun:test";
import { MAX_NO_PROXY_RULES, validateNoProxyPattern } from "@shared/proxy-settings";
import { mergeProxySettingsPatch, updateSettingsSchema } from "../../../server/routes/settings";

function proxyPatch(noProxyRules: unknown) {
	return { proxy: { mode: "custom", url: "http://proxy.example:3128", noProxyRules } };
}

describe("no_proxy rule settings validation", () => {
	test("accepts wildcard and regex rules and trims the pattern", () => {
		const parsed = updateSettingsSchema.parse(
			proxyPatch([
				{ match: "wildcard", pattern: " *.internal.example.com " },
				{ id: "np_1", match: "regex", pattern: "^api\\d+\\.example\\.com$", enabled: false },
			]),
		);
		expect(parsed.proxy?.noProxyRules).toEqual([
			{ match: "wildcard", pattern: "*.internal.example.com" },
			{ id: "np_1", match: "regex", pattern: "^api\\d+\\.example\\.com$", enabled: false },
		]);
	});

	test("accepts clearing the list and omitting it entirely", () => {
		expect(updateSettingsSchema.parse(proxyPatch([])).proxy?.noProxyRules).toEqual([]);
		expect(
			updateSettingsSchema.parse({ proxy: { mode: "direct" } }).proxy?.noProxyRules,
		).toBeUndefined();
	});

	test("rejects an uncompilable regex", () => {
		expect(
			updateSettingsSchema.safeParse(proxyPatch([{ match: "regex", pattern: "([unclosed" }]))
				.success,
		).toBe(false);
	});

	test("rejects an unknown match kind, empty pattern or over-long pattern", () => {
		expect(
			updateSettingsSchema.safeParse(proxyPatch([{ match: "glob", pattern: "*.example.com" }]))
				.success,
		).toBe(false);
		expect(
			updateSettingsSchema.safeParse(proxyPatch([{ match: "wildcard", pattern: "   " }])).success,
		).toBe(false);
		expect(
			updateSettingsSchema.safeParse(proxyPatch([{ match: "wildcard", pattern: "a".repeat(501) }]))
				.success,
		).toBe(false);
	});

	test("caps the number of rules", () => {
		const tooMany = Array.from({ length: MAX_NO_PROXY_RULES + 1 }, () => ({
			match: "wildcard",
			pattern: "*.example.com",
		}));
		expect(updateSettingsSchema.safeParse(proxyPatch(tooMany)).success).toBe(false);
	});
});

describe("validateNoProxyPattern", () => {
	test("only regex rules are compile-checked", () => {
		expect(validateNoProxyPattern("wildcard", "*.[weird")).toBeUndefined();
		expect(validateNoProxyPattern("regex", "*.[weird")).toBeDefined();
		expect(validateNoProxyPattern("regex", "^ok$")).toBeUndefined();
		expect(validateNoProxyPattern("wildcard", "   ")).toBeDefined();
	});
});

describe("proxy patch merge keeps the shared rule list", () => {
	const storedRules = [{ match: "wildcard" as const, pattern: "*.internal.example.com" }];

	test("a mode-only patch keeps the stored rules and drops the stale url", () => {
		const merged = mergeProxySettingsPatch(
			{ mode: "custom", url: "http://old:3128", noProxyRules: storedRules },
			{ mode: "direct" },
		);
		expect(merged).toEqual({ mode: "direct", noProxyRules: storedRules });
	});

	test("an explicit list replaces the stored one, including an empty list", () => {
		const next = [{ match: "regex" as const, pattern: "^api\\.example\\.com$" }];
		expect(
			mergeProxySettingsPatch(
				{ mode: "custom", url: "http://old:3128", noProxyRules: storedRules },
				{ mode: "custom", url: "http://new:3128", noProxyRules: next },
			).noProxyRules,
		).toEqual(next);
		expect(
			mergeProxySettingsPatch(
				{ mode: "direct", noProxyRules: storedRules },
				{ mode: "direct", noProxyRules: [] },
			).noProxyRules,
		).toEqual([]);
	});

	test("a first write without stored rules stays without rules", () => {
		expect(mergeProxySettingsPatch(undefined, { mode: "system" })).toEqual({ mode: "system" });
	});
});
