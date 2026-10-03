import { sha256 } from "@noble/hashes/sha2.js";
import type { WorktreeCreateRequest } from "@shared/narrator-worktrees";

export interface ReceiptScope {
	userId: string;
	narratorId: string;
	deviceId: string;
	repositoryKey: string;
}
export interface PendingReceipt {
	scope: ReceiptScope;
	request: WorktreeCreateRequest;
	/** SHA-256 of the submitted draft, never its requirement text. */
	fingerprint: string;
	phase: "dispatched";
	createdAt: number;
}
export const RECEIPT_KEY = "narrafork.worktree-receipts.v1";
export const RECEIPT_MAX_BYTES = 64 * 1024;
export const RECEIPT_MAX_COUNT = 32;
export const RECEIPT_SCOPE_LIMIT = 8;
export const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const identity = (scope: ReceiptScope) =>
	JSON.stringify([scope.userId, scope.narratorId, scope.deviceId, scope.repositoryKey]);

/** No eviction of unresolved operations: overflow/expiry closes creation, not recovery. */
export class WorktreeReceiptStore {
	constructor(
		private storage: Pick<Storage, "getItem" | "setItem">,
		private now = Date.now,
	) {}
	private read(): PendingReceipt[] {
		const raw = this.storage.getItem(RECEIPT_KEY) ?? "[]";
		if (bytes(raw) > RECEIPT_MAX_BYTES) throw new Error("worktree.receiptStorage");
		const records: PendingReceipt[] = JSON.parse(raw);
		if (
			!Array.isArray(records) ||
			records.length > RECEIPT_MAX_COUNT ||
			records.some(
				(r) =>
					!r.scope?.userId ||
					!r.scope?.narratorId ||
					!r.scope?.deviceId ||
					!r.scope?.repositoryKey ||
					!r.request?.requestId ||
					!r.request?.workspaceKey ||
					!r.request?.destinationPath ||
					!r.request?.branch?.name ||
					r.phase !== "dispatched" ||
					!Number.isFinite(r.createdAt) ||
					!Number.isFinite(r.request.expectedRevision) ||
					!/^[a-f0-9]{64}$/.test(r.fingerprint),
			)
		)
			throw new Error("worktree.receiptStorage");
		return records;
	}
	list(scope: ReceiptScope) {
		return this.read().filter((r) => identity(r.scope) === identity(scope));
	}
	put(scope: ReceiptScope, request: WorktreeCreateRequest, fingerprint: string) {
		try {
			const records = this.read();
			const own = records.filter((r) => identity(r.scope) === identity(scope));
			if (own.some((r) => r.createdAt + RECEIPT_TTL_MS <= this.now()))
				throw new Error("worktree.receiptExpired");
			if (own.some((r) => r.fingerprint === fingerprint)) throw new Error("worktree.pendingNotice");
			if (records.length >= RECEIPT_MAX_COUNT || own.length >= RECEIPT_SCOPE_LIMIT)
				throw new Error("worktree.pendingLimit");
			// Explicit projection: extra runtime fields must never persist prompt bodies.
			const proposal: WorktreeCreateRequest = {
				requestId: request.requestId,
				expectedRevision: request.expectedRevision,
				workspaceKey: request.workspaceKey,
				destinationPath: request.destinationPath,
				branch: { kind: request.branch.kind, name: request.branch.name },
				...(request.baseRef !== undefined ? { baseRef: request.baseRef } : {}),
			};
			records.push({
				scope: {
					userId: scope.userId,
					narratorId: scope.narratorId,
					deviceId: scope.deviceId,
					repositoryKey: scope.repositoryKey,
				},
				request: proposal,
				fingerprint,
				phase: "dispatched",
				createdAt: this.now(),
			});
			const raw = JSON.stringify(records);
			if (bytes(raw) > RECEIPT_MAX_BYTES) throw new Error("worktree.pendingLimit");
			this.storage.setItem(RECEIPT_KEY, raw);
			if (this.storage.getItem(RECEIPT_KEY) !== raw) throw new Error("worktree.receiptStorage");
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("worktree.")) throw error;
			throw new Error("worktree.receiptStorage");
		}
	}
	remove(scope: ReceiptScope, requestId: string) {
		const records = this.read().filter(
			(r) => !(identity(r.scope) === identity(scope) && r.request.requestId === requestId),
		);
		const raw = JSON.stringify(records);
		this.storage.setItem(RECEIPT_KEY, raw);
		if (this.storage.getItem(RECEIPT_KEY) !== raw) throw new Error("worktree.receiptStorage");
	}
}

export async function draftFingerprint(draft: object): Promise<string> {
	const normalized = Object.fromEntries(
		Object.entries(draft)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => [key, typeof value === "string" ? value.trim() : value]),
	);
	// WebCrypto.subtle is absent on non-localhost plaintext HTTP deployments.
	// Use the project's browser-safe SHA-256 without requiring a secure context.
	const hash = sha256(new TextEncoder().encode(JSON.stringify(normalized)));
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
