import { describe, expect, test } from "bun:test";
import {
	INTELLIGENT_UI_ACTIONS,
	INTELLIGENT_UI_INLINE_HEIGHTS,
	isIntelligentUiReadAction,
	readIntelligentUiInlineSize,
} from "./intelligent-ui-tool-policy";

describe("IntelligentUI file tool permission classification", () => {
	test("show, render and kit_status are read-only; everything else is mutating", () => {
		expect(INTELLIGENT_UI_ACTIONS).toEqual(["create", "show", "render", "kit_status", "kit_build"]);
		for (const action of ["show", "render", "kit_status"])
			expect(isIntelligentUiReadAction(action)).toBe(true);
		for (const action of [
			"create",
			// Runs the project's bundler and rewrites the bundle previews load.
			"kit_build",
			"catalog",
			"prepare",
			"read",
			"edit",
			"list",
			"archive",
			undefined,
			null,
			{},
			"SHOW",
			"RENDER",
			"future",
		])
			expect(isIntelligentUiReadAction(action)).toBe(false);
	});

	test("inline size falls back to the default instead of an unmeasured height", () => {
		expect(readIntelligentUiInlineSize("sm")).toBe("sm");
		expect(readIntelligentUiInlineSize("lg")).toBe("lg");
		for (const value of ["md", "xl", "", undefined, 400, null])
			expect(readIntelligentUiInlineSize(value)).toBe("md");
		expect(INTELLIGENT_UI_INLINE_HEIGHTS.sm).toBeLessThan(INTELLIGENT_UI_INLINE_HEIGHTS.md);
		expect(INTELLIGENT_UI_INLINE_HEIGHTS.md).toBeLessThan(INTELLIGENT_UI_INLINE_HEIGHTS.lg);
	});
});
