import { describe, expect, test } from "bun:test";
import {
	buildToolTimingRows,
	type ToolTimingStep,
} from "../../frontend/components/narrator/tool-timing-rows";

function step(key: string, time: number | null): ToolTimingStep {
	return { key, label: key, time };
}

describe("buildToolTimingRows", () => {
	test("gives the first row a null delta and every later row a gap from its predecessor", () => {
		const rows = buildToolTimingRows([
			step("started", 1_000),
			step("execution", 3_100),
			step("completed", 3_600),
		]);
		expect(rows.map((row) => [row.key, row.deltaMs])).toEqual([
			["started", null],
			["execution", 2_100],
			["completed", 500],
		]);
	});

	test("drops phases the tool never reached and re-anchors the gap on the survivor", () => {
		const rows = buildToolTimingRows([
			step("started", null),
			step("stream", 1_000),
			step("permission", null),
			step("execution", null),
			step("completed", 4_000),
		]);
		expect(rows.map((row) => row.key)).toEqual(["stream", "completed"]);
		expect(rows[1]?.deltaMs).toBe(3_000);
	});

	test("clamps out-of-order timestamps instead of showing a negative gap", () => {
		const rows = buildToolTimingRows([step("started", 5_000), step("completed", 4_000)]);
		expect(rows[1]?.deltaMs).toBe(0);
	});

	test("ignores non-finite times and returns nothing when no phase has a timestamp", () => {
		expect(buildToolTimingRows([step("started", Number.NaN), step("completed", null)])).toEqual([]);
		expect(buildToolTimingRows([])).toEqual([]);
	});

	test("keeps exactly one row for a single known phase, with no delta", () => {
		const rows = buildToolTimingRows([step("started", 7_000), step("completed", null)]);
		expect(rows).toEqual([{ key: "started", label: "started", time: 7_000, deltaMs: null }]);
	});
});
