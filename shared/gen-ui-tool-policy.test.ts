import { describe, expect, test } from "bun:test";
import {
	GEN_UI_ACTIONS,
	GEN_UI_INLINE_HEIGHTS,
	isGenUiReadAction,
	readGenUiInlineSize,
} from "./gen-ui-tool-policy";

describe("GenUI file tool permission classification", () => {
	test("show, render and kit_status are read-only; everything else is mutating", () => {
		expect(GEN_UI_ACTIONS).toEqual([
			"create",
			"show",
			"render",
			"inspect",
			"kit_status",
			"kit_build",
		]);
		for (const action of ["show", "render", "kit_status"])
			expect(isGenUiReadAction(action)).toBe(true);
		for (const action of [
			"create",
			// Executes generated code in a server-side browser; not an exempt read.
			"inspect",
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
			expect(isGenUiReadAction(action)).toBe(false);
	});

	test("inline size falls back to the default instead of an unmeasured height", () => {
		expect(readGenUiInlineSize("sm")).toBe("sm");
		expect(readGenUiInlineSize("lg")).toBe("lg");
		for (const value of ["md", "xl", "", undefined, 400, null])
			expect(readGenUiInlineSize(value)).toBe("md");
		expect(GEN_UI_INLINE_HEIGHTS.sm).toBeLessThan(GEN_UI_INLINE_HEIGHTS.md);
		expect(GEN_UI_INLINE_HEIGHTS.md).toBeLessThan(GEN_UI_INLINE_HEIGHTS.lg);
	});
});
