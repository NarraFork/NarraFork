import { describe, expect, test } from "bun:test";
import {
	coerceQuestions,
	formatHMS,
	getCustomSavedAnswer,
	getSelectedOptionValue,
	isSavedOptionSelected,
	resolveSavedAnswer,
} from "./ask-user-question-utils";

describe("formatHMS", () => {
	test("formats sub-minute, minute, and hour durations with zero-padding", () => {
		expect(formatHMS(0)).toBe("00:00:00");
		expect(formatHMS(5_000)).toBe("00:00:05");
		expect(formatHMS(65_000)).toBe("00:01:05");
		expect(formatHMS(3_661_000)).toBe("01:01:01");
	});

	test("clamps negatives to zero and floors partial seconds", () => {
		expect(formatHMS(-1)).toBe("00:00:00");
		expect(formatHMS(-999_999)).toBe("00:00:00");
		expect(formatHMS(1_999)).toBe("00:00:01");
	});
});

describe("ask-user-question-utils", () => {
	test("coerces advertised short-header + description shape", () => {
		const questions = coerceQuestions([
			{
				header: "测试策略",
				description: "是否坚持全修全部测试？",
				options: [{ header: "坚持全修", description: "修复全部测试" }],
			},
		]);

		expect(questions[0]?.header).toBe("测试策略");
		expect(questions[0]?.description).toBe("是否坚持全修全部测试？");
		expect(questions[0]?.options[0]?.header).toBe("坚持全修");
	});

	test("maps legacy short header + long question body into title/description", () => {
		const body = "背景很长……最终怎么选？";
		const questions = coerceQuestions([
			{
				question: body,
				header: "短标题",
				options: [{ label: "A", description: "desc" }],
			},
		]);

		expect(questions[0]?.header).toBe("短标题");
		expect(questions[0]?.description).toBe(body);
		expect(questions[0]?.options[0]?.header).toBe("A");
	});

	test("parses stringified questions and normalizes option headers", () => {
		const questions = coerceQuestions(
			JSON.stringify([
				{
					header: "  Approach  ",
					description: " Which implementation approach? ",
					options: [{ header: " 坚持全修 ", description: "desc", preview: "preview" }],
				},
			]),
		);

		expect(questions[0]?.header).toBe("Approach");
		expect(questions[0]?.description).toBe("Which implementation approach?");
		expect(questions[0]?.options[0]).toEqual({
			header: "坚持全修",
			description: "desc",
			preview: "preview",
		});
	});

	test("uniquifies colliding headers so answer keys stay unique", () => {
		const questions = coerceQuestions([
			{ header: "Approach", options: [{ header: "A" }] },
			{ header: "Approach", options: [{ header: "B" }] },
		]);
		expect(questions.map((q) => q.header)).toEqual(["Approach", "Approach (2)"]);
	});

	test("matches read-only answers by header first", () => {
		const [question] = coerceQuestions([
			{
				header: "测试策略",
				options: [{ header: "修有价值那几类" }, { header: "坚持全修" }],
			},
		]);

		expect(getSelectedOptionValue(question, { 测试策略: " 坚持全修 " })).toBe("坚持全修");
		expect(
			isSavedOptionSelected(question, "坚持全修", { 测试策略: "修有价值那几类, 坚持全修" }),
		).toBe(true);
		expect(getCustomSavedAnswer(question, { 测试策略: "使用其它方案" })).toBe("使用其它方案");
	});

	test("matches read-only option headers that contain commas", () => {
		const [question] = coerceQuestions([
			{
				header: "Strategy",
				options: [{ header: "Fix parser, then tests" }],
			},
		]);

		expect(getSelectedOptionValue(question, { Strategy: "Fix parser, then tests" })).toBe(
			"Fix parser, then tests",
		);
		expect(
			isSavedOptionSelected(question, "Fix parser, then tests", {
				Strategy: "Fix parser, then tests",
			}),
		).toBe(true);
		expect(getCustomSavedAnswer(question, { Strategy: "Fix parser, then tests" })).toBeUndefined();
	});

	test("uses a single legacy answer value when the original answer key was malformed", () => {
		const [question] = coerceQuestions([
			{
				question: "undefined",
				header: "测试策略",
				options: [{ header: "坚持全修" }],
			},
		]);

		expect(
			getSelectedOptionValue(
				question,
				{ undefined: "坚持全修" },
				{ allowSingleAnswerFallback: true },
			),
		).toBe("坚持全修");
		expect(resolveSavedAnswer(question, { [question.header]: "坚持全修" })).toBe("坚持全修");
	});
});
