import { describe, expect, test } from "bun:test";
import { INTELLIGENT_UI_ACTIONS, isIntelligentUiReadAction } from "./intelligent-ui-tool-policy";

describe("IntelligentUI file tool permission classification", () => {
	test("only show is read-only; create and unknown actions are mutating", () => {
		expect(INTELLIGENT_UI_ACTIONS).toEqual(["create", "show"]);
		expect(isIntelligentUiReadAction("show")).toBe(true);
		for (const action of [
			"create",
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
			"future",
		])
			expect(isIntelligentUiReadAction(action)).toBe(false);
	});
});
