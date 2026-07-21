import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toolContinuationService } from "../tool-continuation-service";
import {
	consumePlannedUpdateRecoverySnapshot,
	getUpdateCoordinationStatus,
	resetUpdateCoordinationForTests,
	scheduleUpdate,
	writePlannedUpdateRecoverySnapshot,
} from "../update-coordinator";
import { checkpointPreparedUpdateFence, failPreparedUpdateAttempt } from "../update-service";

const originalCancelEpoch = toolContinuationService.cancelEpoch;

function scheduleWithManifest(targetVersion: string): string {
	const scheduled = scheduleUpdate(targetVersion);
	if (!scheduled.updateEpoch) throw new Error("Expected scheduled update epoch");
	writePlannedUpdateRecoverySnapshot({
		version: 2,
		updateEpoch: scheduled.updateEpoch,
		targetVersion,
		capturedAt: new Date().toISOString(),
		narrators: [],
	});
	return scheduled.updateEpoch;
}

describe("planned update checkpoint fence", () => {
	test("covers a tool row inserted while the checkpoint query is in flight", async () => {
		const activeToolCallIds = ["tool-a"];
		const coveredToolCallIds = new Set<string>();
		let checkpointCalls = 0;
		let activeQueries = 0;
		const snapshot = {
			version: 2 as const,
			updateEpoch: "race-epoch",
			targetVersion: "2.0.0",
			capturedAt: new Date().toISOString(),
			narrators: [],
		};

		const result = await checkpointPreparedUpdateFence(snapshot.updateEpoch, {
			waitForFence: async () => {},
			checkpoint: async () => {
				checkpointCalls++;
				for (const toolCallId of activeToolCallIds) coveredToolCallIds.add(toolCallId);
				return snapshot;
			},
			listActiveToolCallIds: async () => {
				activeQueries++;
				if (activeQueries === 1) activeToolCallIds.push("tool-raced");
				return [...activeToolCallIds];
			},
			listCoveredToolCallIds: async () => [...coveredToolCallIds],
			verifySendAwaitContinuations: async () => ({ stable: true, unstableToolCallIds: [] }),
		});

		expect(result).toBe(snapshot);
		expect(checkpointCalls).toBe(3);
		expect(coveredToolCallIds).toEqual(new Set(["tool-a", "tool-raced"]));
	});

	for (const settlement of ["reply", "timeout", "abort"] as const) {
		test(`rechecks a Send await that settles by ${settlement} after the first checkpoint`, async () => {
			const snapshot = {
				version: 2 as const,
				updateEpoch: `send-${settlement}-epoch`,
				targetVersion: "2.0.0",
				capturedAt: new Date().toISOString(),
				narrators: [],
			};
			let checkpointCalls = 0;
			let verificationCalls = 0;
			let resultWritten = false;

			await checkpointPreparedUpdateFence(snapshot.updateEpoch, {
				waitForFence: async () => {},
				checkpoint: async () => {
					checkpointCalls++;
					return snapshot;
				},
				listActiveToolCallIds: async () => [],
				listCoveredToolCallIds: async () => ["send-tool"],
				verifySendAwaitContinuations: async () => {
					verificationCalls++;
					if (verificationCalls === 1) {
						// The old process settles immediately after its first durable snapshot. The
						// reverse scan must force another round before replacement spawn is allowed.
						resultWritten = true;
						return { stable: false, unstableToolCallIds: ["send-tool"] };
					}
					return { stable: resultWritten, unstableToolCallIds: [] };
				},
			});

			expect(resultWritten).toBe(true);
			expect(checkpointCalls).toBe(3);
			expect(verificationCalls).toBe(3);
		});
	}
});

describe("update service failure cleanup", () => {
	beforeEach(() => {
		resetUpdateCoordinationForTests();
		toolContinuationService.cancelEpoch = originalCancelEpoch;
	});

	afterEach(() => {
		toolContinuationService.cancelEpoch = originalCancelEpoch;
		resetUpdateCoordinationForTests();
	});

	test("cancels the attempt epoch before deleting recovery evidence and opening the gate", async () => {
		const updateEpoch = scheduleWithManifest("2.0.0");
		const events: string[] = [];
		toolContinuationService.cancelEpoch = async (epoch, error) => {
			events.push(`cancel:${epoch}:${error}`);
			expect(consumePlannedUpdateRecoverySnapshot()?.updateEpoch).toBe(updateEpoch);
			expect(getUpdateCoordinationStatus().scheduled).toBe(true);
			return 2;
		};

		await failPreparedUpdateAttempt({
			updateEpoch,
			targetVersion: "2.0.0",
			error: "spawn failed",
		});

		expect(events).toEqual([`cancel:${updateEpoch}:spawn failed`]);
		expect(consumePlannedUpdateRecoverySnapshot()).toBeNull();
		expect(getUpdateCoordinationStatus()).toMatchObject({
			phase: "idle",
			scheduled: false,
			error: "spawn failed",
		});
	});

	test("keeps the gate closed and preserves a manifest when epoch cancellation fails", async () => {
		const scheduled = scheduleUpdate("3.0.0");
		if (!scheduled.updateEpoch) throw new Error("Expected scheduled update epoch");
		toolContinuationService.cancelEpoch = async () => {
			throw new Error("database unavailable");
		};

		await failPreparedUpdateAttempt({
			updateEpoch: scheduled.updateEpoch,
			targetVersion: "3.0.0",
			error: "handoff timed out",
		});

		expect(getUpdateCoordinationStatus()).toMatchObject({
			phase: "draining_background_bash",
			scheduled: true,
			updateEpoch: scheduled.updateEpoch,
		});
		expect(consumePlannedUpdateRecoverySnapshot()).toMatchObject({
			version: 2,
			updateEpoch: scheduled.updateEpoch,
			targetVersion: "3.0.0",
		});
	});

	test("ignores a stale watchdog epoch without cancelling the active attempt", async () => {
		const scheduled = scheduleUpdate("4.0.0");
		let cancelCalls = 0;
		toolContinuationService.cancelEpoch = async () => {
			cancelCalls++;
			return 0;
		};

		await failPreparedUpdateAttempt({
			updateEpoch: "stale-update-epoch",
			targetVersion: "4.0.0",
			error: "old watchdog fired",
		});

		expect(cancelCalls).toBe(0);
		expect(getUpdateCoordinationStatus()).toMatchObject({
			scheduled: true,
			updateEpoch: scheduled.updateEpoch,
		});
	});
});
