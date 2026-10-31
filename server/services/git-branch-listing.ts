import {
	GIT_BRANCH_LIST_LIMIT,
	GIT_BRANCH_SUBJECT_MAX_CHARS,
	type GitBranchEntry,
	type GitBranches,
	matchingRemoteName,
} from "@shared/git-branches";

/**
 * One record per ref, NUL-separated and newline-terminated. NUL is the one byte git
 * forbids in a branch name, so a subject containing a tab, or a name containing a
 * space, cannot shift the columns.
 *
 * The separator is spelled `%00`, not `%x00`: `for-each-ref` uses git's ref-filter
 * formatter, which expands two hex digits, while `git log`/`stash list` use the
 * pretty-format spelling `%x00`. With `%xNN` ref-filter prints the text literally.
 *
 * `refname:lstrip=2` drops `refs/heads/` and `refs/remotes/`, which is exactly the
 * short spelling both the UI and the checkout request use (`main`, `origin/main`).
 * `%(symref)` is what identifies `refs/remotes/origin/HEAD` as a pointer rather than
 * a branch; `%(HEAD)` marks the checked-out local branch.
 */
export const GIT_BRANCH_REF_FORMAT = [
	"%(refname:lstrip=2)",
	"%(objectname)",
	"%(upstream:short)",
	"%(upstream:track)",
	"%(committerdate:iso-strict)",
	"%(contents:subject)",
	"%(HEAD)",
	"%(symref)",
].join("%00");

/**
 * Keys of the raw listings. The local implementation fills them from `execRead`,
 * the remote executor returns the same names in `outputs`, and both then go
 * through {@link parseGitBranches} — so parsing exists in exactly one place.
 */
export const GIT_BRANCH_OUTPUT_KEYS = {
	heads: "heads",
	remoteRefs: "remoteRefs",
	remoteNames: "remoteNames",
	worktrees: "worktrees",
	headSha: "headSha",
	branch: "branch",
} as const;

/** Raw `for-each-ref` / `worktree list` text, before any interpretation. */
export interface GitBranchRawListing {
	heads?: string;
	remoteRefs?: string;
	remoteNames?: string;
	worktrees?: string;
	headSha?: string;
	branch?: string;
	/** A listing hit its byte budget or its record cap. */
	truncated?: boolean;
}

const FIELDS_PER_RECORD = 8;

function clampSubject(subject: string): string {
	return subject.length > GIT_BRANCH_SUBJECT_MAX_CHARS
		? `${subject.slice(0, GIT_BRANCH_SUBJECT_MAX_CHARS)}…`
		: subject;
}

/**
 * `%(upstream:track)` forms: `[ahead 1]`, `[behind 2]`, `[ahead 1, behind 2]`,
 * `[gone]`, and empty when the branch has no upstream at all.
 */
function parseUpstreamTrack(track: string): { ahead: number; behind: number; gone: boolean } {
	const text = track.trim();
	if (!text) return { ahead: 0, behind: 0, gone: false };
	if (text.includes("gone")) return { ahead: 0, behind: 0, gone: true };
	const ahead = /\bahead (\d+)/.exec(text);
	const behind = /\bbehind (\d+)/.exec(text);
	return {
		ahead: ahead ? Number.parseInt(ahead[1] ?? "0", 10) || 0 : 0,
		behind: behind ? Number.parseInt(behind[1] ?? "0", 10) || 0 : 0,
		gone: false,
	};
}

/**
 * Branch name → worktree path, from `git worktree list --porcelain`.
 *
 * Only `branch refs/heads/<name>` lines count: a detached worktree has no branch
 * line, and `bare`/`locked`/`prunable` are attributes of the worktree, not of the
 * branch this listing is about.
 */
function parseWorktreeBranches(raw: string): Map<string, string> {
	const paths = new Map<string, string>();
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		if (line.startsWith("worktree ")) {
			current = line.slice("worktree ".length).trim();
			continue;
		}
		if (line.startsWith("branch ") && current) {
			const ref = line.slice("branch ".length).trim();
			if (ref.startsWith("refs/heads/")) paths.set(ref.slice("refs/heads/".length), current);
		}
	}
	return paths;
}

interface ParsedRef {
	entry: GitBranchEntry;
	current: boolean;
}

function parseRefRecords(raw: string, truncatedInput: boolean): ParsedRef[] {
	const lines = raw.split("\n");
	// A byte budget can cut the stream mid-record; that tail is not a ref.
	if (truncatedInput && lines.length > 0) {
		const last = lines[lines.length - 1] ?? "";
		if (last && last.split("\0").length < FIELDS_PER_RECORD) lines.pop();
	}
	const parsed: ParsedRef[] = [];
	for (const line of lines) {
		if (!line) continue;
		const fields = line.split("\0");
		if (fields.length < FIELDS_PER_RECORD) continue;
		const [name = "", sha = "", upstream = "", track = "", committedAt = "", subject = ""] = fields;
		const headMarker = fields[6] ?? "";
		const symref = fields[7] ?? "";
		// `origin/HEAD` is a symbolic pointer at another ref, not a branch of its own.
		if (symref.trim()) continue;
		if (!name) continue;
		const { ahead, behind, gone } = parseUpstreamTrack(track);
		parsed.push({
			entry: {
				name,
				sha,
				committedAt: committedAt.trim() || null,
				subject: clampSubject(subject),
				upstream: upstream.trim() || null,
				ahead,
				behind,
				upstreamGone: gone,
				worktreePath: null,
			},
			current: headMarker.trim() === "*",
		});
	}
	return parsed;
}

/** Current branch first, then most recent commit, then name — stable across refs. */
function orderRefs(refs: ParsedRef[], current: string | null): GitBranchEntry[] {
	return refs
		.map((ref) => ref.entry)
		.sort((a, b) => {
			const aCurrent = current !== null && a.name === current;
			const bCurrent = current !== null && b.name === current;
			if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
			const at = a.committedAt ?? "";
			const bt = b.committedAt ?? "";
			if (at !== bt) return at < bt ? 1 : -1;
			return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
		});
}

/**
 * Apply the record cap without ever losing the checked-out branch.
 *
 * Two different truncations meet here. Our own cap cuts the ordered list, and the
 * `--count` git applied cuts the ref set before we ever see it — so a repository
 * with more refs than the window can omit the current branch entirely. A minimal
 * record keeps the UI able to name where HEAD is, and both cases report
 * `truncated` so the panel can say the list is partial.
 */
function limitEntries(
	refs: ParsedRef[],
	current: string | null,
	headSha: string | null,
): { entries: GitBranchEntry[]; truncated: boolean } {
	const ordered = orderRefs(refs, current);
	let truncated = ordered.length > GIT_BRANCH_LIST_LIMIT;
	const kept = ordered.slice(0, GIT_BRANCH_LIST_LIMIT);
	if (current && ordered.length > 0 && !kept.some((entry) => entry.name === current)) {
		const existing = ordered.find((entry) => entry.name === current);
		const replacement: GitBranchEntry = existing ?? {
			name: current,
			sha: headSha ?? "",
			committedAt: null,
			subject: "",
			upstream: null,
			ahead: 0,
			behind: 0,
			upstreamGone: false,
			worktreePath: null,
		};
		if (kept.length >= GIT_BRANCH_LIST_LIMIT) kept[kept.length - 1] = replacement;
		else kept.push(replacement);
		truncated = true;
	}
	return { entries: kept, truncated };
}

/**
 * Fallback chain for "which remote should a push/fetch default to":
 * the current branch's own upstream, then `origin`, then a sole remote.
 */
function pickDefaultRemote(remotes: string[], upstream: string | null): string | null {
	if (upstream) {
		const tracked = matchingRemoteName(remotes, upstream);
		if (tracked) return tracked;
	}
	if (remotes.includes("origin")) return "origin";
	return remotes.length === 1 ? (remotes[0] ?? null) : null;
}

/** Single parser for the local and remote backends; never cached. */
export function parseGitBranches(raw: GitBranchRawListing): GitBranches {
	const truncatedInput = raw.truncated === true;
	const localRefs = parseRefRecords(raw.heads ?? "", truncatedInput);
	const remoteRefs = parseRefRecords(raw.remoteRefs ?? "", truncatedInput);
	const remotes = (raw.remoteNames ?? "")
		.split("\n")
		.map((name) => name.trim())
		.filter(Boolean);
	const headSha = (raw.headSha ?? "").trim() || null;
	const branchName = (raw.branch ?? "").trim() || null;
	// The `%(HEAD)` marker is authoritative; `symbolic-ref` covers a HEAD whose ref
	// fell outside git's own `--count` window.
	const marked = localRefs.find((ref) => ref.current)?.entry.name;
	const current = branchName ?? marked ?? null;
	const worktrees = parseWorktreeBranches(raw.worktrees ?? "");

	const local = limitEntries(localRefs, current, headSha);
	const remote = limitEntries(remoteRefs, null, null);
	for (const entry of local.entries) {
		// Only another worktree is worth warning about; this one already has it.
		if (entry.name === current) continue;
		entry.worktreePath = worktrees.get(entry.name) ?? null;
	}
	const currentEntry = local.entries.find((entry) => entry.name === current);
	return {
		headSha,
		branch: current,
		// An unborn HEAD has no commit either, but that is not a detached checkout.
		detached: current === null && headSha !== null,
		local: local.entries,
		remote: remote.entries,
		remotes,
		defaultRemote: pickDefaultRemote(remotes, currentEntry?.upstream ?? null),
		truncated: truncatedInput || local.truncated || remote.truncated,
	};
}
