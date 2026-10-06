import { afterEach, expect, test } from "bun:test";
import { permissionPolicyChanges } from "../../permission-rule-service";
import {
	flushExecutionPolicyChangeQueue,
	registerExecutionPolicyPendingReprocessor,
} from "../events";

afterEach(async () => {
	registerExecutionPolicyPendingReprocessor(() => undefined);
	await flushExecutionPolicyChangeQueue();
});

test("policy changes coalesce affected narrator pending reprocessing", async () => {
	const reprocessed: string[] = [];
	registerExecutionPolicyPendingReprocessor((narratorId) => {
		reprocessed.push(narratorId);
		return undefined;
	});

	const changedAt = "2026-07-22T00:00:00.000Z";
	permissionPolicyChanges.emit({
		type: "permission:policy_changed",
		narratorId: "narrator-a",
		ruleType: "directoryWhitelist",
		ruleId: "rule-a",
		change: "updated",
		changedAt,
	});
	permissionPolicyChanges.emit({
		type: "permission:policy_changed",
		narratorId: "narrator-a",
		ruleType: "directoryBlacklist",
		ruleId: "rule-b",
		change: "deleted",
		changedAt,
	});
	permissionPolicyChanges.emit({
		type: "permission:policy_changed",
		narratorId: "narrator-b",
		ruleType: "commandWhitelist",
		ruleId: "rule-c",
		change: "created",
		changedAt,
	});

	await flushExecutionPolicyChangeQueue();
	expect(reprocessed).toEqual(["narrator-a", "narrator-b"]);
});
