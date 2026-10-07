import { expect, mock, test } from "bun:test";
import type {
	WorkspaceSnapshotRestorePreview,
	WorkspaceSnapshotRestoreRequest,
	WorkspaceSnapshotRestoreResult,
	WorkspaceSnapshotSummary,
} from "../../../lib/api/workspace-snapshot-restores";
import { SnapshotRestoreFlow } from "./snapshot-restore-flow";

export const snapshot: WorkspaceSnapshotSummary = {
	id: "s".repeat(21),
	deviceId: "origin-device",
	root: "D:\\original repo",
	rootIdentity: "original-object",
	treeDigest: "a".repeat(64),
	sourceInstanceId: "original-executor",
	scopeId: "original-scope",
	contextKey: "original-context",
	workspaceRevision: 5,
	originProjectId: null,
	originContextVersion: 1,
	state: "complete",
	edge: "before",
	createdAt: new Date().toISOString(),
	restorableCandidate: true,
};
function previewValue(): WorkspaceSnapshotRestorePreview {
	return {
		plan: {
			id: "p".repeat(21),
			status: "prepared",
			planHash: "b".repeat(64),
			coverageComplete: true,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
		origin: {
			captureId: snapshot.id,
			deviceId: snapshot.deviceId,
			root: snapshot.root as string,
			rootIdentity: snapshot.rootIdentity as string,
			treeDigest: snapshot.treeDigest as string,
			sourceInstanceId: snapshot.sourceInstanceId as string,
			scopeId: snapshot.scopeId,
			contextKey: snapshot.contextKey as string,
			workspaceRevision: 5,
			originProjectId: null,
			originContextVersion: 1,
		},
		confirmation: {
			kind: "snapshot_restore",
			captureId: snapshot.id,
			deviceId: snapshot.deviceId,
			root: snapshot.root as string,
			rootIdentity: snapshot.rootIdentity as string,
			treeDigest: snapshot.treeDigest as string,
		},
		requiresExplicitSnapshotRestore: true,
		files: [
			{ deviceId: snapshot.deviceId, path: "D:\\original repo\\changed.txt", willBeDeleted: false },
		],
		totalFileCount: 101,
		hasMore: true,
	};
}
function setup() {
	let scope: string | null = "view-current:12",
		now = Date.now(),
		counter = 0;
	const preview = mock(
		async (_input: { captureId: string; idempotencyKey: string }, _signal: AbortSignal) =>
			previewValue(),
	);
	const apply = mock(
		async (input: WorkspaceSnapshotRestoreRequest): Promise<WorkspaceSnapshotRestoreResult> => ({
			planId: input.planId,
			status: "committed",
			restoredFileCount: 101,
		}),
	);
	const recover = mock(
		async (input: WorkspaceSnapshotRestoreRequest): Promise<WorkspaceSnapshotRestoreResult> => ({
			planId: input.planId,
			status: "committed",
			restoredFileCount: 101,
		}),
	);
	const save = mock((_value: unknown) => {}),
		complete = mock((_request: WorkspaceSnapshotRestoreRequest) => {});
	const ports = {
		scope: () => scope,
		now: () => now,
		requestId: () => `request_${++counter}`,
		preview,
		apply,
		recover,
		save,
		complete,
	};
	const flow = new SnapshotRestoreFlow(ports);
	flow.select(snapshot);
	return {
		flow,
		ports,
		preview,
		apply,
		recover,
		save,
		complete,
		setScope: (value: string | null) => {
			scope = value;
		},
		setNow: (value: number) => {
			now = value;
		},
	};
}
test("source-qualified preview never grants consent and sends the exact original root confirmation only after checkbox", async () => {
	const s = setup();
	s.flow.setConsent(true);
	await s.flow.preview();
	expect(s.flow.state.consent).toBe(false);
	await s.flow.apply();
	expect(s.apply).not.toHaveBeenCalled();
	s.flow.setConsent(true);
	await s.flow.apply();
	expect(s.apply.mock.calls[0]?.[0]).toEqual({
		planId: "p".repeat(21),
		planHash: "b".repeat(64),
		confirmation: previewValue().confirmation,
	});
	expect(s.save).toHaveBeenCalledTimes(1);
	expect(s.flow.state.step).toBe("finished");
});
test.each([
	"root",
	"rootIdentity",
	"treeDigest",
	"sourceInstanceId",
	"scopeId",
	"contextKey",
])("changed preview origin %s rejects the plan instead of using current cwd", async (field) => {
	const s = setup();
	s.preview.mockImplementation(async () => {
		const value = previewValue();
		Object.assign(value.origin, { [field]: "wrong-current-or-source" });
		return value;
	});
	await s.flow.preview();
	s.flow.setConsent(true);
	await s.flow.apply();
	expect(s.flow.state.preview).toBeUndefined();
	expect(s.apply).not.toHaveBeenCalled();
});
test("late preview after context change is rejected and A→B→A cannot revive its consent", async () => {
	const s = setup();
	let release: ((value: WorkspaceSnapshotRestorePreview) => void) | undefined;
	s.preview.mockImplementation(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const reading = s.flow.preview();
	s.setScope("view-B:13");
	s.flow.observeScope();
	release?.(previewValue());
	await reading;
	expect(s.flow.state.step).toBe("stale");
	expect(s.flow.canApply()).toBe(false);
	s.preview.mockImplementation(async () => previewValue());
	s.setScope("view-A:14");
	await s.flow.preview();
	expect(s.flow.state.consent).toBe(false);
});
test("a changed plan hash cannot inherit an earlier checkbox and expired plans cannot apply", async () => {
	const s = setup();
	await s.flow.preview();
	s.flow.setConsent(true);
	if (!s.flow.state.preview) throw new Error("missing plan");
	s.flow.state.preview.plan.planHash = "c".repeat(64);
	await s.flow.apply();
	expect(s.apply).not.toHaveBeenCalled();
	s.flow.setConsent(true);
	s.setNow(Date.now() + 120_000);
	s.flow.observeScope();
	expect(s.flow.state.consent).toBe(false);
	expect(s.flow.state.step).toBe("stale");
	await s.flow.apply();
	expect(s.apply).not.toHaveBeenCalled();
});
test("generic fresh-apply 409 clears consent and requires new preview/idempotency key", async () => {
	const s = setup();
	s.apply.mockRejectedValue(
		Object.assign(new Error("fixed plan hash changed"), {
			status: 409,
			data: { code: "REVERT_JOURNAL_REQUEST_CONFLICT" },
		}),
	);
	await s.flow.preview();
	const old = s.preview.mock.calls[0]?.[0].idempotencyKey;
	s.flow.setConsent(true);
	await s.flow.apply();
	expect(s.flow.state.step).toBe("stale");
	expect(s.flow.state.consent).toBe(false);
	expect(s.flow.state.pending).toBeUndefined();
	await s.flow.preview();
	expect(s.preview.mock.calls[1]?.[0].idempotencyKey).not.toBe(old);
	expect(s.flow.canApply()).toBe(false);
});
test("double-click and in-flight cancel cannot dispatch twice; lost reply retains original for recovery", async () => {
	const s = setup();
	let reject: ((error: Error) => void) | undefined;
	s.apply.mockImplementation(
		() =>
			new Promise((_resolve, fail) => {
				reject = fail;
			}),
	);
	await s.flow.preview();
	s.flow.setConsent(true);
	const applying = s.flow.apply();
	await s.flow.apply();
	expect(s.apply).toHaveBeenCalledTimes(1);
	expect(s.flow.cancel()).toBe(false);
	reject?.(new Error("network disconnected"));
	await applying;
	expect(s.flow.state.step).toBe("recovery");
	const pending = s.flow.state.pending;
	if (!pending) throw new Error("original lost");
	expect(s.flow.cancel()).toBe(true);
	expect(s.flow.state.pending).toEqual(pending);
	s.setScope("new-device:new-root:99");
	s.flow.observeScope();
	await s.flow.recover();
	expect(s.recover).not.toHaveBeenCalled();
	s.flow.setConsent(true);
	await s.flow.recover();
	expect(s.recover).toHaveBeenCalledWith(pending.request);
	expect(s.apply).toHaveBeenCalledTimes(1);
});
test("recovery_required is never success and recover rejection retains original receipt/root/hash", async () => {
	const s = setup();
	s.apply.mockImplementation(async (input) => ({
		planId: input.planId,
		status: "recovery_required",
		restoredFileCount: 0,
		reason: "source must be revalidated",
	}));
	await s.flow.preview();
	s.flow.setConsent(true);
	await s.flow.apply();
	expect(s.flow.state.step).toBe("recovery");
	expect(s.complete).not.toHaveBeenCalled();
	const original = s.flow.state.pending;
	s.recover.mockRejectedValue(Object.assign(new Error("source/root changed"), { status: 409 }));
	s.flow.setConsent(true);
	await s.flow.recover();
	expect(s.flow.state.pending).toEqual(original);
	expect(s.flow.state.consent).toBe(false);
});
test.each([
	401, 403, 404, 409, 500,
])("unproven HTTP%s after possible dispatch retains the original and cannot start a fresh restore", async (status) => {
	const s = setup();
	s.apply.mockRejectedValue(
		Object.assign(new Error("outcome unknown"), {
			status,
			data: { code: "WORKSPACE_SNAPSHOT_RESTORE_OUTCOME_UNKNOWN" },
		}),
	);
	await s.flow.preview();
	s.flow.setConsent(true);
	await s.flow.apply();
	expect(s.flow.state.step).toBe("recovery");
	expect(s.flow.state.pending).toBeDefined();
	expect(s.complete).not.toHaveBeenCalled();
	await s.flow.preview();
	expect(s.preview).toHaveBeenCalledTimes(1);
});
test("cancelled preview is aborted and no late result or consent is installed", async () => {
	const s = setup();
	let release: ((value: WorkspaceSnapshotRestorePreview) => void) | undefined;
	s.preview.mockImplementation(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const reading = s.flow.preview();
	expect(s.flow.cancel()).toBe(true);
	expect(s.preview.mock.calls[0]?.[1].aborted).toBe(true);
	release?.(previewValue());
	await reading;
	expect(s.flow.state.preview).toBeUndefined();
	expect(s.apply).not.toHaveBeenCalled();
});
test.each([null, 0])("legacy provenance version %s cannot preview or consent", async (version) => {
	const s = setup();
	s.flow.select({ ...snapshot, originContextVersion: version });
	await s.flow.preview();
	s.flow.setConsent(true);
	expect(s.preview).not.toHaveBeenCalled();
	expect(s.flow.canApply()).toBe(false);
});
test("receipt write failure fails closed before any destructive HTTP dispatch", async () => {
	const s = setup();
	s.save.mockImplementation(() => {
		throw new Error("storage blocked");
	});
	await s.flow.preview();
	s.flow.setConsent(true);
	await s.flow.apply();
	expect(s.apply).not.toHaveBeenCalled();
	expect(s.flow.state.consent).toBe(false);
});
