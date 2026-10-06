import type { WorktreeEntry } from "@shared/narrator-worktrees";

export type WorktreeSort = "lastCommitAt" | "createdAt" | "name";

export function worktreeLabel(entry: WorktreeEntry): string {
	return entry.branch?.replace(/^refs\/heads\//, "") ?? worktreeDirectoryLabel(entry.path);
}

export function worktreeDirectoryLabel(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export function filterSortWorktrees(
	entries: WorktreeEntry[],
	search: string,
	sort: WorktreeSort,
	descending: boolean,
): WorktreeEntry[] {
	const query = search.trim().toLocaleLowerCase();
	return entries
		.filter((entry) => `${entry.branch ?? ""}\n${entry.path}`.toLocaleLowerCase().includes(query))
		.sort((a, b) => {
			const stable =
				worktreeLabel(a).localeCompare(worktreeLabel(b)) || a.path.localeCompare(b.path);
			if (sort === "name") return descending ? -stable : stable;
			const left = a[sort];
			const right = b[sort];
			const leftKnown = typeof left === "number" && Number.isFinite(left);
			const rightKnown = typeof right === "number" && Number.isFinite(right);
			if (!leftKnown) return rightKnown ? 1 : stable;
			if (!rightKnown) return -1;
			return (descending ? right - left : left - right) || stable;
		});
}
