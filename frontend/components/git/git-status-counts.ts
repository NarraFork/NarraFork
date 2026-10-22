import type { GitStatusSummary } from "../../hooks/useGit";

export type GitChangeSection = "staged" | "unstaged";

/** Counts are per section: a porcelain `AM`/`MM` file can contribute to both. */
export function gitSectionCount(
	status: Pick<GitStatusSummary, "staged" | "unstaged" | "untracked">,
	section: GitChangeSection,
): number {
	return section === "staged" ? status.staged : status.unstaged + status.untracked;
}

/** Count visible paths once, even when a file contributes a row to both sections. */
export function gitUniqueFileCount(files: ReadonlyArray<{ path: string }>): number {
	return new Set(files.map((file) => file.path)).size;
}

/**
 * The header counts files, not section rows. `totalFiles` is the server's unique
 * count; the visible path set is a safe lower bound for older or test payloads.
 */
export function gitTotalFileCount(status: Pick<GitStatusSummary, "files" | "totalFiles">): number {
	return Math.max(status.totalFiles, gitUniqueFileCount(status.files));
}

/** Truncated subprocess output makes every reported count a lower bound. */
export function formatGitSectionCount(count: number, truncated: boolean): string {
	return truncated ? `${count}+` : String(count);
}

/** Rows omitted by the client-side render cap, never negative. */
export function hiddenGitSectionRows(total: number, visible: number): number {
	return Math.max(0, total - visible);
}
