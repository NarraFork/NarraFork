/** Provider failures are tested against the common runtime, never retired delegated helpers. */
import { describe, expect, spyOn, test } from "bun:test";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { generateId } from "../../lib/id";
import { nugAvailabilityPoller } from "../../lib/nug-availability-poller";
import * as quotaWait from "../../lib/provider-quota-wait";
import { settings } from "../../lib/settings";
import { executeRuntimeRetry } from "../agent-runtime/orchestrator";
import { startNarratorRun } from "../agent-runtime/run";
import { createRuntimeRecoveryState, selectRuntimeRecovery } from "../agent-runtime/transition";
import type { ExecuteLoopResult } from "../narrator-executor";
import * as executor from "../narrator-executor";
import * as recovery from "../narrator-recovery";
import { narratorService } from "../narrator-service";
import { MAX_TURN_INTERRUPTION_RETRIES } from "../turn-continuation-decisions";

const paymentRequired = {
	message: "Balance exhausted; top up to continue.",
	providerId: "nug-1",
	providerPrefix: "nug",
	balance: 0,
	required: 120,
	resumeAction: "retry" as const,
};
const completed = { finalText: "", hasError: false, shouldUpdateTitle: false };
function select(
	result: Partial<ExecuteLoopResult>,
	previousRetries = 0,
	maxRetries = 3,
	aborted = false,
) {
	const state = { ...createRuntimeRecoveryState(), transientRetries: previousRetries };
	return selectRuntimeRecovery(state, {
		result: { ...completed, ...result },
		aborted,
		planApproved: false,
		stateful: true,
		maxTransientRetries: maxRetries,
	});
}
async function runPayment(
	failure: Partial<ExecuteLoopResult> = { paymentRequired },
	timedOutcome?: "available" | "aborted",
) {
	const id = generateId();
	const now = new Date().toISOString();
	const before = settings.anthropicProviders;
	settings.anthropicProviders = [
		{
			id: "payment-test",
			name: "Payment test",
			prefix: "paymenttest",
			apiKey: "test-only",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "claude-sonnet-4",
		},
	];
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "paymenttest:claude-sonnet-4",
		autoContinuationOverride: "off",
		createdAt: now,
		updatedAt: now,
	});
	const provider = spyOn(executor, "executeAgentLoop").mockResolvedValue({
		...completed,
		...failure,
	});
	const waitingRows: Awaited<ReturnType<typeof narratorService.getById>>[] = [];
	const timer = timedOutcome
		? spyOn(quotaWait, "waitForQuotaReset").mockImplementation(async () => {
				waitingRows.push(await narratorService.getById(id));
				return timedOutcome;
			})
		: undefined;
	const poller = spyOn(nugAvailabilityPoller, "waitForModelAvailable");
	try {
		const run = await startNarratorRun({
			narratorId: id,
			locale: "en",
			text: "finish work",
			principal: null,
			foreground: true,
		});
		const result = await run.terminal;
		expect(provider).toHaveBeenCalledTimes(
			timedOutcome === "available" ? quotaWait.MAX_QUOTA_WAITS_PER_RUN + 1 : 1,
		);
		if (timedOutcome) {
			expect(timer).toHaveBeenCalledTimes(
				timedOutcome === "available" ? quotaWait.MAX_QUOTA_WAITS_PER_RUN : 1,
			);
			expect(poller).not.toHaveBeenCalled();
		}
		return { result, row: await narratorService.getById(id), waitingRows };
	} finally {
		timer?.mockRestore();
		poller.mockRestore();
		provider.mockRestore();
		settings.anthropicProviders = before;
	}
}

describe("common payment-required recovery", () => {
	test("does nothing when the provider did not refuse", () => {
		expect(select({})).toEqual({ kind: "completed" });
	});
	test("ends the run with a stated reason rather than an empty success", async () => {
		const { result } = await runPayment();
		expect(result.finalText).toContain("Balance exhausted");
		expect(result.finalText).toContain("Payment required:");
	});
	test("carries the payload shape the recharge prompt is parsed from", async () => {
		const { row } = await runPayment();
		expect(JSON.parse(row.errorMessage ?? "{}")).toEqual({
			type: "payment_required",
			...paymentRequired,
		});
	});
	test("stays quiet on an aborted run", () => {
		expect(select({ paymentRequired }, 0, 3, true)).toEqual({ kind: "aborted" });
	});
});

test("ordinary run without deliverTo keeps the quota recovery JSON after terminal settlement", async () => {
	const quotaResetAt = Date.now() + 86_400_000;
	const { row, result } = await runPayment({
		hasError: true,
		modelUnavailable: {
			message: "Quota exhausted",
			model: "kimi-model",
			provider: "anthropic",
			providerPrefix: "paymenttest",
			waitKind: "quota",
			quotaResetAt,
		},
	});
	expect(result.hasError).toBe(true);
	expect(row.status).toBe("idle");
	expect(JSON.parse(row.errorMessage ?? "{}")).toMatchObject({
		type: "kimi_quota_exhausted",
		reason: "reset-beyond-budget",
		quotaResetAt,
	});
});

describe("timed upstream refusal runtime", () => {
	test.each([
		"capacity",
		"rate_limit",
		"quota",
	] as const)("%s retains its reason and stops after the shared wait budget", async (waitKind) => {
		const resumeAt = Date.now() + 35_000;
		const quotaResetAt = resumeAt - 5_000;
		const { row, result, waitingRows } = await runPayment(
			{
				hasError: true,
				modelUnavailable: {
					message: "Upstream temporarily refused request",
					model: "test-model",
					provider: "anthropic",
					providerPrefix: "paymenttest",
					quotaProvider: "opencode",
					waitKind,
					resumeAt,
					quotaResetAt,
				},
			},
			"available",
		);
		expect(result.hasError).toBe(true);
		expect(waitingRows.length).toBe(quotaWait.MAX_QUOTA_WAITS_PER_RUN);
		for (const waiting of waitingRows) {
			expect(waiting.status).toBe("waiting");
			expect(JSON.parse(waiting.substatus ?? "[]")).toEqual([
				waitKind === "quota" ? "quota_exhausted" : "model_unavailable",
			]);
			expect(JSON.parse(waiting.errorMessage ?? "{}")).toMatchObject({
				type: waitKind === "quota" ? "quota_exhausted" : "model_unavailable",
				waitKind,
				resumeAt,
			});
		}
		expect(JSON.parse(row.errorMessage ?? "{}")).toMatchObject({
			type: waitKind === "quota" ? "opencode_quota_exhausted" : "provider_wait_exhausted",
			waitKind,
			reason: "wait-budget-spent",
			quotaResetAt,
		});
	});

	test.each([
		"capacity",
		"rate_limit",
	] as const)("%s reports a too-distant retry without parking or claiming quota exhaustion", async (waitKind) => {
		const { row } = await runPayment({
			hasError: true,
			modelUnavailable: {
				message: "Upstream temporary refusal",
				model: "test-model",
				provider: "anthropic",
				waitKind,
				quotaResetAt: Date.now() + 9 * 86_400_000,
			},
		});
		expect(JSON.parse(row.errorMessage ?? "{}")).toMatchObject({
			type: "provider_wait_exhausted",
			waitKind,
			reason: "reset-beyond-budget",
		});
	});

	test("capacity wait interruption ends without an exhaustion payload or another request", async () => {
		const { row, result, waitingRows } = await runPayment(
			{
				hasError: true,
				modelUnavailable: {
					message: "Capacity congestion",
					model: "test-model",
					provider: "anthropic",
					waitKind: "capacity",
					resumeAt: Date.now() + 35_000,
				},
			},
			"aborted",
		);
		expect(waitingRows).toHaveLength(1);
		expect(row.status).toBe("idle");
		expect(row.errorMessage ?? "").not.toContain("provider_wait_exhausted");
		expect(result.interrupted).toBe(true);
	});
});

describe("common silent-disconnect recovery", () => {
	test("does nothing when the socket did not close quietly", () => {
		expect(select({})).toEqual({ kind: "completed" });
	});
	test("retries within the shared transient budget", () => {
		expect(select({ silentDisconnect: true })).toMatchObject({
			kind: "backoff",
			retryCount: 1,
			maxRetries: 3,
		});
	});
	test("advances the shared counter instead of restarting it", () => {
		expect(select({ silentDisconnect: true }, 2)).toMatchObject({ kind: "backoff", retryCount: 3 });
	});
	test("fails once the budget is spent", async () => {
		const transition = select({ silentDisconnect: true }, 3);
		if (transition.kind !== "backoff") throw new Error("expected shared retry effect");
		const id = generateId();
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id, createdAt: now, updatedAt: now });
		const handler = spyOn(recovery, "handleTransientError");
		try {
			const outcome = await executeRuntimeRetry(createRuntimeRecoveryState(), transition, {
				narratorId: id,
				locale: "en",
				signal: new AbortController().signal,
				finalizePartial: async () => false,
			});
			expect(outcome).toEqual({ kind: "failed", error: "Codex WebSocket silent disconnect" });
			expect(handler).toHaveBeenCalledWith(
				expect.objectContaining({ retryCount: 4, maxRetries: 3 }),
			);
		} finally {
			handler.mockRestore();
		}
	});
	test("honours the unlimited-retry sentinel", () => {
		expect(select({ silentDisconnect: true }, 99, -1)).toMatchObject({
			kind: "backoff",
			retryCount: 100,
			maxRetries: -1,
		});
	});
	test("stays quiet on an aborted run", () => {
		expect(select({ silentDisconnect: true }, 0, 3, true)).toEqual({ kind: "aborted" });
	});
	test("the exhausted error text is stated, not empty", () => {
		expect(select({ silentDisconnect: true })).toMatchObject({
			error: "Codex WebSocket silent disconnect",
		});
	});
	test("the disconnect budget is independent of the interruption budget", () => {
		expect(select({ silentDisconnect: true }, MAX_TURN_INTERRUPTION_RETRIES + 1, -1)).toMatchObject(
			{ kind: "backoff", maxRetries: -1 },
		);
	});
});
