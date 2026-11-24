import { describe, expect, test } from "bun:test";
import { parseSubagentOutputCount, type SubagentOutputCount } from "./subagent-output-counts";

const count: SubagentOutputCount = {
	childNarratorId: "child",
	logicalRunId: "run",
	toolUseId: "wire",
	toolCallId: "pk",
	attempt: 0,
	count: 0,
	active: true,
};

describe("subagent output count protocol", () => {
	test("copies only the seven count and identity fields, including zero and terminal states", () => {
		const input = { ...count, input: "private prompt", text: "private body", nested: {} };
		expect(parseSubagentOutputCount(input)).toEqual(count);
		expect(parseSubagentOutputCount(input)).not.toBe(input);
		expect(parseSubagentOutputCount({ ...input, active: false })).toEqual({
			...count,
			active: false,
		});
	});

	test("rejects missing or empty identity fields", () => {
		for (const field of ["childNarratorId", "logicalRunId", "toolUseId", "toolCallId"] as const) {
			for (const invalid of [undefined, null, "", "  ", 1]) {
				expect(parseSubagentOutputCount({ ...count, [field]: invalid })).toBeUndefined();
			}
		}
	});

	test("bounds identity strings by the runtime registration's narrator and record budgets", () => {
		for (const [field, limit] of [
			["childNarratorId", 64],
			["logicalRunId", 128],
			["toolUseId", 128],
			["toolCallId", 128],
		] as const) {
			expect(parseSubagentOutputCount({ ...count, [field]: "x".repeat(limit) })).toBeDefined();
			expect(
				parseSubagentOutputCount({ ...count, [field]: "x".repeat(limit + 1) }),
			).toBeUndefined();
		}
	});

	test("accepts only nonnegative safe integer counts and attempts and boolean activity", () => {
		for (const field of ["attempt", "count"] as const) {
			for (const invalid of [
				-1,
				0.1,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.MAX_SAFE_INTEGER + 1,
				"0",
				null,
			]) {
				expect(parseSubagentOutputCount({ ...count, [field]: invalid })).toBeUndefined();
			}
			expect(
				parseSubagentOutputCount({ ...count, [field]: Number.MAX_SAFE_INTEGER }),
			).toBeDefined();
		}
		for (const active of [undefined, null, 0, "true"]) {
			expect(parseSubagentOutputCount({ ...count, active })).toBeUndefined();
		}
		for (const value of [null, undefined, [], 1, "count"]) {
			expect(parseSubagentOutputCount(value)).toBeUndefined();
		}
	});
});
