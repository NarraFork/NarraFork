/**
 * subagent-file-changes.test.ts — the parent-facing view of what its subagents wrote.
 *
 * The properties under test are the ones a wrong answer would make invisible:
 *
 *   1. UNMEASURED ≠ ZERO. `SUM` skips NULLs silently, so an aggregate that folds in
 *      unmeasured changes must report how many, and the counts must cover the WHOLE
 *      set rather than the displayed window. Getting this wrong produces a total that
 *      looks complete while omitting half its inputs.
 *   2. FIGURES ARE CHURN. Summing per file yields cumulative change, not the net
 *      difference from the original — so the wording must carry a qualifier whenever
 *      several edits were folded together. One subagent in real data edited a single
 *      file 80 times.
 *   3. BASH IS COUNTED, NOT LISTED. One real Bash call attributed 1556 files; listing
 *      them would drown the measured files and let the unmeasured tally dominate.
 *      Dropping them entirely would instead hide real disk changes from the parent.
 *   4. CHANGES OUTSIDE THE PARENT'S WORKSPACE SURVIVE ITS REVERT, and must say so.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { fileAttributions, narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
// The real module is captured and restored in `afterAll`: `mock.module` is
// PROCESS-GLOBAL in Bun, so leaving it installed hands this in-memory database to
// every other suite that runs afterwards in the same process — they then query a
// database with none of their fixtures in it and fail for no visible reason.
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const {
	appendSubagentFileChanges,
	formatSubagentFileChanges,
	getFileChangesBySubagent,
	getSubagentFileChanges,
	hasSubagentFileChanges,
	INJECTED_FILE_LIST_MAX,
	MAX_AGGREGATED_FILES,
} = await import("../subagent-file-changes");

const PARENT = "parent-1";
const WORKSPACE = "/repo";
const OTHER_WORKSPACE = "/elsewhere";

async function makeNarrator(id: string, parentNarratorId: string | null, cwd?: string) {
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		title: id,
		createdAt: now,
		updatedAt: now,
		...(cwd ? { cwd } : {}),
		...(parentNarratorId ? { parentNarratorId, type: "subagent" } : {}),
	});
}

let attributionSeq = 0;

async function attribute(over: {
	narratorId: string;
	filePath: string;
	action?: "write" | "edit" | "bash";
	linesAdded?: number | null;
	linesRemoved?: number | null;
	workspacePath?: string;
}) {
	attributionSeq += 1;
	await db.insert(fileAttributions).values({
		id: `attr-${attributionSeq}`,
		deviceId: "local",
		workspacePath: over.workspacePath ?? WORKSPACE,
		filePath: over.filePath,
		narratorId: over.narratorId,
		action: over.action ?? "edit",
		linesAdded: over.linesAdded ?? null,
		linesRemoved: over.linesRemoved ?? null,
		changedAt: new Date().toISOString(),
	});
}

beforeEach(async () => {
	await makeNarrator(PARENT, null);
	await makeNarrator("sub-a", PARENT);
	await makeNarrator("sub-b", PARENT);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

afterEach(() => {
	cleanDb(sqlite);
	attributionSeq = 0;
});

describe("getSubagentFileChanges — aggregation", () => {
	test("returns an empty aggregate when the parent has no subagents", async () => {
		const changes = await getSubagentFileChanges("no-such-parent");
		expect(changes.totalFiles).toBe(0);
		expect(hasSubagentFileChanges(changes)).toBe(false);
	});

	test("returns an empty aggregate when subagents changed nothing", async () => {
		expect(hasSubagentFileChanges(await getSubagentFileChanges(PARENT))).toBe(false);
	});

	test("aggregates across several subagents", async () => {
		await attribute({ narratorId: "sub-a", filePath: "a.ts", linesAdded: 10, linesRemoved: 2 });
		await attribute({ narratorId: "sub-b", filePath: "b.ts", linesAdded: 3, linesRemoved: 0 });
		const changes = await getSubagentFileChanges(PARENT);
		expect(changes.totalFiles).toBe(2);
		expect(changes.files.map((f) => f.filePath)).toEqual(["a.ts", "b.ts"]);
		expect(changes.files[0]?.subagentNarratorId).toBe("sub-a");
	});

	test("does not include another parent's subagents", async () => {
		await makeNarrator("other-parent", null);
		await makeNarrator("other-sub", "other-parent");
		await attribute({ narratorId: "other-sub", filePath: "leak.ts", linesAdded: 99 });
		expect((await getSubagentFileChanges(PARENT)).totalFiles).toBe(0);
	});

	test("sums repeated edits to one file as churn, with an edit count", async () => {
		// Property 2: three edits of +1/-1 each report +3 -3 — cumulative, not net.
		for (let i = 0; i < 3; i++) {
			await attribute({ narratorId: "sub-a", filePath: "hot.ts", linesAdded: 1, linesRemoved: 1 });
		}
		const [file] = (await getSubagentFileChanges(PARENT)).files;
		expect(file?.linesAdded).toBe(3);
		expect(file?.linesRemoved).toBe(3);
		expect(file?.editCount).toBe(3);
	});

	test("orders by churn descending so a display cap keeps the biggest changes", async () => {
		await attribute({ narratorId: "sub-a", filePath: "small.ts", linesAdded: 1, linesRemoved: 0 });
		await attribute({ narratorId: "sub-a", filePath: "big.ts", linesAdded: 100, linesRemoved: 50 });
		await attribute({ narratorId: "sub-a", filePath: "mid.ts", linesAdded: 10, linesRemoved: 0 });
		expect((await getSubagentFileChanges(PARENT)).files.map((f) => f.filePath)).toEqual([
			"big.ts",
			"mid.ts",
			"small.ts",
		]);
	});

	test("counts unmeasured changes over the whole set, not just measured files", async () => {
		// Property 1. A NULL row must not silently vanish into a clean-looking total.
		await attribute({ narratorId: "sub-a", filePath: "known.ts", linesAdded: 5, linesRemoved: 1 });
		await attribute({ narratorId: "sub-a", filePath: "unknown.ts", linesAdded: null });
		const changes = await getSubagentFileChanges(PARENT);
		expect(changes.totalUnmeasured).toBe(1);
		const unknown = changes.files.find((f) => f.filePath === "unknown.ts");
		expect(unknown?.linesAdded).toBeNull();
		expect(unknown?.unmeasuredCount).toBe(1);
	});

	test("keeps a file listed when only SOME of its changes were measured", async () => {
		await attribute({ narratorId: "sub-a", filePath: "mixed.ts", linesAdded: 4, linesRemoved: 1 });
		await attribute({ narratorId: "sub-a", filePath: "mixed.ts", linesAdded: null });
		const [file] = (await getSubagentFileChanges(PARENT)).files;
		// The measured half still counts; the unmeasured one is reported, not dropped.
		expect(file?.linesAdded).toBe(4);
		expect(file?.editCount).toBe(2);
		expect(file?.unmeasuredCount).toBe(1);
	});

	test("counts Bash-touched files separately and never lists them", async () => {
		// Property 3.
		await attribute({ narratorId: "sub-a", filePath: "edited.ts", linesAdded: 2 });
		await attribute({ narratorId: "sub-a", filePath: "shell-1.ts", action: "bash" });
		await attribute({ narratorId: "sub-a", filePath: "shell-2.ts", action: "bash" });
		// The same path touched twice by shell must not inflate the count.
		await attribute({ narratorId: "sub-a", filePath: "shell-2.ts", action: "bash" });
		const changes = await getSubagentFileChanges(PARENT);
		expect(changes.files.map((f) => f.filePath)).toEqual(["edited.ts"]);
		expect(changes.bashTouchedCount).toBe(2);
		// Bash rows carry no line data, so they must not swell the unmeasured tally of
		// the measured list either.
		expect(changes.totalUnmeasured).toBe(0);
	});

	test("a Bash-only subagent still reports something", async () => {
		await attribute({ narratorId: "sub-a", filePath: "built.js", action: "bash" });
		const changes = await getSubagentFileChanges(PARENT);
		expect(changes.totalFiles).toBe(0);
		expect(changes.bashTouchedCount).toBe(1);
		// Nothing measured, but the disk DID change — the parent must be told.
		expect(hasSubagentFileChanges(changes)).toBe(true);
	});

	test("flags changes outside the parent workspace", async () => {
		// Property 4: a `workdir` subagent writes into another worktree, which the
		// parent's tree-snapshot revert does not cover.
		await attribute({ narratorId: "sub-a", filePath: "in.ts", linesAdded: 1 });
		await attribute({
			narratorId: "sub-b",
			filePath: "out.ts",
			linesAdded: 1,
			workspacePath: OTHER_WORKSPACE,
		});
		const changes = await getSubagentFileChanges(PARENT, WORKSPACE);
		expect(changes.files.find((f) => f.filePath === "in.ts")?.outsideParentWorkspace).toBe(false);
		expect(changes.files.find((f) => f.filePath === "out.ts")?.outsideParentWorkspace).toBe(true);
	});

	test("claims nothing about location when the parent workspace is unknown", async () => {
		// Absent parent path must not be read as "everything is outside".
		await attribute({ narratorId: "sub-a", filePath: "x.ts", linesAdded: 1 });
		const changes = await getSubagentFileChanges(PARENT);
		expect(changes.files[0]?.outsideParentWorkspace).toBe(false);
	});
});

describe("getFileChangesBySubagent — the card projection", () => {
	// This function and `getSubagentFileChanges` answer the same question for two
	// audiences (a card, and text injected for the model). Where they disagree, the
	// card is the wrong answer the user actually sees — so the tests here are mostly
	// about the two agreeing.
	test("folds several actions on one file into a single row", async () => {
		// The regression this pins: grouping by `action` split a Write-then-Edit on the
		// same file into two rows, listing the path twice with each half of the figure and
		// double-counting it in `totalFiles`.
		await attribute({
			narratorId: "sub-a",
			filePath: "a.ts",
			action: "write",
			linesAdded: 10,
			linesRemoved: 0,
		});
		await attribute({
			narratorId: "sub-a",
			filePath: "a.ts",
			action: "edit",
			linesAdded: 4,
			linesRemoved: 3,
		});

		const byId = await getFileChangesBySubagent(["sub-a"]);
		const entry = byId.get("sub-a");

		expect(entry?.files.map((f) => f.filePath)).toEqual(["a.ts"]);
		expect(entry?.totalFiles).toBe(1);
		// Summed across both actions, matching what the injected text reports.
		expect(entry?.files[0]?.linesAdded).toBe(14);
		expect(entry?.files[0]?.linesRemoved).toBe(3);
		expect(entry?.files[0]?.editCount).toBe(2);
	});

	test("agrees with the injected-text aggregate on the same data", async () => {
		await attribute({
			narratorId: "sub-a",
			filePath: "a.ts",
			action: "write",
			linesAdded: 10,
			linesRemoved: 0,
		});
		await attribute({
			narratorId: "sub-a",
			filePath: "a.ts",
			action: "edit",
			linesAdded: 4,
			linesRemoved: 3,
		});
		await attribute({ narratorId: "sub-b", filePath: "b.ts", linesAdded: 3 });

		const injected = await getSubagentFileChanges(PARENT);
		const byId = await getFileChangesBySubagent(["sub-a", "sub-b"]);

		const cardTotal = [...byId.values()].reduce((sum, entry) => sum + entry.totalFiles, 0);
		expect(cardTotal).toBe(injected.totalFiles);
	});

	test("counts shell-touched files without listing them", async () => {
		await attribute({ narratorId: "sub-a", filePath: "built.js", action: "bash" });
		await attribute({ narratorId: "sub-a", filePath: "built.js", action: "bash" });
		await attribute({ narratorId: "sub-a", filePath: "other.js", action: "bash" });

		const entry = (await getFileChangesBySubagent(["sub-a"])).get("sub-a");

		// Distinct paths, not attribution rows.
		expect(entry?.bashTouchedCount).toBe(2);
		expect(entry?.files).toEqual([]);
	});

	test("does not mark an unaffected subagent's counts as truncated", async () => {
		// A shared limit must not make a subagent with one file claim its counts were
		// capped at 2000 — a statement that is both false and unactionable.
		await attribute({ narratorId: "sub-a", filePath: "one.ts", linesAdded: 1 });

		const entry = (await getFileChangesBySubagent(["sub-a", "sub-b"])).get("sub-a");

		expect(entry?.countsTruncated).toBe(false);
	});

	test("omits subagents that changed nothing rather than mapping them to zero", async () => {
		await attribute({ narratorId: "sub-a", filePath: "a.ts", linesAdded: 1 });

		const byId = await getFileChangesBySubagent(["sub-a", "sub-b"]);

		expect(byId.has("sub-a")).toBe(true);
		expect(byId.has("sub-b")).toBe(false);
	});

	/**
	 * THE CARD MUST CLASSIFY LOCATION, LIKE THE INJECTED TEXT DOES.
	 *
	 * This was hard-coded to `false`, which made the two outlets contradict each other on
	 * the one fact that decides whether a revert helps: the injected block warned "⚠ N
	 * file(s) outside this workspace — a revert here will not restore them" while the card
	 * next to it showed the same files unmarked. The user reads the card.
	 */
	test("marks a change that landed outside the parent's workspace", async () => {
		// The parent must have a cwd for the classification to be possible at all; a
		// `workdir` subagent then writes into a different worktree.
		cleanDb(sqlite);
		await makeNarrator(PARENT, null, WORKSPACE);
		await makeNarrator("sub-a", PARENT);
		await makeNarrator("sub-b", PARENT);
		await attribute({ narratorId: "sub-a", filePath: "in.ts", linesAdded: 1 });
		await attribute({
			narratorId: "sub-b",
			filePath: "out.ts",
			linesAdded: 1,
			workspacePath: OTHER_WORKSPACE,
		});

		const byId = await getFileChangesBySubagent(["sub-a", "sub-b"]);

		expect(byId.get("sub-a")?.files[0]?.outsideParentWorkspace).toBe(false);
		expect(byId.get("sub-b")?.files[0]?.outsideParentWorkspace).toBe(true);
	});

	test("agrees with the injected text on which changes are outside", async () => {
		// The two outlets must reach the SAME verdict from the same rows — that agreement,
		// not either value alone, is the property worth pinning.
		cleanDb(sqlite);
		await makeNarrator(PARENT, null, WORKSPACE);
		await makeNarrator("sub-a", PARENT);
		await makeNarrator("sub-b", PARENT);
		await attribute({ narratorId: "sub-a", filePath: "in.ts", linesAdded: 1 });
		await attribute({
			narratorId: "sub-b",
			filePath: "out.ts",
			linesAdded: 1,
			workspacePath: OTHER_WORKSPACE,
		});

		const injected = await getSubagentFileChanges(PARENT, WORKSPACE);
		const byId = await getFileChangesBySubagent(["sub-a", "sub-b"]);

		const cardVerdicts = new Map(
			[...byId.values()].flatMap((entry) =>
				entry.files.map((f) => [f.filePath, f.outsideParentWorkspace] as const),
			),
		);
		for (const file of injected.files) {
			expect(cardVerdicts.get(file.filePath)).toBe(file.outsideParentWorkspace);
		}
		// Guard against the assertion above passing on an empty set.
		expect(cardVerdicts.size).toBe(2);
		expect([...cardVerdicts.values()].sort()).toEqual([false, true]);
	});

	test("claims nothing about location when the parent has no workspace", async () => {
		// Unknown must not be read as "outside": that would cry wolf on every ordinary
		// change made by a chapter-bound narrator with no explicit cwd.
		await attribute({ narratorId: "sub-a", filePath: "a.ts", linesAdded: 1 });

		const byId = await getFileChangesBySubagent(["sub-a"]);

		expect(byId.get("sub-a")?.files[0]?.outsideParentWorkspace).toBe(false);
	});
});

describe("formatSubagentFileChanges — model-facing block", () => {
	const file = (over: Partial<Parameters<typeof formatFileFixture>[0]> = {}) =>
		formatFileFixture(over);
	function formatFileFixture(over: {
		filePath?: string;
		linesAdded?: number | null;
		linesRemoved?: number | null;
		editCount?: number;
		unmeasuredCount?: number;
		outsideParentWorkspace?: boolean;
	}) {
		return {
			subagentNarratorId: "sub-a",
			filePath: over.filePath ?? "a.ts",
			linesAdded: over.linesAdded === undefined ? 1 : over.linesAdded,
			linesRemoved: over.linesRemoved === undefined ? 0 : over.linesRemoved,
			editCount: over.editCount ?? 1,
			unmeasuredCount: over.unmeasuredCount ?? 0,
			outsideParentWorkspace: over.outsideParentWorkspace ?? false,
		};
	}
	const aggregate = (over: Partial<ReturnType<typeof baseAggregate>> = {}) => ({
		...baseAggregate(),
		...over,
	});
	function baseAggregate() {
		return {
			files: [] as ReturnType<typeof formatFileFixture>[],
			totalFiles: 0,
			totalUnmeasured: 0,
			bashTouchedCount: 0,
			countsTruncated: false,
		};
	}

	test("renders nothing when the subagent changed nothing", () => {
		expect(formatSubagentFileChanges(aggregate())).toBe("");
	});

	test("lists a single change without a churn qualifier", () => {
		const text = formatSubagentFileChanges(
			aggregate({
				files: [file({ filePath: "w.ts", linesAdded: 42, linesRemoved: 3 })],
				totalFiles: 1,
			}),
		);
		expect(text).toContain("w.ts +42 -3");
		// One change means churn == net difference, so the qualifier would be noise.
		expect(text).not.toContain("across");
		expect(text).not.toContain("cumulative");
	});

	test("qualifies figures that fold several edits together", () => {
		const text = formatSubagentFileChanges(
			aggregate({
				files: [file({ filePath: "w.ts", linesAdded: 42, linesRemoved: 3, editCount: 3 })],
				totalFiles: 1,
			}),
		);
		expect(text).toContain("w.ts +42 -3 across 3 edits");
		// Stated BEFORE the numbers, so a reader cannot absorb the figures first.
		const noticeAt = text.indexOf("cumulative across edits");
		expect(noticeAt).toBeGreaterThan(-1);
		expect(noticeAt).toBeLessThan(text.indexOf("+42 -3"));
	});

	test("says a file's lines were not measured instead of showing zeros", () => {
		const text = formatSubagentFileChanges(
			aggregate({
				files: [file({ filePath: "bin.dat", linesAdded: null, linesRemoved: null })],
				totalFiles: 1,
				totalUnmeasured: 1,
			}),
		);
		expect(text).toContain("bin.dat (lines not measured)");
		expect(text).not.toContain("+0 -0");
	});

	test("caps the list and reports the real remainder", () => {
		const files = Array.from({ length: INJECTED_FILE_LIST_MAX + 5 }, (_, i) =>
			file({ filePath: `f${i}.ts` }),
		);
		const text = formatSubagentFileChanges(aggregate({ files, totalFiles: files.length }));
		expect(text).toContain("…and 5 more files");
		expect(text).toContain("f0.ts");
		expect(text).not.toContain(`f${INJECTED_FILE_LIST_MAX}.ts`);
	});

	test("carries the unmeasured tally into the overflow line", () => {
		const files = Array.from({ length: INJECTED_FILE_LIST_MAX + 2 }, (_, i) =>
			file({ filePath: `f${i}.ts` }),
		);
		const text = formatSubagentFileChanges(
			aggregate({ files, totalFiles: files.length, totalUnmeasured: 3 }),
		);
		// The tally covers the whole set, including the hidden files.
		expect(text).toContain("…and 2 more files (3 not measured)");
	});

	test("still discloses unmeasured changes when every listed file shows figures", () => {
		// The trap: all visible rows look measured, so an omitted tally would read as a
		// complete summary.
		const text = formatSubagentFileChanges(
			aggregate({
				files: [
					file({
						filePath: "a.ts",
						linesAdded: 5,
						linesRemoved: 1,
						editCount: 2,
						unmeasuredCount: 1,
					}),
				],
				totalFiles: 1,
				totalUnmeasured: 1,
			}),
		);
		expect(text).toContain("no line measurement");
	});

	test("reports shell-touched files as a count", () => {
		const text = formatSubagentFileChanges(
			aggregate({ files: [file()], totalFiles: 1, bashTouchedCount: 5 }),
		);
		expect(text).toContain("plus 5 file(s) touched by shell commands (lines not measured)");
	});

	test("warns that changes outside the workspace survive a revert", () => {
		const text = formatSubagentFileChanges(
			aggregate({
				files: [file({ outsideParentWorkspace: true }), file({ filePath: "b.ts" })],
				totalFiles: 2,
			}),
		);
		expect(text).toContain("1 file(s) outside this workspace");
		expect(text).toContain("will not restore them");
	});

	test("discloses a truncated count", () => {
		const text = formatSubagentFileChanges(
			aggregate({ files: [file()], totalFiles: 1, countsTruncated: true }),
		);
		expect(text).toContain(`counts truncated at ${MAX_AGGREGATED_FILES}`);
	});
});

describe("appendSubagentFileChanges", () => {
	test("appends the block to a result", async () => {
		await attribute({ narratorId: "sub-a", filePath: "w.ts", linesAdded: 4, linesRemoved: 1 });
		const text = await appendSubagentFileChanges(PARENT, WORKSPACE, "all done");
		expect(text.startsWith("all done")).toBe(true);
		expect(text).toContain("<subagent_file_changes>");
		expect(text).toContain("w.ts +4 -1");
	});

	test("leaves the result untouched when nothing changed", async () => {
		expect(await appendSubagentFileChanges(PARENT, WORKSPACE, "all done")).toBe("all done");
	});

	/**
	 * The crash outlet wraps the ERROR text. A failed summary must never replace a
	 * diagnosable failure with a mysterious one.
	 */
	test("preserves the original text when aggregation fails", async () => {
		const errorText = "Subagent error: boom";
		expect(await appendSubagentFileChanges("no-such-parent", WORKSPACE, errorText)).toBe(errorText);
	});
});

/**
 * Two sources answer "what did my subagents change", deliberately:
 *
 *   - `subagent-team.ts` keeps an in-memory parent→subagent→paths set, read by the
 *     TeamStatus tool. Process-local, no line counts, cleared on restart — it exists
 *     so a RUNNING parent can coordinate cheaply (a synchronous map read, callable
 *     several times per turn).
 *   - this module aggregates persisted attributions WITH line counts, for the UI, the
 *     revert warning, and the end-of-run injection.
 *
 * Keeping both is a cost decision (routing TeamStatus through SQL would put a query
 * on a hot path), but two sources of one fact is exactly how drift starts. This test
 * pins the overlap: a file recorded by the tool chain must be visible in BOTH.
 */
describe("in-memory TeamStatus source and the DB aggregate agree", () => {
	test("a file recorded for a subagent appears in both sources", async () => {
		const { recordTeamFileChange, getTeamFileChanges, clearTeamFileChanges } = await import(
			"../subagent-team"
		);
		clearTeamFileChanges(PARENT);

		// One change, recorded the way `trackFileChange` records it: the in-memory team
		// map AND an attribution row.
		recordTeamFileChange(PARENT, "sub-a", "src/shared.ts");
		await attribute({
			narratorId: "sub-a",
			filePath: "src/shared.ts",
			linesAdded: 7,
			linesRemoved: 2,
		});

		const inMemory = getTeamFileChanges(PARENT);
		expect(inMemory.get("sub-a")?.has("src/shared.ts")).toBe(true);

		const aggregate = await getSubagentFileChanges(PARENT);
		const file = aggregate.files.find((f) => f.filePath === "src/shared.ts");
		expect(file).toBeDefined();
		// The DB side additionally carries the figures the in-memory side cannot.
		expect(file?.linesAdded).toBe(7);
		expect(file?.linesRemoved).toBe(2);

		clearTeamFileChanges(PARENT);
	});

	test("the in-memory source is scoped per parent, like the aggregate", async () => {
		const { recordTeamFileChange, getTeamFileChanges, clearTeamFileChanges } = await import(
			"../subagent-team"
		);
		clearTeamFileChanges(PARENT);
		clearTeamFileChanges("other-parent");

		recordTeamFileChange("other-parent", "other-sub", "theirs.ts");
		expect(getTeamFileChanges(PARENT).size).toBe(0);
		expect((await getSubagentFileChanges(PARENT)).totalFiles).toBe(0);

		clearTeamFileChanges("other-parent");
	});
});
