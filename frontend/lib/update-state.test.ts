import { describe, expect, test } from "bun:test";
import {
	hasActiveUpdateSchedule,
	LOCAL_SCHEDULE_CLAIM_MAX_AGE_MS,
	type PreparedUpdateStatus,
	resolveScheduledUpdatePill,
	resolveUpdateCoordinationCounts,
	resolveUpdateStatusPollInterval,
	shouldAssumeLocalSchedule,
	shouldShowUpdateScheduleButton,
	UPDATE_STATUS_ACTIVE_POLL_MS,
	UPDATE_STATUS_IDLE_POLL_MS,
} from "./update-state";

describe("update scheduling state", () => {
	test("uses granular coordination counts when available", () => {
		expect(
			resolveUpdateCoordinationCounts({
				pendingExecutionCount: 9,
				pendingBackgroundBashCount: 2,
				pendingOrdinaryExecutionCount: 3,
				resumableExecutionCount: 4,
				pausedToolCount: 5,
			}),
		).toEqual({
			pendingExecutionCount: 9,
			pendingBackgroundBashCount: 2,
			pendingOrdinaryExecutionCount: 3,
			resumableExecutionCount: 4,
			pausedToolCount: 5,
		});
	});

	test("includes resumable executions when deriving the total", () => {
		expect(
			resolveUpdateCoordinationCounts({
				pendingBackgroundBashCount: 2,
				pendingOrdinaryExecutionCount: 3,
				resumableExecutionCount: 4,
			}),
		).toMatchObject({
			pendingExecutionCount: 9,
			resumableExecutionCount: 4,
		});
	});

	test("preserves a legacy total without inventing both phase counts", () => {
		expect(resolveUpdateCoordinationCounts({ pendingExecutionCount: 5 })).toEqual({
			pendingExecutionCount: 5,
			pendingBackgroundBashCount: 0,
			pendingOrdinaryExecutionCount: 0,
			resumableExecutionCount: 0,
			pausedToolCount: 0,
		});
	});

	test("attributes a legacy total only to the active drain phase", () => {
		expect(
			resolveUpdateCoordinationCounts({
				phase: "draining",
				pendingExecutionCount: 5,
			}),
		).toMatchObject({
			pendingExecutionCount: 5,
			pendingBackgroundBashCount: 5,
			pendingOrdinaryExecutionCount: 0,
		});
		expect(
			resolveUpdateCoordinationCounts({
				phase: "quiescing_tools",
				pendingExecutionCount: 3,
			}),
		).toMatchObject({
			pendingExecutionCount: 3,
			pendingBackgroundBashCount: 0,
			pendingOrdinaryExecutionCount: 3,
		});
	});

	test("allows retry after an asynchronous coordination failure", () => {
		expect(
			shouldShowUpdateScheduleButton({
				canRestartIntoUpdate: true,
				applySucceeded: true,
				coordinationFailed: true,
			}),
		).toBe(true);
	});

	test("hides scheduling while a successful attempt is still active", () => {
		expect(
			shouldShowUpdateScheduleButton({
				canRestartIntoUpdate: true,
				applySucceeded: true,
				coordinationFailed: false,
			}),
		).toBe(false);
	});
});

describe("scheduled update header pill", () => {
	test("stays absent until an update is actually scheduled", () => {
		expect(resolveScheduledUpdatePill(undefined)).toBeNull();
		expect(resolveScheduledUpdatePill({ scheduled: false, phase: "idle" })).toBeNull();
		// A stale phase without `scheduled` must not resurrect the pill after the update ended.
		expect(resolveScheduledUpdatePill({ phase: "quiescing_tools" })).toBeNull();
	});

	test("reports waiting for both drain phases, including the legacy phase name", () => {
		for (const phase of ["draining", "draining_background_bash", "quiescing_tools"] as const) {
			expect(resolveScheduledUpdatePill({ scheduled: true, phase })).toEqual({
				labelKey: "updatePillWaiting",
				tooltipKey: "updatePillWaitingTooltip",
				busy: false,
			});
		}
	});

	test("marks restarting as busy", () => {
		expect(resolveScheduledUpdatePill({ scheduled: true, phase: "restarting" })).toMatchObject({
			labelKey: "updatePillRestarting",
			busy: true,
		});
	});

	test("cancellation outranks the phase so the pill never looks like it is still waiting", () => {
		expect(
			resolveScheduledUpdatePill({
				scheduled: true,
				phase: "quiescing_tools",
				cancelRequested: true,
			}),
		).toMatchObject({ labelKey: "updatePillCancelling", busy: true });
	});

	test("falls back to a neutral scheduled label for an unreported phase", () => {
		expect(resolveScheduledUpdatePill({ scheduled: true })).toMatchObject({
			labelKey: "updatePillScheduled",
			busy: false,
		});
	});
});

describe("update status poll interval", () => {
	function status(overrides: Partial<PreparedUpdateStatus> = {}): PreparedUpdateStatus {
		return { ready: true, canAutoRestart: true, ...overrides };
	}

	test("polls fast while an update is scheduled", () => {
		expect(
			resolveUpdateStatusPollInterval({
				status: status({ scheduled: true, phase: "quiescing_tools" }),
				dataUpdatedAt: 1000,
			}),
		).toBe(UPDATE_STATUS_ACTIVE_POLL_MS);
	});

	test("polls fast as soon as a local apply reports a schedule, before the first confirmation", () => {
		expect(
			resolveUpdateStatusPollInterval({
				status: status({ scheduled: false }),
				dataUpdatedAt: 1000,
				assumeScheduled: true,
			}),
		).toBe(UPDATE_STATUS_ACTIVE_POLL_MS);
	});

	test("keeps a slow fallback when nothing is scheduled so another tab's schedule is noticed", () => {
		expect(
			resolveUpdateStatusPollInterval({
				status: status({ scheduled: false }),
				dataUpdatedAt: 1000,
			}),
		).toBe(UPDATE_STATUS_IDLE_POLL_MS);
		// No data yet (first load) must also keep polling rather than settle on `false`.
		expect(resolveUpdateStatusPollInterval({ status: undefined, dataUpdatedAt: 0 })).toBe(
			UPDATE_STATUS_IDLE_POLL_MS,
		);
	});

	test("stops only when a current error says the attempt is over", () => {
		expect(
			resolveUpdateStatusPollInterval({
				status: status({ scheduled: false, error: "spawn failed" }),
				dataUpdatedAt: 5000,
				errorSinceMs: 4000,
			}),
		).toBe(false);
	});

	test("a stale error recorded before this attempt must not stop polling", () => {
		expect(
			resolveUpdateStatusPollInterval({
				status: status({ scheduled: false, error: "previous attempt failed" }),
				// Received before the current apply attempt started, so the error is not ours.
				dataUpdatedAt: 3000,
				errorSinceMs: 4000,
			}),
		).toBe(UPDATE_STATUS_IDLE_POLL_MS);
	});

	test("an error while still scheduled keeps the fast poll", () => {
		expect(
			resolveUpdateStatusPollInterval({
				status: status({ scheduled: true, error: "transient" }),
				dataUpdatedAt: 5000,
				errorSinceMs: 4000,
			}),
		).toBe(UPDATE_STATUS_ACTIVE_POLL_MS);
	});

	test("a current error does not stop polling while a local apply still claims a schedule", () => {
		expect(
			resolveUpdateStatusPollInterval({
				status: status({ scheduled: false, error: "spawn failed" }),
				dataUpdatedAt: 5000,
				errorSinceMs: 4000,
				assumeScheduled: true,
			}),
		).toBe(UPDATE_STATUS_ACTIVE_POLL_MS);
	});

	test("errorSinceMs null treats any reported error as current", () => {
		expect(
			resolveUpdateStatusPollInterval({
				status: status({ scheduled: false, error: "spawn failed" }),
				dataUpdatedAt: 1,
				errorSinceMs: null,
			}),
		).toBe(false);
	});
});

describe("local schedule claim", () => {
	const claimedAt = 10_000;
	function claim(overrides: Partial<Parameters<typeof shouldAssumeLocalSchedule>[0]> = {}) {
		return shouldAssumeLocalSchedule({
			applyScheduled: true,
			claimedAt,
			serverConfirmedSchedule: false,
			abandonedLocally: false,
			now: claimedAt + 1_000,
			...overrides,
		});
	}

	test("bridges the window before the first poll confirms the schedule", () => {
		expect(claim()).toBe(true);
	});

	test("never claims anything when this client did not schedule an update", () => {
		expect(claim({ applyScheduled: false })).toBe(false);
		expect(claim({ claimedAt: null })).toBe(false);
	});

	test("releases the claim once this client asked to abandon the attempt", () => {
		// The regression: cancelling left `applyResult.scheduled` set forever, so the claim kept
		// overriding an idle coordinator and `/api/update/status` was polled once a second for good.
		expect(claim({ abandonedLocally: true })).toBe(false);
	});

	test("hands over to server truth as soon as the server confirms a schedule", () => {
		expect(claim({ serverConfirmedSchedule: true })).toBe(false);
	});

	test("expires so an attempt that ends without confirmation cannot poll forever", () => {
		expect(claim({ now: claimedAt + LOCAL_SCHEDULE_CLAIM_MAX_AGE_MS - 1 })).toBe(true);
		expect(claim({ now: claimedAt + LOCAL_SCHEDULE_CLAIM_MAX_AGE_MS })).toBe(false);
	});

	test("expiry cannot cut a real drain short, because the server keeps the fast poll itself", () => {
		// Long past the claim's expiry, a genuinely scheduled update still polls fast on server
		// truth alone — which is why bounding the local claim is safe.
		expect(claim({ now: claimedAt + 10 * LOCAL_SCHEDULE_CLAIM_MAX_AGE_MS })).toBe(false);
		expect(
			resolveUpdateStatusPollInterval({
				status: { ready: true, canAutoRestart: true, scheduled: true, phase: "quiescing_tools" },
				dataUpdatedAt: claimedAt + 10 * LOCAL_SCHEDULE_CLAIM_MAX_AGE_MS,
				assumeScheduled: false,
			}),
		).toBe(UPDATE_STATUS_ACTIVE_POLL_MS);
	});

	test("a cancelled attempt stops polling once the claim is released", () => {
		// End-to-end shape of the bug report: coordinator idle with a cancellation error, and the
		// released claim lets that error be believed.
		const cancelledStatus: PreparedUpdateStatus = {
			ready: true,
			canAutoRestart: true,
			scheduled: false,
			phase: "idle",
			error: "Scheduled update update_1 was cancelled by an administrator",
			errorKind: "cancelled",
		};
		expect(
			resolveUpdateStatusPollInterval({
				status: cancelledStatus,
				dataUpdatedAt: claimedAt + 2_000,
				errorSinceMs: claimedAt,
				assumeScheduled: claim({ abandonedLocally: true }),
			}),
		).toBe(false);
	});
});

describe("ambient schedule detection", () => {
	test("reports a schedule only when the server says one exists", () => {
		expect(hasActiveUpdateSchedule(undefined)).toBe(false);
		expect(hasActiveUpdateSchedule({ ready: true, canAutoRestart: true })).toBe(false);
		expect(hasActiveUpdateSchedule({ ready: true, canAutoRestart: true, scheduled: true })).toBe(
			true,
		);
	});
});
