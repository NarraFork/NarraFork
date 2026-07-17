import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	capturePlannedUpdateRecoverySnapshot,
	consumePlannedUpdateRecoverySnapshot,
	failScheduledUpdate,
	getUpdateCoordinationStatus,
	registerNarratorLoop,
	resetUpdateCoordinationForTests,
	scheduleUpdate,
	tryAcquireUpdateExecution,
	waitForUpdateExecutionDrain,
	writePlannedUpdateRecoverySnapshot,
} from "../update-coordinator";

describe("update coordinator", () => {
	beforeEach(() => {
		resetUpdateCoordinationForTests();
	});

	afterEach(() => {
		resetUpdateCoordinationForTests();
	});

	test("blocks new executions while draining and waits for existing leases", async () => {
		const lease = tryAcquireUpdateExecution("bash", "narrator-1");
		expect(lease).not.toBeNull();

		const scheduled = scheduleUpdate("9.9.9");
		expect(scheduled).toMatchObject({
			phase: "draining",
			scheduled: true,
			targetVersion: "9.9.9",
			pendingExecutionCount: 1,
		});
		expect(tryAcquireUpdateExecution("subagent", "narrator-2")).toBeNull();

		let drained = false;
		const drain = waitForUpdateExecutionDrain().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);

		lease?.release();
		await drain;
		expect(drained).toBe(true);
		expect(getUpdateCoordinationStatus().pendingExecutionCount).toBe(0);
	});

	test("captures active narrator context and subagent leases", () => {
		const unregisterLoop = registerNarratorLoop("narrator-1", "zh-CN", {
			userId: "user-1",
			replyInUserLanguage: true,
		});
		const subagentLease = tryAcquireUpdateExecution("subagent");
		subagentLease?.setNarratorId("subagent-1");

		// A subagent lease acquired before scheduling is part of the recovery snapshot.
		scheduleUpdate("2.0.0");
		const snapshot = capturePlannedUpdateRecoverySnapshot();
		expect(snapshot.targetVersion).toBe("2.0.0");
		expect(snapshot.narrators).toEqual([
			{
				narratorId: "narrator-1",
				locale: "zh-CN",
				userId: "user-1",
				replyInUserLanguage: true,
			},
			{ narratorId: "subagent-1", locale: "en" },
		]);

		unregisterLoop();
		subagentLease?.release();
	});

	test("reading a recovery snapshot does not delete it before recovery succeeds", () => {
		const unregisterLoop = registerNarratorLoop("narrator-1", "en");
		scheduleUpdate("3.0.0");
		writePlannedUpdateRecoverySnapshot();

		expect(consumePlannedUpdateRecoverySnapshot()?.narrators).toEqual([
			{ narratorId: "narrator-1", locale: "en" },
		]);
		expect(consumePlannedUpdateRecoverySnapshot()?.narrators).toEqual([
			{ narratorId: "narrator-1", locale: "en" },
		]);
		unregisterLoop();
	});

	test("repeated scheduling is idempotent and failure returns to idle", () => {
		const first = scheduleUpdate("1.0.0");
		const second = scheduleUpdate("2.0.0");
		expect(second.targetVersion).toBe("1.0.0");
		expect(second.phase).toBe("draining");

		const failed = failScheduledUpdate("spawn failed");
		expect(failed.phase).toBe("idle");
		expect(failed.scheduled).toBe(false);
		expect(failed.error).toBe("spawn failed");
		expect(first.targetVersion).toBe("1.0.0");
	});
});
