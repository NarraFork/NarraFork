import { describe, expect, test } from "bun:test";
import {
	askUserQuestionTool,
	isAsyncAskRequest,
	isWithdrawOnlyAskRequest,
	readWithdrawIds,
} from "../ask-user-question";

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

/**
 * These three predicates are shared with the permission gate, which uses them to
 * decide whether a call needs a prompt at all. A disagreement between the two sides
 * would show up as the gate rejecting a call the tool handles fine (or worse, blocking
 * on a question that was meant not to block), so they are pinned here.
 */
describe("AskUserQuestion — async mode predicates", () => {
	test("async is opt-in and strictly boolean true", () => {
		expect(isAsyncAskRequest({ questions: [], async: true })).toBe(true);
		expect(isAsyncAskRequest({ questions: [] })).toBe(false);
		expect(isAsyncAskRequest({ questions: [], async: false })).toBe(false);
		// A truthy non-boolean must not silently enable a non-blocking ask.
		expect(isAsyncAskRequest({ questions: [], async: "yes" })).toBe(false);
		expect(isAsyncAskRequest(null)).toBe(false);
	});

	test("withdraw ids ignore malformed entries", () => {
		expect(readWithdrawIds({ withdraw: ["a", "", "  ", 7, null, "b"] })).toEqual(["a", "b"]);
		expect(readWithdrawIds({ withdraw: "a" })).toEqual([]);
		expect(readWithdrawIds({})).toEqual([]);
	});

	test("a withdraw-only call is recognised, and asking alongside it is not", () => {
		expect(isWithdrawOnlyAskRequest({ withdraw: ["q1"] })).toBe(true);
		expect(isWithdrawOnlyAskRequest({ questions: [], withdraw: ["q1"] })).toBe(true);
		// Still asking something → the questions decide how the call is treated.
		expect(
			isWithdrawOnlyAskRequest({
				questions: [{ question: "k", header: "h", options: [] }],
				withdraw: ["q1"],
			}),
		).toBe(false);
		expect(isWithdrawOnlyAskRequest({ withdraw: [] })).toBe(false);
	});

	test("validation accepts a withdraw-only call but rejects an empty one", () => {
		// A maintenance call carries no questions — the gate validates input with this
		// same schema, so rejecting it here would make withdrawals unreachable.
		expect(askUserQuestionTool.parameters.safeParse({ withdraw: ["q1"] }).success).toBe(true);
		// Neither asking nor withdrawing: nothing for this call to do.
		expect(askUserQuestionTool.parameters.safeParse({}).success).toBe(false);
		expect(askUserQuestionTool.parameters.safeParse({ questions: [], withdraw: [] }).success).toBe(
			false,
		);
	});

	test("async and withdraw are advertised to the model", () => {
		const schema = askUserQuestionTool.rawJsonSchema as {
			properties?: Record<string, { type?: string }>;
		};
		expect(schema.properties?.async?.type).toBe("boolean");
		expect(schema.properties?.withdraw?.type).toBe("array");
	});

	test("the description tells the model how to wait for an async answer", () => {
		// Without this the async mode is a one-way street: the agent can defer a question
		// but has no documented way to block on it when the answer finally does decide its
		// next step, so it either guesses or re-asks synchronously.
		expect(askUserQuestionTool.description).toContain('Await({ type: "question"');
	});

	test("a user-deferred call is validated like any other async submission", () => {
		// The permission gate marks a "answer later" call with `deferredByUser` and flips
		// it to `async`. That input must still validate, or the deferral would fail
		// AFTER the user already released the loop — losing the question entirely.
		expect(
			askUserQuestionTool.parameters.safeParse({
				questions: [{ question: "cache", header: "Which cache?", options: [] }],
				async: true,
				deferredByUser: true,
			}).success,
		).toBe(true);
	});
});
