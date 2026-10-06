/**
 * subagent-revert-coverage.guard.test.ts — a subagent's writes must be revertable by
 * its parent, and where they are NOT, that must be visible.
 *
 * WHY THIS EXISTS
 * ---------------
 * A subagent has its own narrator record, so "can the parent undo what its child
 * wrote?" is not obviously yes. It currently IS yes, but only because of a property
 * nothing tests: workspace tree snapshots are keyed by WORKTREE PATH, not by narrator
 * id, and a subagent inherits its parent's cwd by default. The snapshot hashes real
 * bytes, so it captures whoever wrote them.
 *
 * That makes the coverage a side effect of a design choice made elsewhere. If someone
 * re-keyed snapshots per narrator — a plausible "isolation" improvement — subagent
 * writes would silently stop being revertable: no error, no failing test, just an
 * undo that quietly leaves the child's edits on disk. This guard is what turns that
 * into a red test.
 *
 * The second half covers the exception. `task.ts` accepts a `workdir`, and such a
 * subagent writes into a DIFFERENT worktree, which the parent's revert genuinely does
 * not reach (2.5% of subagents in this repository's own data). There the requirement
 * inverts: the aggregate must FLAG it, because a parent that assumes a clean undo is
 * available is worse off than one told the truth.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { fileAttributions, narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
// The real module is captured and restored in `afterAll`: `mock.module` is
// PROCESS-GLOBAL in Bun, so leaving it installed hands this in-memory database to
// every other suite that runs afterwards in the same process — they then query a
// database with none of their fixtures in it and fail for no visible reason.
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { getSubagentFileChanges } = await import("../subagent-file-changes");

const PARENT = "revert-parent";
const PARENT_WORKSPACE = "/repo";
const OTHER_WORKSPACE = "/tmp/scratch";

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

let seq = 0;
async function attribute(narratorId: string, filePath: string, workspacePath: string) {
	seq += 1;
	await db.insert(fileAttributions).values({
		id: `rv-${seq}`,
		deviceId: "local",
		workspacePath,
		filePath,
		narratorId,
		action: "edit",
		linesAdded: 2,
		linesRemoved: 1,
		changedAt: new Date().toISOString(),
	});
}

beforeEach(async () => {
	await makeNarrator(PARENT, null, PARENT_WORKSPACE);
	await makeNarrator("sub-inside", PARENT, PARENT_WORKSPACE);
	await makeNarrator("sub-outside", PARENT, OTHER_WORKSPACE);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

afterEach(() => {
	cleanDb(sqlite);
	seq = 0;
});

describe("tree snapshots are keyed by worktree, not by narrator", () => {
	/**
	 * The structural reason subagent writes are revertable at all. Asserted against the
	 * SOURCE because it is an API-shape property: the snapshot entry points take a
	 * worktree path and a device, and no narrator id. Adding one would be the moment
	 * this coverage breaks, and it would break silently.
	 */
	test("the snapshot API takes a worktree path and never a narrator id", () => {
		const source = readFileSync(join(import.meta.dir, "..", "worktree-tree-snapshot.ts"), "utf-8");
		// The exported surface, from `export const worktreeTreeSnapshot = {` onward.
		const apiStart = source.indexOf("export const worktreeTreeSnapshot = {");
		expect(apiStart).toBeGreaterThan(-1);
		const api = source.slice(apiStart);
		expect(api).toContain("worktreePath: string");
		// A narrator-scoped parameter here would mean per-narrator snapshots, i.e. a
		// parent revert that no longer covers its children.
		expect(api).not.toContain("narratorId: string");
	});

	/**
	 * The behavioural half of the same property: subagents share the parent's cwd, so
	 * their changes are recorded against the parent's workspace and fall inside the
	 * tree the parent restores.
	 */
	test("a subagent's writes land in the parent's workspace by default", async () => {
		await attribute("sub-inside", "src/worker.ts", PARENT_WORKSPACE);
		const changes = await getSubagentFileChanges(PARENT, PARENT_WORKSPACE);
		const file = changes.files.find((f) => f.filePath === "src/worker.ts");
		expect(file).toBeDefined();
		// Inside → the parent's revert reaches it, so nothing is flagged.
		expect(file?.outsideParentWorkspace).toBe(false);
	});
});

describe("changes outside the parent workspace are flagged, not assumed away", () => {
	test("a workdir subagent's writes are marked un-revertable", async () => {
		await attribute("sub-outside", "scratch/notes.md", OTHER_WORKSPACE);
		const changes = await getSubagentFileChanges(PARENT, PARENT_WORKSPACE);
		const file = changes.files.find((f) => f.filePath === "scratch/notes.md");
		expect(file).toBeDefined();
		expect(file?.outsideParentWorkspace).toBe(true);
	});

	test("both kinds are distinguished within one parent", async () => {
		// The realistic mixed case: the flag must be per FILE, not per parent, or a
		// single stray change would either taint every row or be lost among them.
		await attribute("sub-inside", "src/worker.ts", PARENT_WORKSPACE);
		await attribute("sub-outside", "scratch/notes.md", OTHER_WORKSPACE);
		const changes = await getSubagentFileChanges(PARENT, PARENT_WORKSPACE);
		expect(changes.totalFiles).toBe(2);
		const flagged = changes.files.filter((f) => f.outsideParentWorkspace);
		expect(flagged.map((f) => f.filePath)).toEqual(["scratch/notes.md"]);
	});

	test("the injected block warns about them explicitly", async () => {
		const { formatSubagentFileChanges } = await import("../subagent-file-changes");
		await attribute("sub-outside", "scratch/notes.md", OTHER_WORKSPACE);
		const text = formatSubagentFileChanges(await getSubagentFileChanges(PARENT, PARENT_WORKSPACE));
		// Silence here is the one unacceptable outcome: the parent would believe a clean
		// undo is available.
		expect(text).toContain("outside this workspace");
		expect(text).toContain("will not restore them");
	});
});
