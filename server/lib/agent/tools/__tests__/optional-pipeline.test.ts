import { describe, expect, test } from "bun:test";
import { getBuiltinRoutine, getBuiltinToolNames } from "../../../builtin-routines";
import { OPTIONAL_TOOLS } from "../index";

describe("optional Pipeline tools", () => {
	test("the pipeline routine controls both registered tools and is disabled by default", () => {
		const routine = getBuiltinRoutine("pipeline");
		expect(routine?.defaultEnabled).toBeUndefined();
		expect(routine?.tool).toBeDefined();
		if (!routine?.tool) throw new Error("pipeline routine is missing its tool definition");
		expect(getBuiltinToolNames(routine.tool)).toEqual(["StartPipeline", "ExtractPipeline"]);
	});

	test("both Pipeline tools are registered as optional", () => {
		expect(OPTIONAL_TOOLS.has("StartPipeline")).toBe(true);
		expect(OPTIONAL_TOOLS.has("ExtractPipeline")).toBe(true);
	});
});
