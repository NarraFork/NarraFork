/**
 * Status filter for the git changes list.
 *
 * The invariants these lock, in order of how badly they break the panel:
 *
 * 1. An empty / corrupt / unknown selection means SHOW EVERYTHING. Every other
 *    reading turns a mis-click or a stale storage entry into a panel that looks
 *    like a clean working tree while changes are merely hidden.
 * 2. Filtering matches the BADGE letter a row shows, not the raw porcelain pair.
 *    `AM` is one file that appears as `A` under Staged and `M` under Changes; a
 *    filter on the pair would match neither — the same class of bug that
 *    `git-file-status.ts` exists to prevent.
 * 3. A selected letter keeps its chip even after its rows disappear, or the only
 *    control that could undo the filter removes itself.
 */

import { describe, expect, test } from "bun:test";
import { gitFileBadgeChar } from "./git-file-status";
import {
	clearStatusFilter,
	countBadgeChars,
	filterFilesByStatus,
	GIT_STATUS_FILTER_CHARS,
	type GitStatusFilterChar,
	type GitStatusFilterPrefs,
	isGitStatusFilterChar,
	parseStatusFilterPrefs,
	readStatusFilter,
	toggleStatusFilter,
	visibleFilterChars,
} from "./git-status-filter";

const CHAPTER = "chapter-1";

function selection(...chars: GitStatusFilterChar[]): Set<GitStatusFilterChar> {
	return new Set(chars);
}

describe("filterFilesByStatus", () => {
	const files = [
		{ status: "M ", path: "a.ts" },
		{ status: " D", path: "b.ts" },
		{ status: "??", path: "c.ts" },
		{ status: "AM", path: "d.ts" },
		{ status: "UU", path: "e.ts" },
	];

	test("an empty selection shows everything, and does not copy the array", () => {
		// Referential identity matters: the unfiltered path is the common one, and a
		// fresh array every render defeats downstream memoization.
		expect(filterFilesByStatus(files, "unstaged", selection())).toBe(files);
	});

	test("matches the badge letter the row actually shows, per section", () => {
		// `AM` is the case a naive raw-status filter gets wrong: it is an addition in
		// the staged half and a modification in the unstaged one, so the SAME file
		// answers to a different letter depending on which list it is in.
		const staged = [{ status: "AM", path: "d.ts" }];
		expect(filterFilesByStatus(staged, "staged", selection("A")).map((f) => f.path)).toEqual([
			"d.ts",
		]);
		expect(filterFilesByStatus(staged, "staged", selection("M"))).toEqual([]);

		expect(filterFilesByStatus(staged, "unstaged", selection("M")).map((f) => f.path)).toEqual([
			"d.ts",
		]);
		expect(filterFilesByStatus(staged, "unstaged", selection("A"))).toEqual([]);
	});

	test("an untracked file is filtered as an addition, not as ??", () => {
		// `??` is not a selectable letter at all; the row shows `A`, so `A` is what
		// has to reveal it.
		const untracked = [{ status: "??", path: "c.ts" }];
		expect(filterFilesByStatus(untracked, "unstaged", selection("A")).map((f) => f.path)).toEqual([
			"c.ts",
		]);
		expect(filterFilesByStatus(untracked, "unstaged", selection("M"))).toEqual([]);
		expect(isGitStatusFilterChar("??")).toBe(false);
	});

	test("selecting several letters is a union", () => {
		expect(filterFilesByStatus(files, "unstaged", selection("D", "U")).map((f) => f.path)).toEqual([
			"b.ts",
			"e.ts",
		]);
	});

	test("conflicts are reachable through U in both sections", () => {
		for (const section of ["staged", "unstaged"] as const) {
			expect(filterFilesByStatus(files, section, selection("U")).map((f) => f.path)).toEqual([
				"e.ts",
			]);
		}
	});

	test("every letter a row can show is selectable", () => {
		// The real failure mode: a row whose badge letter has no chip can never be
		// filtered in, so selecting anything else hides it with no way to bring it
		// back. Cover every status the panel classifies.
		const statuses = ["A ", "AM", "AD", "M ", " M", "MM", "D ", " D", "R ", "RM", "C ", "UU", "??"];
		for (const status of statuses) {
			for (const section of ["staged", "unstaged"] as const) {
				const char = gitFileBadgeChar(status, section);
				expect(isGitStatusFilterChar(char)).toBe(true);
			}
		}
	});

	test("a status the mapping degrades to M is still reachable", () => {
		// `gitFileBadgeChar` is total and falls back to `M`; the filter must agree,
		// otherwise a malformed status becomes permanently invisible.
		const odd = [{ status: "XY", path: "odd.ts" }];
		expect(filterFilesByStatus(odd, "staged", selection("M")).map((f) => f.path)).toEqual([
			"odd.ts",
		]);
	});
});

describe("countBadgeChars", () => {
	test("counts rows, not files — a two-sided status contributes to both", () => {
		const counts = countBadgeChars([
			{ section: "staged", files: [{ status: "AM" }] },
			{ section: "unstaged", files: [{ status: "AM" }] },
		]);
		// The same file, but two rows: one `A` under Staged and one `M` under Changes.
		// Counting files instead would promise one row and reveal two.
		expect(counts.get("A")).toBe(1);
		expect(counts.get("M")).toBe(1);
	});

	test("omits letters with no rows rather than storing zeros", () => {
		const counts = countBadgeChars([{ section: "unstaged", files: [{ status: " M" }] }]);
		expect(counts.get("M")).toBe(1);
		expect(counts.has("D")).toBe(false);
	});

	test("empty input yields no counts", () => {
		expect(countBadgeChars([]).size).toBe(0);
		expect(countBadgeChars([{ section: "staged", files: [] }]).size).toBe(0);
	});
});

describe("visibleFilterChars", () => {
	test("shows a chip for every kind present, in a fixed order", () => {
		const counts = new Map<GitStatusFilterChar, number>([
			["D", 2],
			["A", 1],
		]);
		// Order follows GIT_STATUS_FILTER_CHARS, not the data: a chip must not move
		// under the cursor when git reports a new kind of change.
		expect(visibleFilterChars(counts, selection())).toEqual(["A", "D"]);
	});

	test("keeps a selected letter whose rows are gone", () => {
		// Committing away every deletion while "only D" is on must not remove the
		// one control that explains (and undoes) an empty list.
		const counts = new Map<GitStatusFilterChar, number>([["M", 3]]);
		expect(visibleFilterChars(counts, selection("D"))).toEqual(["M", "D"]);
	});

	test("no changes and no selection means no chips", () => {
		expect(visibleFilterChars(new Map(), selection())).toEqual([]);
	});
});

describe("toggleStatusFilter", () => {
	test("adds and removes one letter", () => {
		const once = toggleStatusFilter({}, CHAPTER, "M");
		expect(once[CHAPTER]).toEqual(["M"]);
		expect(toggleStatusFilter(once, CHAPTER, "M")).toEqual({});
	});

	test("keeps the canonical letter order regardless of click order", () => {
		let prefs: GitStatusFilterPrefs = {};
		for (const char of ["U", "A", "D"] as const) {
			prefs = toggleStatusFilter(prefs, CHAPTER, char);
		}
		// Stored in chip order so the persisted document does not depend on the order
		// the user happened to click.
		expect(prefs[CHAPTER]).toEqual(["A", "D", "U"]);
	});

	test("an emptied selection is removed, not stored as []", () => {
		// "Unfiltered" must have exactly one representation, or `readStatusFilter`
		// has two shapes to agree about.
		const prefs = toggleStatusFilter(toggleStatusFilter({}, CHAPTER, "M"), CHAPTER, "M");
		expect(CHAPTER in prefs).toBe(false);
	});

	test("does not touch other chapters", () => {
		const prefs = toggleStatusFilter({ other: ["D"] }, CHAPTER, "M");
		expect(prefs.other).toEqual(["D"]);
		expect(prefs[CHAPTER]).toEqual(["M"]);
	});

	test("is pure — the input document is not mutated", () => {
		const before: GitStatusFilterPrefs = { [CHAPTER]: ["M"] };
		toggleStatusFilter(before, CHAPTER, "D");
		expect(before).toEqual({ [CHAPTER]: ["M"] });
	});
});

describe("clearStatusFilter", () => {
	test("drops the chapter and leaves the rest alone", () => {
		expect(clearStatusFilter({ [CHAPTER]: ["M"], other: ["D"] }, CHAPTER)).toEqual({
			other: ["D"],
		});
	});

	test("returns the same document when there was nothing to clear", () => {
		const prefs: GitStatusFilterPrefs = { other: ["D"] };
		expect(clearStatusFilter(prefs, CHAPTER)).toBe(prefs);
	});
});

describe("parseStatusFilterPrefs", () => {
	test("round-trips what toggle produced", () => {
		const prefs = toggleStatusFilter(toggleStatusFilter({}, CHAPTER, "M"), CHAPTER, "D");
		expect(parseStatusFilterPrefs(JSON.stringify(prefs))).toEqual(prefs);
	});

	test("garbage, wrong shapes and absent storage all mean unfiltered", () => {
		// Every one of these must degrade to "show everything". Degrading to "show
		// nothing" would present an empty panel with no visible cause.
		for (const raw of [null, "", "not json", "[]", "null", '"M"', "42"]) {
			expect(parseStatusFilterPrefs(raw)).toEqual({});
		}
		expect(parseStatusFilterPrefs('{"c":"M"}')).toEqual({});
		expect(parseStatusFilterPrefs('{"c":{"0":"M"}}')).toEqual({});
	});

	test("drops unknown letters instead of keeping them", () => {
		// A letter no row can produce would match nothing while having no chip to
		// switch it back off — an unhideable empty list.
		expect(parseStatusFilterPrefs('{"c":["M","Z","??",5,null]}')).toEqual({ c: ["M"] });
		expect(parseStatusFilterPrefs('{"c":["Z"]}')).toEqual({});
	});

	test("deduplicates and normalizes order", () => {
		expect(parseStatusFilterPrefs('{"c":["D","M","D"]}')).toEqual({ c: ["M", "D"] });
	});
});

describe("readStatusFilter", () => {
	test("an unknown chapter is unfiltered", () => {
		expect(readStatusFilter({}, CHAPTER).size).toBe(0);
	});

	test("returns the stored letters", () => {
		expect([...readStatusFilter({ [CHAPTER]: ["M", "D"] }, CHAPTER)]).toEqual(["M", "D"]);
	});
});

describe("GIT_STATUS_FILTER_CHARS", () => {
	test("every selectable letter is a single character with its own colour", () => {
		// The chips reuse the file rows' colour; a letter the registry does not know
		// would render a gray chip next to a coloured badge for the same status.
		for (const char of GIT_STATUS_FILTER_CHARS) {
			expect(char).toHaveLength(1);
			expect(isGitStatusFilterChar(char)).toBe(true);
		}
		expect(new Set(GIT_STATUS_FILTER_CHARS).size).toBe(GIT_STATUS_FILTER_CHARS.length);
	});
});
