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
			const report = analyzeModelTrace(text, "gpt-5.4");
			expect(report).toContain("无法评分");
			expect(report).not.toContain("TOP5");
			expect(report).not.toContain("%");
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

	test("reports count, TOP5, families, configured rank and limitations", () => {
		const report = analyzeModelTrace(sample, "gpt-5.4");
		for (const token of [
			"数字数：300",
			"TOP5",
			"家族概率",
			"GPT",
			"Claude",
			"候选库排名",
			"闭集",
			"上下文偏差",
			"单样本",
		]) {
			expect(report).toContain(token);
		}
		expect(report.match(/^\d\. /gm)?.length).toBe(5);
	});

	test("unknown and alias IDs are not guessed; user model names are escaped and bounded", () => {
		const report = analyzeModelTrace(sample, "provider/gpt-5.4\n<script>|".repeat(1_000));
		expect(report).toContain("未收录");
		expect(report).not.toContain("<script>");
		expect(report.length).toBeLessThan(3_000);
	});

	test("case-insensitive exact candidate matching", () => {
		expect(analyzeModelTrace(sample, " GPT-5.4 ")).toContain("候选库排名");
	});

	test("supports English report and rejection messages", () => {
		const report = analyzeModelTrace(sample, "unknown", "en-US");
		expect(report).toContain("Numbers: 300");
		expect(report).toContain("not included");
		expect(report).toContain("closed-set");
		expect(report).toContain("context bias");
		expect(analyzeModelTrace("refused", "unknown", "en")).toContain("no result");
	});

	test("single-round reports do not promise to disable provider transport retries", () => {
		for (const text of [sample, "refused"]) {
			const en = analyzeModelTrace(text, "unknown", "en");
			expect(en).toContain("Only one sampling round was scheduled");
			expect(en).toContain("existing transport retry policy");
			expect(en).not.toContain("No retry");
			const zh = analyzeModelTrace(text, "unknown", "zh-CN");
			expect(zh).toContain("仅安排一轮采样");
			expect(zh).toContain("现有重试策略");
			expect(zh).not.toContain("未重试");
		}
	});

	test("short accepted sample is labeled cautiously", () => {
		expect(analyzeModelTrace(JSON.stringify(numbers.slice(0, 165)), "unknown")).toContain(
			"样本少于请求数量",
		);
	});
});
