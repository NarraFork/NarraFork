import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	assertUpdateNotCancelled,
	beginNarratorResponseActivity,
	beginQuiescingTools,
	beginToolStartAdmission,
	beginUpdatePreAdmissionActivity,
	cancelScheduledUpdate,
	capturePlannedUpdateRecoverySnapshot,
	consumePlannedUpdateRecoverySnapshot,
	convertToolStartGrantToExecution,
	failScheduledUpdate,
	getUpdateCoordinationStatus,
	markUpdateRestarting,
	parsePlannedUpdateRecoverySnapshot,
	registerNarratorLoop,
	removePlannedUpdateRecoverySnapshot,
	resetUpdateCoordinationForTests,
	scheduleUpdate,
	tryAcquireFinalUpdateExecution,
	tryAcquireUpdateExecution,
	UpdateCancelledError,
	waitForBackgroundBashDrain,
	waitForOrdinaryToolDrain,
	waitForUpdateCheckpointFence,
	waitUntilUpdateGateOpens,
	writePlannedUpdateRecoverySnapshot,
} from "../update-coordinator";

describe("update coordinator", () => {
	beforeEach(() => {
		resetUpdateCoordinationForTests();
	});

	afterEach(() => {
		resetUpdateCoordinationForTests();
	});

	test("phase one blocks background Bash while admitting ordinary and resumable work", () => {
		const existingBackground = tryAcquireFinalUpdateExecution("background_bash", "narrator-1");
		expect(existingBackground).not.toBeNull();

		const scheduled = scheduleUpdate("9.9.9");
		expect(scheduled).toMatchObject({
			phase: "draining_background_bash",
			scheduled: true,
			targetVersion: "9.9.9",
			pendingBackgroundBashCount: 1,
			pendingOrdinaryExecutionCount: 0,
			resumableExecutionCount: 0,
			pendingExecutionCount: 1,
		});
		expect(scheduled.updateEpoch).toBeString();

		expect(tryAcquireFinalUpdateExecution("background_bash", "narrator-2")).toBeNull();
		const ordinary = tryAcquireFinalUpdateExecution("ordinary", "narrator-2");
		const resumable = tryAcquireFinalUpdateExecution("resumable", "narrator-3");
		expect(ordinary).not.toBeNull();
		expect(resumable).not.toBeNull();
		expect(getUpdateCoordinationStatus()).toMatchObject({
			pendingBackgroundBashCount: 1,
			pendingOrdinaryExecutionCount: 1,
			resumableExecutionCount: 1,
			pendingExecutionCount: 3,
		});

		existingBackground?.release();
		ordinary?.release();
		resumable?.release();
	});

	test("phase two rejects every execution kind", () => {
		scheduleUpdate("9.9.9");
		const status = beginQuiescingTools();
		expect(status.phase).toBe("quiescing_tools");

		expect(tryAcquireFinalUpdateExecution("background_bash")).toBeNull();
		expect(tryAcquireFinalUpdateExecution("ordinary")).toBeNull();
		expect(tryAcquireFinalUpdateExecution("resumable")).toBeNull();

		markUpdateRestarting();
		expect(tryAcquireFinalUpdateExecution("background_bash")).toBeNull();
		expect(tryAcquireFinalUpdateExecution("ordinary")).toBeNull();
		expect(tryAcquireFinalUpdateExecution("resumable")).toBeNull();
	});

	test("tool start grant atomically survives a phase switch and fences checkpointing", async () => {
		const admission = beginToolStartAdmission("ordinary", "narrator-grant", "tool-grant");
		expect(admission.status).toBe("granted");
		if (admission.status !== "granted") throw new Error("Expected a tool start grant");
		expect(getUpdateCoordinationStatus().pendingToolStartGrantCount).toBe(1);

		scheduleUpdate("9.9.9");
		beginQuiescingTools();
		let stable = false;
		const fence = waitForUpdateCheckpointFence().then(() => {
			stable = true;
		});
		await Promise.resolve();
		expect(stable).toBe(false);

		admission.grant.release();
		await fence;
		expect(stable).toBe(true);
		expect(getUpdateCoordinationStatus().pendingToolStartGrantCount).toBe(0);
	});

	test("phase-two conversion preserves the irrevocable grant and hands off to ordinary drain", async () => {
		const admission = beginToolStartAdmission("ordinary", "narrator-grant", "tool-grant");
		if (admission.status !== "granted") throw new Error("Expected a tool start grant");
		scheduleUpdate("9.9.9");
		beginQuiescingTools();

		let checkpointStable = false;
		const checkpointFence = waitForUpdateCheckpointFence().then(() => {
			checkpointStable = true;
		});
		await Promise.resolve();
		expect(checkpointStable).toBe(false);

		const transition = convertToolStartGrantToExecution(
			admission.grant,
			"narrator-grant",
			"tool-grant",
		);
		expect(transition.status).toBe("execution");
		expect(getUpdateCoordinationStatus()).toMatchObject({
			pendingToolStartGrantCount: 0,
			pendingPreAdmissionCount: 0,
			pendingOrdinaryExecutionCount: 1,
		});
		await checkpointFence;
		expect(checkpointStable).toBe(true);

		let ordinaryDrained = false;
		const ordinaryDrain = waitForOrdinaryToolDrain().then(() => {
			ordinaryDrained = true;
		});
		await Promise.resolve();
		expect(ordinaryDrained).toBe(false);
		transition.lease.release();
		await ordinaryDrain;
		expect(ordinaryDrained).toBe(true);
	});

	test("drains background Bash first, ordinary tools second, and never waits for resumable work", async () => {
		const background = tryAcquireFinalUpdateExecution("background_bash");
		const ordinary = tryAcquireFinalUpdateExecution("ordinary");
		const resumable = tryAcquireFinalUpdateExecution("resumable");
		scheduleUpdate("9.9.9");

		let backgroundDrained = false;
		const backgroundDrain = waitForBackgroundBashDrain().then(() => {
			backgroundDrained = true;
		});
		await Promise.resolve();
		expect(backgroundDrained).toBe(false);

		background?.release();
		await backgroundDrain;
		expect(backgroundDrained).toBe(true);
		expect(getUpdateCoordinationStatus().pendingOrdinaryExecutionCount).toBe(1);

		beginQuiescingTools();
		let ordinaryDrained = false;
		const ordinaryDrain = waitForOrdinaryToolDrain().then(() => {
			ordinaryDrained = true;
		});
		await Promise.resolve();
		expect(ordinaryDrained).toBe(false);

		ordinary?.release();
		await ordinaryDrain;
		expect(ordinaryDrained).toBe(true);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			resumableExecutionCount: 1,
			pendingExecutionCount: 1,
		});
		resumable?.release();
	});

	test("checkpoint fence waits for active responses and durable pre-admission work", async () => {
		const response = await beginNarratorResponseActivity("narrator-response");
		const scheduled = scheduleUpdate("9.9.9");
		beginQuiescingTools();
		if (!scheduled.updateEpoch) throw new Error("Expected update epoch");
		const admission = beginUpdatePreAdmissionActivity(
			scheduled.updateEpoch,
			"narrator-tool",
			"tool-use-1",
		);
		expect(admission).not.toBeNull();

		let stable = false;
		const waiting = waitForUpdateCheckpointFence().then(() => {
			stable = true;
		});
		await Promise.resolve();
		expect(stable).toBe(false);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			activeResponseCount: 1,
			pendingPreAdmissionCount: 1,
		});

		response.release();
		await Promise.resolve();
		expect(stable).toBe(false);
		admission?.release();
		await waiting;
		expect(stable).toBe(true);
	});

	test("checkpoint fence has no deadline and only ends on readiness or cancellation", async () => {
		const response = await beginNarratorResponseActivity("slow-response");
		scheduleUpdate("9.9.9");
		beginQuiescingTools();

		let settled = false;
		const waiting = waitForUpdateCheckpointFence().then(
			() => {
				settled = true;
			},
			(error: unknown) => {
				settled = true;
				throw error;
			},
		);
		// A response legitimately outlives any short deadline (first-token timeout plus retries),
		// so the fence must still be open well past the former 30s budget.
		await Bun.sleep(60);
		expect(settled).toBe(false);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			activeResponseCount: 1,
			cancelRequested: false,
		});

		expect(cancelScheduledUpdate("operator asked to stop")).toBe(true);
		await expect(waiting).rejects.toBeInstanceOf(UpdateCancelledError);
		expect(getUpdateCoordinationStatus().cancelRequested).toBe(true);
		response.release();
	});

	test("cancellation unblocks the drain waits and clears once the update is abandoned", async () => {
		const backgroundBash = tryAcquireFinalUpdateExecution("background_bash", "narrator-bg");
		expect(backgroundBash).not.toBeNull();
		scheduleUpdate("9.9.9");

		const draining = waitForBackgroundBashDrain();
		await Promise.resolve();
		expect(cancelScheduledUpdate()).toBe(true);
		await expect(draining).rejects.toBeInstanceOf(UpdateCancelledError);

		// A wait started after cancellation fails immediately instead of hanging.
		await expect(waitForOrdinaryToolDrain()).rejects.toBeInstanceOf(UpdateCancelledError);
		expect(() => assertUpdateNotCancelled()).toThrow(UpdateCancelledError);

		failScheduledUpdate("cancelled by operator", { cancelled: true });
		expect(getUpdateCoordinationStatus()).toMatchObject({
			phase: "idle",
			cancelRequested: false,
			errorKind: "cancelled",
		});
		backgroundBash?.release();

		// The next attempt must not inherit the previous epoch's cancellation.
		scheduleUpdate("9.9.10");
		const rescheduled = getUpdateCoordinationStatus();
		expect(rescheduled.cancelRequested).toBe(false);
		expect(rescheduled.errorKind).toBeUndefined();
		expect(rescheduled.error).toBeUndefined();
		expect(() => assertUpdateNotCancelled()).not.toThrow();
	});

	test("cancelling without a scheduled update is a no-op", () => {
		expect(cancelScheduledUpdate()).toBe(false);
		expect(getUpdateCoordinationStatus().cancelRequested).toBe(false);
	});

	test("status reports the blockers holding a scheduled update open", async () => {
		const response = await beginNarratorResponseActivity("blocking-narrator");
		// A grant issued during phase one is exactly the case a fence wait must observe: the tool
		// has already started, so it can still add rows after the phase switch.
		const admission = beginToolStartAdmission("ordinary", "grant-narrator", "grant-tool-use");
		expect(admission.status).toBe("granted");
		scheduleUpdate("9.9.9");
		beginQuiescingTools();

		const blockers = getUpdateCoordinationStatus().blockers;
		expect(blockers.map((blocker) => blocker.kind).sort()).toEqual([
			"response",
			"tool_start_grant",
		]);
		expect(blockers.find((blocker) => blocker.kind === "tool_start_grant")).toMatchObject({
			narratorId: "grant-narrator",
			toolUseId: "grant-tool-use",
		});

		if (admission.status === "granted") admission.grant.release();
		response.release();
	});

	test("phase two prevents a new narrator response from entering the checkpoint fence", async () => {
		scheduleUpdate("9.9.9");
		beginQuiescingTools();
		let entered = false;
		const responsePromise = beginNarratorResponseActivity("late-response").then((lease) => {
			entered = true;
			return lease;
		});
		await Promise.resolve();
		expect(entered).toBe(false);
		await waitForUpdateCheckpointFence();

		failScheduledUpdate("test failure");
		const response = await responsePromise;
		expect(entered).toBe(true);
		response.release();
	});

	test("failed update returns to idle and wakes paused tools without a tool failure result", async () => {
		scheduleUpdate("1.0.0");
		beginQuiescingTools();

		let resumed = false;
		const waiting = waitUntilUpdateGateOpens().then(() => {
			resumed = true;
		});
		await Promise.resolve();
		expect(resumed).toBe(false);
		expect(getUpdateCoordinationStatus().pausedToolCount).toBe(1);

		const failed = failScheduledUpdate("spawn failed");
		await waiting;
		expect(resumed).toBe(true);
		expect(failed).toMatchObject({
			phase: "idle",
			scheduled: false,
			pausedToolCount: 0,
			error: "spawn failed",
		});
		expect(tryAcquireFinalUpdateExecution("ordinary")).not.toBeNull();
	});

	test("captures and persists a version 2 manifest with the scheduled update epoch", () => {
		const unregisterLoop = registerNarratorLoop("narrator-1", "zh-CN", {
			userId: "user-1",
			replyInUserLanguage: true,
		});
		const ordinary = tryAcquireFinalUpdateExecution("ordinary", "subagent-1");
		const scheduled = scheduleUpdate("2.0.0");
		const updateEpoch = scheduled.updateEpoch;
		expect(updateEpoch).toBeString();
		if (!updateEpoch) throw new Error("Scheduled update must have an epoch");

		const snapshot = capturePlannedUpdateRecoverySnapshot();
		expect(snapshot).toEqual({
			version: 2,
			updateEpoch,
			targetVersion: "2.0.0",
			capturedAt: expect.any(String),
			narrators: [
				{
					narratorId: "narrator-1",
					locale: "zh-CN",
					userId: "user-1",
					replyInUserLanguage: true,
				},
				{ narratorId: "subagent-1", locale: "en" },
			],
		});

		const written = writePlannedUpdateRecoverySnapshot(snapshot);
		expect(written.version).toBe(2);
		expect(consumePlannedUpdateRecoverySnapshot()).toEqual(written);
		expect(consumePlannedUpdateRecoverySnapshot()).toEqual(written);

		const rewritten = writePlannedUpdateRecoverySnapshot({
			version: 2,
			targetVersion: written.targetVersion,
			capturedAt: new Date().toISOString(),
			narrators: written.narrators,
		});
		expect(rewritten.updateEpoch).toBe(updateEpoch);

		unregisterLoop();
		ordinary?.release();
	});

	test("parses a version 1 manifest into the version 2 shape", () => {
		const parsed = parsePlannedUpdateRecoverySnapshot({
			version: 1,
			targetVersion: "1.5.0",
			capturedAt: "2026-07-20T00:00:00.000Z",
			narrators: [{ narratorId: "narrator-1", locale: "en" }],
		});

		expect(parsed).toEqual({
			version: 2,
			updateEpoch: "legacy_2026_07_20T00_00_00_000Z",
			targetVersion: "1.5.0",
			capturedAt: "2026-07-20T00:00:00.000Z",
			narrators: [{ narratorId: "narrator-1", locale: "en" }],
		});
	});

	test("aborting a gate wait rejects and removes its abort listener", async () => {
		scheduleUpdate("9.9.9");
		beginQuiescingTools();

		const controller = new AbortController();
		const waiting = waitUntilUpdateGateOpens(controller.signal);
		await Promise.resolve();
		expect(getUpdateCoordinationStatus().pausedToolCount).toBe(1);

		controller.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		// The waiter must be gone, not merely rejected: a leaked entry would keep the coordinator
		// reporting a paused tool that no longer exists.
		expect(getUpdateCoordinationStatus().pausedToolCount).toBe(0);

		// Opening the gate afterwards must not double-settle the already-rejected waiter.
		expect(() => failScheduledUpdate("cleanup")).not.toThrow();
	});

	test("an already-aborted signal fails the gate wait without registering a waiter", async () => {
		scheduleUpdate("9.9.9");
		beginQuiescingTools();
		const controller = new AbortController();
		controller.abort();

		await expect(waitUntilUpdateGateOpens(controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(getUpdateCoordinationStatus().pausedToolCount).toBe(0);
	});

	test("an aborted gate waiter is not resolved when the gate later opens", async () => {
		scheduleUpdate("9.9.9");
		beginQuiescingTools();
		const controller = new AbortController();
		const aborted = waitUntilUpdateGateOpens(controller.signal);
		const surviving = waitUntilUpdateGateOpens();
		await Promise.resolve();
		expect(getUpdateCoordinationStatus().pausedToolCount).toBe(2);

		controller.abort();
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

		let resumed = false;
		const survivingTracked = surviving.then(() => {
			resumed = true;
		});
		failScheduledUpdate("spawn failed");
		await survivingTracked;
		expect(resumed).toBe(true);
	});

	test("gate waiting is a no-op once the coordinator is idle", async () => {
		await expect(waitUntilUpdateGateOpens()).resolves.toBeUndefined();
		const controller = new AbortController();
		controller.abort();
		// Idle short-circuits before the abort check, so an aborted signal is irrelevant here.
		await expect(waitUntilUpdateGateOpens(controller.signal)).resolves.toBeUndefined();
	});

	test("a rejected tool start becomes a durable pause that fences checkpointing", async () => {
		const scheduled = scheduleUpdate("9.9.9");
		beginQuiescingTools();

		const admission = beginToolStartAdmission("ordinary", "narrator-late", "tool-late");
		expect(admission.status).toBe("paused");
		if (admission.status !== "paused") throw new Error("Expected a paused admission");
		expect(admission.updateEpoch).toBe(scheduled.updateEpoch as string);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			pendingPreAdmissionCount: 1,
			pendingToolStartGrantCount: 0,
		});

		let stable = false;
		const fence = waitForUpdateCheckpointFence().then(() => {
			stable = true;
		});
		await Promise.resolve();
		expect(stable).toBe(false);

		admission.activity.release();
		await fence;
		expect(stable).toBe(true);
		expect(getUpdateCoordinationStatus().pendingPreAdmissionCount).toBe(0);
	});

	test("background Bash is rejected during phase one while ordinary work is still admitted", () => {
		scheduleUpdate("9.9.9");
		const rejected = beginToolStartAdmission("background_bash", "narrator-bg", "tool-bg");
		expect(rejected.status).toBe("paused");
		const granted = beginToolStartAdmission("ordinary", "narrator-ord", "tool-ord");
		expect(granted.status).toBe("granted");
		if (rejected.status === "paused") rejected.activity.release();
		if (granted.status === "granted") granted.grant.release();
	});

	test("pre-admission activity is refused for a stale epoch and while idle", () => {
		// Idle: nothing to fence, so no activity may be registered.
		expect(beginUpdatePreAdmissionActivity("any-epoch", "narrator-1", "tool-1")).toBeNull();

		const scheduled = scheduleUpdate("9.9.9");
		if (!scheduled.updateEpoch) throw new Error("Expected update epoch");
		// A tool paused by a previous attempt must not fence the current one.
		expect(beginUpdatePreAdmissionActivity("stale-epoch", "narrator-1", "tool-1")).toBeNull();
		expect(getUpdateCoordinationStatus().pendingPreAdmissionCount).toBe(0);

		const activity = beginUpdatePreAdmissionActivity(scheduled.updateEpoch, "narrator-1", "tool-1");
		expect(activity).not.toBeNull();
		activity?.release();
	});

	test("blockers are sorted oldest first and capped for the status payload", async () => {
		const leases = [];
		// 12 blockers exceeds the 10-entry status limit.
		for (let index = 0; index < 12; index++) {
			const lease = tryAcquireFinalUpdateExecution("ordinary", `narrator-${index}`);
			expect(lease).not.toBeNull();
			leases.push(lease);
			// Stagger start times so the sort order is observable without relying on insertion order.
			await Bun.sleep(2);
		}
		// Resumable work never blocks a restart, so it must not appear among the blockers.
		const resumable = tryAcquireFinalUpdateExecution("resumable", "narrator-resumable");
		scheduleUpdate("9.9.9");

		const blockers = getUpdateCoordinationStatus().blockers;
		expect(blockers).toHaveLength(10);
		expect(blockers.every((blocker) => blocker.kind === "ordinary")).toBe(true);
		// Longest wait first.
		const waits = blockers.map((blocker) => blocker.waitingMs);
		expect([...waits].sort((a, b) => b - a)).toEqual(waits);
		// The two most recent leases are the ones dropped by the cap.
		expect(blockers.map((blocker) => blocker.narratorId)).not.toContain("narrator-11");
		expect(blockers.map((blocker) => blocker.narratorId)).toContain("narrator-0");

		resumable?.release();
		for (const lease of leases) lease?.release();
	});

	test("an idle coordinator reports no blockers even while work is running", () => {
		const lease = tryAcquireFinalUpdateExecution("ordinary", "narrator-idle");
		expect(getUpdateCoordinationStatus().blockers).toEqual([]);
		lease?.release();
	});

	test("repeated scheduling keeps the original epoch and legacy callers still compile", () => {
		const first = scheduleUpdate("1.0.0");
		const second = scheduleUpdate("2.0.0");
		expect(second.targetVersion).toBe("1.0.0");
		expect(second.phase).toBe("draining_background_bash");
		expect(second.updateEpoch).toBe(first.updateEpoch);

		// Legacy subagent maps to ordinary work and remains admissible during phase one.
		const legacyLease = tryAcquireUpdateExecution("subagent", "narrator-1");
		expect(legacyLease?.kind).toBe("ordinary");
		legacyLease?.release();
	});
});

describe("recovery manifest epoch guard", () => {
	beforeEach(() => {
		resetUpdateCoordinationForTests();
	});

	afterEach(() => {
		resetUpdateCoordinationForTests();
	});

	function manifest(updateEpoch: string, targetVersion: string) {
		return {
			version: 2 as const,
			updateEpoch,
			targetVersion,
			capturedAt: new Date().toISOString(),
			narrators: [],
		};
	}

	test("write with a matching guard replaces a stale manifest owned by the same epoch", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"));
		const written = writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.1.0"), {
			expectedEpoch: "epoch-a",
		});
		expect(written.targetVersion).toBe("1.1.0");
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			updateEpoch: "epoch-a",
			targetVersion: "1.1.0",
		});
	});

	test("guarded write rejects a manifest owned by a different epoch", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-new", "2.0.0"));
		// A stale attempt tries to persist evidence for its own (older) epoch.
		expect(() =>
			writePlannedUpdateRecoverySnapshot(manifest("epoch-stale", "1.0.0"), {
				expectedEpoch: "epoch-stale",
			}),
		).toThrow(/refusing to replace/);
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			updateEpoch: "epoch-new",
			targetVersion: "2.0.0",
		});
	});

	test("normal checkpoint write cannot take over a manifest from another epoch", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"));
		expect(() => writePlannedUpdateRecoverySnapshot(manifest("epoch-b", "2.0.0"))).toThrow(
			/refusing to replace/,
		);
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			updateEpoch: "epoch-a",
			targetVersion: "1.0.0",
		});
	});

	test("guarded write onto an absent manifest still writes (nothing to protect)", () => {
		const written = writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"), {
			expectedEpoch: "epoch-a",
		});
		expect(written.updateEpoch).toBe("epoch-a");
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({ updateEpoch: "epoch-a" });
	});

	test("guarded write throws when the snapshot epoch disagrees with the declared epoch", () => {
		expect(() =>
			writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"), {
				expectedEpoch: "epoch-b",
			}),
		).toThrow(/epoch guard mismatch/);
	});

	test("guarded remove deletes only a manifest owned by the expected epoch", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-a", "1.0.0"));
		removePlannedUpdateRecoverySnapshot({ expectedEpoch: "epoch-a" });
		expect(consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});

	test("guarded remove preserves a manifest owned by a different epoch", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-new", "2.0.0"));
		// A stale cleanup for an older epoch must not delete the newer epoch's manifest.
		removePlannedUpdateRecoverySnapshot({ expectedEpoch: "epoch-stale" });
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			updateEpoch: "epoch-new",
			targetVersion: "2.0.0",
		});
	});

	test("legacy writes derive their own epoch instead of borrowing the current owner", () => {
		writePlannedUpdateRecoverySnapshot(manifest("epoch-current", "3.0.0"));
		expect(() =>
			writePlannedUpdateRecoverySnapshot({
				version: 1,
				targetVersion: "2.0.0",
				capturedAt: "2026-07-20T00:00:00.000Z",
				narrators: [],
			}),
		).toThrow(/refusing to replace/);
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			updateEpoch: "epoch-current",
		});
	});
});
