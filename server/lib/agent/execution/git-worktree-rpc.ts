import type {
	WorktreeCreateResult,
	WorktreeEntry,
	WorktreePrepareResult,
} from "@shared/narrator-worktrees";

/** Additive, structured capability. Never transports arbitrary Git argv. */
export const FEATURE_GIT_WORKTREE_V1 = "git.worktree.v1";
export interface GitWorktreeRequest {
	operation: "list" | "prepare" | "create" | "status" | "reconcile";
	cwd: string;
	expectedRoot: string;
	expectedRepository: string;
	requestId?: string;
	/** Frozen server proposal digest, independent of connection/runtime generation. */
	requestDigest?: string;
	actorKey?: string;
	branchName?: string;
	branchKind?: "new" | "existing";
	baseRef?: string;
	destinationPath?: string;
	worktreeName?: string;
	maxBytes?: number;
	timeoutMs?: number;
}
export interface GitWorktreeResult {
	entries?: WorktreeEntry[];
	truncated?: boolean;
	prepared?: WorktreePrepareResult;
	result?: WorktreeCreateResult;
}
