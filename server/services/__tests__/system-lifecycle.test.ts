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
	resetUpdateCoordinationForTests,
	scheduleUpdate,
	tryAcquireFinalUpdateExecution,
	UpdateCancelledError,
	waitForBackgroundBashDrain,
	waitForOrdinaryToolDrain,
	waitUntilUpdateGateOpens,
	writePlannedUpdateRecoverySnapshot,
} from "../update-coordinator";

function harness(
	options: { available?: boolean; failCheckpoint?: boolean; failShutdown?: boolean } = {},
) {
	const shutdown = mock(() => !options.failShutdown);
	const persist = mock((snapshot: ReturnType<typeof capturePlannedUpdateRecoverySnapshot>) => {
		writePlannedUpdateRecoverySnapshot(snapshot);
	});
	const lifecycle = createSystemLifecycle({
		coordination: getUpdateCoordinationStatus,
		canShutdown: () => options.available !== false,
		schedule: () => scheduleUpdate(undefined, "system_shutdown"),
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
		cleanup: async (_epoch, error, cancelled) => {
			failScheduledUpdate(error, { cancelled });
		},
		isCancellation: (error) => error instanceof UpdateCancelledError,
	});
	return { lifecycle, shutdown, persist };
}

beforeEach(resetUpdateCoordinationForTests);
afterEach(resetUpdateCoordinationForTests);

describe("system shutdown lifecycle", () => {
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
