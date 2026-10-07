import { ApiError, request } from "./client";

/** Catalogue metadata only. Candidate does not mean an authorized/fresh restore plan. */
export interface WorkspaceSnapshotSummary {
	id: string;
	deviceId: string;
	root: string | null;
	rootIdentity: string | null;
	treeDigest: string | null;
	sourceInstanceId: string | null;
	scopeId: string;
	contextKey: string | null;
	workspaceRevision: number | null;
	originProjectId: string | null;
	originContextVersion: number | null;
	state: string;
	edge: "before" | "after";
	createdAt: string;
	restorableCandidate: boolean;
	reason?: string;
}
export interface WorkspaceSnapshotPage {
	items: WorkspaceSnapshotSummary[];
	nextCursor?: string | null;
}
export interface WorkspaceSnapshotRestoreConfirmation {
	kind: "snapshot_restore";
	captureId: string;
	deviceId: string;
	root: string;
	rootIdentity: string;
	treeDigest: string;
}
export interface WorkspaceSnapshotRestorePreview {
	plan: {
		id: string;
		status: string;
		planHash: string | null;
		coverageComplete: boolean;
		expiresAt: string;
	};
	origin: {
		captureId: string;
		deviceId: string;
		root: string;
		rootIdentity: string;
		treeDigest: string;
		sourceInstanceId: string;
		scopeId: string;
		contextKey: string;
		workspaceRevision: number;
		originProjectId: string | null;
		originContextVersion: 1;
	};
	confirmation: WorkspaceSnapshotRestoreConfirmation;
	requiresExplicitSnapshotRestore: true;
	files: Array<{ deviceId: string; path: string; willBeDeleted: boolean }>;
	totalFileCount: number;
	hasMore: boolean;
}
export interface WorkspaceSnapshotRestoreRequest {
	planId: string;
	planHash: string;
	confirmation: WorkspaceSnapshotRestoreConfirmation;
}
export interface WorkspaceSnapshotRestoreResult {
	planId: string;
	status: "committed" | "compensated" | "recovery_required";
	reason?: string;
	restoredFileCount: number;
	nativeOperationId?: string;
}
const base = (id: string) => `/narrators/${encodeURIComponent(id)}`;
async function mutation(
	id: string,
	input: WorkspaceSnapshotRestoreRequest,
	phase: "apply" | "recover",
) {
	try {
		return await request<WorkspaceSnapshotRestoreResult>(
			`${base(id)}/workspace-snapshot-restores/${encodeURIComponent(input.planId)}/${phase}`,
			{
				method: "POST",
				body: JSON.stringify({ planHash: input.planHash, confirmation: input.confirmation }),
				maxResponseBytes: 64 * 1024,
			},
		);
	} catch (error) {
		// The actual route returns recovery_required with HTTP 409, not success.
		if (
			error instanceof ApiError &&
			error.status === 409 &&
			error.data?.status === "recovery_required"
		) {
			if (
				error.data.planId !== input.planId ||
				!Number.isSafeInteger(error.data.restoredFileCount) ||
				Number(error.data.restoredFileCount) < 0
			)
				throw new Error("snapshotRestore.resultUnknown");
			return error.data as unknown as WorkspaceSnapshotRestoreResult;
		}
		throw error;
	}
}
export const workspaceSnapshotRestoreApi = {
	list: (id: string, cursor?: string, signal?: AbortSignal) => {
		const query = new URLSearchParams({ limit: "32" });
		if (cursor) query.set("cursor", cursor);
		return request<WorkspaceSnapshotPage>(`${base(id)}/workspace-snapshots?${query}`, {
			signal,
			maxResponseBytes: 1024 * 1024,
		});
	},
	preview: (
		id: string,
		input: { captureId: string; idempotencyKey: string },
		signal?: AbortSignal,
	) =>
		request<WorkspaceSnapshotRestorePreview>(`${base(id)}/workspace-snapshot-restores/preview`, {
			method: "POST",
			body: JSON.stringify(input),
			signal,
			maxResponseBytes: 1024 * 1024,
		}),
	apply: (id: string, input: WorkspaceSnapshotRestoreRequest) => mutation(id, input, "apply"),
	recover: (id: string, input: WorkspaceSnapshotRestoreRequest) => mutation(id, input, "recover"),
};
