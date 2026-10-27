import { describe, expect, test } from "bun:test";
import {
	analyzeModelTrace,
	buildModelTracePrompt,
	ModelTraceOutputError,
	parseModelTraceOutput,
} from "./index";
import { bank, scoreModelTrace } from "./scoring";
import upstream from "./upstream-fixtures.json";

const numbers = upstream.fixtures[0].numbers;
const sample = JSON.stringify(numbers);

describe("ModelTrace upstream numerical parity", () => {
	for (const [index, fixture] of upstream.fixtures.entries()) {
		test(`fixture ${index + 1}: every score, probability, order and family matches upstream`, () => {
			const actual = scoreModelTrace(fixture.numbers);
			expect(actual.beta).toBe(bank.calibration["1"].beta);
			expect(actual.results.map((item) => item.model)).toEqual(
				fixture.results.map((item) => item.model),
			);
			actual.results.forEach((item, resultIndex) => {
				expect(item.score).toBe(fixture.results[resultIndex].score);
				expect(item.probability).toBe(fixture.results[resultIndex].probability);
			});
			actual.families.forEach((item, familyIndex) => {
				expect(item.family).toBe(fixture.families[familyIndex].family);
				expect(item.probability).toBe(fixture.families[familyIndex].probability);
			});
			expect(actual.results.reduce((sum, item) => sum + item.probability, 0)).toBeCloseTo(1, 14);
		});
	}
});

describe("strict sample parsing", () => {
	test("accepts bare JSON and complete JSON/unlabeled code fences", () => {
		for (const text of [
			sample,
			` \n${sample}\n`,
			`\`\`\`json\n${sample}\n\`\`\``,
			`~~~JSON\r\n${sample}\r\n~~~`,
			`\`\`\`\n${sample}\n\`\`\``,
		]) {
			expect(parseModelTraceOutput(text)).toEqual(numbers);
		}
	});

	for (const [name, text] of [
		["empty", ""],
		["refusal", "I cannot comply."],
		["prose", `Here is the answer: ${sample}`],
		["truncated", sample.slice(0, -1)],
		["trailing prose", `${sample}\nDone`],
		["multiple arrays", `${sample}\n${sample}`],
		["outer fence prose", `Answer:\n\`\`\`json\n${sample}\n\`\`\``],
		["mismatched fence", `\`\`\`json\n${sample}\n~~~`],
		["unsupported fence language", `\`\`\`js\n${sample}\n\`\`\``],
		["object", JSON.stringify({ numbers })],
		["empty array", "[]"],
		["too few", JSON.stringify(numbers.slice(0, 164))],
		["too many", JSON.stringify(Array(376).fill(1))],
		["zero", sample.replace(/^\[\d+/, "[0")],
		["above range", sample.replace(/^\[\d+/, "[356")],
		["negative", sample.replace(/^\[\d+/, "[-1")],
		["decimal", sample.replace(/^\[\d+/, "[1.0")],
		["exponent", sample.replace(/^\[\d+/, "[1e2")],
		["string", sample.replace(/^\[\d+/, '["12"')],
		["boolean", sample.replace(/^\[\d+/, "[true")],
		["null", sample.replace(/^\[\d+/, "[null")],
		["nested", sample.replace(/^\[\d+/, "[[1]")],
		["oversized", ` ${" ".repeat(10_000)}${sample}`],
	]) {
		test(`rejects ${name} without inventing results`, () => {
			expect(() => parseModelTraceOutput(text)).toThrow(ModelTraceOutputError);
			const report = analyzeModelTrace(text);
			expect(report.type).toBe("modeltrace_result");
			expect(report.results).toEqual([]);
			expect(report.error).toBeTruthy();
		});
	}

	test("includes both accepted length boundaries", () => {
		for (const count of [165, 375]) {
			expect(parseModelTraceOutput(JSON.stringify(Array(count).fill(1))).length).toBe(count);
		}
	});
});

describe("prompt and local report", () => {
	test("prompt demands one bounded direct generation and does not resume prior task", () => {
		const prompt = buildModelTracePrompt();
		for (const token of [
			"300",
			"355",
			"JSON 整数数组",
			"不要调用工具",
			"其他模型",
			"不要继续之前的任务",
			"不要排序、平衡频数、修复重复",
		]) {
			expect(prompt).toContain(token);
		}
		expect(prompt).not.toContain("例如");
		expect(prompt).not.toMatch(/\[\s*\d/);
	});

	test("returns only five ranked model probabilities for a compact result card", () => {
		const report = analyzeModelTrace(sample);
		const expected = scoreModelTrace(numbers)
			.results.slice(0, 5)
			.map(({ model, displayName, probability }) => ({ model, displayName, probability }));
		expect(report).toEqual({ type: "modeltrace_result", results: expected });
		expect(report.results).toHaveLength(5);
		expect(report).not.toHaveProperty("families");
		expect(report).not.toHaveProperty("configuredModel");
		expect(report).not.toHaveProperty("sampleCount");
	});

	test("failure has a short localized reason and no invented probabilities", () => {
		const en = analyzeModelTrace("refused", "en-US");
		expect(en.type).toBe("modeltrace_result");
		expect(en.error).toContain("not complete JSON");
		expect(en.results).toEqual([]);
		const zh = analyzeModelTrace("refused", "zh-CN");
		expect(zh.error).toContain("不是完整JSON");
		expect(zh.error?.length).toBeLessThan(100);
		expect(zh.results).toEqual([]);
	});

	test("an accepted short sample still yields five candidates without verbose metadata", () => {
		expect(analyzeModelTrace(JSON.stringify(numbers.slice(0, 165))).results).toHaveLength(5);
	});
});
