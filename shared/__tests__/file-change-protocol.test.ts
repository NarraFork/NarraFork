import { describe, expect, test } from "bun:test";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeEffect,
	type FileChangeState,
	fileChangeStatesEqual,
	hasConfirmedNoFileChange,
	hasSettledMeasuredFileEffect,
	isKnownFileChangeState,
} from "../file-change-protocol";

const before: FileChangeState = {
	kind: "regular",
	blob: { algorithm: "sha256", digest: "a".repeat(64), sizeBytes: 3 },
	mode: 0o644,
};
const after: FileChangeState = {
	kind: "regular",
	blob: { algorithm: "sha256", digest: "b".repeat(64), sizeBytes: 5 },
	mode: 0o644,
};
const unknown: FileChangeState = { kind: "unknown", reason: "missing_after" };

function effect(overrides: Partial<FileChangeEffect> = {}): FileChangeEffect {
	const result: FileChangeEffect = {
		id: "effect",
		operationId: "operation",
		attempt: 1,
		mutationId: "mutation",
		requestDigest: "c".repeat(64),
		phase: "apply",
		identity: {
			sourceInstanceId: "source",
			deviceId: "local",
			workspaceInstanceId: "workspace",
			scopeId: "scope",
			pathFlavor: "posix",
			objectRole: "referent",
			canonicalPath: "/repo/a.txt",
			lexicalPath: "/repo/a.txt",
			displayPath: "a.txt",
		},
		before,
		intendedAfter: after,
		observedAfter: after,
		outcome: "changed",
		settlement: "settled",
		attribution: "measured",
		executionConfirmed: true,
		linesAdded: null,
		linesRemoved: null,
		...overrides,
	};
	if (!Object.hasOwn(overrides, "executionReceipt")) {
		result.executionReceipt = {
			receiptId: "receipt",
			mutationId: result.mutationId,
			requestDigest: result.requestDigest,
			executionBinding: {
				deviceId: result.identity.deviceId,
				runtimeEpoch: "epoch",
				runtimeGeneration: 1,
				fencingToken: 1,
			},
			confirmed: true,
			outcome: "applied",
			observedAfter: result.observedAfter,
		};
	}
	return result;
}

describe("file change state evidence", () => {
	test("unknown is neither absence nor equality evidence", () => {
		expect(isKnownFileChangeState(unknown)).toBe(false);
		expect(fileChangeStatesEqual(unknown, unknown)).toBe(false);
		expect(fileChangeStatesEqual(unknown, { kind: "absent" })).toBe(false);
		expect(fileChangeStatesEqual({ kind: "absent" }, { kind: "absent" })).toBe(true);
	});

	test("an empty regular file is not an absent file", () => {
		expect(
			fileChangeStatesEqual(
				{
					kind: "regular",
					blob: { algorithm: "sha256", digest: "d".repeat(64), sizeBytes: 0 },
					mode: 0o644,
				},
				{ kind: "absent" },
			),
		).toBe(false);
	});

	test("bytes, object type, and mode all participate in equality", () => {
		expect(fileChangeStatesEqual(before, structuredClone(before))).toBe(true);
		expect(fileChangeStatesEqual(before, after)).toBe(false);
		if (before.kind !== "regular") throw new Error("invalid fixture");
		expect(fileChangeStatesEqual(before, { ...before, mode: 0o755 })).toBe(false);
		expect(
			fileChangeStatesEqual(before, { kind: "symlink", target: before.blob, mode: 0o644 }),
		).toBe(false);
		expect(
			fileChangeStatesEqual(before, { ...before, blob: { ...before.blob, sizeBytes: 4 } }),
		).toBe(false);
	});
});

describe("settled measured effects", () => {
	test("requires a settled execution receipt and matching actual after", () => {
		expect(hasSettledMeasuredFileEffect(effect())).toBe(true);
		for (const overrides of [
			{ executionConfirmed: false },
			{ settlement: "applying" },
			{ settlement: "reconcile_required" },
			{ attribution: "observed_ambiguous" },
			{ attribution: "unknown" },
			{ outcome: "pending" },
			{ outcome: "unknown" },
			{ before: unknown },
			{ intendedAfter: unknown },
			{ observedAfter: unknown },
			{ observedAfter: before },
		] satisfies Partial<FileChangeEffect>[]) {
			expect(hasSettledMeasuredFileEffect(effect(overrides))).toBe(false);
		}
	});

	test("matching bytes and an execution flag cannot replace or contradict the actual receipt", () => {
		expect(hasSettledMeasuredFileEffect(effect({ executionReceipt: null }))).toBe(false);
		expect(hasSettledMeasuredFileEffect(effect({ executionReceipt: undefined }))).toBe(false);
		const valid = effect();
		if (!valid.executionReceipt) throw new Error("Missing receipt fixture");
		for (const patch of [
			{ confirmed: false },
			{ mutationId: "other-mutation" },
			{ requestDigest: "d".repeat(64) },
			{ outcome: "not_applied" as const },
			{ outcome: "unknown" as const },
			{ observedAfter: before },
			{ observedAfter: unknown },
			{ executionBinding: { ...valid.executionReceipt.executionBinding, deviceId: "remote" } },
		]) {
			expect(
				hasSettledMeasuredFileEffect({
					...valid,
					executionReceipt: { ...valid.executionReceipt, ...patch },
				}),
			).toBe(false);
		}
	});

	test("rejects mislabeled no-ops instead of silently dropping real effects", () => {
		expect(hasSettledMeasuredFileEffect(effect({ outcome: "no_change" }))).toBe(false);
		expect(
			hasSettledMeasuredFileEffect(effect({ intendedAfter: before, observedAfter: before })),
		).toBe(false);
		expect(
			hasSettledMeasuredFileEffect(
				effect({ outcome: "no_change", intendedAfter: before, observedAfter: before }),
			),
		).toBe(true);
	});

	test("a bound not-applied receipt proves no mutation without claiming the workspace stayed unchanged", () => {
		const rejected = effect({ outcome: "no_change", observedAfter: unknown });
		rejected.executionReceipt = {
			receiptId: "receipt",
			mutationId: rejected.mutationId,
			requestDigest: rejected.requestDigest,
			executionBinding: {
				deviceId: "local",
				runtimeEpoch: "epoch",
				runtimeGeneration: 1,
				fencingToken: 1,
			},
			confirmed: true,
			observedAfter: unknown,
			outcome: "not_applied",
		};
		expect(hasConfirmedNoFileChange(rejected)).toBe(true);
		expect(hasSettledMeasuredFileEffect(rejected)).toBe(false);
		expect(hasConfirmedNoFileChange({ ...rejected, executionReceipt: null })).toBe(false);
		expect(hasConfirmedNoFileChange({ ...rejected, executionConfirmed: false })).toBe(false);
		for (const patch of [
			{ confirmed: false },
			{ mutationId: "another-mutation" },
			{ requestDigest: "d".repeat(64) },
			{ outcome: "unknown" as const },
		]) {
			expect(
				hasConfirmedNoFileChange({
					...rejected,
					executionReceipt: { ...rejected.executionReceipt, ...patch },
				}),
			).toBe(false);
		}
		expect(
			hasConfirmedNoFileChange({
				...rejected,
				executionReceipt: {
					...rejected.executionReceipt,
					executionBinding: { ...rejected.executionReceipt.executionBinding, deviceId: "remote" },
				},
			}),
		).toBe(false);
	});

	test("creation and deletion require known states on both sides", () => {
		expect(hasSettledMeasuredFileEffect(effect({ before: { kind: "absent" } }))).toBe(true);
		expect(
			hasSettledMeasuredFileEffect(
				effect({ intendedAfter: { kind: "absent" }, observedAfter: { kind: "absent" } }),
			),
		).toBe(true);
	});
});

test("file, history, streaming, and retention budgets remain independently bounded", () => {
	expect(Object.isFrozen(FILE_CHANGE_LIMITS)).toBe(true);
	expect(FILE_CHANGE_LIMITS.streamChunkBytes).toBeLessThan(FILE_CHANGE_LIMITS.blobBytes);
	expect(FILE_CHANGE_LIMITS.blobBytes).toBeLessThan(FILE_CHANGE_LIMITS.operationEvidenceBytes);
	expect(FILE_CHANGE_LIMITS.historyMessageRefChanges).toBe(5000);
	expect(FILE_CHANGE_LIMITS.historyCowBytes).toBe(4 * 1024 * 1024);
	expect(FILE_CHANGE_LIMITS.completedRevertRetentionMs).toBeGreaterThan(
		FILE_CHANGE_LIMITS.planLifetimeMs,
	);
});
