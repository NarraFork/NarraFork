/**
 * Status filter for the git changes list ("show only D", "show only A + U").
 *
 * ── What it filters on ──────────────────────────────────────────────────────
 * The BADGE letter a row already shows, not the raw porcelain pair. A porcelain
 * status is two independent characters and one file can legitimately appear in
 * both sections with a different verdict in each (`AM` = staged addition + later
 * edit). Filtering on the raw pair would mean `AM` matches neither "A" nor "M",
 * which is exactly the class of bug `git-file-status.ts` exists to prevent — so
 * the filter reuses `gitFileBadgeChar` and matches what the user can see.
 *
 * That also fixes the meaning of the counts: they count ROWS, not files. `AM`
 * contributes one to A (staged section) and one to M (unstaged section), which is
 * the number of rows that letter will actually reveal or hide.
 *
 * ── Why an empty selection means "everything" ────────────────────────────────
 * The alternative (empty = nothing) turns a mis-click into an empty panel that
 * looks broken. Empty = unfiltered also means the stored document has nothing to
 * write in the common case.
 *
 * PURE: no React, no DOM. The React binding lives in `useGitStatusFilter`.
 */

import { type GitFileSection, gitFileBadgeChar } from "./git-file-status";

/**
 * Letters the filter can select.
 *
 * Deliberately the same set `gitFileBadgeChar` can return, in the order the chips
 * render. Order is fixed rather than derived from the data so the chip a user
 * aims at does not move when git reports a new kind of change.
 */
export const GIT_STATUS_FILTER_CHARS = ["A", "M", "D", "R", "C", "U"] as const;

export type GitStatusFilterChar = (typeof GIT_STATUS_FILTER_CHARS)[number];

export const GIT_STATUS_FILTER_KEY = "narrafork_git_status_filter";

/** Selected letters per chapter. Absent chapter → unfiltered. */
export type GitStatusFilterPrefs = Record<string, GitStatusFilterChar[]>;

const CHAR_SET: ReadonlySet<string> = new Set(GIT_STATUS_FILTER_CHARS);

export function isGitStatusFilterChar(value: unknown): value is GitStatusFilterChar {
	return typeof value === "string" && CHAR_SET.has(value);
}

/**
 * Parse a stored document, discarding anything not shaped as expected.
 *
 * Total by construction: corrupt or hand-edited storage yields `{}` rather than
 * throwing, because a bad view preference must never keep the panel from
 * rendering — and an unparseable filter must degrade to "show everything", never
 * to "show nothing".
 */
export function parseStatusFilterPrefs(raw: string | null): GitStatusFilterPrefs {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};

	const result: GitStatusFilterPrefs = {};
	for (const [chapterId, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!Array.isArray(value)) continue;
		// Unknown letters are dropped rather than kept: a letter no row can ever
		// produce would hide everything with no chip to switch it back off.
		const chars = value.filter(isGitStatusFilterChar);
		const deduped = GIT_STATUS_FILTER_CHARS.filter((char) => chars.includes(char));
		if (deduped.length > 0) result[chapterId] = deduped;
	}
	return result;
}

/** Selected letters for one chapter. Absent chapter → empty set → unfiltered. */
export function readStatusFilter(
	prefs: GitStatusFilterPrefs,
	chapterId: string,
): Set<GitStatusFilterChar> {
	return new Set(prefs[chapterId] ?? []);
}

/**
 * Toggle one letter, returning the next document.
 *
 * Pure: takes and returns the whole document so the caller decides when to
 * persist. A chapter whose selection empties out is REMOVED rather than stored as
 * `[]`, so "unfiltered" has exactly one representation.
 */
export function toggleStatusFilter(
	prefs: GitStatusFilterPrefs,
	chapterId: string,
	char: GitStatusFilterChar,
): GitStatusFilterPrefs {
	const current = prefs[chapterId] ?? [];
	const next = current.includes(char)
		? current.filter((c) => c !== char)
		: GIT_STATUS_FILTER_CHARS.filter((c) => c === char || current.includes(c));
	if (next.length === 0) {
		const { [chapterId]: _dropped, ...rest } = prefs;
		return rest;
	}
	return { ...prefs, [chapterId]: next };
}

/** Drop one chapter's selection entirely (the "clear filter" action). */
export function clearStatusFilter(
	prefs: GitStatusFilterPrefs,
	chapterId: string,
): GitStatusFilterPrefs {
	if (!(chapterId in prefs)) return prefs;
	const { [chapterId]: _dropped, ...rest } = prefs;
	return rest;
}

/**
 * Keep only the rows whose badge letter is selected.
 *
 * Returns the input array untouched when nothing is selected, so an unfiltered
 * panel does not allocate a copy or lose referential stability.
 */
export function filterFilesByStatus<TFile extends { status: string }>(
	files: readonly TFile[],
	section: GitFileSection,
	selected: ReadonlySet<GitStatusFilterChar>,
): readonly TFile[] {
	if (selected.size === 0) return files;
	return files.filter((file) => {
		const char = gitFileBadgeChar(file.status, section);
		return isGitStatusFilterChar(char) && selected.has(char);
	});
}

/** One section's rows, as the panel splits them. */
export interface GitStatusFilterGroup {
	section: GitFileSection;
	files: readonly { status: string }[];
}

/**
 * How many ROWS each letter would show, across every section.
 *
 * Counted from the UNFILTERED lists: a chip must state how many rows it can
 * reveal, and counting the filtered list would collapse every unselected chip to
 * zero the moment any filter is on.
 */
export function countBadgeChars(
	groups: readonly GitStatusFilterGroup[],
): Map<GitStatusFilterChar, number> {
	const counts = new Map<GitStatusFilterChar, number>();
	for (const group of groups) {
		for (const file of group.files) {
			const char = gitFileBadgeChar(file.status, group.section);
			if (!isGitStatusFilterChar(char)) continue;
			counts.set(char, (counts.get(char) ?? 0) + 1);
		}
	}
	return counts;
}

/**
 * Which chips to render: every letter present in the change set, plus every
 * letter still selected.
 *
 * The second half is the important one. A selected letter whose rows have all
 * been committed away would otherwise remove its own chip while still hiding
 * everything else — a panel filtered to nothing, with no visible control to
 * explain it.
 */
export function visibleFilterChars(
	counts: ReadonlyMap<GitStatusFilterChar, number>,
	selected: ReadonlySet<GitStatusFilterChar>,
): GitStatusFilterChar[] {
	return GIT_STATUS_FILTER_CHARS.filter(
		(char) => (counts.get(char) ?? 0) > 0 || selected.has(char),
	);
}
