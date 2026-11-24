import { GEN_UI_TOOL_NAME, isGenUiReadAction } from "@shared/gen-ui-tool-policy";
import type { BashAnalysis } from "../lib/agent/bash-analyze";
import type { GitStatusSummary } from "./git-service";

export type GitToolRefreshIntent = "none" | "write" | "git-write";

/** Intent, not exit status: a failed command may already have written part of its output. */
export async function classifyGitToolRefresh(
	toolName: string,
	input: Record<string, unknown> | undefined,
	analyze: (command: string) => Promise<Pick<BashAnalysis, "allReadOnly" | "commands">>,
): Promise<GitToolRefreshIntent> {
	if (typeof input?.device === "string" && input.device !== "local") return "none";
	if (toolName === "Bash") {
		if (typeof input?.command !== "string" || !input.command) return "write";
		try {
			const analysis = await analyze(input.command);
			if (analysis.allReadOnly) return "none";
			return analysis.commands.some(({ tokens }) => tokens[0] === "git") ? "git-write" : "write";
		} catch {
			// Unknown shell syntax or an unavailable parser is never proof of a read.
			return "write";
		}
	}
	if (toolName === GEN_UI_TOOL_NAME) return isGenUiReadAction(input?.action) ? "none" : "write";
	if (toolName === "StructSed" && input?.dry_run !== false) return "none";
	if (toolName !== "Write" && toolName !== "Edit" && toolName !== "StructSed") return "none";
	if (typeof input?.file_path === "string" && input.file_path.startsWith("spec://")) return "none";
	return "write";
}

/** Exactly the bounded fields sent to the narrator header; file lists belong to workspace watch. */
function summaryIdentity(status: GitStatusSummary): string {
	return JSON.stringify([
		status.hasChanges,
		status.staged,
		status.unstaged,
		status.untracked,
		status.totalFiles,
		status.totalFilesExact,
		status.headSha,
		status.branch,
		status.truncated,
		status.linesAdded,
		status.linesRemoved,
	]);
}

type PendingRefresh = { path: string; toolUseId: string; delayMs: number };
interface RefreshDependencies {
	state: { _gitTrackTimer?: ReturnType<typeof setTimeout> };
	markDirty(path: string): void;
	peek(path: string): GitStatusSummary | null;
	read(path: string): Promise<GitStatusSummary>;
	hasReaders(): boolean;
	isCurrent(path: string): boolean;
	publish(status: GitStatusSummary, toolUseId: string): void;
	onError(error: unknown): void;
}

/** One delayed read and at most one pending successor, even while a read is in flight. */
export class GitToolRefreshQueue {
	private pending?: PendingRefresh;
	private running = false;
	private identity?: string;
	private identityPath?: string;
	private scheduledDelay?: number;

	constructor(private readonly deps: RefreshDependencies) {}

	track(intent: GitToolRefreshIntent, path: string, toolUseId: string): void {
		if (intent === "none" || !this.deps.isCurrent(path)) return;
		if (this.identityPath !== path) {
			this.identityPath = path;
			const cached = this.deps.peek(path);
			this.identity = cached ? summaryIdentity(cached) : undefined;
		}
		// Cache freshness is independent of demand. This does not evict page snapshots
		// or announce an unverified workspace change; watch owns that observation.
		this.deps.markDirty(path);
		if (!this.deps.hasReaders()) return;
		const delayMs = intent === "git-write" ? 100 : 800;
		this.pending = { path, toolUseId, delayMs };
		if (this.deps.state._gitTrackTimer && delayMs < (this.scheduledDelay ?? 800)) {
			clearTimeout(this.deps.state._gitTrackTimer);
			this.deps.state._gitTrackTimer = undefined;
		}
		this.schedule();
	}

	private schedule(): void {
		if (
			this.running ||
			this.deps.state._gitTrackTimer ||
			!this.pending ||
			!this.deps.hasReaders() ||
			!this.deps.isCurrent(this.pending.path)
		)
			return;
		this.scheduledDelay = this.pending.delayMs;
		this.deps.state._gitTrackTimer = setTimeout(() => {
			this.deps.state._gitTrackTimer = undefined;
			void this.refresh();
		}, this.pending.delayMs);
		this.deps.state._gitTrackTimer.unref?.();
	}

	private async refresh(): Promise<void> {
		const pending = this.pending;
		this.pending = undefined;
		if (!pending || !this.deps.hasReaders() || !this.deps.isCurrent(pending.path)) return;
		this.running = true;
		try {
			const status = await this.deps.read(pending.path);
			// A write arriving during this read gets one fresh successor, not an old push.
			if (this.pending || !this.deps.hasReaders() || !this.deps.isCurrent(pending.path)) return;
			const identity = summaryIdentity(status);
			if (identity === this.identity) return;
			this.identity = identity;
			this.deps.publish(status, pending.toolUseId);
		} catch (error) {
			this.deps.onError(error);
		} finally {
			this.running = false;
			this.schedule();
		}
	}
}
