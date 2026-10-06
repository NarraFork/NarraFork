/**
 * Expand/collapse state for the git panel's folder rows, scoped to the browser
 * session.
 *
 * ── Why sessionStorage and not localStorage ─────────────────────────────────
 * The complaint this solves is "a refresh forgets which folders I opened", not
 * "remember my folders forever". Session scope covers the refresh and the
 * navigate-away-and-back, then clears itself when the tab closes — so a folder
 * layout from last week never resurrects onto a working tree that has moved on,
 * and there is nothing to prune or bound. Each tab also gets its own copy, which
 * matches how the panel is used: two tabs on two chapters are two workspaces.
 *
 * ── Why "expanded" and not "collapsed" ──────────────────────────────────────
 * Folders default to CLOSED, so the stored set must be the exception list, not
 * the rule: recording collapsed folders would mean enumerating every folder in
 * the tree up front (and re-enumerating whenever git reports a new path) just to
 * express "closed by default". Storing the expanded ones makes an unknown path
 * collapsed for free, which is exactly the default.
 *
 * Sections are kept apart because the same folder means different things in
 * each: `src/` under Staged and under Changes are two independent rows.
 *
 * PURE: every function here is DOM-free and total, so the format is testable
 * without a browser. The React binding lives in `useGitFolderPrefs`.
 */

/** Section a folder row belongs to. Staged and unstaged expand independently. */
export type GitFolderSection = "staged" | "unstaged";

/** Expanded folder paths for one chapter, per section. */
export interface ChapterFolderPrefs {
	staged: string[];
	unstaged: string[];
}

export type GitFolderPrefs = Record<string, ChapterFolderPrefs>;

export const GIT_FOLDER_PREFS_KEY = "narrafork_git_expanded_folders";

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Parse a stored document, discarding anything not shaped as expected.
 *
 * Total by construction: corrupt or hand-edited storage yields `{}` rather than
 * throwing, because a bad preference must never keep the git panel from
 * rendering.
 */
export function parseFolderPrefs(raw: string | null): GitFolderPrefs {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};

	const result: GitFolderPrefs = {};
	for (const [chapterId, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
		const entry = value as Record<string, unknown>;
		result[chapterId] = {
			staged: isStringArray(entry.staged) ? entry.staged : [],
			unstaged: isStringArray(entry.unstaged) ? entry.unstaged : [],
		};
	}
	return result;
}

/** Expanded paths for one chapter+section. Absent chapter → nothing expanded. */
export function readExpanded(
	prefs: GitFolderPrefs,
	chapterId: string,
	section: GitFolderSection,
): Set<string> {
	return new Set(prefs[chapterId]?.[section] ?? []);
}

/**
 * Toggle one folder, returning the next document.
 *
 * Pure: takes and returns the whole document so the caller decides when to
 * persist, and so a test can assert the transition without any storage.
 */
export function toggleExpanded(
	prefs: GitFolderPrefs,
	chapterId: string,
	section: GitFolderSection,
	path: string,
): GitFolderPrefs {
	const existing = prefs[chapterId] ?? { staged: [], unstaged: [] };
	const current = existing[section];
	const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
	return { ...prefs, [chapterId]: { ...existing, [section]: next } };
}
