import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import type { AgentToolUse, ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig } from "../types";

const DECISION_TOOL = "RetryReflectionDecision";
const OTHER_DECISION_TOOL = "RetryReflectionOtherDecision";
const ORDINARY_TOOL = "RetryReflectionOriginalOperation";
const UNKNOWN_TOOL = "RetryReflectionUnknownTool";
const PROMPT = "Return the current reflection decision";

type Reply =
	| { name: string; input: Record<string, unknown> }
	| { text: string }
	| { reasoning: string }
	| { empty: true };
type ToolResult = { toolUseId: string; output: string; isError: boolean };
type Request = { history: unknown[]; content: string; toolResults: ToolResult[] };
let replies: Reply[] = [];
let requests: Request[] = [];
let decisions = 0;
let originalExecutions = 0;
let permissionChecks = 0;
let executionAuthorizations = 0;
let nextToolUseId = 0;
let onReply: (() => void) | undefined;

const provider: ProviderAdapter = {
	formatTools: (tools) =>
		tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.rawJsonSchema ?? z.toJSONSchema(tool.parameters),
		})),
	injectSystemPrompt: (history, systemPrompt) => {
		history.unshift({ role: "system", content: systemPrompt });
	},
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	async *chat(params) {
		params.onRequestStart?.();
		requests.push(
			JSON.parse(
				JSON.stringify({
					history: params.history,
					content: params.content,
					toolResults: params.toolResults,
				}),
			),
		);
		const reply = replies[requests.length - 1];
		if (!reply) throw new Error("Reflection exceeded the scripted turn budget");
		onReply?.();
		if ("empty" in reply) return;
		if ("reasoning" in reply) yield { reasoning: reply.reasoning };
		else if ("text" in reply) yield { text: reply.text };
		else {
			const toolUse: AgentToolUse = {
				toolUseId: `retry-reflection-${++nextToolUseId}`,
				name: reply.name,
				input: reply.input,
			};
			yield { toolUses: [toolUse] };
		}
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: (history, content, _model, toolResults) => {
		history.push({ role: "user", content, toolResults });
	},
	pushAssistantTurn: (history, text, toolUses) => {
		history.push({ role: "assistant", content: text, toolUses });
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

// mock.restore() alone does not restore Bun's module mocks.
const realProviderModule = { ...(await import("../provider")) };
mock.module("../provider", () => ({
	getProvider: () => provider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: provider,
		model: "test:model",
	}),
}));
const { runReflectionLoop } = await import("../loop");

for (const name of [DECISION_TOOL, OTHER_DECISION_TOOL]) {
	toolRegistry.register({
		name,
		description: "Fake allowed reflection decision",
		reflectionOnly: true,
		parameters: z.object({ confirm: z.literal(true) }),
		execute: async () => {
			decisions++;
			return { output: "reflection decision accepted" };
		},
	});
}
toolRegistry.register({
	name: ORDINARY_TOOL,
	description: "Original operation must never run inside reflection",
	parameters: z.object({}),
	execute: async () => {
		originalExecutions++;
		return { output: "unexpected original side effect" };
	},
});

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	for (const name of [DECISION_TOOL, OTHER_DECISION_TOOL, ORDINARY_TOOL]) {
		toolRegistry.unregister(name);
	}
	mock.restore();
});
beforeEach(() => {
	replies = [];
	requests = [];
	decisions = 0;
	originalExecutions = 0;
	permissionChecks = 0;
	executionAuthorizations = 0;
	onReply = undefined;
});

function config(locale = "en", signal = new AbortController().signal): AgentConfig {
	return {
		narratorId: "n-reflection-retry",
		conversationId: "conv-reflection-retry",
		provider: "test",
		model: "test:model",
		cwd: "/tmp",
		systemPrompt: "Reflection retry parent system",
		locale,
		signal,
		requireToolCallBinding: true,
		permissionHandler: async () => {
			permissionChecks++;
			return { behavior: "allow" };
		},
		onToolExecutionInvoking: () => {
			executionAuthorizations++;
		},
	};
}
function run(
	parentConfig = config(),
	maxTurns = 99,
	kind = "exitPlanMode",
	history: unknown[] = [{ role: "system", content: parentConfig.systemPrompt }],
) {
	return runReflectionLoop({
		parentConfig,
		history,
		prompt: PROMPT,
		maxTurns,
		reflectionLoop: {
			allowedTools: [DECISION_TOOL, OTHER_DECISION_TOOL],
			context: { kind, requestId: "retry-request" },
		},
	});
}
function decision(): Reply {
	return { name: DECISION_TOOL, input: { confirm: true } };
}
function assertNoOriginalExecution() {
	expect(originalExecutions).toBe(0);
	expect(permissionChecks).toBe(0);
	expect(executionAuthorizations).toBe(0);
}

function secondTurnFeedback(): ToolResult[] {
	return requests[1].toolResults;
}

describe("reflection decision retries are bounded and safe", () => {
	for (const locale of ["en", "zh-CN"]) {
		for (const name of ["Edit", UNKNOWN_TOOL, ORDINARY_TOOL]) {
			test(`${locale}: ${name} without a durable binding is corrected on turn two`, async () => {
				replies = [{ name, input: {} }, decision()];
				const result = await run(config(locale));
				expect(requests).toHaveLength(2);
				expect(decisions).toBe(1);
				expect(result.failureSummary).toBeUndefined();
				expect(result.toolResults.map((tool) => tool.isError)).toEqual([true, false]);
				const feedback = secondTurnFeedback();
				expect(feedback).toHaveLength(1);
				expect(feedback[0].isError).toBe(true);
				for (const allowed of [DECISION_TOOL, OTHER_DECISION_TOOL]) {
					expect(feedback[0].output).toContain(allowed);
				}
				expect(feedback[0].output).not.toContain("durable");
				expect(feedback[0].output).toContain(locale === "zh-CN" ? "反思" : "reflection");
				// The pending error result travels in params.toolResults; the previous
				// assistant call is already part of the reusable history prefix.
				const history = requests[1].history as Array<{ toolUses?: AgentToolUse[] }>;
				expect(history.some((turn) => turn.toolUses?.[0]?.name === name)).toBe(true);
				const previousToolUseId = history.find((turn) => turn.toolUses?.[0]?.name === name)
					?.toolUses?.[0]?.toolUseId;
				if (previousToolUseId === undefined) throw new Error("Previous tool use is missing");
				expect(feedback[0].toolUseId).toBe(previousToolUseId);
				assertNoOriginalExecution();
			});
		}
	}

	test("invalid allowed-tool arguments get an error result before a valid retry", async () => {
		replies = [{ name: DECISION_TOOL, input: { confirm: "yes" } }, decision()];
		const result = await run();
		expect(requests).toHaveLength(2);
		expect(decisions).toBe(1);
		expect(secondTurnFeedback()[0].isError).toBe(true);
		for (const allowed of [DECISION_TOOL, OTHER_DECISION_TOOL]) {
			expect(secondTurnFeedback()[0].output).toContain(allowed);
		}
		expect(secondTurnFeedback()[0].output).not.toContain("durable");
		expect(result.toolResults.map((tool) => tool.isError)).toEqual([true, false]);
		expect(result.failureSummary).toBeUndefined();
		assertNoOriginalExecution();
	});

	for (const invalid of [
		{ name: UNKNOWN_TOOL, input: {} },
		{ name: DECISION_TOOL, input: { confirm: false } },
	]) {
		test(`${invalid.name}: two errors stop even with maxTurns=99`, async () => {
			replies = [invalid, invalid, decision()];
			const result = await run(config(), 99);
			expect(requests).toHaveLength(2);
			expect(decisions).toBe(0);
			expect(result.toolResults.map((tool) => tool.isError)).toEqual([true, true]);
			expect(result.failureSummary).toBeTruthy();
			assertNoOriginalExecution();
		});
	}

	test("a first-turn success does not request a second turn", async () => {
		replies = [decision(), { name: ORDINARY_TOOL, input: {} }];
		const result = await run();
		expect(requests).toHaveLength(1);
		expect(decisions).toBe(1);
		expect(result.failureSummary).toBeUndefined();
		assertNoOriginalExecution();
	});

	for (const locale of ["en", "zh-CN"]) {
		test(`${locale}: text-only first answer receives a reminder and can decide`, async () => {
			replies = [{ text: "I will revise the plan." }, decision()];
			const result = await run(config(locale));
			expect(requests).toHaveLength(2);
			expect(decisions).toBe(1);
			expect(result.failureSummary).toBeUndefined();
			const reminder = requests[1].content;
			for (const allowed of [DECISION_TOOL, OTHER_DECISION_TOOL]) {
				expect(reminder).toContain(allowed);
			}
			expect(reminder).not.toBe(PROMPT);
			expect(reminder).toContain(locale === "zh-CN" ? "反思" : "reflection");
			const secondHistory = JSON.stringify(requests[1].history);
			expect(secondHistory).toContain("I will revise the plan.");
			expect(secondHistory).toContain(PROMPT);
			assertNoOriginalExecution();
		});
	}

	test("two text-only answers terminate without requesting a third turn", async () => {
		replies = [{ text: "First answer" }, { text: "Still no decision" }, decision()];
		const result = await run();
		expect(requests).toHaveLength(2);
		expect(decisions).toBe(0);
		expect(result.assistantMessages).toBe(2);
		expect(result.failureSummary).toBeTruthy();
		assertNoOriginalExecution();
	});

	for (const firstReply of [{ empty: true } as const, { reasoning: "Considering the decision" }]) {
		const label = "empty" in firstReply ? "empty" : "reasoning-only";
		test(`${label} first response can be corrected on the second and final turn`, async () => {
			replies = [firstReply, decision(), decision()];
			const result = await run();
			expect(requests).toHaveLength(2);
			expect(decisions).toBe(1);
			expect(result.failureSummary).toBeUndefined();
			expect(result.toolResults).toHaveLength(1);
			expect(requests[1].content).toContain(DECISION_TOOL);
			assertNoOriginalExecution();
		});

		test(`two ${label} responses stop without a third provider request`, async () => {
			replies = [firstReply, firstReply, decision()];
			const result = await run();
			expect(requests).toHaveLength(2);
			expect(decisions).toBe(0);
			expect(result.failureSummary).toBeTruthy();
			assertNoOriginalExecution();
		});
	}

	for (const action of ["confirm", "cancel"] as const) {
		test(`valid danger ${action} text fallback is terminal on the first turn`, async () => {
			const text = `<DangerDecision>${JSON.stringify({ action, reflection: "Checked", reason: "Declined" })}</DangerDecision>`;
			replies = [{ text }, decision()];
			const result = await run(config(), 99, "dangerReflection");
			expect(requests).toHaveLength(1);
			expect(result.assistantText).toBe(text);
			expect(result.dangerTextDecision?.action).toBe(action);
			expect(result.failureSummary).toBeUndefined();
			expect(result.toolResults).toHaveLength(0);
			expect(decisions).toBe(0);
			assertNoOriginalExecution();
		});
	}

	test("retry preserves the exact parent cache prefix without reinjecting the system prompt", async () => {
		const parentConfig = config();
		const parentHistory = [
			{ role: "system", content: parentConfig.systemPrompt },
			{ role: "user", content: "Parent question with cacheable context" },
			{ role: "assistant", content: "Prior work" },
		];
		const originalBytes = JSON.stringify(parentHistory);
		replies = [{ name: UNKNOWN_TOOL, input: {} }, decision(), decision()];
		const result = await run(parentConfig, 99, "exitPlanMode", parentHistory);
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(JSON.stringify(request.history.slice(0, parentHistory.length))).toBe(originalBytes);
			expect(
				request.history.filter(
					(turn) =>
						typeof turn === "object" && turn !== null && "role" in turn && turn.role === "system",
				),
			).toHaveLength(1);
		}
		expect(JSON.stringify(parentHistory)).toBe(originalBytes);
		expect(decisions).toBe(1);
		expect(result.toolResults.filter((tool) => !tool.isError)).toHaveLength(1);
		expect(result.failureSummary).toBeUndefined();
		assertNoOriginalExecution();
	});

	test("parent abort during the first response prevents a retry or original execution", async () => {
		const controller = new AbortController();
		onReply = () => controller.abort();
		replies = [{ name: ORDINARY_TOOL, input: {} }, decision()];
		await run(config("en", controller.signal));
		expect(requests).toHaveLength(1);
		expect(decisions).toBe(0);
		assertNoOriginalExecution();
	});
});
