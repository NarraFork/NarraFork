import type { GitBranchEntry } from "@shared/git-branches";

/** Why a branch row cannot be clicked. The caller turns it into a sentence. */
export type BranchRowDisabledReason = "current" | "worktree" | "readOnly";

/**
 * Search across the three things a user can actually recognise a branch by: its
 * name, the upstream it tracks, and the commit it points at. Case-insensitive
 * because branch names are usually lowercase but nobody types them exactly.
 */
export function filterBranches(
	entries: readonly GitBranchEntry[],
	query: string,
): GitBranchEntry[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...entries];
	return entries.filter((entry) =>
		[entry.name, entry.upstream ?? "", entry.subject].some((value) =>
			value.toLowerCase().includes(needle),
		),
	);
}

/**
 * Local branch name for a remote-tracking ref.
 *
 * `git checkout --track origin/feature/x` derives the local name by dropping the
 * remote prefix, and this has to agree with it — otherwise the UI would claim a
 * branch already exists (or not) based on a different name than git creates.
 */
export function localNameForRemote(remoteRef: string): string {
	const slash = remoteRef.indexOf("/");
	return slash === -1 ? remoteRef : remoteRef.slice(slash + 1);
}

/**
 * The request a row click should send.
 *
 * A remote branch whose local counterpart already exists is just a local switch —
 * `checkout --track` would refuse, since the local name is taken. Otherwise the
 * local branch is created from the remote ref, which is exactly `--track`'s
 * behaviour and also records the upstream.
 */
export function branchSwitchRequest(
	entry: GitBranchEntry,
	options: { localNames: ReadonlySet<string>; remote: boolean },
): { branch: string; create?: boolean; startPoint?: string } {
	if (!options.remote) return { branch: entry.name };
	const name = localNameForRemote(entry.name);
	return options.localNames.has(name)
		? { branch: name }
		: { branch: name, create: true, startPoint: entry.name };
}

export function branchRowDisabledReason(
	entry: GitBranchEntry,
	options: { current: boolean; canWrite: boolean },
): BranchRowDisabledReason | null {
	if (options.current) return "current";
	// Another worktree already has it checked out; git would refuse the switch.
	if (entry.worktreePath) return "worktree";
	if (!options.canWrite) return "readOnly";
	return null;
}

/**
 * `↑2 ↓1` for a branch row, or null when there is nothing to say.
 *
 * Counts are rendered as arrow glyphs rather than translated words so the row stays
 * narrow; `t` is only needed for the "upstream gone" note, which has no glyph.
 */
export function aheadBehindLabel(entry: GitBranchEntry, t: (key: string) => string): string | null {
	const parts: string[] = [];
	if (entry.ahead > 0) parts.push(`↑${entry.ahead}`);
	if (entry.behind > 0) parts.push(`↓${entry.behind}`);
	if (entry.upstreamGone) parts.push(t("branches.upstreamGone"));
	return parts.length > 0 ? parts.join(" ") : null;
}
