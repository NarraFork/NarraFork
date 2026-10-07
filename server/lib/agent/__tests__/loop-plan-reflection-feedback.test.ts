import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Locale } from "@server/lib/prompt-i18n";
import type { AgentToolUse, ProviderAdapter } from "../provider";
import type { ExitPlanReflectionDecision } from "../tools/exit-plan-reflection";
import type { AgentConfig } from "../types";

const realProviderModule = { ...(await import("../provider")) };
const realPermissionModule = { ...(await import("@server/services/narrator-permission")) };
const realReflectionModule = { ...(await import("../tools/exit-plan-reflection")) };

type Request = { toolResults: Array<{ output: string; isError: boolean }> };
const requests: Request[] = [];
const pending = new Map<string, (decision: ExitPlanReflectionDecision) => void>();
const lifecycle: string[] = [];
const failureOptions: Array<{ failed?: boolean } | undefined> = [];
let cancellationMode: "normal" | "delayed" | "human" = "normal";
let humanFeedback = "";
let releaseCancellation: (() => void) | undefined;
let cancellationFinished: Promise<void> | undefined;

const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: (history, systemPrompt) => {
		history.unshift({ role: "system", content: systemPrompt });
	},
	async *chat(params) {
		params.onRequestStart?.();
		requests.push(JSON.parse(JSON.stringify({ toolResults: params.toolResults })));
		if (requests.length > 2) throw new Error("Reflection exceeded its two-turn budget");
		yield {
			toolUses: [
				{
					toolUseId: `plan-feedback-edit-${requests.length}`,
					name: "Edit",
					input: { file_path: "/never-edit-plan", old_string: "old", new_string: "new" },
				},
			],
		};
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

mock.module("../provider", () => ({
	...realProviderModule,
	getProvider: () => provider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: provider,
		model: "test:model",
	}),
}));
mock.module("@server/services/narrator-permission", () => ({
	...realPermissionModule,
	loadPlanFileReadPolicy: async () => undefined,
	resolveExitPlanModeInputWithBackend: async () => ({
		ok: true,
		input: { plan: "Add regression coverage, then run the isolated tests." },
	}),
}));
// Only the pending-decision lifecycle is a fixture: the gate, reflection loop,
// retry restrictions and final user-facing tool result all use production code.
mock.module("../tools/exit-plan-reflection", () => ({
	...realReflectionModule,
	createExitPlanReflectionDecision: (requestId: string) =>
		new Promise<ExitPlanReflectionDecision>((resolve) => {
			pending.set(requestId, resolve);
		}),
	markExitPlanReflectionStarted: async () => true,
	broadcastPlanReflectionProgress: async () => {},
	isExitPlanReflectionWaitingForUser: () => false,
	cancelExitPlanReflection: async (
		requestId: string,
		feedback: string,
		options?: { failed?: boolean },
	) => {
		failureOptions.push(options);
		const resolve = pending.get(requestId);
		if (!resolve) return false;
		// A human can settle the same pending promise while fallback cancellation
		// is in flight. Its concrete revision must not be relabeled as check failure.
		resolve({
			action: "revise",
			feedback: cancellationMode === "human" ? humanFeedback : feedback,
		});
		lifecycle.push("decision-resolved");
		let finishCancellation: (() => void) | undefined;
		if (cancellationMode === "delayed") {
			const finished = Promise.withResolvers<void>();
			cancellationFinished = finished.promise;
			finishCancellation = finished.resolve;
			await new Promise<void>((resolve) => {
				releaseCancellation = resolve;
			});
		}
		if (cancellationMode !== "normal") {
			await Promise.resolve();
			await Promise.resolve();
		}
		lifecycle.push("cancel-returned");
		finishCancellation?.();
		return cancellationMode !== "human";
	},
	cleanupExitPlanReflection: (requestId: string) => {
		lifecycle.push("gate-cleaned");
		pending.delete(requestId);
	},
}));

const { resolveExitPlanModeReflection, buildExitPlanReflectionDeniedToolResult } = await import(
	"../loop"
);

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	mock.module("@server/services/narrator-permission", () => realPermissionModule);
	mock.module("../tools/exit-plan-reflection", () => realReflectionModule);
	mock.restore();
});
beforeEach(() => {
	requests.length = 0;
	pending.clear();
	lifecycle.length = 0;
	failureOptions.length = 0;
	cancellationMode = "normal";
	humanFeedback = "";
	releaseCancellation = undefined;
	cancellationFinished = undefined;
});

async function runGate(locale: Locale) {
	const config: AgentConfig = {
		narratorId: "n-plan-reflection-feedback",
		conversationId: "conv-plan-reflection-feedback",
		provider: "test",
		model: "test:model",
		cwd: "/tmp",
		systemPrompt: "Review the submitted plan",
		locale,
		signal: new AbortController().signal,
		permissionHandler: async () => {
			throw new Error("Disallowed Edit must not reach permission checks");
		},
	};
	const toolUse: AgentToolUse = {
		toolUseId: "plan-feedback-exit",
		name: "ExitPlanMode",
		input: {},
	};
	const result = await resolveExitPlanModeReflection(config, [], toolUse);
	expect(result.decision.action).toBe("revise");
	if (result.decision.action !== "revise") throw new Error("Expected a revision gate decision");
	expect(requests).toHaveLength(2);
	expect(failureOptions).toEqual([{ failed: true }]);
	expect(requests[1].toolResults).toHaveLength(1);
	expect(requests[1].toolResults[0].isError).toBe(true);
	// The reviewer gets corrective instructions; the main assistant must not.
	expect(requests[1].toolResults[0].output).toContain("ExitPlanRevise");
	expect(pending.size).toBe(0);
	const toolResult = buildExitPlanReflectionDeniedToolResult(
		result.decision,
		locale,
		result.checkFailed,
	);
	expect(toolResult.isError).toBe(true);
	return { result, output: toolResult.output };
}

function assertCheckFailure(output: string, locale: Locale) {
	expect(output).toContain(locale === "zh-CN" ? "计划检查未完成" : "Plan check could not complete");
	expect(output).toContain(locale === "zh-CN" ? "计划尚未提交" : "The plan was not submitted");
	expect(output).toContain(
		locale === "zh-CN" ? "这不代表计划内容被否决" : "This is not a rejection of the plan's content",
	);
	expect(output).toContain(locale === "zh-CN" ? "重新提交 ExitPlanMode" : "resubmit ExitPlanMode");
	for (const internal of [
		"ExitPlanRevise",
		"durable",
		"receipt",
		"请先修改计划",
		"Revise the plan first",
	]) {
		expect(output).not.toContain(internal);
	}
}

describe("ExitPlanMode gate failure feedback", () => {
	test("restored awaiting_user returns to the original permission without starting AI", async () => {
		const result = await resolveExitPlanModeReflection(
			{
				narratorId: "n-plan-reflection-feedback",
				conversationId: "conv-plan-reflection-feedback",
				provider: "test",
				model: "test:model",
				cwd: "/tmp",
				signal: new AbortController().signal,
				permissionHandler: async () => ({ behavior: "allow" }),
			},
			[],
			{
				toolUseId: "plan-feedback-exit",
				name: "ExitPlanMode",
				input: { plan: "Add regression coverage, then run the isolated tests." },
			},
			{
				id: "original-plan-call",
				status: "pending",
				permissionSuggestions: [
					{
						type: "plan_reflection",
						status: "awaiting_user",
						requestId: "original-plan-reflection",
						startedAt: "2025-01-02T03:04:05.000Z",
					},
				],
			},
		);
		expect(result.decision.action).toBe("manual");
		expect(requests).toHaveLength(0);
		expect(pending.size).toBe(0);
		expect(failureOptions).toHaveLength(0);
	});

	test("restored user-owned plan refuses a changed plan without starting AI", async () => {
		const result = await resolveExitPlanModeReflection(
			{
				narratorId: "n-plan-reflection-feedback",
				conversationId: "conv-plan-reflection-feedback",
				provider: "test",
				model: "test:model",
				cwd: "/tmp",
				signal: new AbortController().signal,
				permissionHandler: async () => ({ behavior: "allow" }),
			},
			[],
			{
				toolUseId: "plan-feedback-exit",
				name: "ExitPlanMode",
				input: { plan: "Original user-owned plan" },
			},
			{
				id: "original-plan-call",
				status: "pending",
				permissionSuggestions: [
					{
						type: "plan_reflection",
						status: "awaiting_user",
						requestId: "original-plan-reflection",
					},
				],
			},
		);
		expect(result.decision.action).toBe("revise");
		expect(result.input.plan).toBe("Original user-owned plan");
		expect(requests).toHaveLength(0);
		expect(pending.size).toBe(0);
	});
	for (const locale of ["en", "zh-CN"] as const) {
		test(`${locale}: two disallowed Edits report a failed check, not a rejected plan`, async () => {
			const { result, output } = await runGate(locale);
			expect(result.checkFailed).toBe(true);
			assertCheckFailure(output, locale);
		});

		test(`${locale}: decision wins before async cancellation returns without losing checkFailed`, async () => {
			cancellationMode = "delayed";
			const { result, output } = await runGate(locale);
			expect(result.checkFailed).toBe(true);
			assertCheckFailure(output, locale);
			expect(lifecycle.indexOf("decision-resolved")).toBeLessThan(
				lifecycle.indexOf("gate-cleaned"),
			);
			expect(lifecycle).not.toContain("cancel-returned");
			expect(releaseCancellation).toBeDefined();
			releaseCancellation?.();
			await cancellationFinished;
			expect(lifecycle.indexOf("gate-cleaned")).toBeLessThan(lifecycle.indexOf("cancel-returned"));
		});

		test(`${locale}: a competing human revision keeps its concrete feedback`, async () => {
			cancellationMode = "human";
			humanFeedback =
				locale === "zh-CN" ? "请补充数据库回滚步骤。" : "Add database rollback steps.";
			const { result, output } = await runGate(locale);
			expect(result.checkFailed).toBe(false);
			expect(result.decision).toEqual({ action: "revise", feedback: humanFeedback });
			expect(output).toContain(humanFeedback);
			expect(output).toContain(locale === "zh-CN" ? "请先修改计划" : "Revise the plan first");
			expect(output).not.toContain(
				locale === "zh-CN" ? "计划检查未完成" : "Plan check could not complete",
			);
		});
	}
});
