import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentToolUse, ProviderAdapter } from "../provider";
import type { AgentConfig } from "../types";

const realProviderModule = { ...(await import("../provider")) };
const realPermissionModule = { ...(await import("@server/services/narrator-permission")) };

/** Plan input re-resolutions: the pending runner must review the input it was given. */
let planInputResolutions = 0;
let providerMode: "confirm" | "rejected-tool" = "confirm";
let chatCalls = 0;

const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: (history, systemPrompt) => {
		history.unshift({ role: "system", content: systemPrompt });
	},
	async *chat(params) {
		params.onRequestStart?.();
		chatCalls += 1;
		if (chatCalls > 2) throw new Error("Reflection exceeded its two-turn budget");
		yield {
			toolUses:
				providerMode === "confirm"
					? [
							{
								toolUseId: `plan-confirm-${chatCalls}`,
								name: "ExitPlanConfirm",
								input: { confirm: true, reflection: "The plan is concrete and actionable." },
							},
						]
					: [
							{
								toolUseId: `plan-edit-${chatCalls}`,
								name: "Edit",
								input: { file_path: "/never-edit-plan", old_string: "old", new_string: "new" },
							},
						],
		};
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
// The pending runner reflects on the input the approval card shows; it must not resolve the
// plan a second time (a plan file could have changed since the request was raised).
mock.module("@server/services/narrator-permission", () => ({
	...realPermissionModule,
	loadPlanFileReadPolicy: async () => undefined,
	resolveExitPlanModeInputWithBackend: async () => {
		planInputResolutions += 1;
		return { ok: true, input: { plan: "a plan re-read from disk" }, resolvedFromFile: false };
	},
}));

const { createPendingPlanReflectionRunner } = await import("../loop");
const { getPendingPlanReflectionRunner, registerPendingPlanReflectionRunner } = await import(
	"../pending-plan-reflection"
);

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	mock.module("@server/services/narrator-permission", () => realPermissionModule);
	mock.restore();
});

beforeEach(() => {
	planInputResolutions = 0;
	providerMode = "confirm";
	chatCalls = 0;
});

function makeConfig(): AgentConfig {
	return {
		narratorId: "n-pending-plan-reflection",
		conversationId: "conv-pending-plan-reflection",
		provider: "test",
		model: "test:model",
		cwd: "/tmp",
		systemPrompt: "Review the submitted plan",
		locale: "en",
		signal: new AbortController().signal,
		permissionHandler: async () => {
			throw new Error("A reflection must not raise permission requests");
		},
	};
}

const toolUse: AgentToolUse = {
	toolUseId: "pending-plan-reflection-exit",
	name: "ExitPlanMode",
	input: {},
};

describe("pending plan reflection runner registry", () => {
	test("registers, serves by narrator + tool_use, and unregisters idempotently", () => {
		const run = async () => ({ decision: { action: "manual" } as const, input: {} });
		const unregister = registerPendingPlanReflectionRunner("n-a", "tu-1", run);
		expect(getPendingPlanReflectionRunner("n-a", "tu-1")).toBe(run);
		expect(getPendingPlanReflectionRunner("n-a", "tu-2")).toBeUndefined();
		expect(getPendingPlanReflectionRunner("n-b", "tu-1")).toBeUndefined();
		unregister();
		unregister();
		expect(getPendingPlanReflectionRunner("n-a", "tu-1")).toBeUndefined();
	});

	test("an older unregister never removes a newer registration of the same call", () => {
		const first = async () => ({ decision: { action: "manual" } as const, input: {} });
		const second = async () => ({ decision: { action: "manual" } as const, input: {} });
		const unregisterFirst = registerPendingPlanReflectionRunner("n-a", "tu-1", first);
		registerPendingPlanReflectionRunner("n-a", "tu-1", second);
		unregisterFirst();
		expect(getPendingPlanReflectionRunner("n-a", "tu-1")).toBe(second);
	});
});

describe("pending plan reflection runner", () => {
	test("reviews the input it is handed, without resolving the plan again", async () => {
		const pendingInput = { plan: "Add the regression test, then run it." };
		const runner = createPendingPlanReflectionRunner(makeConfig(), [], toolUse);
		const result = await runner(pendingInput);
		expect(result.decision.action).toBe("confirm");
		expect(result.input).toBe(pendingInput);
		expect(planInputResolutions).toBe(0);
	});

	test("hands the plan back to the person instead of denying it when the review cannot decide", async () => {
		providerMode = "rejected-tool";
		const pendingInput = { plan: "Add the regression test, then run it." };
		const runner = createPendingPlanReflectionRunner(makeConfig(), [], toolUse);
		const result = await runner(pendingInput);
		expect(result.decision.action).toBe("human");
		if (result.decision.action !== "human") throw new Error("Expected a handover decision");
		expect(result.decision.reason).toContain("could not finish");
		expect(planInputResolutions).toBe(0);
	});
});
