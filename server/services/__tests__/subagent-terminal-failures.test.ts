/**
 * Two provider outcomes a subagent used to swallow.
 *
 * Both share a failure shape that is worse than an error: the pass sets no
 * `hasError`, no `finalText`, and no retryable flag, so the run reached the
 * end-of-loop finalText backfill and handed the parent the subagent's PREVIOUS
 * assistant text — or "(no output)" — as if the work had finished. A refused
 * payment and a dropped socket both silently became "done".
 *
 * The decisions are pure functions (the same seam `planSubagentInterruption` and
 * `planSubagentCompactRestart` use) so both branches are pinned without standing up
 * a loop and without `mock.module`, which is process-wide in Bun and leaks into
 * every later-loaded suite.
 */
import { describe, expect, test } from "bun:test";
import {
	MAX_SUBAGENT_INTERRUPTION_RETRIES,
	planSubagentPaymentRequired,
	planSubagentSilentDisconnect,
	SUBAGENT_SILENT_DISCONNECT_ERROR,
} from "../subagent-executor";

const paymentRequired = {
	message: "Balance exhausted; top up to continue.",
	providerId: "nug-1",
	providerPrefix: "nug",
	balance: 0,
	required: 120,
	resumeAction: "retry" as const,
};

describe("planSubagentPaymentRequired", () => {
	test("does nothing when the provider did not refuse", () => {
		expect(planSubagentPaymentRequired({}, false)).toEqual({ action: "none" });
	});

	test("ends the run with a stated reason rather than an empty success", () => {
		// The load-bearing assertion: finalText is non-empty and names the cause, so the
		// end-of-run backfill cannot substitute a stale previous answer for it.
		const plan = planSubagentPaymentRequired({ paymentRequired }, false);
		expect(plan.action).toBe("fail");
		if (plan.action !== "fail") throw new Error("expected a terminal plan");
		expect(plan.finalText).toContain("Balance exhausted");
		expect(plan.finalText.startsWith("Error:")).toBe(true);
	});

	test("carries the payload shape the recharge prompt is parsed from", () => {
		// The subagent's own panel decides between "recharge" and a generic failure by
		// parsing this JSON; a plain message string would render as an unexplained error.
		const plan = planSubagentPaymentRequired({ paymentRequired }, false);
		if (plan.action !== "fail") throw new Error("expected a terminal plan");
		expect(JSON.parse(plan.errorMessage)).toEqual({
			type: "payment_required",
			...paymentRequired,
		});
	});

	test("stays quiet on an aborted run", () => {
		// The run is already ending for a reason the caller owns; a recharge prompt on a
		// session nobody is waiting for is noise.
		expect(planSubagentPaymentRequired({ paymentRequired }, true)).toEqual({ action: "none" });
	});
});

describe("planSubagentSilentDisconnect", () => {
	test("does nothing when the socket did not close quietly", () => {
		expect(planSubagentSilentDisconnect({}, 0, 3, false)).toEqual({ action: "none" });
	});

	test("retries within the shared transient budget", () => {
		expect(planSubagentSilentDisconnect({ silentDisconnect: true }, 0, 3, false)).toEqual({
			action: "retry",
			retries: 1,
		});
	});

	test("advances the shared counter instead of restarting it", () => {
		// The regression this guards: the success path resets `transientRetries` to 0
		// every pass. If the disconnect branch ran after that reset — or ignored the
		// incoming count — each reconnect would look like the first and the bounded
		// retry would become an unbounded loop against a dead socket.
		expect(planSubagentSilentDisconnect({ silentDisconnect: true }, 2, 3, false)).toEqual({
			action: "retry",
			retries: 3,
		});
	});

	test("fails once the budget is spent", () => {
		expect(planSubagentSilentDisconnect({ silentDisconnect: true }, 3, 3, false)).toEqual({
			action: "fail",
			retries: 4,
		});
	});

	test("honours the unlimited-retry sentinel", () => {
		// -1 is handleTransientError's own "no limit" contract (Codex account failover).
		expect(planSubagentSilentDisconnect({ silentDisconnect: true }, 99, -1, false)).toEqual({
			action: "retry",
			retries: 100,
		});
	});

	test("stays quiet on an aborted run", () => {
		// Nothing to retry into, and an abort must not pay for a backoff sleep before
		// its transcript is written.
		expect(planSubagentSilentDisconnect({ silentDisconnect: true }, 0, 3, true)).toEqual({
			action: "none",
		});
	});

	test("the exhausted error text is stated, not empty", () => {
		// What the parent receives as the tool_result when retries run out.
		expect(SUBAGENT_SILENT_DISCONNECT_ERROR.length).toBeGreaterThan(0);
		expect(`Error: ${SUBAGENT_SILENT_DISCONNECT_ERROR}`).toContain("silent disconnect");
	});

	test("the disconnect budget is independent of the interruption budget", () => {
		// They are different failures with different counters; conflating them would
		// make a run of interruptions shorten the reconnect allowance and vice versa.
		expect(
			planSubagentSilentDisconnect(
				{ silentDisconnect: true },
				MAX_SUBAGENT_INTERRUPTION_RETRIES + 1,
				-1,
				false,
			).action,
		).toBe("retry");
	});
});
