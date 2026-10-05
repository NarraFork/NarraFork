import { describe, expect, test } from "bun:test";
import type { NarratorRestorePreview } from "@shared/narrator-backup";
import {
	canApplyBackupState,
	canExportPrivateBackup,
	parseBackupMapping,
} from "./narrator-backup-policy";

const valid: NarratorRestorePreview = {
	artifactId: "owned",
	profile: "conversation-state-v1",
	narratorIds: ["deleted-session"],
	verifiedSameInstance: true,
	sameInstanceStateRestoreAllowed: true,
	crossInstanceApplySupported: false,
	productionDiskRestoreAllowed: false,
	blockers: [],
	exclusions: ["No production filesystem writes"],
	manualActivationRequired: true,
};

describe("private backup authority and recovery ceiling", () => {
	test("only owner or admin may export; public readers and project writers cannot download", () => {
		const narrator = {
			ownerUserId: "owner",
			visibility: "public",
			writeAudience: "public",
			variant: "primary",
		};
		expect(canExportPrivateBackup({ id: "owner", role: "user" }, narrator)).toBe(true);
		expect(canExportPrivateBackup({ id: "admin", role: "admin" }, narrator)).toBe(true);
		expect(canExportPrivateBackup({ id: "reader", role: "user" }, narrator)).toBe(false);
		expect(canExportPrivateBackup(null, narrator)).toBe(false);
		expect(
			canExportPrivateBackup(
				{ id: "owner", role: "user" },
				{ ...narrator, variant: "subagent:review" },
			),
		).toBe(false);
	});
	test.each([
		"conversation-state-v1",
		"conversation-tree-v1",
	] as const)("%s requires explicit confirmation and never grants disk recovery", (profile) => {
		expect(canApplyBackupState({ ...valid, profile }, false)).toBe(false);
		expect(canApplyBackupState({ ...valid, profile }, true)).toBe(true);
		expect(
			canApplyBackupState(
				{ ...valid, productionDiskRestoreAllowed: true } as unknown as NarratorRestorePreview,
				true,
			),
		).toBe(false);
	});
	test.each([
		"Missing account mapping",
		"Missing device mapping",
		"Missing history image bytes",
		"ID conflict",
		"Active narrator",
	])("any dependency/mapping/conflict blocker refuses rather than skips: %s", (blocker) => {
		expect(canApplyBackupState({ ...valid, blockers: [blocker] }, true)).toBe(false);
	});
	test("no proof, cross-instance, or automatic runtime activation is fail-closed", () => {
		expect(canApplyBackupState({ ...valid, verifiedSameInstance: false }, true)).toBe(false);
		expect(canApplyBackupState({ ...valid, sameInstanceStateRestoreAllowed: false }, true)).toBe(
			false,
		);
		expect(
			canApplyBackupState(
				{ ...valid, crossInstanceApplySupported: true } as unknown as NarratorRestorePreview,
				true,
			),
		).toBe(false);
		expect(
			canApplyBackupState(
				{ ...valid, manualActivationRequired: false } as unknown as NarratorRestorePreview,
				true,
			),
		).toBe(false);
	});
	test("explicit advanced mappings preserve remote paths and never infer identities", () => {
		expect(parseBackupMapping("")).toBeUndefined();
		expect(
			parseBackupMapping('{"devices":{"old":"new"},"paths":{"C:\\\\old":"/remote/new"}}'),
		).toEqual({ devices: { old: "new" }, paths: { "C:\\old": "/remote/new" } });
		for (const invalid of [
			"[]",
			'{"guess":{}}',
			'{"users":{"old":null}}',
			'{"devices":{"old":""}}',
		])
			expect(() => parseBackupMapping(invalid)).toThrow();
	});
});
