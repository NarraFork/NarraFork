import { describe, expect, test } from "bun:test";
import { coerceAskQuestionShape } from "./ask-user-question-shape";
import {
	assertQuestionBudget,
	normalizeQuestionKeys,
	QUESTION_ANSWER_MAX_BYTES,
	QUESTION_CONTEXT_MAX_BYTES,
	QUESTION_NOTE_MAX_BYTES,
	QUESTION_RECEIPT_MAX_BYTES,
	QUESTION_SNAPSHOT_MAX_BYTES,
	questionBytes,
} from "./question-protocol";

describe("question protocol byte and identity contract", () => {
	test("all budgets are byte budgets with exact boundary acceptance", () => {
		for (const max of [
			QUESTION_CONTEXT_MAX_BYTES,
			QUESTION_NOTE_MAX_BYTES,
			QUESTION_SNAPSHOT_MAX_BYTES,
			QUESTION_ANSWER_MAX_BYTES,
			QUESTION_RECEIPT_MAX_BYTES,
		]) {
			expect(() => assertQuestionBudget("a".repeat(max), max, "test")).not.toThrow();
			expect(() => assertQuestionBudget("a".repeat(max + 1), max, "test")).toThrow();
		}
		expect(questionBytes("中")).toBe(3);
	});
	test("coercion preserves IDs, header aliases become IDs and duplicate aliases reject", () => {
		const questions = coerceAskQuestionShape([{ id: "stable", header: "Readable" }]);
		expect(coerceAskQuestionShape(questions)[0].id).toBe("stable");
		expect(normalizeQuestionKeys(questions, { Readable: "answer" })).toEqual({ stable: "answer" });
		expect(() => normalizeQuestionKeys(questions, { Readable: "one", stable: "two" })).toThrow(
			"Duplicate",
		);
		expect(
			normalizeQuestionKeys(
				[
					{ id: "a", header: "b" },
					{ id: "b", header: "other" },
				],
				{ b: "answer" },
			),
		).toEqual({ b: "answer" });
		expect(() =>
			normalizeQuestionKeys(
				[
					{ id: "a", header: "shared" },
					{ id: "b", header: "shared" },
				],
				{ shared: "answer" },
			),
		).toThrow("ambiguous");
		expect(() => normalizeQuestionKeys(questions, { unknown: "answer" })).toThrow("Unknown");
	});
	test("generated canonical IDs take precedence over another question's title", () => {
		const questions = coerceAskQuestionShape([
			{ header: "q2", options: [{ header: "A" }] },
			{ header: "Second question", options: [{ header: "B" }] },
		]);
		expect(questions.map((question) => question.id)).toEqual(["q1", "q2"]);
		expect(normalizeQuestionKeys(questions, { q1: "A", q2: "B" })).toEqual({ q1: "A", q2: "B" });
		expect(normalizeQuestionKeys(questions, { q1: "A", "Second question": "B" })).toEqual({
			q1: "A",
			q2: "B",
		});
	});

	test("duplicate canonical IDs remain invalid even when titles differ", () => {
		expect(() =>
			normalizeQuestionKeys(
				[
					{ id: "same", header: "First" },
					{ id: "same", header: "Second" },
				],
				{ same: "answer" },
			),
		).toThrow("ambiguous");
	});

	test("canonical key ordering makes reordered retries byte-equivalent", () => {
		const questions = [
			{ id: "a", header: "A" },
			{ id: "b", header: "B" },
		];
		expect(JSON.stringify(normalizeQuestionKeys(questions, { B: "two", A: "one" }))).toBe(
			JSON.stringify(normalizeQuestionKeys(questions, { a: "one", b: "two" })),
		);
	});
	test("prototype-looking stable IDs remain ordinary own fields", () => {
		const result = normalizeQuestionKeys([{ id: "__proto__", header: "Readable" }], {
			Readable: "answer",
		});
		expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
		expect(Object.hasOwn(result, "__proto__")).toBe(true);
		expect(JSON.stringify(result)).toBe('{"__proto__":"answer"}');
	});
});
