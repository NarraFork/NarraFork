/**
 * View preference for the Git changes list.
 *
 * The default is the compact tree view because it keeps a large working tree
 * readable in a narrow panel. The preference is persistent and keyed by the
 * resolved workspace target, so two worktrees never share a presentation choice.
 */
export const GIT_VIEW_PREFS_KEY = "narrafork_git_view_mode";

export const GIT_VIEW_MODES = ["tree", "flat"] as const;
export type GitViewMode = (typeof GIT_VIEW_MODES)[number];
export type GitViewPrefs = Record<string, GitViewMode>;

export function isGitViewMode(value: unknown): value is GitViewMode {
	return value === "tree" || value === "flat";
}

export function parseGitViewPrefs(raw: string | null): GitViewPrefs {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};

	const result: GitViewPrefs = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (isGitViewMode(value)) result[key] = value;
	}
	return result;
}

export function readGitViewMode(prefs: GitViewPrefs, key: string): GitViewMode {
	return prefs[key] ?? "tree";
}

export function setGitViewMode(prefs: GitViewPrefs, key: string, mode: GitViewMode): GitViewPrefs {
	if (prefs[key] === mode) return prefs;
	return { ...prefs, [key]: mode };
}
