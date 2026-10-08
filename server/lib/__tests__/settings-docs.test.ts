import { describe, expect, test } from "bun:test";
import { DEFAULTS, getMissingSettingDocPaths, SETTING_DOCS } from "../settings/defaults";

describe("setting documentation completeness", () => {
	test("documents every editable default leaf and provider collection", () => {
		expect(getMissingSettingDocPaths()).toEqual([]);
		for (const path of [
			"customApiProviders",
			"openaiProviders",
			"anthropicProviders",
			"geminiProviders",
		]) {
			expect(SETTING_DOCS[path]?.type).toBe("array");
			expect(SETTING_DOCS[path]?.desc).toBeTruthy();
		}
	});

	test("keeps generated JWT material out of editable field documentation", () => {
		expect(SETTING_DOCS).not.toHaveProperty("auth.jwtSecret");
		expect(
			getMissingSettingDocPaths({ auth: { jwtSecret: "private runtime material" } }, {}),
		).toEqual([]);
	});

	test("does not hide new authentication fields or other genuine gaps", () => {
		expect(
			getMissingSettingDocPaths(
				{ auth: { jwtSecret: "", newPublicSetting: true }, unknown: 1 },
				{},
			),
		).toEqual(["auth.newPublicSetting", "unknown"]);
	});

	test("detects a removed collection doc rather than excluding provider arrays", () => {
		const { openaiProviders: _removed, ...docs } = SETTING_DOCS;
		expect(getMissingSettingDocPaths(DEFAULTS as unknown as Record<string, unknown>, docs)).toEqual(
			["openaiProviders"],
		);
	});
});
