import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	CheckpointStop,
	freezeCheckpointStopAdmission,
	isCheckpointStop,
} from "../agent-runtime/checkpoint-stop";
import * as gate from "../update-coordinator";

beforeEach(gate.resetUpdateCoordinationForTests);
afterEach(gate.resetUpdateCoordinationForTests);
function actor(
	narratorId = "parked",
	logicalRunId = "run-1",
	executionEpoch = "owner-1",
	parentNarratorId?: string,
) {
	const controller = new AbortController();
	const identity = { narratorId, logicalRunId, executionEpoch };
	const unregister = gate.registerNarratorLoop(narratorId, "en", {
		logicalRunId,
		executionEpoch,
		parentNarratorId,
	});
	gate.bindCheckpointGateActor(controller.signal, identity);
	return {
		controller,
		identity,
		unregister,
		park: () => gate.beginNarratorResponseActivity(narratorId, controller.signal),
	};
}
async function verified() {
	gate.scheduleUpdate(undefined, "system_shutdown");
	gate.beginQuiescingTools();
	await gate.waitForScheduledRecoveryHandoff();
	const snapshot = gate.capturePlannedUpdateRecoverySnapshot();
	gate.verifyPreparedCheckpoint(snapshot);
	return snapshot;
}
async function commit(snapshot: gate.PlannedUpdateRecoverySnapshot) {
	freezeCheckpointStopAdmission();
	gate.writePreparedUpdateRecoverySnapshot({ ...snapshot, resumeOnNextStartup: true });
	gate.markUpdateRestarting();
}

test("durable publication is required; only exact actors unwind and late gates pause immediately", async () => {
	const known = actor();
	const snapshot = await verified();
	const pending = known.park();
	void pending.catch(() => {});
	expect(gate.stopCheckpointedNarratorRuns()).toBe(0);
	gate.writePreparedUpdateRecoverySnapshot({ ...snapshot, resumeOnNextStartup: true });
	gate.markUpdateRestarting();
	expect(gate.stopCheckpointedNarratorRuns()).toBe(0);
	await commit(snapshot);
	const unknown = actor("other", "other-run", "other-owner");
	const blocked = unknown.park();
	void blocked.catch(() => {});
	expect(gate.stopCheckpointedNarratorRuns()).toBe(1);
	expect(isCheckpointStop(await pending.catch((error) => error))).toBe(true);
	expect(isCheckpointStop(await known.park().catch((error) => error))).toBe(true);
	expect(
		gate.checkpointStopForRun({ ...known.identity, logicalRunId: "different" }),
	).toBeUndefined();
	expect(
		gate.checkpointStopForRun({ ...known.identity, executionEpoch: "different" }),
	).toBeUndefined();
	expect(gate.getUpdateCoordinationStatus().phase).toBe("restarting");
	unknown.controller.abort("real cancel");
	await expect(blocked).rejects.toMatchObject({ name: "AbortError" });
});

test("signal-only deferred tool waits inherit checkpoint authority but unbound waits do not", async () => {
	const known = actor();
	const unknown = new AbortController();
	const snapshot = await verified();
	const pending = gate.waitUntilUpdateGateOpens(known.controller.signal);
	const blocked = gate.waitUntilUpdateGateOpens(unknown.signal);
	void pending.catch(() => {});
	void blocked.catch(() => {});
	try {
		await commit(snapshot);
		expect(gate.stopCheckpointedNarratorRuns()).toBe(1);
		expect(await pending.catch((error) => error)).toMatchObject({ identity: known.identity });
		await expect(gate.waitUntilUpdateGateOpens(known.controller.signal)).rejects.toMatchObject({
			identity: known.identity,
		});
		unknown.abort();
		await expect(blocked).rejects.toMatchObject({ name: "AbortError" });
	} finally {
		known.controller.abort();
		unknown.abort();
		await Promise.allSettled([pending, blocked]);
	}
});

test("failed manifest IO cannot grant process-only stop", async () => {
	const known = actor();
	const snapshot = await verified();
	const pending = known.park();
	void pending.catch(() => {});
	const rename = spyOn(fs, "renameSync").mockImplementation(() => {
		throw new Error("injected checkpoint IO failure");
	});
	try {
		expect(() => gate.writePreparedUpdateRecoverySnapshot(snapshot)).toThrow(
			"injected checkpoint IO failure",
		);
	} finally {
		rename.mockRestore();
	}
	gate.markUpdateRestarting();
	expect(gate.stopCheckpointedNarratorRuns()).toBe(0);
	expect(gate.checkpointStopForRun(known.identity)).toBeUndefined();
	known.controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("published eligibility without durable continuation verification does not authorize stopping", async () => {
	const known = actor();
	gate.scheduleUpdate(undefined, "system_shutdown");
	gate.beginQuiescingTools();
	await gate.waitForScheduledRecoveryHandoff();
	await commit(gate.capturePlannedUpdateRecoverySnapshot());
	const pending = known.park();
	void pending.catch(() => {});
	expect(gate.stopCheckpointedNarratorRuns()).toBe(0);
	known.controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("a covered child cannot unwind when its foreground parent has no checkpoint authority", async () => {
	const child = actor("child", "child-run", "child-owner", "uncovered-parent");
	const snapshot = await verified();
	await commit(snapshot);
	const pending = child.park();
	void pending.catch(() => {});
	expect(gate.stopCheckpointedNarratorRuns()).toBe(0);
	expect(gate.checkpointStopForRun(child.identity)).toBeUndefined();
	child.controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("a replaced owner cannot inherit a prior run's verified checkpoint", async () => {
	const original = actor();
	const snapshot = await verified();
	original.unregister();
	const replacement = actor("parked", "run-2", "owner-2");
	await commit(snapshot);
	const pending = replacement.park();
	void pending.catch(() => {});
	expect(gate.stopCheckpointedNarratorRuns()).toBe(0);
	replacement.controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("a covered intermediate parent cannot hide an uncovered foreground ancestor", async () => {
	actor("parent", "parent-run", "parent-owner", "uncovered-root");
	const child = actor("child", "child-run", "child-owner", "parent");
	const snapshot = await verified();
	await commit(snapshot);
	const pending = child.park();
	void pending.catch(() => {});
	expect(gate.stopCheckpointedNarratorRuns()).toBe(0);
	child.controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("a child's original parent identity cannot be replaced by another covered run", async () => {
	const parent = actor("parent", "parent-run-1", "parent-owner-1");
	const child = actor("child", "child-run", "child-owner", "parent");
	parent.unregister();
	actor("parent", "parent-run-2", "parent-owner-2");
	const snapshot = await verified();
	await commit(snapshot);
	const pending = child.park();
	void pending.catch(() => {});
	expect(gate.stopCheckpointedNarratorRuns()).toBe(0);
	expect(gate.checkpointStopForRun(child.identity)).toBeUndefined();
	child.controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("an identity absent from durable active rows has no pause authority", async () => {
	const known = actor();
	const snapshot = await verified();
	gate.verifyPreparedCheckpoint(snapshot, new Set());
	await commit(snapshot);
	const pending = known.park();
	void pending.catch(() => {});
	expect(gate.stopCheckpointedNarratorRuns()).toBe(0);
	known.controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("checkpoint reason recognition is process-local, not a name or code string", () => {
	expect(isCheckpointStop({ name: "CheckpointStop", code: "CHECKPOINT_STOP" })).toBe(false);
	expect(isCheckpointStop(new Error("CheckpointStop"))).toBe(false);
	expect(
		isCheckpointStop(
			new CheckpointStop("epoch", { narratorId: "n", logicalRunId: "r", executionEpoch: "e" }),
		),
	).toBe(true);
});
