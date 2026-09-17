import type { ExecutionBackend } from "../lib/agent/execution/backend";
import {
	GIT_WORKSPACE_AI_DIFF_BYTES,
	GIT_WORKSPACE_MAX_BYTES,
	GIT_WORKSPACE_TIMEOUT_MS,
	GIT_WORKSPACE_WRITE_TIMEOUT_MS,
	type GitWorkspaceOperation,
	type GitWorkspaceRequest,
	type GitWorkspaceResult,
} from "../lib/agent/execution/git-workspace-rpc";
import { GitError } from "../lib/errors";
import type { GitCommitIdentity, GitStatusFile, GitStatusSummary } from "./git-service";

const WRITES = new Set<GitWorkspaceOperation>([
	"stage",
	"unstage",
	"commit",
	"discard",
	"stashPush",
	"stashPop",
	"stashDrop",
	"reset",
]);

export function supportsRemoteGitWorkspace(backend: ExecutionBackend): boolean {
	return (
		backend.kind === "remote" && backend.supportsGitWorkspace === true && !!backend.gitWorkspace
	);
}

type LineStats = { added: number; removed: number };
function numstat(raw: string): Map<string, LineStats> {
	const result = new Map<string, LineStats>();
	const records = raw.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		const first = record.indexOf("\t");
		const second = record.indexOf("\t", first + 1);
		if (first < 0 || second < 0) continue;
		let path = record.slice(second + 1);
		if (!path) {
			i++;
			path = records[++i] ?? "";
		}
		if (!path) continue;
		result.set(path, {
			added: Number.parseInt(record.slice(0, first), 10) || 0,
			removed: Number.parseInt(record.slice(first + 1, second), 10) || 0,
		});
	}
	return result;
}

/** Same status contract as local Git. NUL delimiters preserve tabs/newlines/renames. */
export function parseRemoteGitStatus(
	result: GitWorkspaceResult,
): GitStatusSummary & { truncated: boolean } {
	const outputs = result.outputs ?? {};
	const truncated = result.truncated ?? false;
	const stagedStats = numstat(outputs.stagedNumstat ?? "");
	const unstagedStats = numstat(outputs.unstagedNumstat ?? "");
	for (const [path, stats] of numstat(outputs.untrackedNumstat ?? ""))
		unstagedStats.set(path, stats);
	const records = (outputs.status ?? "").split("\0");
	const files: GitStatusFile[] = [];
	let staged = 0,
		unstaged = 0,
		untracked = 0,
		totalFiles = 0;
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		if (record.length < 4) continue;
		const status = record.slice(0, 2);
		const path = record.slice(3);
		const renamed = /[RC]/.test(status);
		const oldPath = renamed ? records[++i] : undefined;
		// A capped porcelain stream can end after the first half of a rename.
		// Exclude that incomplete logical entry; `truncated` still makes every
		// reported count a lower bound and prevents a false clean status.
		if (renamed && !oldPath && truncated) continue;
		if (status === "??") untracked++;
		else {
			if (status[0] !== " " && status[0] !== "?") staged++;
			if (status[1] !== " " && status[1] !== "?") unstaged++;
		}
		totalFiles++;
		if (files.length >= 200) continue;
		const s = stagedStats.get(path) ?? { added: 0, removed: 0 };
		const u = unstagedStats.get(path) ?? { added: 0, removed: 0 };
		files.push({
			status,
			path,
			...(oldPath ? { oldPath } : {}),
			linesAdded: s.added + u.added,
			linesRemoved: s.removed + u.removed,
			stagedLinesAdded: s.added,
			stagedLinesRemoved: s.removed,
			unstagedLinesAdded: u.added,
			unstagedLinesRemoved: u.removed,
		});
	}
	let linesAdded = 0,
		linesRemoved = 0;
	for (const stats of [...stagedStats.values(), ...unstagedStats.values()]) {
		linesAdded += stats.added;
		linesRemoved += stats.removed;
	}
	return {
		// A zero-record truncated prefix is unknown, never proof of a clean tree.
		hasChanges: totalFiles > 0 || truncated,
		staged,
		unstaged,
		untracked,
		files,
		totalFiles,
		headSha: (outputs.head ?? "").trim(),
		branch: (outputs.branch ?? "").trim(),
		linesAdded,
		linesRemoved,
		truncated,
	};
}

/**
 * Caller must authorize narrator + project + device + canonical root on EVERY
 * request before constructing this adapter. No cache, local fallback, or retry.
 * The backend is pinned to its authenticated transport generation; the executor
 * independently verifies expectedRoot and its operator-owned path policy.
 */
export function createRemoteGitService(
	backend: ExecutionBackend,
	options?: AbortSignal | { signal?: AbortSignal },
	beforeWrite?: () => Promise<void>,
) {
	const signal = options instanceof AbortSignal ? options : options?.signal;
	async function request(
		cwd: string,
		operation: GitWorkspaceOperation,
		args: Partial<GitWorkspaceRequest> = {},
		overrideSignal = signal,
	): Promise<GitWorkspaceResult> {
		if (!supportsRemoteGitWorkspace(backend) || !backend.gitWorkspace) {
			throw new GitError("Remote executor lacks git.workspace.v1; upgrade the device executor");
		}
		const write = WRITES.has(operation);
		// Keep authorization errors intact and run the live policy check directly
		// before dispatch (not once at adapter construction or workspace probing).
		if (write) await beforeWrite?.();
		try {
			return await backend.gitWorkspace(
				{
					cwd,
					expectedRoot: operation === "probe" ? undefined : cwd,
					operation,
					timeoutMs: write ? GIT_WORKSPACE_WRITE_TIMEOUT_MS : GIT_WORKSPACE_TIMEOUT_MS,
					maxBytes: GIT_WORKSPACE_MAX_BYTES,
					...args,
				},
				overrideSignal,
			);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (write)
				throw new GitError(
					`${detail}. Remote Git write result may be uncertain; refresh status/history before retrying.`,
				);
			throw error;
		}
	}
	async function mutate(
		cwd: string,
		operation: GitWorkspaceOperation,
		args: Partial<GitWorkspaceRequest> = {},
	) {
		await request(cwd, operation, args);
	}
	return {
		probe: (cwd: string, probeSignal?: AbortSignal) =>
			request(cwd, "probe", {}, probeSignal ?? signal),
		async getStatusSummary(cwd: string) {
			return parseRemoteGitStatus(await request(cwd, "status"));
		},
		async getFileDiff(cwd: string, path: string, staged = false, maxBytes = 200_000) {
			const result = await request(cwd, "diff", { files: [path], staged, maxBytes });
			return { diff: result.stdout ?? "", truncated: result.truncated ?? false };
		},
		async getFullDiff(cwd: string, maxBytes = GIT_WORKSPACE_AI_DIFF_BYTES) {
			const result = await request(cwd, "fullDiff", { maxBytes });
			return `${result.stdout ?? ""}${result.truncated ? "\n[diff truncated]" : ""}`;
		},
		stageFiles: (cwd: string, files: string[]) => mutate(cwd, "stage", { files }),
		stageAll: (cwd: string) => mutate(cwd, "stage", { all: true }),
		unstageFiles: (cwd: string, files: string[]) => mutate(cwd, "unstage", { files }),
		unstageAll: (cwd: string) => mutate(cwd, "unstage", { all: true }),
		async commit(cwd: string, message: string, identity?: GitCommitIdentity) {
			const result = await request(cwd, "commit", { message, identity: identity ?? undefined });
			return (result.stdout ?? "").trim();
		},
		discardFiles: (cwd: string, files: string[]) => mutate(cwd, "discard", { files }),
		discardAll: (cwd: string) => mutate(cwd, "discard", { all: true }),
		async getLog(cwd: string, opts: { limit?: number; skip?: number; branch?: string } = {}) {
			const result = await request(cwd, "log", opts);
			if (result.truncated)
				throw new GitError("Remote Git history exceeds output limit; reduce the page size");
			return (result.stdout ?? "")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [sha = "", shortSha = "", message = "", author = "", date = ""] = line.split("\0");
					return { sha, shortSha, message, author, date };
				});
		},
		stash: (cwd: string, message?: string, identity?: GitCommitIdentity) =>
			mutate(cwd, "stashPush", { message, identity: identity ?? undefined }),
		async stashList(cwd: string) {
			const result = await request(cwd, "stashList");
			if (result.truncated) throw new GitError("Remote stash list exceeds output limit");
			return (result.stdout ?? "")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [ref = "", message = "", date = ""] = line.split("\0");
					return { index: Number.parseInt(ref.replace("stash@{", ""), 10), message, date };
				});
		},
		async stashPop(cwd: string) {
			return { hasConflicts: (await request(cwd, "stashPop")).hasConflicts ?? false };
		},
		stashDrop: (cwd: string, index: number) => mutate(cwd, "stashDrop", { index }),
		resetSoft: (cwd: string, target: string) => mutate(cwd, "reset", { mode: "soft", target }),
		resetHard: (cwd: string, target: string) => mutate(cwd, "reset", { mode: "hard", target }),
	};
}

export type RemoteGitService = ReturnType<typeof createRemoteGitService>;
