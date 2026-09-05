import { describe, expect, test } from "bun:test";
import { coerceAskQuestions } from "../ask-user-question-coerce";

describe("coerceAskQuestions", () => {
	test("repairs a question missing its `question` key by deriving from header", () => {
		const questions = coerceAskQuestions([
			{
				question: "max-enum",
				header: "max 档位怎么处理",
				options: [
					{ label: "方案A", description: "全局加 max" },
					{ label: "方案B", description: "维持现状" },
				],
			},
			{
				// no `question` key — this is the real-world failure case
				header: "能否关闭思考模式",
				options: [
					{ label: "对齐IDE", description: "不提供 none" },
					{ label: "保留none", description: "比 IDE 多一个能力" },
				],
			},
		]);

		expect(questions).toHaveLength(2);
		expect(questions[0].question).toBe("max-enum");
		expect(questions[1].question).toBe("能否关闭思考模式");
		expect(questions.every((q) => q.question.length > 0)).toBe(true);
	});

	test("derives unique keys when multiple questions share a header", () => {
		const questions = coerceAskQuestions([
			{ header: "测试策略", options: [{ label: "A", description: "" }] },
			{ header: "测试策略", options: [{ label: "B", description: "" }] },
		]);

		expect(questions.map((q) => q.question)).toEqual(["测试策略", "测试策略 (2)"]);
	});

	test("replaces placeholder keys like 'undefined'/'null'", () => {
		const questions = coerceAskQuestions([
			{ question: "undefined", header: "策略", options: [{ label: "A", description: "" }] },
			{ question: "null", header: "范围", options: [{ label: "B", description: "" }] },
		]);

		expect(questions[0].question).toBe("策略");
		expect(questions[1].question).toBe("范围");
	});

	test("parses a stringified questions array", () => {
		const questions = coerceAskQuestions(
			JSON.stringify([
				{ question: "approach", header: "Approach", options: [{ label: "A", description: "d" }] },
			]),
		);

		expect(questions).toHaveLength(1);
		expect(questions[0].question).toBe("approach");
		expect(questions[0].options[0]).toEqual({ label: "A", description: "d" });
	});

	test("falls back to positional key when neither question nor header exist", () => {
		const questions = coerceAskQuestions([
			{ options: [{ label: "A", description: "" }] },
			{ options: [{ label: "B", description: "" }] },
		]);

		expect(questions.map((q) => q.question)).toEqual(["Question 1", "Question 2"]);
		expect(questions.map((q) => q.header)).toEqual(["Question 1", "Question 2"]);
	});

	test("returns empty array for unrecoverable input", () => {
		expect(coerceAskQuestions("not json")).toEqual([]);
		expect(coerceAskQuestions(null)).toEqual([]);
		expect(coerceAskQuestions(42)).toEqual([]);
	});
});
