import { describe, expect, test } from "bun:test";
import {
	type PreparedUpdateStatus,
	resolveUpdateStatusPollInterval,
	UPDATE_STATUS_ACTIVE_POLL_MS,
	UPDATE_STATUS_IDLE_POLL_MS,
} from "../lib/update-state";

/**
 * `useUpdateScheduleStatus` delegates its whole refetch decision to
 * `resolveUpdateStatusPollInterval`. These cases walk the sequences the hook actually sees, so a
 * regression in the wiring shows up as a wrong interval for a realistic timeline rather than only
 * as a unit-level disagreement.
 */
function status(overrides: Partial<PreparedUpdateStatus> = {}): PreparedUpdateStatus {
	return { ready: true, canAutoRestart: true, ...overrides };
}

describe("update schedule polling over a full attempt", () => {
	test("apply → drain → restart keeps the fast poll the whole way", () => {
		const applyStartedAt = 1_000;
		// Right after apply: the local result claims a schedule before any poll confirms it.
		expect(
			resolveUpdateStatusPollInterval({
				status: status({ scheduled: false }),
				dataUpdatedAt: applyStartedAt - 500,
				errorSinceMs: applyStartedAt,
				assumeScheduled: true,
			}),
		).toBe(UPDATE_STATUS_ACTIVE_POLL_MS);

		for (const phase of ["draining_background_bash", "quiescing_tools", "restarting"] as const) {
			expect(
				resolveUpdateStatusPollInterval({
					status: status({ scheduled: true, phase }),
					dataUpdatedAt: applyStartedAt + 1_000,
					errorSinceMs: applyStartedAt,
					assumeScheduled: true,
				}),
			).toBe(UPDATE_STATUS_ACTIVE_POLL_MS);
		}
	});

	test("a cancellation ends polling once the coordinator reports it", () => {
		const applyStartedAt = 1_000;
		expect(
			resolveUpdateStatusPollInterval({
				status: status({
					scheduled: false,
					error: "cancelled by operator",
					errorKind: "cancelled",
				}),
				dataUpdatedAt: applyStartedAt + 2_000,
				errorSinceMs: applyStartedAt,
			}),
		).toBe(false);
	});

	test("an error left over from a previous attempt must not stop the new one", () => {
		// The dialog reopens after an earlier failure; the first poll response still carries that
		// old error. Treating it as current would stop polling before the new attempt even starts.
		expect(
			resolveUpdateStatusPollInterval({
				status: status({ scheduled: false, error: "previous handoff timed out" }),
				dataUpdatedAt: 1_000,
				errorSinceMs: 5_000,
			}),
		).toBe(UPDATE_STATUS_IDLE_POLL_MS);
	});

	test("a second tab discovers a schedule it never started", () => {
		// This tab never called apply, so `assumeScheduled` is false and no error is present. The
		// slow fallback is the only reason it ever notices the other tab's schedule.
		expect(
			resolveUpdateStatusPollInterval({ status: status({ scheduled: false }), dataUpdatedAt: 10 }),
		).toBe(UPDATE_STATUS_IDLE_POLL_MS);
		expect(
			resolveUpdateStatusPollInterval({
				status: status({ scheduled: true, phase: "quiescing_tools" }),
				dataUpdatedAt: 10,
			}),
		).toBe(UPDATE_STATUS_ACTIVE_POLL_MS);
	});
});
