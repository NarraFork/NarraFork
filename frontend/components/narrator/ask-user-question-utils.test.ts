import { describe, expect, test } from "bun:test";
import {
	coerceQuestions,
	formatHMS,
	getCustomSavedAnswer,
	getSelectedOptionValue,
	isSavedOptionSelected,
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
	test("replaces missing or placeholder question keys with stable non-empty keys", () => {
		const questions = coerceQuestions([
			{
				question: "undefined",
				header: "测试策略",
				options: [{ label: "坚持全修", description: "修复全部测试" }],
				multiSelect: false,
			},
			{
				header: "测试策略",
				options: [{ label: "另立 spec", description: "拆出规格" }],
				multiSelect: false,
			},
		]);

		expect(questions.map((q) => q.question)).toEqual(["测试策略", "测试策略 (2)"]);
		expect(questions.every((q) => q.question !== "undefined")).toBe(true);
	});

	test("parses stringified questions and normalizes option labels", () => {
		const questions = coerceQuestions(
			JSON.stringify([
				{
					question: " approach ",
					header: "  Approach  ",
					options: [{ label: " 坚持全修 ", description: "desc", preview: "preview" }],
				},
			]),
		);

		expect(questions).toEqual([
			{
				question: "approach",
				header: "Approach",
				options: [{ label: "坚持全修", description: "desc", preview: "preview" }],
				multiSelect: false,
			},
		]);
	});

	test("matches read-only answers by normalized option parts", () => {
		const [question] = coerceQuestions([
			{
				question: "strategy",
				header: "测试策略",
				options: [
					{ label: "修有价值那几类", description: "" },
					{ label: "坚持全修", description: "" },
				],
			},
		]);

		expect(getSelectedOptionValue(question, { strategy: " 坚持全修 " })).toBe("坚持全修");
		expect(
			isSavedOptionSelected(question, "坚持全修", { strategy: "修有价值那几类, 坚持全修" }),
		).toBe(true);
		expect(getCustomSavedAnswer(question, { strategy: "使用其它方案" })).toBe("使用其它方案");
	});

	test("matches read-only option labels that contain commas", () => {
		const [question] = coerceQuestions([
			{
				question: "strategy",
				header: "Strategy",
				options: [{ label: "Fix parser, then tests", description: "" }],
			},
		]);

		expect(getSelectedOptionValue(question, { strategy: "Fix parser, then tests" })).toBe(
			"Fix parser, then tests",
		);
		expect(
			isSavedOptionSelected(question, "Fix parser, then tests", {
				strategy: "Fix parser, then tests",
			}),
		).toBe(true);
		expect(getCustomSavedAnswer(question, { strategy: "Fix parser, then tests" })).toBeUndefined();
	});

	test("uses a single legacy answer value when the original answer key was malformed", () => {
		const [question] = coerceQuestions([
			{
				question: "undefined",
				header: "测试策略",
				options: [{ label: "坚持全修", description: "" }],
			},
		]);

		expect(
			getSelectedOptionValue(
				question,
				{ undefined: "坚持全修" },
				{ allowSingleAnswerFallback: true },
			),
		).toBe("坚持全修");
	});
});
