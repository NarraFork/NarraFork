import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	type WorkspaceSnapshotRestoreRequest,
	workspaceSnapshotRestoreApi,
} from "./workspace-snapshot-restores";

const originalFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const requests: Array<{ path: string; init?: RequestInit }> = [];
const input: WorkspaceSnapshotRestoreRequest = {
	planId: "p".repeat(21),
	planHash: "b".repeat(64),
	confirmation: {
		kind: "snapshot_restore",
		captureId: "s".repeat(21),
		deviceId: "original-device",
		root: "D:\\original repo",
		rootIdentity: "original-object",
		treeDigest: "a".repeat(64),
	},
};
beforeEach(() => {
	requests.length = 0;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null },
	});
	globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
		requests.push({ path: String(url), init });
		return Response.json({ planId: input.planId, status: "committed", restoredFileCount: 1 });
	}) as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
	else Reflect.deleteProperty(globalThis, "localStorage");
});
test("actual API submits only original plan hash and exact source-qualified confirmation", async () => {
	await workspaceSnapshotRestoreApi.apply("n", input);
	expect(requests[0]?.path).toEndWith(
		`/narrators/n/workspace-snapshot-restores/${input.planId}/apply`,
	);
	expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
		planHash: input.planHash,
		confirmation: input.confirmation,
	});
});
test("actual structured HTTP409 recovery_required remains an unresolved result, not generic refusal/success", async () => {
	globalThis.fetch = mock(async () =>
		Response.json(
			{
				planId: input.planId,
				status: "recovery_required",
				restoredFileCount: 0,
				reason: "WORKSPACE_SNAPSHOT_RESTORE_UNAVAILABLE",
			},
			{ status: 409 },
		),
	) as unknown as typeof fetch;
	expect(await workspaceSnapshotRestoreApi.apply("n", input)).toMatchObject({
		planId: input.planId,
		status: "recovery_required",
	});
});
test("generic refusal409 stays an error and unknown wrong-plan replies cannot be normalized to success", async () => {
	globalThis.fetch = mock(async () =>
		Response.json(
			{ code: "WORKSPACE_SNAPSHOT_RESTORE_UNAVAILABLE", error: "revalidate source" },
			{ status: 409 },
		),
	) as unknown as typeof fetch;
	await expect(workspaceSnapshotRestoreApi.apply("n", input)).rejects.toMatchObject({
		status: 409,
	});
	globalThis.fetch = mock(async () =>
		Response.json(
			{ planId: "other", status: "recovery_required", restoredFileCount: 0 },
			{ status: 409 },
		),
	) as unknown as typeof fetch;
	await expect(workspaceSnapshotRestoreApi.recover("n", input)).rejects.toThrow(
		"snapshotRestore.resultUnknown",
	);
});
test("catalogue always asks for bounded32 and keeps the cursor opaque", async () => {
	await workspaceSnapshotRestoreApi.list("n", "opaque_cursor-12");
	expect(requests[0]?.path).toEndWith(
		"/narrators/n/workspace-snapshots?limit=32&cursor=opaque_cursor-12",
	);
});
