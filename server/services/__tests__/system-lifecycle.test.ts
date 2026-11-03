import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createSystemLifecycle } from "../../lib/system-lifecycle";
import {
	assertUpdateNotCancelled,
	beginQuiescingTools,
	cancelScheduledUpdate,
	capturePlannedUpdateRecoverySnapshot,
	classifyRecoveryManifestOwnership,
	consumePlannedUpdateRecoverySnapshot,
	failScheduledUpdate,
	getUpdateCoordinationStatus,
	markUpdateRestarting,
	releasePreparedUpdateRecoveryHandoff,
	resetUpdateCoordinationForTests,
	rollbackPreparedUpdateRecoverySnapshot,
	scheduleUpdate,
	tryAcquireFinalUpdateExecution,
	UpdateCancelledError,
	waitForBackgroundBashDrain,
	waitForOrdinaryToolDrain,
	waitUntilUpdateGateOpens,
	writePlannedUpdateRecoverySnapshot,
} from "../update-coordinator";

function harness(
	options: {
		available?: boolean;
		failCheckpoint?: boolean;
		failShutdown?: boolean;
		failSchedule?: boolean;
		failCleanup?: boolean;
	} = {},
) {
	const changed = mock(() => {});
	const shutdown = mock(() => !options.failShutdown);
	const persist = mock((snapshot: ReturnType<typeof capturePlannedUpdateRecoverySnapshot>) => {
		writePlannedUpdateRecoverySnapshot(snapshot);
	});
	const lifecycle = createSystemLifecycle({
		changed,
		coordination: getUpdateCoordinationStatus,
		canShutdown: () => options.available !== false,
		schedule: () => {
			if (options.failSchedule) throw new Error("Recovery source is not owned by this process");
			return scheduleUpdate(undefined, "system_shutdown");
		},
		drain: async () => {
			await waitForBackgroundBashDrain();
			assertUpdateNotCancelled();
			beginQuiescingTools();
			await waitForOrdinaryToolDrain();
			if (options.failCheckpoint) throw new Error("Checkpoint failed");
			return capturePlannedUpdateRecoverySnapshot();
		},
		persist,
		assertNotCancelled: assertUpdateNotCancelled,
		markClosing: markUpdateRestarting,
		shutdown,
		cancel: () => {
			cancelScheduledUpdate();
		},
		cleanup: async (epoch, error, cancelled) => {
			if (options.failCleanup) throw new Error("Manifest rollback unavailable");
			rollbackPreparedUpdateRecoverySnapshot(epoch);
			releasePreparedUpdateRecoveryHandoff(epoch);
			failScheduledUpdate(error, { cancelled });
		},
		isCancellation: (error) => error instanceof UpdateCancelledError,
	});
	return { lifecycle, shutdown, persist, changed };
}

beforeEach(resetUpdateCoordinationForTests);
afterEach(resetUpdateCoordinationForTests);

describe("system shutdown lifecycle", () => {
	test("notifies effective state changes, including shutdown upgrades and async completion", async () => {
		const bash = tryAcquireFinalUpdateExecution("background_bash");
		const { lifecycle, changed } = harness();
		lifecycle.cancel();
		expect(changed).not.toHaveBeenCalled();
		lifecycle.prepare();
		expect(changed).toHaveBeenCalledTimes(1);
		lifecycle.prepare();
		lifecycle.status();
		expect(changed).toHaveBeenCalledTimes(1);
		lifecycle.shutdown();
		expect(changed).toHaveBeenCalledTimes(2);
		lifecycle.shutdown();
		expect(changed).toHaveBeenCalledTimes(2);
		bash?.release();
		await lifecycle.settled();
		expect(lifecycle.status().phase).toBe("shutting_down");
		expect(changed).toHaveBeenCalledTimes(4);
		lifecycle.shutdown();
		lifecycle.cancel();
		expect(changed).toHaveBeenCalledTimes(4);
	});

	test("notifies prepared completion, cancellation rollback and failures", async () => {
		const { lifecycle, changed } = harness();
		lifecycle.prepare();
		await lifecycle.settled();
		expect(changed).toHaveBeenCalledTimes(2);
		lifecycle.cancel();
		await lifecycle.settled();
		expect(lifecycle.status().phase).toBe("idle");
		expect(changed).toHaveBeenCalledTimes(5);
		lifecycle.cancel();
		expect(changed).toHaveBeenCalledTimes(5);

		const failed = harness({ failCheckpoint: true, failCleanup: true });
		failed.lifecycle.shutdown();
		await failed.lifecycle.settled();
		expect(failed.lifecycle.status().phase).toBe("failed");
		expect(failed.changed).toHaveBeenCalledTimes(3);
	});

	test("preparation uses the same Bash/ordinary gate and does not shut down", async () => {
		const bash = tryAcquireFinalUpdateExecution("background_bash");
		const ordinary = tryAcquireFinalUpdateExecution("ordinary");
		const { lifecycle, shutdown, persist } = harness();
		expect(lifecycle.prepare()).toMatchObject({ success: true, status: { phase: "preparing" } });
		expect(lifecycle.prepare().success).toBe(true);
		expect(persist).not.toHaveBeenCalled();
		bash?.release();
		await Promise.resolve();
		await Promise.resolve();
		expect(lifecycle.status().phase).toBe("preparing");
		ordinary?.release();
		await lifecycle.settled();
		expect(lifecycle.status().phase).toBe("prepared");
		expect(persist).toHaveBeenCalledTimes(1);
		expect(shutdown).not.toHaveBeenCalled();
		expect(consumePlannedUpdateRecoverySnapshot()?.resumeOnNextStartup).toBe(true);
		expect(tryAcquireFinalUpdateExecution("ordinary")).toBeNull();
	});

	test("direct shutdown prepares first, duplicates do not schedule a second close", async () => {
		const bash = tryAcquireFinalUpdateExecution("background_bash");
		const { lifecycle, shutdown, persist } = harness();
		lifecycle.shutdown();
		lifecycle.shutdown();
		expect(shutdown).not.toHaveBeenCalled();
		bash?.release();
		await lifecycle.settled();
		expect(persist).toHaveBeenCalledTimes(1);
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(lifecycle.status().phase).toBe("shutting_down");
		expect(lifecycle.cancel().success).toBe(false);
		lifecycle.shutdown();
		expect(shutdown).toHaveBeenCalledTimes(1);
	});

	test("a shutdown click while preparing upgrades the final action", async () => {
		const bash = tryAcquireFinalUpdateExecution("background_bash");
		const { lifecycle, shutdown } = harness();
		lifecycle.prepare();
		lifecycle.shutdown();
		bash?.release();
		await lifecycle.settled();
		expect(shutdown).toHaveBeenCalledTimes(1);
	});

	test("prepared shutdown refreshes the durable snapshot under the same epoch", async () => {
		const { lifecycle, persist, shutdown } = harness();
		lifecycle.prepare();
		await lifecycle.settled();
		const epoch = lifecycle.status().coordination.updateEpoch;
		lifecycle.shutdown();
		await lifecycle.settled();
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(persist).toHaveBeenCalledTimes(2);
		expect(lifecycle.status().coordination.updateEpoch).toBe(epoch);
	});

	test.each([false, true])("cancel releases the tool gate (prepared=%s)", async (prepared) => {
		const bash = prepared ? null : tryAcquireFinalUpdateExecution("background_bash");
		const { lifecycle, shutdown } = harness();
		lifecycle.prepare();
		if (prepared) await lifecycle.settled();
		const waiting = waitUntilUpdateGateOpens();
		expect(lifecycle.cancel().success).toBe(true);
		await lifecycle.settled();
		await waiting;
		bash?.release();
		expect(lifecycle.status().phase).toBe("idle");
		expect(getUpdateCoordinationStatus().scheduled).toBe(false);
		expect(shutdown).not.toHaveBeenCalled();
	});

	test.each([
		{ failCheckpoint: true },
		{ failShutdown: true },
	])("failure unfreezes work: %j", async (options) => {
		const { lifecycle } = harness(options);
		lifecycle.shutdown();
		await lifecycle.settled();
		expect(lifecycle.status().phase).toBe("failed");
		expect(lifecycle.status().error).toBeString();
		expect(getUpdateCoordinationStatus().scheduled).toBe(false);
	});

	test("rejects unavailable runtimes and automatic update conflicts", () => {
		expect(harness({ available: false }).lifecycle.prepare().success).toBe(false);
		expect(getUpdateCoordinationStatus().scheduled).toBe(false);
		scheduleUpdate("next");
		expect(harness().lifecycle.shutdown().success).toBe(false);
		expect(getUpdateCoordinationStatus().operation).toBe("update");
	});

	test("source admission failure returns a conflict without starting preparation", () => {
		const { lifecycle, shutdown, persist } = harness({ failSchedule: true });
		expect(lifecycle.prepare()).toEqual({
			success: false,
			error: "Recovery source is not owned by this process",
		});
		expect(lifecycle.status().phase).toBe("idle");
		expect(getUpdateCoordinationStatus().scheduled).toBe(false);
		expect(persist).not.toHaveBeenCalled();
		expect(shutdown).not.toHaveBeenCalled();
	});

	test("failed durable rollback keeps the epoch and gate until cancellation can retry", async () => {
		const options = { failCheckpoint: true, failCleanup: true };
		const { lifecycle, shutdown } = harness(options);
		lifecycle.shutdown();
		await lifecycle.settled();
		const epoch = getUpdateCoordinationStatus().updateEpoch;
		expect(lifecycle.status()).toMatchObject({
			phase: "failed",
			shutdownRequested: false,
			error: expect.stringContaining("Manifest rollback unavailable"),
		});
		expect(getUpdateCoordinationStatus().scheduled).toBe(true);
		expect(lifecycle.prepare().success).toBe(false);
		expect(getUpdateCoordinationStatus().updateEpoch).toBe(epoch);
		options.failCleanup = false;
		expect(lifecycle.cancel().success).toBe(true);
		await lifecycle.settled();
		expect(lifecycle.status().phase).toBe("idle");
		expect(getUpdateCoordinationStatus().scheduled).toBe(false);
		expect(shutdown).not.toHaveBeenCalled();
	});
	test("only explicit manual authorization permits an ordinary startup", () => {
		expect(classifyRecoveryManifestOwnership({}, null).owned).toBe(false);
		expect(classifyRecoveryManifestOwnership({ resumeOnNextStartup: true }, null).owned).toBe(true);
		expect(
			classifyRecoveryManifestOwnership({ resumeOnNextStartup: true, evidenceOnly: true }, null)
				.owned,
		).toBe(false);
		expect(
			classifyRecoveryManifestOwnership(
				{ resumeOnNextStartup: true, handoffMarkerNonce: "old" },
				null,
			).owned,
		).toBe(false);
		expect(
			classifyRecoveryManifestOwnership({ handoffMarkerNonce: "old" }, { markerNonce: "new" })
				.owned,
		).toBe(false);
	});
});
