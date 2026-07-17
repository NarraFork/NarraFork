import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { validatePluginRelease } from "../../scripts/validate-plugin-release";

describe("plugin GA release validation", () => {
	test("validates the three reference packages across the supported matrix", async () => {
		const summary = await validatePluginRelease(resolve(process.cwd(), "examples/plugins"));
		expect(summary.valid).toBe(true);
		expect(summary.packageCount).toBe(3);
		expect(summary.matrixCombinationCount).toBe(18);
		expect(summary.errors).toEqual([]);
		expect(summary.packages.map((item) => item.kind)).toEqual([
			"provider",
			"sandbox-ui-panel",
			"tool-command",
		]);
		expect(summary.packages.every((item) => item.sbom.generatedSpdx)).toBe(true);
	});
});
