import { expect, test } from "bun:test";
import type { PendingSnapshotRestore } from "./snapshot-restore-flow";
import { SnapshotRestoreReceiptStore } from "./snapshot-restore-receipt-store";

function fixture() {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	};
	const snapshot = {
		id: "s".repeat(21),
		deviceId: "origin",
		root: "/original root",
		rootIdentity: "original-object",
		treeDigest: "a".repeat(64),
		sourceInstanceId: "original-source",
		scopeId: "original-scope",
		contextKey: "old-context",
		workspaceRevision: 2,
		originProjectId: null,
		originContextVersion: 1,
		state: "complete",
		edge: "before" as const,
		createdAt: new Date().toISOString(),
		restorableCandidate: true,
	};
	const origin = {
		captureId: snapshot.id,
		deviceId: snapshot.deviceId,
		root: snapshot.root,
		rootIdentity: snapshot.rootIdentity,
		treeDigest: snapshot.treeDigest,
		sourceInstanceId: snapshot.sourceInstanceId,
		scopeId: snapshot.scopeId,
		contextKey: snapshot.contextKey,
		workspaceRevision: 2,
		originProjectId: null,
		originContextVersion: 1 as const,
	};
	const pending: PendingSnapshotRestore = {
		version: 1,
		snapshot,
		origin,
		request: {
			planId: "p".repeat(21),
			planHash: "b".repeat(64),
			confirmation: {
				kind: "snapshot_restore",
				captureId: snapshot.id,
				deviceId: snapshot.deviceId,
				root: snapshot.root,
				rootIdentity: snapshot.rootIdentity,
				treeDigest: snapshot.treeDigest,
			},
		},
	};
	return {
		values,
		storage,
		pending,
		store: new SnapshotRestoreReceiptStore(storage, "actor", "narrator"),
	};
}
test("closing/reopening retains exactly the original plan/source and never shares another actor's pending receipt", () => {
	const f = fixture();
	f.store.save(f.pending);
	expect(new SnapshotRestoreReceiptStore(f.storage, "actor", "narrator").load()).toEqual(f.pending);
	expect(new SnapshotRestoreReceiptStore(f.storage, "other", "narrator").load()).toBeUndefined();
});
test("pending unknown cannot be overwritten or cleared by a different plan/hash", () => {
	const f = fixture();
	f.store.save(f.pending);
	expect(() =>
		f.store.save({ ...f.pending, request: { ...f.pending.request, planId: "other" } }),
	).toThrow("pendingOriginal");
	expect(() => f.store.complete({ ...f.pending.request, planHash: "other" })).toThrow(
		"pendingOriginal",
	);
	expect(f.store.load()).toEqual(f.pending);
});
test("tampered root identity/confirmation is retained as an error rather than being silently rebound", () => {
	const f = fixture();
	f.store.save(f.pending);
	const [key, raw] = [...f.values.entries()][0];
	const broken = JSON.parse(raw);
	broken.request.confirmation.root = "/current-cwd";
	f.values.set(key, JSON.stringify(broken));
	expect(() => f.store.load()).toThrow("receiptUnavailable");
	expect(f.values.has(key)).toBe(true);
});
test("oversized receipts cannot admit new writes and completed original receipts can be removed", () => {
	const f = fixture();
	f.store.save(f.pending);
	f.store.complete(f.pending.request);
	expect(f.store.load()).toBeUndefined();
	expect(() =>
		f.store.save({ ...f.pending, origin: { ...f.pending.origin, root: "x".repeat(40_000) } }),
	).toThrow("receiptUnavailable");
});
