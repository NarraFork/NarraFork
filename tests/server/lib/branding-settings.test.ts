/**
 * branding-settings.test.ts — The settings WRITE path for branding.
 *
 * Two behaviours matter here and neither is obvious from the types:
 *
 *  1. The schema validates strictly while every read path is forgiving. An admin
 *     who typed a malformed colour must get an error rather than a save that
 *     silently renders as the default — the settings page is the only place where a
 *     mistake can still be corrected by the person who made it.
 *
 *  2. `normalizeBrandingSettings` canonicalizes and DROPS blanks. Dropping is what
 *     makes "clear the field" work: the UI sends "" to distinguish clearing from
 *     "leave unchanged" (an absent key under `.partial()`), so an empty string that
 *     survived into storage would only be indistinguishable from unset by accident.
 */

import { describe, expect, test } from "bun:test";
import { BRAND_NAME_MAX_LENGTH } from "@shared/branding";
import { normalizeBrandingSettings } from "../../../server/lib/branding";
import type { NarraForkSettings } from "../../../server/lib/settings/types";
import { updateSettingsSchema } from "../../../server/routes/settings";

function parseBranding(branding: unknown) {
	return updateSettingsSchema.safeParse({ branding });
}

function normalize(branding: NarraForkSettings["branding"]): NarraForkSettings["branding"] {
	const settings = { branding } as NarraForkSettings;
	normalizeBrandingSettings(settings);
	return settings.branding;
}

describe("updateSettingsSchema branding validation", () => {
	test("accepts a name and a full hex colour", () => {
		expect(parseBranding({ name: "Work Instance", iconColor: "#e64980" }).success).toBe(true);
	});

	test("accepts the short hex form", () => {
		expect(parseBranding({ iconColor: "#abc" }).success).toBe(true);
	});

	test("accepts empty strings, which is how the UI clears a field", () => {
		expect(parseBranding({ name: "", iconColor: "" }).success).toBe(true);
	});

	test("accepts each field independently", () => {
		expect(parseBranding({ name: "Only a name" }).success).toBe(true);
		expect(parseBranding({ iconColor: "#123456" }).success).toBe(true);
		expect(parseBranding({}).success).toBe(true);
	});

	test("rejects a malformed colour instead of silently storing it", () => {
		for (const bad of ["red", "e64980", "#12345", "#gggggg", "rgb(1,2,3)", "#4c6ef5x"]) {
			expect(parseBranding({ iconColor: bad }).success).toBe(false);
		}
	});

	test("trims surrounding whitespace rather than rejecting on it", () => {
		// Pasted colours often carry a trailing space. That is input hygiene, not a
		// malformed value, so the schema trims before matching.
		const result = parseBranding({ iconColor: " #4c6ef5 " });
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.branding?.iconColor).toBe("#4c6ef5");
	});

	test("rejects a name past the display bound", () => {
		expect(parseBranding({ name: "x".repeat(BRAND_NAME_MAX_LENGTH) }).success).toBe(true);
		expect(parseBranding({ name: "x".repeat(BRAND_NAME_MAX_LENGTH + 1) }).success).toBe(false);
	});

	test("rejects non-string values", () => {
		expect(parseBranding({ name: 42 }).success).toBe(false);
		expect(parseBranding({ iconColor: null }).success).toBe(false);
	});
});

describe("normalizeBrandingSettings", () => {
	test("canonicalizes a short-form colour and collapses a padded name", () => {
		expect(normalize({ name: "  Work   Instance ", iconColor: "#ABC" })).toEqual({
			name: "Work Instance",
			iconColor: "#aabbcc",
		});
	});

	test("drops a blank field rather than storing an empty string", () => {
		expect(normalize({ name: "", iconColor: "#e64980" })).toEqual({ iconColor: "#e64980" });
		expect(normalize({ name: "Work", iconColor: "" })).toEqual({ name: "Work" });
	});

	test("removes the whole object when nothing is left", () => {
		// An instance that never customized anything should have no stray key in
		// settings.json.
		expect(normalize({ name: "", iconColor: "" })).toBeUndefined();
		expect(normalize({ name: "   " })).toBeUndefined();
	});

	test("drops an invalid stored colour instead of persisting it", () => {
		expect(normalize({ name: "Work", iconColor: "not-a-colour" })).toEqual({ name: "Work" });
	});

	test("leaves an absent branding key absent", () => {
		expect(normalize(undefined)).toBeUndefined();
	});

	test("is idempotent", () => {
		const once = normalize({ name: " Work ", iconColor: "#ABC" });
		expect(normalize(once)).toEqual(once);
	});
});
