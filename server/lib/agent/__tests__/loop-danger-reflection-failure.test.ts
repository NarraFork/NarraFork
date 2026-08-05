/**
 * loop-danger-reflection-failure.test.ts — a danger reflection that THROWS must still
 * decide the gate.
 *
 * THE BUG
 *
 * `resolveDangerReflectionDecision` raced `pause.decision` against
 * `reflectionPromise.then(...)`. A bare `.then()` propagates rejections, so when the
 * reflection sub-loop threw — an unresolvable model id, a failed dynamic import, a
 * SQLite error while recording the auxiliary request — the rejection went straight into
 * `Promise.race` and skipped the fallback that cancels the gate.
 *
 * The consequences were all durable, which is why users saw it without any update running:
 *   - `pause.decision` was never resolved, so the permission handler never returned and the
 *     tool row stayed `pending`/`running` forever;
 *   - `permissionSuggestions` kept `danger_reflection: running`, so every client (including
 *     a fresh reload) rendered a "危险反思正在检查此操作" card with a live elapsed timer;
 *   - the `pendingDangerReflections` entry leaked, keeping the narrator tagged `reflecting`;
 *   - because `agentLoop` serializes permission checks through `permissionTail`, the stuck
 *     gate blocked every LATER tool call in that narrator too.
 *
 * The plan and task gates already had this `.catch()`. Danger did not.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ProviderAdapter } from "../provider";
import type { AgentConfig, PermissionResult } from "../types";

const NARRATOR_ID = "n-danger-reflection-failure";
const TOOL_USE_ID = "tu-danger-failure";
const REQUEST_ID = "req-danger-failure";

/** Cancellations observed by the fake permission service, in order. */
const cancellations: Array<{ requestId: string; reason?: string }> = [];
/** Resolver for the pause's decision promise, mirroring the real pending entry. */
let resolvePauseDecision: ((result: PermissionResult) => void) | undefined;

const realProviderModule = { ...(await import("../provider")) };
const realPermissionModule = { ...(await import("@server/services/narrator-permission")) };
const realSessionStateModule = { ...(await import("@server/services/narrator-session-state")) };

const pendingDangerReflections = new Map<string, Record<string, unknown>>();

/**
 * The parent turn streams a normal Bash tool call; only the nested REFLECTION request
 * throws. That asymmetry is the point: the parent loop is healthy, so any hang belongs to
 * the gate rather than to the turn that opened it.
 */
let sawParentTurn = false;

const throwingProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		if (sawParentTurn) throw new Error("reflection provider exploded");
		sawParentTurn = true;
		params.onRequestStart?.();
		yield {
			toolUses: [
				{
					toolUseId: TOOL_USE_ID,
					name: "Bash",
					input: { command: "python3 - <<'PY'\nprint(1)\nPY" },
				},
			],
		};
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

mock.module("../provider", () => ({
	...realProviderModule,
	getProvider: () => throwingProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: throwingProvider,
		model: "test:model",
	}),
}));

mock.module("@server/services/narrator-session-state", () => ({
	...realSessionStateModule,
	pendingDangerReflections,
}));

mock.module("@server/services/narrator-permission", () => ({
	...realPermissionModule,
	confirmDangerReflection: async () => false,
	cancelDangerReflection: async (requestId: string, reason?: string) => {
		cancellations.push({ requestId, reason });
		// Mirror the real implementation: resolving the pause is what releases the
		// permission handler, and the entry is removed as part of cancelling.
		const existed = pendingDangerReflections.delete(requestId);
		resolvePauseDecision?.({ behavior: "deny", message: reason });
		return existed;
	},
	broadcastDangerReflectionProgress: () => {},
}));

const { agentLoop } = await import("../loop");

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	mock.module("@server/services/narrator-permission", () => realPermissionModule);
	mock.module("@server/services/narrator-session-state", () => realSessionStateModule);
	mock.restore();
});

beforeEach(() => {
	cancellations.length = 0;
	pendingDangerReflections.clear();
	resolvePauseDecision = undefined;
	sawParentTurn = false;
});

/**
 * A permission handler that pauses the tool exactly as the real danger gate does: it returns
 * a `dangerReflection` result whose `decision` only settles when something cancels the gate.
 */
function dangerReflectionConfig(): AgentConfig {
	const decision = new Promise<PermissionResult>((resolve) => {
		resolvePauseDecision = resolve;
	});
	pendingDangerReflections.set(REQUEST_ID, {
		narratorId: NARRATOR_ID,
		requestId: REQUEST_ID,
		toolCallId: REQUEST_ID,
		toolUseId: TOOL_USE_ID,
		toolName: "Bash",
		broadcastTargetId: NARRATOR_ID,
		input: { command: "python3 - <<'PY'\nprint(1)\nPY" },
		fingerprint: "fingerprint",
		danger: { severity: "high", summary: "Shell command contains dangerous execution patterns." },
		startedAt: Date.now(),
		resolve: () => {},
		cleanup: () => {},
	});
	return {
		narratorId: NARRATOR_ID,
		conversationId: "conv-danger-failure",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal: new AbortController().signal,
		permissionHandler: async () => ({
			behavior: "dangerReflection",
			requestId: REQUEST_ID,
			danger: {
				severity: "high",
				summary: "Shell command contains dangerous execution patterns.",
			},
			fingerprint: "fingerprint",
			input: { command: "python3 - <<'PY'\nprint(1)\nPY" },
			decision,
		}),
	} as unknown as AgentConfig;
}

describe("danger reflection whose loop throws", () => {
	test("falls back to cancelling the gate instead of hanging", async () => {
		const config = dangerReflectionConfig();
		const permission = await config.permissionHandler("Bash", {}, TOOL_USE_ID);

		// Before the fix this promise never settled, which is the whole defect: the
		// permission handler never returned and the tool row stayed pending forever.
		const settled = await Promise.race([
			Promise.resolve(permission).then(() => "settled"),
			new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
		]);
		expect(settled).toBe("settled");
	});

	test("agentLoop keeps running and the gate is cancelled and cleaned up", async () => {
		const config = dangerReflectionConfig();
		const events: string[] = [];
		const iterate = (async () => {
			for await (const event of agentLoop(config, "run the command", [])) {
				events.push(event.type);
				if (events.length > 40) break;
			}
		})();

		const outcome = await Promise.race([
			iterate.then(() => "finished"),
			new Promise((resolve) => setTimeout(() => resolve("hung"), 5000)),
		]);

		expect(outcome).toBe("finished");
		// The gate must be resolved by the fallback, not left running.
		expect(cancellations.length).toBeGreaterThan(0);
		expect(cancellations[0]?.requestId).toBe(REQUEST_ID);
		// The reason must name the gate AND the concrete cause, not a generic
		// "the model didn't call its decision tool" (see reflection-failure-summary.test.ts).
		expect(cancellations[0]?.reason).toContain("Danger reflection could not decide");
		expect(cancellations[0]?.reason).toContain("provider error");
		// And no runtime entry may survive, or the narrator stays tagged "reflecting".
		expect(pendingDangerReflections.has(REQUEST_ID)).toBe(false);
	});
});
