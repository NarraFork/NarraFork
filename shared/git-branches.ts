/**
 * Branch listing contract shared by the server, the Go executor and the browser.
 *
 * The panel asks two different questions and both are answered from one listing:
 * "which branches exist" (`local`/`remote`) and "where does this checkout stand"
 * (`branch`/`headSha`/`detached`, plus each local entry's upstream tracking).
 */

/** Longest branch name we accept; git itself has no hard cap, we bound the argv. */
export const GIT_BRANCH_NAME_MAX = 200;
/**
 * A checkout start point may be `origin/<branch>`, so it is allowed to run past a
 * single branch name. Still bounded: it is one git argument.
 */
export const GIT_START_POINT_MAX = 300;
/** Per-kind listing cap. A repository with more branches gets a truncated list. */
export const GIT_BRANCH_LIST_LIMIT = 300;
/** Commit subject is display text; long ones are cut rather than shipped whole. */
export const GIT_BRANCH_SUBJECT_MAX_CHARS = 200;

/**
 * Characters git forbids anywhere in a ref name: space, C0 controls, DEL, and the
 * punctuation its revision syntax reserves (`~ ^ : ? * [ \`).
 *
 * Written as a code-point walk rather than a character class because a control
 * character range in a regex is exactly what `noControlCharactersInRegex` exists to
 * catch, and the intent here is deliberate, not accidental.
 */
function hasForbiddenRefChar(name: string): boolean {
	for (const char of name) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x20 || code === 0x7f) return true;
		if ("~^:?*[\\".includes(char)) return true;
	}
	return false;
}

/**
 * `git check-ref-format --branch` equivalent, used by both ends.
 *
 * Implemented here instead of reusing the `gitRef` validator on purpose. `gitRef`
 * models REVISION syntax (it must accept `HEAD~2`, `@{1}`, `main^2`), so it allows
 * `~`, `^` and `@{}` — every one of which is illegal in a branch name. Conversely
 * a real branch name may be non-ASCII or contain `+`, which the ASCII-only ref
 * pattern rejects. A branch name is also passed to commands that create refs, so it
 * cannot lean on rev syntax at all.
 *
 * The server still runs `git check-ref-format --branch` before touching a ref, so
 * this can only ever be stricter than git (and is what the UI shows inline).
 */
export function isValidGitBranchName(name: string, maxLength = GIT_BRANCH_NAME_MAX): boolean {
	if (!name || name.length > maxLength) return false;
	// A lone "@" is shorthand for HEAD, not a name.
	if (name === "@") return false;
	// A leading dash would be read as a flag; trailing/leading slashes have no ref.
	if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
	// A ref cannot end with "." (it makes "<ref>." ambiguous with parent syntax).
	if (name.endsWith(".")) return false;
	if (name.includes("//") || name.includes("..") || name.includes("@{") || name.includes("\\"))
		return false;
	if (hasForbiddenRefChar(name)) return false;
	for (const segment of name.split("/")) {
		// No empty component; no ".hidden"; no directory/file collision via ".lock".
		if (!segment || segment.startsWith(".") || segment.endsWith(".lock")) return false;
	}
	return true;
}

/**
 * A configured remote NAME (not a URL). Looser than a branch name — a remote may
 * contain almost anything a refspec can — but it still reaches git as an argument,
 * so a leading dash and ref punctuation stay out.
 */
export function isValidGitRemoteName(name: string): boolean {
	if (!name || name.length > 100) return false;
	if (name.startsWith("-") || name.includes("..")) return false;
	return !hasForbiddenRefChar(name);
}

/**
 * Revision punctuation `gitRef` accepts and a branch name does not.
 * Kept beside the branch-name rules so a start point can be either `HEAD~2` or
 * `origin/功能+登录` without importing the server validator.
 */
const GIT_REVISION_PATTERN = /^[A-Za-z0-9_./@~^{][A-Za-z0-9._/~^@{}-]*$/;

/**
 * `git checkout -b <name> <start>`'s start point.
 *
 * A branch name (including `+` and non-ASCII, and a remote ref such as
 * `origin/feature+x`) or a revision (`HEAD~2`). A leading dash is rejected in both
 * shapes because git would read it as a flag.
 */
export function isValidGitStartPoint(value: string): boolean {
	if (!value || value.length > GIT_START_POINT_MAX || value.startsWith("-") || value.includes(".."))
		return false;
	if (isValidGitBranchName(value, GIT_START_POINT_MAX)) return true;
	return GIT_REVISION_PATTERN.test(value);
}

/**
 * The configured remote named by an upstream short ref (`origin/main`, or
 * `foo/bar/main` when the remote itself is `foo/bar`).
 *
 * The longest matching remote wins, so a remote named `foo` does not swallow
 * `foo/bar/main`.
 */
export function matchingRemoteName(remotes: readonly string[], upstream: string): string | null {
	let best: string | null = null;
	for (const remote of remotes) {
		if (upstream === remote || upstream.startsWith(`${remote}/`)) {
			if (!best || remote.length > best.length) best = remote;
		}
	}
	return best;
}

/** Branch on `remote` that `upstream` (`remote/topic`) names, when it is a legal branch. */
export function upstreamBranchName(upstream: string, remote: string): string | null {
	const prefix = `${remote}/`;
	if (!upstream.startsWith(prefix)) return null;
	const dest = upstream.slice(prefix.length);
	return dest && isValidGitBranchName(dest) ? dest : null;
}

export interface GitBranchEntry {
	/** Local `main`; remote `origin/main`. */
	name: string;
	sha: string;
	/** `%(committerdate:iso-strict)`, or null when the ref has no commit behind it. */
	committedAt: string | null;
	/** Commit subject, truncated to {@link GIT_BRANCH_SUBJECT_MAX_CHARS}. */
	subject: string;
	/** Local only: `%(upstream:short)`, e.g. `origin/main`. */
	upstream: string | null;
	/** Commits this branch has that its upstream does not; 0 without an upstream. */
	ahead: number;
	behind: number;
	/** The configured upstream ref no longer exists (`[gone]`). */
	upstreamGone: boolean;
	/** Another worktree already has this branch checked out. */
	worktreePath: string | null;
}

export interface GitBranches {
	headSha: string | null;
	/** Current branch, or null for a detached HEAD and a repository with no commits. */
	branch: string | null;
	detached: boolean;
	local: GitBranchEntry[];
	remote: GitBranchEntry[];
	remotes: string[];
	defaultRemote: string | null;
	/** At least one listing was cut by {@link GIT_BRANCH_LIST_LIMIT} or its byte budget. */
	truncated: boolean;
}
