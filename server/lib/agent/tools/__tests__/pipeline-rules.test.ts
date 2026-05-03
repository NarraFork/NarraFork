import { describe, expect, test } from "bun:test";
import { executePipelineRule, PipelineRuleError, splitPipelineStages } from "../../pipeline-rules";

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
});
