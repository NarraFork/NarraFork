import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentToolUse, ProviderAdapter } from "../provider";
import type { AgentConfig, PermissionResult } from "../types";

const NARRATOR_ID = "n-danger-reflection-fallback";
const REQUEST_ID = "req-danger-fallback";
const toolUse: AgentToolUse = {
	toolUseId: "tu-danger-fallback",
	name: "Bash",
	input: { command: "original operation must not execute" },
};
type DangerPause = Extract<PermissionResult, { behavior: "dangerReflection" }>;
const confirmations: Array<{ requestId: string; reflection?: string }> = [];
const cancellations: Array<{ requestId: string; reason?: string }> = [];
const pendingDangerReflections = new Map<string, Record<string, unknown>>();
let replies: string[] = [];
let requests = 0;
let originalExecutions = 0;
let resolvePauseDecision: ((result: PermissionResult) => void) | undefined;

const realProviderModule = { ...(await import("../provider")) };
const realPermissionModule = { ...(await import("@server/services/narrator-permission")) };
const realSessionStateModule = { ...(await import("@server/services/narrator-session-state")) };

const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		const text = replies[requests++];
		if (text === undefined) throw new Error("Reflection exceeded scripted request budget");
		yield { text };
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: (history, content) => {
		history.push({ role: "user", content });
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
mock.module("@server/services/narrator-session-state", () => ({
	...realSessionStateModule,
	pendingDangerReflections,
}));
mock.module("@server/services/narrator-permission", () => ({
	...realPermissionModule,
	confirmDangerReflection: async (requestId: string, reflection?: string) => {
		confirmations.push({ requestId, reflection });
		const existed = pendingDangerReflections.delete(requestId);
		resolvePauseDecision?.({ behavior: "allow" });
		return existed;
	},
	cancelDangerReflection: async (requestId: string, reason?: string) => {
		cancellations.push({ requestId, reason });
		const existed = pendingDangerReflections.delete(requestId);
		// Release the parent pause even for failure cancellation; never leave a test hanging.
		resolvePauseDecision?.({ behavior: "deny", message: reason });
		return existed;
	},
	broadcastDangerReflectionProgress: () => {},
}));

const { resolveDangerReflectionDecision, runReflectionLoop } = await import("../loop");

afterAll(() => {
	// Bun module mocks need explicit restoration in addition to mock.restore().
	mock.module("../provider", () => realProviderModule);
	mock.module("@server/services/narrator-permission", () => realPermissionModule);
	mock.module("@server/services/narrator-session-state", () => realSessionStateModule);
	mock.restore();
});
beforeEach(() => {
	replies = [];
	requests = 0;
	originalExecutions = 0;
	confirmations.length = 0;
	cancellations.length = 0;
	pendingDangerReflections.clear();
	resolvePauseDecision = undefined;
});

function config(): AgentConfig {
	return {
		narratorId: NARRATOR_ID,
		conversationId: "conv-danger-fallback",
		provider: "test",
		model: "test:model",
		cwd: "/tmp",
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "deny" }),
		onToolExecutionInvoking: () => {
			originalExecutions++;
			throw new Error("Original operation must never execute in reflection");
		},
	};
}

function pause(): DangerPause {
	const decision = new Promise<PermissionResult>((resolve) => {
		resolvePauseDecision = resolve;
	});
	pendingDangerReflections.set(REQUEST_ID, {
		narratorId: NARRATOR_ID,
		requestId: REQUEST_ID,
		toolCallId: REQUEST_ID,
		toolUseId: toolUse.toolUseId,
		toolName: toolUse.name,
		broadcastTargetId: NARRATOR_ID,
		input: toolUse.input,
		fingerprint: "fingerprint",
		danger: {
			severity: "high",
			summary: "Dangerous operation",
			consequences: ["Original operation may alter user data"],
			saferAlternatives: ["Do not execute the original operation"],
		},
		startedAt: Date.now(),
		resolve: resolvePauseDecision,
		cleanup: () => {},
	});
	return {
		behavior: "dangerReflection",
		requestId: REQUEST_ID,
		fingerprint: "fingerprint",
		danger: {
			severity: "high",
			summary: "Dangerous operation",
			consequences: ["Original operation may alter user data"],
			saferAlternatives: ["Do not execute the original operation"],
		},
		input: toolUse.input,
		decision,
	};
}

function tagged(action: "confirm" | "cancel", detail: string): string {
	return `<DangerDecision>${JSON.stringify(
		action === "confirm" ? { action, reflection: detail } : { action, reason: detail },
	)}</DangerDecision>`;
}

async function resolveGate(): Promise<PermissionResult> {
	const result = await resolveDangerReflectionDecision(config(), [], pause(), toolUse);
	expect(pendingDangerReflections.has(REQUEST_ID)).toBe(false);
	expect(originalExecutions).toBe(0);
	return result;
}

const invalidFirstReplies = [
	["unsupported action", '<DangerDecision>{"action":"approve"}</DangerDecision>'],
	["malformed JSON", "<DangerDecision>{broken json}</DangerDecision>"],
	["ordinary text", "I need to reconsider this operation."],
	["text exceeding cumulative limit", "x".repeat(4500)],
] as const;

describe("danger reflection text fallback uses an individual valid turn", () => {
	for (const [label, firstReply] of invalidFirstReplies) {
		for (const action of ["confirm", "cancel"] as const) {
			test(`${label} then ${action} uses the exact second-turn decision`, async () => {
				const detail = `Second-turn ${action}: checked the concrete operation.`;
				replies = [firstReply, tagged(action, detail)];
				const result = await resolveGate();
				expect(requests).toBe(2);
				if (action === "confirm") {
					expect(result.behavior).toBe("allow");
					expect(confirmations).toEqual([{ requestId: REQUEST_ID, reflection: detail }]);
					expect(cancellations).toEqual([]);
				} else {
					expect(result).toEqual({ behavior: "deny", message: detail });
					expect(cancellations).toEqual([{ requestId: REQUEST_ID, reason: detail }]);
					expect(confirmations).toEqual([]);
				}
			});
		}
	}

	test("two turns without a valid label fail closed without confirmation", async () => {
		replies = ["No decision yet.", '<DangerDecision>{"action":"approve"}</DangerDecision>'];
		const result = await resolveGate();
		expect(requests).toBe(2);
		expect(result.behavior).toBe("deny");
		expect(confirmations).toEqual([]);
		expect(cancellations).toHaveLength(1);
		expect(cancellations[0]?.requestId).toBe(REQUEST_ID);
		expect(cancellations[0]?.reason).toContain("not authorized to execute");
	});

	for (const action of ["confirm", "cancel"] as const) {
		test(`valid first-turn ${action} needs only one provider request`, async () => {
			const detail = `First-turn ${action}`;
			replies = [tagged(action, detail)];
			const result = await resolveGate();
			expect(requests).toBe(1);
			expect(result.behavior).toBe(action === "confirm" ? "allow" : "deny");
			expect(confirmations).toEqual(
				action === "confirm" ? [{ requestId: REQUEST_ID, reflection: detail }] : [],
			);
			expect(cancellations).toEqual(
				action === "cancel" ? [{ requestId: REQUEST_ID, reason: detail }] : [],
			);
		});
	}

	test("cumulative diagnostic text is truncated but second-turn decision is preserved", async () => {
		replies = ["x".repeat(4500), tagged("confirm", "Untruncated second-turn reflection")];
		const observed = await runReflectionLoop({
			parentConfig: config(),
			history: [],
			prompt: "Check the pending danger gate",
			reflectionLoop: {
				allowedTools: ["DangerConfirm", "DangerCancel"],
				context: { kind: "dangerReflection", requestId: REQUEST_ID },
			},
		});
		expect(requests).toBe(2);
		expect(observed.assistantMessages).toBe(2);
		expect(observed.assistantText).toBe("x".repeat(4000));
		expect(observed.assistantText).not.toContain("DangerDecision");
		expect(observed.dangerTextDecision).toEqual({
			action: "confirm",
			reflection: "Untruncated second-turn reflection",
		});
	});

	test("permissionRuleRequest never records a text approval fallback", async () => {
		replies = [tagged("confirm", "Text must not approve a permission rule")];
		const observed = await runReflectionLoop({
			parentConfig: config(),
			history: [],
			prompt: "Check a permission rule request",
			maxTurns: 1,
			reflectionLoop: {
				allowedTools: ["DangerConfirm", "DangerCancel"],
				context: {
					kind: "dangerReflection",
					purpose: "permissionRuleRequest",
					requestId: REQUEST_ID,
				},
			},
		});
		expect(requests).toBe(1);
		expect(observed.assistantText).toContain("DangerDecision");
		expect(observed.dangerTextDecision).toBeUndefined();
		expect(observed.decisionSucceeded).not.toBe(true);
		expect(observed.toolResults).toEqual([]);
		expect(confirmations).toEqual([]);
		expect(cancellations).toEqual([]);
		expect(originalExecutions).toBe(0);
	});
});
