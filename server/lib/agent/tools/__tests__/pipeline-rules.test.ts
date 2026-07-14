import { describe, expect, test } from "bun:test";
import {
	executePipelineRule,
	MAX_PIPELINE_CAPTURE_CHARS,
	MAX_PIPELINE_CAPTURE_LINES,
	MAX_PIPELINE_COMMANDS,
	MAX_PIPELINE_CUT_FIELDS,
	MAX_PIPELINE_OUTPUT_CHARS,
	MAX_PIPELINE_RULE_CHARS,
	MAX_PIPELINE_SELECTED_CAPTURES,
	MAX_PIPELINE_TOTAL_BYTES,
	MAX_PIPELINE_TOTAL_CHARS,
	MAX_PIPELINE_TOTAL_LINES,
	PipelineRuleError,
	preparePipelineRule,
	splitPipelineStages,
} from "../../pipeline-rules";

const sources = [
	{
		alias: "p1",
		text: [
			"src/a.ts:10:error failed",
			"src/b.ts:20:ok",
			"node_modules/pkg/index.js:1:error ignored",
		].join("\n"),
	},
	{
		alias: "p2",
		text: ["src/c.ts:30:FAILED again", "src/a.ts:10:error failed"].join("\n"),
	},
];

describe("pipeline rule parser", () => {
	test("splits stages with quotes and escapes", () => {
		expect(splitPipelineStages('from p1 | grep -i "error|failed" | head -n 2')).toEqual([
			["from", "p1"],
			["grep", "-i", "error|failed"],
			["head", "-n", "2"],
		]);
		expect(splitPipelineStages("from p1 | grep 'hello world' | cut -d ':' -f 1,2")).toEqual([
			["from", "p1"],
			["grep", "hello world"],
			["cut", "-d", ":", "-f", "1,2"],
		]);
	});

	test("throws on unclosed quotes", () => {
		expect(() => splitPipelineStages('grep "unterminated')).toThrow(PipelineRuleError);
	});
});

describe("pipeline rule execution", () => {
	test("runs grep, inverse grep, sort, uniq, and head", () => {
		const result = executePipelineRule(
			sources,
			'from p1 p2 | grep -i "error|failed" | grep -v node_modules | sort | uniq | head -n 2',
		);
		expect(result.aliases).toEqual(["p1", "p2"]);
		expect(result.text).toBe(["src/a.ts:10:error failed", "src/c.ts:30:FAILED again"].join("\n"));
	});

	test("uses default aliases when rule omits from", () => {
		const result = executePipelineRule(sources, "grep ok", ["p1"]);
		expect(result.aliases).toEqual(["p1"]);
		expect(result.text).toBe("src/b.ts:20:ok");
	});

	test("cuts selected fields", () => {
		const result = executePipelineRule(sources, "from p1 | grep ok | cut -d ':' -f 1,3");
		expect(result.text).toBe("src/b.ts:ok");
	});

	test("accepts a small cut field range", () => {
		const result = executePipelineRule(sources, "from p1 | grep ok | cut -d ':' -f 1-3");
		expect(result.text).toBe("src/b.ts:20:ok");
	});

	test("rejects an oversized cut field range without expanding it", () => {
		// Regression: a huge finite range previously expanded eagerly during rule
		// validation (before any deadline existed), freezing the main thread.
		const start = performance.now();
		expect(() => preparePipelineRule(["p1"], "from p1 | cut -d ':' -f 1-50000000")).toThrow(
			`cut field list exceeds ${MAX_PIPELINE_CUT_FIELDS} fields`,
		);
		// The guard must reject before allocating; this stays well under a second.
		expect(performance.now() - start).toBeLessThan(200);
	});

	test("rejects a cut range whose bound parses to a non-finite number", () => {
		// A many-digit upper bound coerces to Infinity; the old loop `i <= Infinity`
		// would never terminate. Must be rejected as an invalid range.
		expect(() =>
			preparePipelineRule(["p1"], `from p1 | cut -d ':' -f 1-${"9".repeat(400)}`),
		).toThrow("Invalid cut field range");
	});

	test("rejects a comma cut list that expands past the field cap", () => {
		const spec = Array.from({ length: MAX_PIPELINE_CUT_FIELDS + 1 }, (_, i) => i + 1).join(",");
		expect(() => preparePipelineRule(["p1"], `from p1 | cut -d ':' -f ${spec}`)).toThrow(
			`cut field list exceeds ${MAX_PIPELINE_CUT_FIELDS} fields`,
		);
	});

	test("tails selected lines", () => {
		const result = executePipelineRule(sources, "from p1 | tail -n 1");
		expect(result.text).toBe("node_modules/pkg/index.js:1:error ignored");
	});

	test("reports unknown aliases", () => {
		expect(() => executePipelineRule(sources, "from p9 | cat")).toThrow("Unknown pipeline alias");
	});

	test("reports unsupported commands", () => {
		expect(() => executePipelineRule(sources, "from p1 | awk '{print $1}'")).toThrow(
			"Unsupported pipeline command",
		);
	});

	test("enforces rule, command, and selected-capture limits before execution", () => {
		expect(() => preparePipelineRule(["p1"], "x".repeat(MAX_PIPELINE_RULE_CHARS + 1))).toThrow(
			"rule exceeds",
		);
		expect(() =>
			preparePipelineRule(
				["p1"],
				Array.from({ length: MAX_PIPELINE_COMMANDS + 1 }, () => "cat").join(" | "),
			),
		).toThrow("commands");
		const aliases = Array.from(
			{ length: MAX_PIPELINE_SELECTED_CAPTURES + 1 },
			(_, index) => `p${index + 1}`,
		);
		expect(() => preparePipelineRule(aliases)).toThrow("captures");
	});

	test("enforces per-capture and total byte, character, and line limits", () => {
		expect(() =>
			executePipelineRule([{ alias: "p1", text: "x".repeat(MAX_PIPELINE_CAPTURE_CHARS + 1) }]),
		).toThrow("characters");
		expect(() =>
			executePipelineRule([{ alias: "p1", text: "x\n".repeat(MAX_PIPELINE_CAPTURE_LINES) }]),
		).toThrow("lines");

		const byteHeavySources = Array.from({ length: 5 }, (_, index) => ({
			alias: `p${index + 1}`,
			text: "😀".repeat(Math.ceil(MAX_PIPELINE_TOTAL_BYTES / 4 / 5) + 1),
		}));
		expect(() => executePipelineRule(byteHeavySources)).toThrow("total bytes");
		const charHeavySources = Array.from({ length: 5 }, (_, index) => ({
			alias: `p${index + 1}`,
			text: "x".repeat(Math.ceil(MAX_PIPELINE_TOTAL_CHARS / 5) + 1),
		}));
		expect(() => executePipelineRule(charHeavySources)).toThrow("total characters");
		const lineHeavySources = Array.from({ length: 5 }, (_, index) => ({
			alias: `p${index + 1}`,
			text: "x\n".repeat(Math.ceil(MAX_PIPELINE_TOTAL_LINES / 5)),
		}));
		expect(() => executePipelineRule(lineHeavySources)).toThrow("total lines");
	});

	test("enforces execution time and output limits", () => {
		let now = 0;
		expect(() =>
			executePipelineRule(sources, "from p1 | grep error", undefined, {
				maxExecutionMs: 0,
				now: () => ++now,
			}),
		).toThrow("execution exceeded");

		const bounded = executePipelineRule([
			{ alias: "p1", text: "x".repeat(MAX_PIPELINE_OUTPUT_CHARS + 100) },
		]);
		expect(bounded.text.length).toBe(MAX_PIPELINE_OUTPUT_CHARS);
	});
});
