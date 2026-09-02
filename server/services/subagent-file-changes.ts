/**
 * subagent-file-changes.ts — "what did my subagents change on disk?"
 *
 * WHY THIS EXISTS
 * ---------------
 * A subagent gets its OWN narrator record, and every existing view of file
 * modifications is scoped to one narrator id. So a parent narrator — the model, its
 * UI panel, and anyone about to revert — could see nothing of what its children
 * wrote. The child's conclusion text was the only channel, and it says whatever the
 * child chose to say.
 *
 * Nothing new is recorded to answer this: `file_attributions` already holds one row
 * per change with `narrator_id`, and `narrators.parent_narrator_id` already links
 * children to their parent. This module is purely the missing READ.
 *
 * COST (measured on this repository's own database, 74k attribution rows)
 * ----------------------------------------------------------------------
 * The worst parent in real data has 220 distinct changed files across 1577 rows;
 * aggregating all of it takes ~8ms and `EXPLAIN QUERY PLAN` shows both narrow
 * indexes in use (`idx_narrators_parent`, then `idx_file_attr_narrator`) with no
 * table scan. Only narrow columns are selected — never `input_json` / `output_json`,
 * which can hold an entire file.
 *
 * This is deliberately NOT the `LIMIT n + 1` shape CLAUDE.md prescribes for
 * pagination, because the caller must report EXACT totals ("…and 12 more files, 3
 * not measured"). A windowed count would understate the unmeasured tally, which is
 * precisely the "looks complete but isn't" failure the NULL contract exists to
 * prevent. The scope is bounded by one parent's children rather than by a page, and
 * {@link MAX_AGGREGATED_FILES} guards against a pathological future session.
 *
 * TWO PROPERTIES CALLERS MUST NOT MISREAD
 * ---------------------------------------
 * 1. FIGURES ARE CHURN, NOT NET DIFFERENCE. Rows are summed per file, so a file
 *    edited three times reports the total of those three edits. One subagent in real
 *    data edited a single file 80 times — for that file churn and net difference
 *    differ by an order of magnitude. Callers MUST label the numbers accordingly
 *    (see `editCount`); a bare `+42 -3` reads as "this file is now 42 lines longer",
 *    which is not what this measures. Computing the net difference would require
 *    diffing real file contents on a summary path, which the performance rules forbid.
 * 2. `linesAdded === null` MEANS UNMEASURED, NOT ZERO. `SUM` skips NULLs silently,
 *    so {@link SubagentFileChanges.totalUnmeasured} carries how many rows could not
 *    be measured and callers must surface it.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "../db";
import { fileAttributions, narrators } from "../db/schema";
import { logger } from "../lib/logger";
import { normalizeWorkspacePath } from "./git-workspace";

/**
 * Hard ceiling on aggregated file rows.
 *
 * ~9× the worst case observed in real data (220). It is a guard against a future
 * pathological session, not a limit the present workload approaches. When it trips,
 * `countsTruncated` is set so the caller can say the totals are partial instead of
 * presenting a short list as complete.
 */
export const MAX_AGGREGATED_FILES = 2000;

/**
 * Files shown on a subagent CARD before the reader expands it.
 *
 * Much smaller than {@link INJECTED_FILE_LIST_MAX} because the two are bounded by
 * different things. The injected text is bounded by reading budget; a card's list is
 * bounded by SCREEN HEIGHT and, unlike the text, it is measured — every extra row
 * makes the card taller. One parent in real data aggregated 220 changed files, so an
 * uncapped (or 20-row) list would let a single card eat the viewport. The remainder
 * stays reachable behind an expand affordance.
 */
export const CARD_FILE_LIST_MAX = 5;

/** One file a subagent changed, with its cumulative line churn. */
export interface SubagentChangedFile {
	/** Narrator id of the subagent that made the change. */
	subagentNarratorId: string;
	/** Path as recorded by the tool (repo-relative locally, normalized if remote). */
	filePath: string;
	/** Cumulative lines added across `editCount` changes; null when unmeasured. */
	linesAdded: number | null;
	/** Cumulative lines removed across `editCount` changes; null when unmeasured. */
	linesRemoved: number | null;
	/**
	 * How many separate changes were folded into the figures above.
	 *
	 * Load-bearing for honest wording: `> 1` means the numbers are churn across
	 * several edits rather than a single file delta, and the caller must say so.
	 */
	editCount: number;
	/** How many of those changes carried no line measurement. */
	unmeasuredCount: number;
	/**
	 * The change landed OUTSIDE the parent's workspace (a subagent launched with a
	 * different `workdir`).
	 *
	 * Matters for reverts: tree snapshots are keyed by worktree path, so the parent's
	 * revert restores only its own workspace. 2.5% of subagents in real data run
	 * elsewhere, and for those the parent's revert silently will not help — which is
	 * why this is reported rather than assumed away.
	 */
	outsideParentWorkspace: boolean;
}

/** Aggregate of everything a parent's subagents changed. */
export interface SubagentFileChanges {
	/** Per-file rows, ordered by churn descending (largest change first). */
	files: SubagentChangedFile[];
	/** Total distinct (subagent, file) pairs — the true count, not the window size. */
	totalFiles: number;
	/** Total changes with no line measurement, across ALL files. */
	totalUnmeasured: number;
	/**
	 * Distinct files touched by Bash, which are NOT in `files`.
	 *
	 * Excluded from the list because a shell command cannot attribute a line delta to
	 * any single file, and because the volume is disproportionate: Bash is 27% of all
	 * attributions in real data and ONE call attributed 1556 files. Including them
	 * would drown the measured list in pathless-looking rows and make
	 * `totalUnmeasured` dominate the summary.
	 *
	 * ⚠️ Still reported as a count, never dropped: a `sed -i` or a build script really
	 * did change the disk, and a parent that does not know continues on a stale view
	 * of the workspace.
	 */
	bashTouchedCount: number;
	/** `MAX_AGGREGATED_FILES` was hit — totals are partial. */
	countsTruncated: boolean;
}

const EMPTY: SubagentFileChanges = {
	files: [],
	totalFiles: 0,
	totalUnmeasured: 0,
	bashTouchedCount: 0,
	countsTruncated: false,
};

/** Whether an aggregate contains anything worth telling the caller about. */
export function hasSubagentFileChanges(changes: SubagentFileChanges): boolean {
	return changes.totalFiles > 0 || changes.bashTouchedCount > 0;
}

/**
 * Files listed by name in the model-facing block.
 *
 * A subagent changes at most 40 files in real data (mean 4.4), so 20 names covers
 * the whole list in almost every case. The cap is not a token optimization: the
 * block sits next to the child's CONCLUSION, and 40 lines of paths would push the
 * one thing the parent actually needs out of view.
 */
export const INJECTED_FILE_LIST_MAX = 20;

/** Tag wrapping the model-facing file-change block. */
const BLOCK_TAG = "subagent_file_changes";

/**
 * `+42 -3` / `+42 -3 across 3 edits` / `lines not measured` for one file.
 *
 * The "across N edits" qualifier is REQUIRED whenever the figures fold several
 * changes together, because a bare `+42 -3` reads as "this file is now 42 lines
 * longer" — a claim this data cannot support (see the module header on churn). A
 * single-change file needs no qualifier: there churn and net difference coincide.
 */
function formatFileLine(file: SubagentChangedFile): string {
	if (file.linesAdded === null || file.linesRemoved === null) {
		return `${file.filePath} (lines not measured)`;
	}
	const figures = `+${file.linesAdded} -${file.linesRemoved}`;
	const qualifier = file.editCount > 1 ? ` across ${file.editCount} edits` : "";
	return `${file.filePath} ${figures}${qualifier}`;
}

/**
 * The `<subagent_file_changes>` block appended to a subagent's result, or "" when
 * the subagent changed nothing.
 *
 * Returning "" for an empty aggregate is deliberate: an empty block would be a
 * standing invitation to read "no files listed" as "the tool failed to report",
 * whereas its absence matches every other optional section of a result.
 */
export function formatSubagentFileChanges(changes: SubagentFileChanges): string {
	if (!hasSubagentFileChanges(changes)) return "";
	const lines: string[] = [];

	// Stated up front, before any numbers: a reader who skips this line and sees
	// `+42 -3` will draw the wrong conclusion, so it must precede the figures rather
	// than trail them as a footnote.
	if (changes.files.some((file) => file.editCount > 1)) {
		lines.push("Figures are cumulative across edits, not net change from the original.");
	}

	const visible = changes.files.slice(0, INJECTED_FILE_LIST_MAX);
	for (const file of visible) lines.push(formatFileLine(file));

	const hidden = changes.totalFiles - visible.length;
	if (hidden > 0) {
		// The counts come from the full aggregate, so this N is real rather than a
		// window artefact. The unmeasured tally covers ALL files, including listed ones.
		const unmeasured =
			changes.totalUnmeasured > 0 ? ` (${changes.totalUnmeasured} not measured)` : "";
		lines.push(`…and ${hidden} more files${unmeasured}`);
	} else if (changes.totalUnmeasured > 0 && visible.every((f) => f.linesAdded !== null)) {
		// Every listed file shows figures, yet some of the folded-in changes had none.
		// Without this the summary would look fully measured.
		lines.push(`(${changes.totalUnmeasured} change(s) had no line measurement)`);
	}

	if (changes.bashTouchedCount > 0) {
		lines.push(
			`plus ${changes.bashTouchedCount} file(s) touched by shell commands (lines not measured)`,
		);
	}

	// A revert by the parent restores only the parent's own worktree, so changes made
	// elsewhere survive it. Saying nothing here would let the parent assume a clean
	// undo is available when it is not.
	const outside = changes.files.filter((file) => file.outsideParentWorkspace).length;
	if (outside > 0) {
		lines.push(`⚠ ${outside} file(s) outside this workspace — a revert here will not restore them`);
	}

	if (changes.countsTruncated) {
		lines.push(`(counts truncated at ${MAX_AGGREGATED_FILES} files)`);
	}

	return `<${BLOCK_TAG}>\n${lines.join("\n")}\n</${BLOCK_TAG}>`;
}

/**
 * Append the file-change block to a subagent result, for the five result outlets.
 *
 * Fault-tolerant by contract: a failed aggregation yields the original text
 * unchanged. That matters most on the CRASH outlet, where the text being wrapped is
 * the error itself — losing it to a failed summary would replace a diagnosable
 * failure with a mysterious one.
 */
export async function appendSubagentFileChanges(
	parentNarratorId: string,
	parentWorkspacePath: string | null | undefined,
	resultText: string,
): Promise<string> {
	try {
		const workspacePath =
			parentWorkspacePath ?? (await resolveParentWorkspacePath(parentNarratorId));
		const changes = await getSubagentFileChanges(parentNarratorId, workspacePath);
		const block = formatSubagentFileChanges(changes);
		return block ? `${resultText}\n\n${block}` : resultText;
	} catch (err) {
		logger.debug("Failed to append subagent file changes", {
			parentNarratorId,
			error: String(err),
		});
		return resultText;
	}
}

/**
 * Per-subagent file changes for a whole page of cards, in ONE query.
 *
 * The card path must not become "one query per card": a message page can hold dozens
 * of Agent calls, and per-card lookups would turn opening a session into a query
 * storm on a list path. So the aggregation runs once over every subagent id on the
 * page and is grouped in JS afterwards.
 *
 * Returns a map keyed by subagent narrator id. Subagents that changed nothing are
 * absent rather than mapped to an empty aggregate, so a caller can spread the field
 * conditionally and leave the common payload the size it was.
 */
export async function getFileChangesBySubagent(
	subagentNarratorIds: string[],
): Promise<Map<string, SubagentFileChanges>> {
	const result = new Map<string, SubagentFileChanges>();
	const ids = [...new Set(subagentNarratorIds)].filter(Boolean);
	if (ids.length === 0) return result;
	try {
		// Each child's parent workspace, for the SAME classification the injected text
		// does. Batched over the whole page (one indexed `inArray` + a join to the parent
		// row), which is what makes it affordable here: the objection to classifying on
		// this path was ever only "one query per card", not the classification itself.
		//
		// Hard-coding `false` instead was a quiet contradiction: the injected block told
		// the model "⚠ N file(s) outside this workspace — a revert here will not restore
		// them" while the card beside it showed those same files with no such mark. A user
		// reading only the card would conclude the parent's revert covers them.
		const workspaceByChild = await resolveParentWorkspaceByChild(ids);
		// `action` is restricted rather than grouped by, and this is the whole reason
		// there are two queries instead of one.
		//
		// Grouping by `action` would split ONE file into one row per action, and a
		// subagent that writes a file and then edits it is the normal case, not an edge
		// one. The card would list the same path twice with each half of the figure, and
		// `totalFiles` would count it twice — while `getSubagentFileChanges`, which does
		// not group by action, reported one row. Two answers to the same question, the
		// wrong one being the one the user sees.
		const rows = await db
			.select({
				subagentNarratorId: fileAttributions.narratorId,
				filePath: fileAttributions.filePath,
				workspacePath: fileAttributions.workspacePath,
				linesAdded: sql<number | null>`sum(${fileAttributions.linesAdded})`,
				linesRemoved: sql<number | null>`sum(${fileAttributions.linesRemoved})`,
				editCount: sql<number>`count(*)`,
				unmeasuredCount: sql<number>`sum(case when ${fileAttributions.linesAdded} is null then 1 else 0 end)`,
			})
			.from(fileAttributions)
			.where(
				and(
					inArray(fileAttributions.narratorId, ids),
					inArray(fileAttributions.action, ["write", "edit"]),
				),
			)
			.groupBy(
				fileAttributions.narratorId,
				fileAttributions.filePath,
				fileAttributions.workspacePath,
			)
			.limit(MAX_AGGREGATED_FILES + 1);

		const truncated = rows.length > MAX_AGGREGATED_FILES;
		const kept = truncated ? rows.slice(0, MAX_AGGREGATED_FILES) : rows;

		for (const row of kept) {
			const owner = row.subagentNarratorId;
			if (!owner) continue;
			let entry = result.get(owner);
			if (!entry) {
				entry = { ...EMPTY, files: [] };
				result.set(owner, entry);
			}
			// Null means the parent's location is UNKNOWN (no explicit cwd), which suppresses
			// the claim rather than guessing — same rule as `resolveParentWorkspacePath`.
			const parentWorkspace = workspaceByChild.get(owner) ?? null;
			entry.files.push({
				subagentNarratorId: owner,
				filePath: row.filePath,
				linesAdded: row.linesAdded ?? null,
				linesRemoved: row.linesRemoved ?? null,
				editCount: Number(row.editCount) || 0,
				unmeasuredCount: Number(row.unmeasuredCount) || 0,
				outsideParentWorkspace: parentWorkspace ? row.workspacePath !== parentWorkspace : false,
			});
		}

		// Bash rows are counted per subagent and never listed — same rule as the
		// single-parent aggregate (see `bashTouchedCount`). Counted in SQL rather than by
		// collecting paths in JS, so the figure describes the whole set even when the
		// measured query above hit its limit.
		const bashRows = await db
			.select({
				subagentNarratorId: fileAttributions.narratorId,
				count: sql<number>`count(distinct ${fileAttributions.filePath})`,
			})
			.from(fileAttributions)
			.where(and(inArray(fileAttributions.narratorId, ids), eq(fileAttributions.action, "bash")))
			.groupBy(fileAttributions.narratorId);

		for (const row of bashRows) {
			const owner = row.subagentNarratorId;
			if (!owner) continue;
			let entry = result.get(owner);
			if (!entry) {
				entry = { ...EMPTY, files: [] };
				result.set(owner, entry);
			}
			entry.bashTouchedCount = Number(row.count) || 0;
		}

		// Truncation is attributed only to the subagents that could actually be affected.
		//
		// The limit is shared across the whole page, so a flat `truncated` would tell a
		// subagent with three files that its counts were capped at 2000 — a claim that is
		// both false and unactionable. Only the LAST owner in the returned order can have
		// had rows cut off, since the rows are contiguous per group; without a stable
		// ordering guarantee from SQLite, the conservative reading is "the owners present
		// in the final row", so that one owner is marked.
		const lastOwner = kept.at(-1)?.subagentNarratorId;
		for (const [owner, entry] of result) {
			sortByChurnDescending(entry.files);
			entry.totalFiles = entry.files.length;
			entry.totalUnmeasured = entry.files.reduce((sum, file) => sum + file.unmeasuredCount, 0);
			entry.countsTruncated = truncated && owner === lastOwner;
		}
		return result;
	} catch (err) {
		logger.debug("Failed to aggregate file changes by subagent", { error: String(err) });
		return result;
	}
}

/**
 * Largest change first.
 *
 * With a display cap downstream, ordering decides WHICH files survive it — so the
 * biggest edits must come first. Unmeasured rows sort last (they contribute 0 to the
 * key) rather than being dropped: they still name a file that changed.
 */
function sortByChurnDescending(files: SubagentChangedFile[]): void {
	files.sort((a, b) => {
		const churn = (f: SubagentChangedFile) => (f.linesAdded ?? 0) + (f.linesRemoved ?? 0);
		const diff = churn(b) - churn(a);
		return diff !== 0 ? diff : a.filePath.localeCompare(b.filePath);
	});
}

/**
 * The parent's own workspace path, normalized the way attribution rows store it.
 *
 * Needed to tell "this change is inside the workspace I can revert" from "this one
 * is not". It costs ONE indexed single-row read — not free, but the alternative is
 * staying silent about un-revertable changes.
 *
 * Only the narrator's explicit `cwd` is consulted. A chapter-bound narrator with no
 * explicit cwd resolves to null, and null means "location unknown", which suppresses
 * the outside-workspace claim entirely rather than guessing. Guessing wrong in the
 * permissive direction would tell the parent a change is revertable when it is not;
 * guessing in the strict direction would cry wolf on every ordinary change.
 */
/**
 * Parent workspace path for each of `childIds`, keyed by CHILD id.
 *
 * The batched counterpart of {@link resolveParentWorkspacePath}, and it must agree with
 * it exactly: the card and the injected block would otherwise classify the same change
 * two different ways. Same rule, same normalization, same treatment of a missing `cwd`
 * (absent from the map ⇒ "location unknown" ⇒ no outside-workspace claim).
 *
 * One query for the whole page: a self-join from the child row to its parent, so the
 * card path gains a single indexed lookup rather than one per card.
 */
async function resolveParentWorkspaceByChild(
	childIds: string[],
): Promise<Map<string, string | null>> {
	const byChild = new Map<string, string | null>();
	if (childIds.length === 0) return byChild;
	try {
		const parent = alias(narrators, "parent_narrator");
		const rows = await db
			.select({ childId: narrators.id, parentCwd: parent.cwd })
			.from(narrators)
			.innerJoin(parent, eq(parent.id, narrators.parentNarratorId))
			.where(inArray(narrators.id, childIds));
		for (const row of rows) {
			byChild.set(row.childId, row.parentCwd ? normalizeWorkspacePath(row.parentCwd) : null);
		}
	} catch (err) {
		// Location stays unknown, which suppresses the claim rather than inventing one.
		logger.debug("Failed to resolve parent workspaces for subagent cards", {
			error: String(err),
		});
	}
	return byChild;
}

async function resolveParentWorkspacePath(parentNarratorId: string): Promise<string | null> {
	try {
		const parent = await db.query.narrators.findFirst({
			where: eq(narrators.id, parentNarratorId),
			columns: { cwd: true },
		});
		return parent?.cwd ? normalizeWorkspacePath(parent.cwd) : null;
	} catch {
		return null;
	}
}

/**
 * Aggregate the file changes made by every subagent of `parentNarratorId`.
 *
 * Read-only and fault-tolerant: any failure resolves to an empty aggregate rather
 * than throwing. Callers run on paths that must not break because a summary could
 * not be produced (a subagent's result still has to reach its parent).
 *
 * @param parentWorkspacePath Normalized workspace path of the PARENT, used to flag
 *   changes that landed elsewhere. Omit to skip that classification (every row then
 *   reports `outsideParentWorkspace: false`, i.e. "not known to be outside").
 */
export async function getSubagentFileChanges(
	parentNarratorId: string,
	parentWorkspacePath?: string | null,
): Promise<SubagentFileChanges> {
	try {
		// Children of this parent. Narrow columns, one indexed lookup.
		const children = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.parentNarratorId, parentNarratorId));
		const childIds = children.map((child) => child.id);
		if (childIds.length === 0) return EMPTY;

		// Measured changes (Write/Edit), grouped per (subagent, file).
		//
		// `action` is restricted here rather than filtered afterwards so Bash rows never
		// enter the grouping at all — see `bashTouchedCount` for why they are counted
		// separately instead.
		const rows = await db
			.select({
				subagentNarratorId: fileAttributions.narratorId,
				filePath: fileAttributions.filePath,
				workspacePath: fileAttributions.workspacePath,
				linesAdded: sql<number | null>`sum(${fileAttributions.linesAdded})`,
				linesRemoved: sql<number | null>`sum(${fileAttributions.linesRemoved})`,
				editCount: sql<number>`count(*)`,
				// Counted in SQL, not derived from the returned page: a caller must be able
				// to say "3 of these were not measured" about the WHOLE set.
				unmeasuredCount: sql<number>`sum(case when ${fileAttributions.linesAdded} is null then 1 else 0 end)`,
			})
			.from(fileAttributions)
			.where(
				and(
					inArray(fileAttributions.narratorId, childIds),
					inArray(fileAttributions.action, ["write", "edit"]),
				),
			)
			.groupBy(
				fileAttributions.narratorId,
				fileAttributions.filePath,
				fileAttributions.workspacePath,
			)
			.limit(MAX_AGGREGATED_FILES + 1);

		const countsTruncated = rows.length > MAX_AGGREGATED_FILES;
		const kept = countsTruncated ? rows.slice(0, MAX_AGGREGATED_FILES) : rows;

		// Distinct files touched by shell commands. A COUNT only — the paths themselves
		// are not listed (see `bashTouchedCount`).
		const bashRows = await db
			.select({
				count: sql<number>`count(distinct ${fileAttributions.filePath})`,
			})
			.from(fileAttributions)
			.where(
				and(inArray(fileAttributions.narratorId, childIds), eq(fileAttributions.action, "bash")),
			);

		const files: SubagentChangedFile[] = kept.map((row) => ({
			subagentNarratorId: row.subagentNarratorId ?? "",
			filePath: row.filePath,
			linesAdded: row.linesAdded ?? null,
			linesRemoved: row.linesRemoved ?? null,
			editCount: Number(row.editCount) || 0,
			unmeasuredCount: Number(row.unmeasuredCount) || 0,
			outsideParentWorkspace: parentWorkspacePath
				? row.workspacePath !== parentWorkspacePath
				: false,
		}));

		sortByChurnDescending(files);

		return {
			files,
			totalFiles: files.length,
			totalUnmeasured: files.reduce((sum, file) => sum + file.unmeasuredCount, 0),
			bashTouchedCount: Number(bashRows[0]?.count) || 0,
			countsTruncated,
		};
	} catch (err) {
		logger.debug("Failed to aggregate subagent file changes", {
			parentNarratorId,
			error: String(err),
		});
		return EMPTY;
	}
}
