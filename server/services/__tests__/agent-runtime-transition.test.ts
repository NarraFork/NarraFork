import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { executeRuntimeRetry } from "../agent-runtime/orchestrator";
import {
	createRuntimeRecoveryState,
	selectRuntimeInterruption,
	selectRuntimeRecovery,
	settleRuntimeRecovery,
} from "../agent-runtime/transition";
import * as recovery from "../narrator-recovery";

const result = { finalText: "", hasError: false, shouldUpdateTitle: false };
const observation = {
	result,
	aborted: false,
	planApproved: false,
	stateful: true,
	maxTransientRetries: 2,
};
afterEach(() => mock.restore());

describe("shared runtime transition decisions", () => {
	test("stateless retries never multiply the exhausted provider budget", () => {
		const state = createRuntimeRecoveryState();
		expect(
			selectRuntimeRecovery(state, {
				...observation,
				stateful: false,
				result: { ...result, retryableError: "upstream exhausted" },
			}),
		).toEqual({ kind: "retry-exhausted", error: "upstream exhausted" });
		expect(state.transientRetries).toBe(0);
	});
	test("transient and silent disconnect spend the same counter", () => {
		const state = createRuntimeRecoveryState();
		const first = selectRuntimeRecovery(state, {
			...observation,
			result: { ...result, retryableError: "retry" },
		});
		expect(first).toMatchObject({ kind: "backoff", retryCount: 1, source: "transient-error" });
		expect(settleRuntimeRecovery(state, first, { recovered: true, aborted: false })).toBe("replay");
		expect(
			selectRuntimeRecovery(state, {
				...observation,
				result: { ...result, silentDisconnect: true },
			}),
		).toMatchObject({ kind: "backoff", retryCount: 2, source: "silent-disconnect" });
	});
	test("progress resets overflow baseline, not the interrupted response budget", () => {
		const state = {
			overflowRetries: 2,
			transientRetries: 1,
			interruptionRetries: 2,
			quotaWaits: 0,
		};
		expect(
			selectRuntimeRecovery(state, {
				...observation,
				result: { ...result, contextLengthExceeded: true, completedAssistantTurn: true },
			}),
		).toEqual({ kind: "overflow", retryCount: 0 });
		expect(state.interruptionRetries).toBe(2);
	});
	test("cancellation outranks balance, context and network errors", () => {
		expect(
			selectRuntimeRecovery(createRuntimeRecoveryState(), {
				...observation,
				aborted: true,
				result: {
					...result,
					contextLengthExceeded: true,
					retryableError: "error",
					paymentRequired: { message: "pay", resumeAction: "retry" },
				},
			}),
		).toEqual({ kind: "aborted" });
	});
	test("tool result replay is distinct from a synthetic continuation", () => {
		const state = createRuntimeRecoveryState();
		const decision = selectRuntimeInterruption(
			state,
			{ ...result, interrupted: true, shouldReplayInterruptedToolResultTurn: true },
			{ suppressed: false, maxRetries: 3 },
		);
		expect(decision.action).toBe("replay");
		expect(state.interruptionRetries).toBe(1);
	});
	test("budget exhaustion stops a truncated response instead of resetting the count", () => {
		const state = { ...createRuntimeRecoveryState(), interruptionRetries: 3 };
		expect(
			selectRuntimeInterruption(
				state,
				{ ...result, interrupted: true },
				{ suppressed: false, maxRetries: 3 },
			).action,
		).toBe("stop");
	});
});

describe("shared bounded retry effect", () => {
	test("replay retains the persisted partial and forces a clean upstream session", async () => {
		spyOn(recovery, "handleTransientError").mockResolvedValue({ shouldRetry: true, delayMs: 0 });
		const finalizePartial = mock(async () => true);
		const state = createRuntimeRecoveryState();
		const outcome = await executeRuntimeRetry(
			state,
			{ kind: "backoff", source: "transient-error", error: "retry", retryCount: 1, maxRetries: 2 },
			{
				narratorId: "retry-effect",
				locale: "en",
				signal: new AbortController().signal,
				finalizePartial,
			},
		);
		expect(outcome).toEqual({ kind: "replay", keptPartial: true, resetUpstreamSession: true });
		expect(finalizePartial).toHaveBeenCalledTimes(1);
		expect(state.transientRetries).toBe(1);
	});
	test("silent disconnect exhaustion reports failure, never stale success", async () => {
		spyOn(recovery, "handleTransientError").mockResolvedValue({ shouldRetry: false, delayMs: 0 });
		const finalizePartial = mock(async () => true);
		const outcome = await executeRuntimeRetry(
			createRuntimeRecoveryState(),
			{
				kind: "backoff",
				source: "silent-disconnect",
				error: "disconnect",
				retryCount: 3,
				maxRetries: 2,
			},
			{
				narratorId: "retry-effect",
				locale: "en",
				signal: new AbortController().signal,
				finalizePartial,
			},
		);
		expect(outcome).toEqual({ kind: "failed", error: "disconnect" });
		expect(finalizePartial).toHaveBeenCalledTimes(1);
	});
	test("abort during backoff cannot issue another replay", async () => {
		const controller = new AbortController();
		spyOn(recovery, "handleTransientError").mockImplementation(async () => {
			controller.abort();
			return { shouldRetry: true, delayMs: 0 };
		});
		const finalizePartial = mock(async () => false);
		const outcome = await executeRuntimeRetry(
			createRuntimeRecoveryState(),
			{ kind: "backoff", source: "transient-error", error: "retry", retryCount: 1, maxRetries: 2 },
			{
				narratorId: "retry-effect",
				locale: "en",
				signal: controller.signal,
				finalizePartial,
			},
		);
		expect(outcome).toEqual({ kind: "aborted" });
		expect(finalizePartial).not.toHaveBeenCalled();
	});
	test("stateless exhausted path performs no extra backoff", async () => {
		const wait = spyOn(recovery, "handleTransientError");
		const finalizePartial = mock(async () => false);
		expect(
			await executeRuntimeRetry(
				createRuntimeRecoveryState(),
				{ kind: "retry-exhausted", error: "exhausted" },
				{
					narratorId: "retry-effect",
					locale: "en",
					signal: new AbortController().signal,
					finalizePartial,
				},
			),
		).toEqual({ kind: "failed", error: "exhausted" });
		expect(wait).not.toHaveBeenCalled();
		expect(finalizePartial).toHaveBeenCalledTimes(1);
	});
});
