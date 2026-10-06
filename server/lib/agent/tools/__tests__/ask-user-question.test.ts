import { describe, expect, test } from "bun:test";
import { isRuntimeToolAllowed, resolveRuntimePolicy } from "@server/services/agent-runtime/policy";
import {
	askUserQuestionTool,
	isAsyncAskRequest,
	isWithdrawOnlyAskRequest,
	readWithdrawIds,
} from "../ask-user-question";
import { questionTool } from "../question";

describe("Question lifecycle capability", () => {
	test("ids, cursors, page size and notes have hard character bounds before SQLite", () => {
		for (const value of [
			{ id: "" },
			{ id: "x".repeat(201) },
			{ ids: [""] },
			{ answerMessageId: "x".repeat(201) },
			{ cursor: "x".repeat(2049) },
			{ limit: 33 },
			{ note: "x".repeat(2049) },
			{ reason: "x".repeat(2049) },
		]) {
			expect(questionTool.parameters.safeParse({ action: "list", ...value }).success).toBe(false);
		}
	});
	test("get/list/resolve/withdraw form one tool without granting creation to subagents", () => {
		for (const action of ["get", "list", "resolve", "withdraw"])
			expect(questionTool.parameters.safeParse({ action }).success).toBe(true);
		for (const subagentType of ["general", "explore", "plan", "review", "search"]) {
			const policy = resolveRuntimePolicy({ variant: "subagent", subagentType });
			expect(isRuntimeToolAllowed(policy, "Question")).toBe(true);
			expect(isRuntimeToolAllowed(policy, "AskUserQuestion")).toBe(false);
		}
		expect(questionTool.parameters.safeParse({ action: "create" }).success).toBe(false);
	});
});

describe("AskUserQuestion", () => {
	test("advertises only header/description on questions and options", () => {
		const schema = askUserQuestionTool.rawJsonSchema as {
			properties?: {
				questions?: {
					items?: {
						required?: string[];
						properties?: Record<string, unknown>;
						additionalProperties?: boolean;
					};
				};
			};
		};
		const items = schema.properties?.questions?.items;
		expect(items?.required ?? []).toEqual(["header", "options"]);
		expect(Object.keys(items?.properties ?? {}).sort()).toEqual([
			"description",
			"header",
			"multiSelect",
			"options",
		]);
		const questionProps = items?.properties as Record<string, { description?: string }>;
		expect(questionProps.header?.description).toContain("SHORT title");
		expect(questionProps.description?.description).toContain("FULL question text");
		expect(items?.additionalProperties).toBe(false);
		const optionProps = (
			items?.properties as {
				options?: { items?: { properties?: Record<string, unknown>; required?: string[] } };
			}
		)?.options?.items;
		expect(optionProps?.required ?? []).toEqual(["header"]);
		expect(Object.keys(optionProps?.properties ?? {}).sort()).toEqual([
			"description",
			"header",
			"preview",
		]);
	});

	test("accepts short header + full description and option headers", () => {
		expect(
			askUserQuestionTool.parameters.safeParse({
				questions: [
					{
						header: "写路径权限策略",
						description: "背景：内网已全放行；云端 key 逐点授予。写路径权限模型选哪个？",
						options: [{ header: "挂权限点（推荐）", description: "推荐" }, { header: "维持现状" }],
						multiSelect: false,
					},
				],
			}).success,
		).toBe(true);
	});

	test("rejects questions without a header", () => {
		expect(
			askUserQuestionTool.parameters.safeParse({
				questions: [
					{
						description: "只有描述没有正文",
						options: [{ header: "A" }, { header: "B" }],
					},
				],
			}).success,
		).toBe(false);
	});

	test("keeps multiSelect optional", () => {
		expect(
			askUserQuestionTool.parameters.safeParse({
				questions: [
					{
						header: "测试策略",
						options: [{ header: "坚持全修" }, { header: "另立 spec" }],
					},
				],
			}).success,
		).toBe(true);
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
				questions: [{ header: "h", options: [] }],
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

	test("the description tells the model header is short and description holds the prompt", () => {
		expect(askUserQuestionTool.description).toContain("ONLY these two field names");
		expect(askUserQuestionTool.description).toContain("SHORT title");
		expect(askUserQuestionTool.description).toContain("FULL prompt");
		expect(askUserQuestionTool.description).toContain("Do not cram the long prompt into `header`");
	});
});
