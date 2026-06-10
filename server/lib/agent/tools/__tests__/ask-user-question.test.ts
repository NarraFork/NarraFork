import { describe, expect, test } from "bun:test";
import { askUserQuestionTool } from "../ask-user-question";

describe("AskUserQuestion", () => {
	test("rejects missing or placeholder question keys", () => {
		expect(
			askUserQuestionTool.parameters.safeParse({
				questions: [
					{
						header: "测试策略",
						options: [{ label: "坚持全修", description: "" }],
					},
				],
			}).success,
		).toBe(false);
		expect(
			askUserQuestionTool.parameters.safeParse({
				questions: [
					{
						question: "undefined",
						header: "测试策略",
						options: [{ label: "坚持全修", description: "" }],
					},
				],
			}).success,
		).toBe(false);
	});

	test("accepts meaningful question keys and option previews", () => {
		expect(
			askUserQuestionTool.parameters.safeParse({
				questions: [
					{
						question: "strategy",
						header: "测试策略",
						options: [{ label: "坚持全修", description: "", preview: "preview" }],
						multiSelect: false,
					},
				],
			}).success,
		).toBe(true);
	});

	test("keeps multiSelect optional in raw schema and runtime validation", () => {
		expect(
			askUserQuestionTool.parameters.safeParse({
				questions: [
					{
						question: "strategy",
						header: "测试策略",
						options: [{ label: "坚持全修", description: "" }],
					},
				],
			}).success,
		).toBe(true);

		const schema = askUserQuestionTool.rawJsonSchema as {
			properties?: { questions?: { items?: { required?: string[] } } };
		};
		expect(schema.properties?.questions?.items?.required ?? []).toEqual([
			"question",
			"header",
			"options",
		]);
	});
});
