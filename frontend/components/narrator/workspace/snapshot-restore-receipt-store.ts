import type { WorkspaceSnapshotRestoreRequest } from "../../../lib/api/workspace-snapshot-restores";
import { type PendingSnapshotRestore, snapshotIsCandidate } from "./snapshot-restore-flow";

type ReceiptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const MAX_RECEIPT_CHARS = 32 * 1024;
/** One bounded pending operation per acting-user/narrator; no blobs or path inventories. */
export class SnapshotRestoreReceiptStore {
	private key: string;
	constructor(
		private storage: ReceiptStorage,
		actorId: string,
		narratorId: string,
	) {
		if (!actorId || !narratorId) throw new Error("snapshotRestore.receiptUnavailable");
		this.key = `nf.snapshot-restore.pending:${encodeURIComponent(actorId)}:${encodeURIComponent(narratorId)}`;
	}
	load(): PendingSnapshotRestore | undefined {
		const raw = this.storage.getItem(this.key);
		if (raw === null) return undefined;
		if (raw.length > MAX_RECEIPT_CHARS) throw new Error("snapshotRestore.receiptUnavailable");
		const value = JSON.parse(raw) as PendingSnapshotRestore;
		const snapshot = value.snapshot,
			origin = value.origin,
			request = value.request;
		if (
			value.version !== 1 ||
			!snapshot ||
			!origin ||
			!request ||
			!snapshotIsCandidate(snapshot) ||
			!request.planId ||
			!request.planHash ||
			origin.captureId !== snapshot.id ||
			origin.deviceId !== snapshot.deviceId ||
			origin.root !== snapshot.root ||
			origin.rootIdentity !== snapshot.rootIdentity ||
			origin.treeDigest !== snapshot.treeDigest ||
			origin.sourceInstanceId !== snapshot.sourceInstanceId ||
			origin.scopeId !== snapshot.scopeId ||
			origin.contextKey !== snapshot.contextKey ||
			origin.workspaceRevision !== snapshot.workspaceRevision ||
			origin.originContextVersion !== 1 ||
			origin.originProjectId !== snapshot.originProjectId ||
			request.confirmation.kind !== "snapshot_restore" ||
			request.confirmation.captureId !== origin.captureId ||
			request.confirmation.deviceId !== origin.deviceId ||
			request.confirmation.root !== origin.root ||
			request.confirmation.rootIdentity !== origin.rootIdentity ||
			request.confirmation.treeDigest !== origin.treeDigest
		)
			throw new Error("snapshotRestore.receiptUnavailable");
		return value;
	}
	save(value: PendingSnapshotRestore) {
		const previous = this.load();
		if (
			previous &&
			(previous.request.planId !== value.request.planId ||
				previous.request.planHash !== value.request.planHash)
		)
			throw new Error("snapshotRestore.pendingOriginal");
		const raw = JSON.stringify({
			version: 1,
			snapshot: value.snapshot,
			origin: value.origin,
			request: value.request,
		});
		if (raw.length > MAX_RECEIPT_CHARS) throw new Error("snapshotRestore.receiptUnavailable");
		this.storage.setItem(this.key, raw);
	}
	complete(request: WorkspaceSnapshotRestoreRequest) {
		const previous = this.load();
		if (
			previous &&
			(previous.request.planId !== request.planId || previous.request.planHash !== request.planHash)
		)
			throw new Error("snapshotRestore.pendingOriginal");
		this.storage.removeItem(this.key);
	}
}
