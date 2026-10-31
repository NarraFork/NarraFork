import { type GitBranchEntry, matchingRemoteName, upstreamBranchName } from "@shared/git-branches";

/** Why a branch row cannot be clicked. The caller turns it into a sentence. */
export type BranchRowDisabledReason = "current" | "worktree" | "readOnly" | "nameTaken";

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
 * When the remote list is known, the longest matching remote is the prefix, so
 * a remote named `foo/bar` yields `main` from `foo/bar/main`.
 */
export function localNameForRemote(remoteRef: string, remotes?: readonly string[]): string {
	const remote = remotes ? matchingRemoteName(remotes, remoteRef) : null;
	if (remote && remoteRef.startsWith(`${remote}/`)) return remoteRef.slice(remote.length + 1);
	const slash = remoteRef.indexOf("/");
	return slash === -1 ? remoteRef : remoteRef.slice(slash + 1);
}

/** Name shown on the push button: the upstream branch when this remote is that upstream. */
export function publishBranchName(options: {
	branch: string;
	upstream: string | null;
	remote: string | null;
}): string {
	const { branch, upstream, remote } = options;
	if (!upstream || !remote) return branch;
	return upstreamBranchName(upstream, remote) ?? branch;
}

export type BranchSwitchRequest = { branch: string };

/**
 * The request a row click should send.
 *
 * A remote row switches to the local branch only when that branch already tracks
 * this exact remote ref. The same short name with a different upstream is blocked:
 * `upstream/main` must not silently check out a local `main` that tracks
 * `origin/main`. Otherwise the remote ref itself is sent, and the server checks
 * it out with `--track` (which also records the upstream).
 */
export function branchSwitchRequest(
	entry: GitBranchEntry,
	options: { local: readonly GitBranchEntry[]; remote: boolean; remotes?: readonly string[] },
): BranchSwitchRequest | { blocked: "nameTaken"; localName: string } {
	if (!options.remote) return { branch: entry.name };
	const name = localNameForRemote(entry.name, options.remotes);
	const existing = options.local.find((item) => item.name === name);
	if (!existing) return { branch: entry.name };
	if (existing.upstream === entry.name) return { branch: existing.name };
	return { blocked: "nameTaken", localName: existing.name };
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
