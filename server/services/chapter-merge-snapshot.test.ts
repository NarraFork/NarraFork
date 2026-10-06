/**
 * Commit-free merging, its conflict lifecycle, and undoing it.
 *
 * The cases are organised around the failure modes that make this feature dangerous
 * rather than around its API surface:
 *
 *   - a merge that discards work the user never committed,
 *   - a conflict check that cannot actually see conflicts (the reason
 *     `--diff-filter=U` is unusable here), and
 *   - an unmerge that hands back a chapter missing everything uncommitted.
 *
 * Everything runs against real git worktrees and real shadow repositories, because the
 * question in every case is whether the git-level pieces compose correctly.
 */
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../tests/setup";
import { chapters, mergeSessions, projects } from "../db/schema";
import { generateId } from "../lib/id";
import { getNarraforkPath } from "../lib/narrafork-home";
import { safeSpawn } from "../lib/spawn";

// Exercise real Git worktrees and shadow repositories, but keep session metadata
// in the standard isolated SQLite fixture. Importing the runtime database here
// would couple filesystem safety tests to unrelated startup migrations.
const { db, sqlite } = getTestDb();
const database = {
	db,
	sqlite,
	activeDatabaseBackend: "sqlite" as const,
	startupShutdownState: { canSkipVerification: true },
	markDatabaseCleanShutdown: () => true,
	releaseDatabaseInstanceLockOnly: () => {},
};
mock.module("../db", () => database);
mock.module("@server/db", () => database);
const { chapterBatchMerge } = await import("./chapter-batch-merge");
const { chapterCleanup } = await import("./chapter-cleanup");
const { chapterMerge } = await import("./chapter-merge");
const {
	abortSnapshotMerge,
	detectRemainingConflicts,
	materializeConflicts,
	planSnapshotMerge,
	restoreSourceSnapshot,
} = await import("./chapter-merge-snapshot");
const { ensureChapterSnapshot } = await import("./chapter-snapshot-ref");
const { gitService } = await import("./git-service");
const { treeSnapshotKey, worktreeTreeSnapshot } = await import("./worktree-tree-snapshot");
afterAll(() => mock.restore());

const tempDirs: string[] = [];
const createdProjects: string[] = [];
/**
 * Merge sessions created directly by the interactive-lifecycle cases.
 *
 * Removed in `afterEach` because `cleanupStaleSessions` scans the WHOLE table: a row
 * left behind here would be picked up by an unrelated suite's startup sweep.
 * Startup may invalidate old sessions, but must never restore their worktrees.
 */
const createdSessions: string[] = [];

const BASE_FILE = "app.txt";
const BASE_CONTENT = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";

function present<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

/** A project with a trunk chapter and one branch chapter, both on linked worktrees. */
async function createMergePair(): Promise<{
	projectId: string;
	gitPath: string;
	target: { id: string; worktree: string };
	source: { id: string; worktree: string };
}> {
	const gitPath = mkdtempSync(join(tmpdir(), "nf-msnap-"));
	tempDirs.push(gitPath);
	await git(["init"], gitPath);
	await git(["config", "user.email", "test@example.com"], gitPath);
	await git(["config", "user.name", "Test"], gitPath);
	writeFileSync(join(gitPath, BASE_FILE), BASE_CONTENT);
	await git(["add", "-A"], gitPath);
	await git(["commit", "-m", "seed"], gitPath);

	const now = new Date().toISOString();
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Snapshot merge project",
		gitPath,
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(projectId);

	const make = async (label: string, role: "trunk" | "branch") => {
		const suffix = `${label}-${generateId().slice(0, 6)}`;
		const branch = `chapter/${suffix}`;
		const worktree = resolve(gitPath, ".worktrees", suffix);
		const added = await safeSpawn({
			cmd: ["git", "worktree", "add", worktree, "-b", branch],
			cwd: gitPath,
			timeout: 15_000,
		});
		if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
		tempDirs.push(worktree);
		const id = generateId();
		await db.insert(chapters).values({
			id,
			projectId,
			title: label,
			branch,
			baseBranch: "main",
			worktreePath: worktree,
			status: "active",
			role,
			createdAt: now,
			updatedAt: now,
		});
		return { id, worktree };
	};

	const target = await make("trunk", "trunk");
	const source = await make("feature", "branch");
	return { projectId, gitPath, target, source };
}

async function chapterRow(id: string) {
	const row = await db.query.chapters.findFirst({ where: eq(chapters.id, id) });
	return present(row, `chapter ${id}`);
}

afterEach(async () => {
	for (const sessionId of createdSessions.splice(0)) {
		await db.delete(mergeSessions).where(eq(mergeSessions.id, sessionId));
	}
	for (const projectId of createdProjects) {
		const rows = await db
			.select({ id: chapters.id, worktreePath: chapters.worktreePath })
			.from(chapters)
			.where(eq(chapters.projectId, projectId));
		for (const row of rows) {
			if (row.worktreePath) {
				await worktreeTreeSnapshot
					.destroy(row.worktreePath, undefined, { force: true })
					.catch(() => {});
			}
			await db.delete(chapters).where(eq(chapters.id, row.id));
		}
	}
	for (const projectId of createdProjects.splice(0)) {
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const dir of tempDirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir, undefined, { force: true }).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("merging uncommitted chapters", () => {
	test("merges two dirty chapters without adding a commit to the user's history", async () => {
		const env = await createMergePair();
		const commitsBefore = await git(["rev-list", "--count", "HEAD"], env.target.worktree);

		// Neither side commits anything.
		writeFileSync(join(env.target.worktree, BASE_FILE), BASE_CONTENT.replace("l1", "l1-trunk"));
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		writeFileSync(join(env.source.worktree, "feature.txt"), "new from feature\n");

		const result = await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id });
		expect(result.success).toBe(true);

		const merged = readFileSync(join(env.target.worktree, BASE_FILE), "utf-8");
		expect(merged).toContain("l1-trunk");
		expect(merged).toContain("l9-feature");
		expect(existsSync(join(env.target.worktree, "feature.txt"))).toBe(true);

		// The point of the whole exercise: no commit was demanded, so none was made.
		expect(await git(["rev-list", "--count", "HEAD"], env.target.worktree)).toBe(commitsBefore);
		const row = await chapterRow(env.source.id);
		expect(row.status).toBe("merged");
		expect(row.mergeSnapshotCommitSha).toBeTruthy();
		// Left null deliberately: it means "a real git merge commit" to its readers.
		expect(row.mergeCommitSha).toBeNull();
	});

	test("keeps an unrelated file the target gained while the merge was being prepared", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		// Present on disk but never part of any earlier snapshot. Without a fresh capture
		// of the target it would fall outside the merged tree and be lost.
		writeFileSync(join(env.target.worktree, "user-notes.txt"), "typed by the user\n");

		const result = await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id });
		expect(result.success).toBe(true);
		expect(readFileSync(join(env.target.worktree, "user-notes.txt"), "utf-8")).toBe(
			"typed by the user\n",
		);
	});

	test("reports a conflict without writing anything to the worktree", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.target.worktree, BASE_FILE), BASE_CONTENT.replace("l5", "l5-TRUNK"));
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l5", "l5-FEATURE"));

		const result = await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id });
		expect(result.success).toBe(false);
		expect(result.conflictFiles).toEqual([BASE_FILE]);

		// A conflicted tree carries markers; writing it out unasked would corrupt the file.
		const onDisk = readFileSync(join(env.target.worktree, BASE_FILE), "utf-8");
		expect(onDisk).toContain("l5-TRUNK");
		expect(onDisk).not.toContain("<<<<<<<");
		// And the source chapter is untouched, so the merge can be retried.
		expect((await chapterRow(env.source.id)).status).toBe("active");
	});

	test("the conflict preview agrees with what the merge actually does", async () => {
		const env = await createMergePair();
		// Only uncommitted state conflicts. A tip-comparing check sees nothing here,
		// which is how the old preview could promise a clean merge and then fail.
		writeFileSync(join(env.target.worktree, BASE_FILE), BASE_CONTENT.replace("l5", "l5-TRUNK"));
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l5", "l5-FEATURE"));

		const check = await chapterMerge.checkConflicts(env.source.id, env.target.id);
		expect(check.hasConflicts).toBe(true);
		expect(check.conflictFiles).toEqual([BASE_FILE]);

		const result = await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id });
		expect(result.success).toBe(false);
		expect(result.conflictFiles).toEqual(check.conflictFiles);
	});
});

describe("conflict lifecycle", () => {
	test("detects markers per file, so a partial resolution is not read as complete", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.target.worktree, "a.txt"), "x\nTRUNK\nz\n");
		writeFileSync(join(env.target.worktree, "b.txt"), "x\nTRUNK\nz\n");
		await ensureChapterSnapshot(env.target.worktree);
		await worktreeTreeSnapshot.restoreInto(
			env.target.worktree,
			env.source.worktree,
			present(await ensureChapterSnapshot(env.target.worktree), "target snapshot").treeHash,
		);
		writeFileSync(join(env.target.worktree, "a.txt"), "x\nTRUNK-EDIT\nz\n");
		writeFileSync(join(env.target.worktree, "b.txt"), "x\nTRUNK-EDIT\nz\n");
		writeFileSync(join(env.source.worktree, "a.txt"), "x\nFEATURE-EDIT\nz\n");
		writeFileSync(join(env.source.worktree, "b.txt"), "x\nFEATURE-EDIT\nz\n");

		const source = await chapterRow(env.source.id);
		const target = await chapterRow(env.target.id);
		const plan = await planSnapshotMerge(source, target);
		expect(plan.conflicts.sort()).toEqual(["a.txt", "b.txt"]);

		await materializeConflicts(env.target.worktree, plan);
		// Both are unresolved, and this must be reported — the git-state query would
		// return nothing here and declare the merge finished.
		expect((await detectRemainingConflicts(env.target.worktree, plan.conflicts)).sort()).toEqual([
			"a.txt",
			"b.txt",
		]);

		writeFileSync(join(env.target.worktree, "a.txt"), "x\nRESOLVED\nz\n");
		expect(await detectRemainingConflicts(env.target.worktree, plan.conflicts)).toEqual(["b.txt"]);

		writeFileSync(join(env.target.worktree, "b.txt"), "x\nRESOLVED\nz\n");
		expect(await detectRemainingConflicts(env.target.worktree, plan.conflicts)).toEqual([]);
	});

	test("a deleted conflict file counts as resolved", async () => {
		const env = await createMergePair();
		const missing = join(env.target.worktree, "never-existed.txt");
		expect(existsSync(missing)).toBe(false);
		expect(await detectRemainingConflicts(env.target.worktree, ["never-existed.txt"])).toEqual([]);
	});

	test("aborting restores the exact pre-merge bytes, untracked files included", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.target.worktree, BASE_FILE), BASE_CONTENT.replace("l5", "l5-TRUNK"));
		// Untracked at merge time. `git merge --abort` has no obligation to preserve this;
		// a snapshot restore does, because it restores recorded bytes rather than git state.
		writeFileSync(join(env.target.worktree, "scratch.txt"), "unstaged scratch\n");
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l5", "l5-FEATURE"));

		const source = await chapterRow(env.source.id);
		const target = await chapterRow(env.target.id);
		const plan = await planSnapshotMerge(source, target);
		expect(plan.conflicts).toEqual([BASE_FILE]);

		await materializeConflicts(env.target.worktree, plan);
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).toContain("<<<<<<<");

		await abortSnapshotMerge(env.target.worktree, plan.preMergeTree);
		const restored = readFileSync(join(env.target.worktree, BASE_FILE), "utf-8");
		expect(restored).not.toContain("<<<<<<<");
		expect(restored).toContain("l5-TRUNK");
		expect(readFileSync(join(env.target.worktree, "scratch.txt"), "utf-8")).toBe(
			"unstaged scratch\n",
		);
		expect(await worktreeTreeSnapshot.capture(env.target.worktree)).toBe(plan.preMergeTree);
	});
});

describe("undoing a commit-free merge", () => {
	test("reverses the source's contribution while keeping the target's later work", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		expect(
			(await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id })).success,
		).toBe(true);

		// The target keeps working after the merge — the case the commit path needs a
		// revert (not a reset) for.
		writeFileSync(
			join(env.target.worktree, BASE_FILE),
			readFileSync(join(env.target.worktree, BASE_FILE), "utf-8").replace("l4", "l4-after-merge"),
		);

		const result = await chapterMerge.unmerge(env.source.id);
		expect(result.ok).toBe(true);

		const after = readFileSync(join(env.target.worktree, BASE_FILE), "utf-8");
		expect(after).not.toContain("l9-feature"); // source contribution reversed
		expect(after).toContain("l4-after-merge"); // target's own later work kept
	});

	test("gives the source chapter back its uncommitted work", async () => {
		const env = await createMergePair();
		// Modified and brand-new content, none of it committed.
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		writeFileSync(join(env.source.worktree, "only-in-source.txt"), "uncommitted extra\n");
		expect(
			(await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id })).success,
		).toBe(true);

		const result = await chapterMerge.unmerge(env.source.id);
		expect(result.warning).toBeUndefined();

		const row = await chapterRow(env.source.id);
		expect(row.status).toBe("active");
		const restoredPath = present(row.worktreePath, "restored source worktree");
		tempDirs.push(restoredPath);

		// Recreating the worktree from the branch alone would give back only the last
		// commit — the merge never advanced the branch, so this is the real test.
		expect(readFileSync(join(restoredPath, BASE_FILE), "utf-8")).toContain("l9-feature");
		expect(readFileSync(join(restoredPath, "only-in-source.txt"), "utf-8")).toBe(
			"uncommitted extra\n",
		);
		// And it comes back as uncommitted work, not as a commit made behind their back.
		expect(await git(["status", "--porcelain"], restoredPath)).toContain(BASE_FILE);
	});

	test("clears every coordinate of the dissolved merge", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id });
		await chapterMerge.unmerge(env.source.id);

		const row = await chapterRow(env.source.id);
		tempDirs.push(present(row.worktreePath, "restored worktree"));
		// A leftover coordinate would route a later unmerge into the snapshot path using
		// data from a merge that no longer exists.
		expect(row.mergeSnapshotCommitSha).toBeNull();
		expect(row.preMergeTargetSnapshotSha).toBeNull();
		expect(row.mergedSourceSnapshotSha).toBeNull();
		expect(row.preMergeTargetSha).toBeNull();
		expect(row.mergedIntoChapterId).toBeNull();
	});

	test("refuses to unmerge when the target rewrote the lines being reversed", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id });

		// The target edits the very line the source contributed.
		writeFileSync(
			join(env.target.worktree, BASE_FILE),
			readFileSync(join(env.target.worktree, BASE_FILE), "utf-8").replace(
				"l9-feature",
				"l9-feature-then-rewritten",
			),
		);
		const before = readFileSync(join(env.target.worktree, BASE_FILE), "utf-8");

		await expect(chapterMerge.unmerge(env.source.id)).rejects.toThrow(/conflict/i);
		// Reported rather than forced, and the worktree is left exactly as it was.
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).toBe(before);
		expect((await chapterRow(env.source.id)).status).toBe("merged");
	});

	test("reports a warning instead of failing when the source snapshot is gone", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id });

		// Simulate EXTERNAL loss in this test's isolated home, not a production force
		// bypass. The lifecycle service correctly refuses to erase this live claim.
		const digest = createHash("sha256")
			.update(treeSnapshotKey("local", env.source.worktree))
			.digest("hex");
		const shadow = getNarraforkPath("tree-snapshots", digest.slice(0, 32));
		const home = process.env.NARRAFORK_HOME;
		if (
			process.env.NARRAFORK_TEST !== "1" ||
			!home ||
			!shadow.startsWith(join(home, "tree-snapshots"))
		)
			throw new Error("External-loss fixture must remain in its isolated test namespace");
		expect(existsSync(shadow)).toBe(true);
		rmSync(shadow, { recursive: true, force: true });

		const result = await chapterMerge.unmerge(env.source.id);
		expect(result.ok).toBe(true);
		expect(result.warning).toMatch(/uncommitted work could not be reapplied/i);
		const row = await chapterRow(env.source.id);
		tempDirs.push(present(row.worktreePath, "restored worktree"));
		// Degraded to the branch tip rather than leaving the chapter unusable.
		expect(row.status).toBe("active");
		expect(existsSync(join(present(row.worktreePath, "worktree"), BASE_FILE))).toBe(true);
	});

	test("waking a merged chapter is refused, because only unmerge can undo the target", async () => {
		// `wake` used to accept a merged chapter and clear every merge coordinate, while
		// leaving the target's content exactly as the merge had left it. That combination
		// is unrecoverable: `unmerge` routes on those coordinates, so once they are gone
		// the source's contribution can never be reversed out of the target, and merging
		// the chapter again applies the same changes a second time.
		//
		// Refusing is what keeps the two operations from overlapping. Nothing is lost by
		// it — `unmerge` restores the source's uncommitted work as well, which the
		// "gives the source chapter back its uncommitted work" case above pins down.
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		writeFileSync(join(env.source.worktree, "wake-me.txt"), "restore on wake\n");
		await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id });

		await expect(chapterCleanup.wake(env.source.id)).rejects.toThrow(/unmerge/i);

		// Still merged, and every coordinate intact — that is precisely what makes the
		// chapter recoverable through unmerge.
		const row = await chapterRow(env.source.id);
		expect(row.status).toBe("merged");
		expect(row.mergeSnapshotCommitSha).toBeTruthy();
		expect(row.mergedSourceSnapshotSha).toBeTruthy();
	});

	test("restoreSourceSnapshot reports rather than throws for a missing snapshot", async () => {
		const env = await createMergePair();
		const bogus = "0".repeat(40);
		const outcome = await restoreSourceSnapshot(env.source.worktree, bogus);
		expect(outcome.restored).toBe(false);
		expect(outcome.reason).toBeTruthy();
	});
});

describe("commit-mode compatibility", () => {
	test("an explicit commit-mode merge still produces a real merge commit", async () => {
		const env = await createMergePair();
		// Committed on the source branch, since commit mode reads branch tips.
		writeFileSync(join(env.source.worktree, "committed.txt"), "from feature\n");
		await git(["add", "-A"], env.source.worktree);
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "feature work"],
			env.source.worktree,
		);

		const result = await chapterMerge.merge(env.source.id, {
			targetChapterId: env.target.id,
			mode: "commit",
		});
		expect(result.success).toBe(true);

		const row = await chapterRow(env.source.id);
		expect(row.mergeCommitSha).toBeTruthy();
		// Commit mode must not leave snapshot coordinates, or unmerge would misroute.
		expect(row.mergeSnapshotCommitSha).toBeNull();
		expect(existsSync(join(env.target.worktree, "committed.txt"))).toBe(true);
	});

	test("cherry-pick keeps using the commit path", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, "picked.txt"), "cherry\n");
		await git(["add", "-A"], env.source.worktree);
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "pick me"],
			env.source.worktree,
		);

		const result = await chapterMerge.merge(env.source.id, {
			targetChapterId: env.target.id,
			strategy: "cherry-pick",
		});
		expect(result.success).toBe(true);
		const row = await chapterRow(env.source.id);
		// No snapshot equivalent exists for replaying a commit sequence.
		expect(row.mergeSnapshotCommitSha).toBeNull();
		expect(row.mergeCommitSha).toBeTruthy();
	});
});

/**
 * An interactive snapshot merge writes its conflicted tree to disk and keeps the way
 * back only in the `merge_sessions` row. These cases cover the transitions where that
 * row stops being actionable — the point at which a forgotten `preMergeTree` becomes
 * either a worktree the user cannot un-conflict, or an instruction that overwrites
 * work it should have kept.
 */
describe("interactive snapshot merge state lifecycle", () => {
	/** Drive a merge to a conflict and persist the session, as processQueue does. */
	async function startConflictedSession(env: Awaited<ReturnType<typeof createMergePair>>) {
		writeFileSync(join(env.target.worktree, BASE_FILE), BASE_CONTENT.replace("l5", "l5-TRUNK"));
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l5", "l5-FEATURE"));

		const result = await chapterMerge.startInteractiveConflictMerge(
			env.source.id,
			{ targetChapterId: env.target.id },
			"en",
		);
		expect(result.success).toBe(false);
		const state = present(result.snapshotState, "snapshot state");
		// Conflict markers really are on disk; that is what makes the restore necessary.
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).toContain("<<<<<<<");

		const now = new Date().toISOString();
		const sessionId = generateId();
		await db.insert(mergeSessions).values({
			id: sessionId,
			targetChapterId: env.target.id,
			sourceChapterIds: [env.source.id],
			strategy: "merge",
			status: "waiting_decision",
			currentIndex: 0,
			currentSourceChapterId: env.source.id,
			mergedCount: 0,
			conflictFiles: result.conflictFiles ?? [],
			preMergeTree: state.preMergeTree,
			conflictTree: state.conflictTree,
			preMergeTargetSnapshot: state.targetSnapshot,
			mergeSourceSnapshot: state.sourceSnapshot,
			preMergeTargetSha: state.preMergeTargetSha,
			createdAt: now,
			updatedAt: now,
		});
		createdSessions.push(sessionId);
		return { sessionId, state };
	}

	async function sessionRow(id: string) {
		const row = await db.query.mergeSessions.findFirst({ where: eq(mergeSessions.id, id) });
		return present(row, `merge session ${id}`);
	}

	async function workspaceState(env: Awaited<ReturnType<typeof createMergePair>>) {
		const indexPath = await git(["rev-parse", "--git-path", "index"], env.target.worktree);
		return {
			tree: await worktreeTreeSnapshot.capture(env.target.worktree),
			head: await git(["rev-parse", "HEAD"], env.target.worktree),
			index: readFileSync(resolve(env.target.worktree, indexPath)),
			chapterSnapshot: (await chapterRow(env.target.id)).snapshotCommitSha,
		};
	}

	test("a restart preserves even an untouched conflicted worktree and its recovery evidence", async () => {
		const env = await createMergePair();
		const { sessionId, state } = await startConflictedSession(env);
		const before = await workspaceState(env);
		const materialize = spyOn(worktreeTreeSnapshot, "materializeTree");
		const abort = spyOn(chapterMerge, "abortInteractiveSnapshotMerge");
		const capture = spyOn(worktreeTreeSnapshot, "capture");
		try {
			await chapterBatchMerge.cleanupStaleSessions();
			expect(materialize).not.toHaveBeenCalled();
			expect(abort).not.toHaveBeenCalled();
			expect(capture).not.toHaveBeenCalled();
		} finally {
			materialize.mockRestore();
			abort.mockRestore();
			capture.mockRestore();
		}
		expect(await workspaceState(env)).toEqual(before);
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf8")).toContain("<<<<<<<");
		const row = await sessionRow(sessionId);
		expect(row.status).toBe("error");
		expect(row.error).toMatch(/preserv|not.*restor/i);
		expect(row.preMergeTree).toBe(state.preMergeTree);
		expect(row.conflictTree).toBe(state.conflictTree);
		expect(row.preMergeTargetSnapshot).toBe(state.targetSnapshot);
		expect(row.mergeSourceSnapshot).toBe(state.sourceSnapshot);
		await chapterBatchMerge.cleanupStaleSessions();
		await chapterBatchMerge.resolveDecision(sessionId, "cancel");
		await chapterBatchMerge.resolveDecision(sessionId, "continue");
		expect(await sessionRow(sessionId)).toEqual(row);
		expect(await workspaceState(env)).toEqual(before);
	});

	test.each([
		"running",
		"ai_resolving",
		"waiting_decision",
	] as const)("startup preserves later commits, index, WIP and new files for %s sessions", async (status) => {
		const env = await createMergePair();
		const { sessionId, state } = await startConflictedSession(env);
		await db.update(mergeSessions).set({ status }).where(eq(mergeSessions.id, sessionId));
		writeFileSync(join(env.target.worktree, BASE_FILE), "resolved and committed later\n");
		writeFileSync(join(env.target.worktree, "later-commit.txt"), "new committed file\n");
		await git(["add", "-A"], env.target.worktree);
		await git(["commit", "-m", "work after interrupted merge"], env.target.worktree);
		writeFileSync(join(env.target.worktree, BASE_FILE), "staged work\n");
		await git(["add", BASE_FILE], env.target.worktree);
		writeFileSync(join(env.target.worktree, BASE_FILE), "unstaged work after staging\n");
		rmSync(join(env.target.worktree, "later-commit.txt"));
		const binary = Buffer.from([0, 255, 128, 1, 13, 10]);
		writeFileSync(join(env.target.worktree, "new-untracked.bin"), binary);
		const before = await workspaceState(env);
		await chapterBatchMerge.cleanupStaleSessions();
		expect(await workspaceState(env)).toEqual(before);
		expect(readFileSync(join(env.target.worktree, "new-untracked.bin"))).toEqual(binary);
		expect(existsSync(join(env.target.worktree, "later-commit.txt"))).toBe(false);
		const row = await sessionRow(sessionId);
		expect(row.status).toBe("error");
		expect(row.preMergeTree).toBe(state.preMergeTree);
		expect(row.conflictTree).toBe(state.conflictTree);
		await chapterBatchMerge.resolveDecision(sessionId, "cancel");
		await chapterBatchMerge.resolveDecision(sessionId, "continue");
		expect(await workspaceState(env)).toEqual(before);
		expect(await sessionRow(sessionId)).toEqual(row);
		expect((await chapterRow(env.source.id)).status).not.toBe("merged");
	});

	test("a second cancellation cannot overwrite work done after the first", async () => {
		const env = await createMergePair();
		const { sessionId } = await startConflictedSession(env);

		await chapterBatchMerge.resolveDecision(sessionId, "cancel");
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).not.toContain("<<<<<<<");

		// The user carries on working in the restored worktree.
		writeFileSync(join(env.target.worktree, "after-cancel.txt"), "written after cancelling\n");
		writeFileSync(join(env.target.worktree, BASE_FILE), "rewritten by the user\n");

		// A re-delivered frame, a double click, or a stale UI. Restoring again here would
		// discard both edits above.
		await chapterBatchMerge.resolveDecision(sessionId, "cancel");

		expect(existsSync(join(env.target.worktree, "after-cancel.txt"))).toBe(true);
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).toBe(
			"rewritten by the user\n",
		);
		expect((await sessionRow(sessionId)).preMergeTree).toBeNull();
	});

	test("a target with no worktree retains evidence without requiring filesystem access", async () => {
		const env = await createMergePair();
		const { sessionId, state } = await startConflictedSession(env);
		const contents = readFileSync(join(env.target.worktree, BASE_FILE));
		await db.update(chapters).set({ worktreePath: null }).where(eq(chapters.id, env.target.id));
		await chapterBatchMerge.cleanupStaleSessions();
		const row = await sessionRow(sessionId);
		expect(row.status).toBe("error");
		expect(row.error).toMatch(/preserv|not.*restor/i);
		expect(row.preMergeTree).toBe(state.preMergeTree);
		expect(row.conflictTree).toBe(state.conflictTree);
		expect(readFileSync(join(env.target.worktree, BASE_FILE))).toEqual(contents);
	});

	test("cleanup walks more than one batch without changing terminal sessions", async () => {
		const env = await createMergePair();
		const now = new Date().toISOString();
		const statuses = ["running", "ai_resolving", "waiting_decision"] as const;
		const entries = Array.from({ length: 205 }, (_, i) => ({
			id: generateId(),
			targetChapterId: env.target.id,
			sourceChapterIds: [env.source.id],
			status: statuses[i % statuses.length],
			createdAt: now,
			updatedAt: now,
		}));
		const terminal = (["error", "completed", "cancelled"] as const).map((status) => ({
			id: generateId(),
			targetChapterId: env.target.id,
			sourceChapterIds: [env.source.id],
			status,
			error: "original diagnostic",
			createdAt: now,
			updatedAt: now,
		}));
		createdSessions.push(...entries.map((entry) => entry.id), ...terminal.map((entry) => entry.id));
		await db.insert(mergeSessions).values([...entries, ...terminal]);
		const before = await workspaceState(env);
		const terminalBefore = await Promise.all(terminal.map((entry) => sessionRow(entry.id)));
		await chapterBatchMerge.cleanupStaleSessions();
		for (const entry of entries) {
			const row = await sessionRow(entry.id);
			expect(row.status).toBe("error");
			expect(row.preMergeTree).toBeNull();
		}
		await chapterBatchMerge.cleanupStaleSessions();
		for (const row of terminalBefore) {
			await chapterBatchMerge.resolveDecision(row.id, "cancel");
			await chapterBatchMerge.resolveDecision(row.id, "continue");
			expect(await sessionRow(row.id)).toEqual(row);
		}
		expect(await workspaceState(env)).toEqual(before);
	});

	test("cancel refuses workspace drift and retains all recovery coordinates", async () => {
		const env = await createMergePair();
		const { sessionId } = await startConflictedSession(env);
		const session = await sessionRow(sessionId);
		writeFileSync(join(env.target.worktree, BASE_FILE), "partially resolved, do not discard\n");
		writeFileSync(join(env.target.worktree, "new-user-file.bin"), Buffer.from([0, 1, 255]));
		const before = await workspaceState(env);
		await expect(chapterBatchMerge.resolveDecision(sessionId, "cancel")).rejects.toThrow();
		expect(await workspaceState(env)).toEqual(before);
		expect(await sessionRow(sessionId)).toEqual(session);
	});

	test("cancel refuses a moved HEAD even when the conflicted workspace tree is unchanged", async () => {
		const env = await createMergePair();
		const { sessionId } = await startConflictedSession(env);
		const session = await sessionRow(sessionId);
		// An empty commit advances HEAD without changing the index or workspace bytes.
		await git(
			["commit", "--allow-empty", "-m", "HEAD advanced independently"],
			env.target.worktree,
		);
		const before = await workspaceState(env);
		expect(before.tree).toBe(session.conflictTree as string);
		await expect(chapterBatchMerge.resolveDecision(sessionId, "cancel")).rejects.toThrow();
		expect(await workspaceState(env)).toEqual(before);
		expect(await sessionRow(sessionId)).toEqual(session);
	});

	test("cancel refuses missing conflict coordinates instead of using an unguarded restore", async () => {
		const env = await createMergePair();
		const { sessionId } = await startConflictedSession(env);
		await db
			.update(mergeSessions)
			.set({ conflictTree: null })
			.where(eq(mergeSessions.id, sessionId));
		const session = await sessionRow(sessionId);
		const before = await workspaceState(env);
		await expect(chapterBatchMerge.resolveDecision(sessionId, "cancel")).rejects.toThrow();
		expect(await workspaceState(env)).toEqual(before);
		expect(await sessionRow(sessionId)).toEqual(session);
	});

	test("cancel retains evidence when the target worktree is unavailable", async () => {
		const env = await createMergePair();
		const { sessionId } = await startConflictedSession(env);
		await db.update(chapters).set({ worktreePath: null }).where(eq(chapters.id, env.target.id));
		const session = await sessionRow(sessionId);
		const before = readFileSync(join(env.target.worktree, BASE_FILE));
		await expect(chapterBatchMerge.resolveDecision(sessionId, "cancel")).rejects.toThrow();
		expect(await sessionRow(sessionId)).toEqual(session);
		expect(readFileSync(join(env.target.worktree, BASE_FILE))).toEqual(before);
	});

	test("interactive cancel rejects malformed full HEAD IDs rather than truncating them", async () => {
		const env = await createMergePair();
		const { state } = await startConflictedSession(env);
		const before = await workspaceState(env);
		for (const expectedHeadSha of ["", `${before.head}invalid`, before.head.slice(0, 7)]) {
			await expect(
				chapterMerge.abortInteractiveSnapshotMerge(env.target.worktree, state.preMergeTree, {
					expectedCurrentTree: state.conflictTree,
					expectedHeadSha,
				}),
			).rejects.toThrow();
		}
		expect(await workspaceState(env)).toEqual(before);
	});

	test("interactive cancel supports a genuinely unborn HEAD with an explicit null guard", async () => {
		const worktree = mkdtempSync(join(tmpdir(), "nf-empty-cancel-"));
		tempDirs.push(worktree);
		await git(["init"], worktree);
		writeFileSync(join(worktree, "draft.txt"), "pre-merge draft\n");
		const preMergeTree = await worktreeTreeSnapshot.capture(worktree);
		writeFileSync(join(worktree, "draft.txt"), "conflict state\n");
		const conflictTree = await worktreeTreeSnapshot.capture(worktree);
		await chapterMerge.abortInteractiveSnapshotMerge(worktree, preMergeTree, {
			expectedCurrentTree: conflictTree,
			expectedHeadSha: null,
		});
		expect(readFileSync(join(worktree, "draft.txt"), "utf8")).toBe("pre-merge draft\n");
	});

	test("interactive cancel never treats an unreadable repository as an unborn HEAD", async () => {
		const worktree = mkdtempSync(join(tmpdir(), "nf-not-git-cancel-"));
		tempDirs.push(worktree);
		writeFileSync(join(worktree, "draft.txt"), "must remain\n");
		const materialize = spyOn(worktreeTreeSnapshot, "materializeTree");
		try {
			await expect(
				chapterMerge.abortInteractiveSnapshotMerge(worktree, "a".repeat(40), {
					expectedCurrentTree: "b".repeat(40),
					expectedHeadSha: null,
				}),
			).rejects.toThrow();
			expect(materialize).not.toHaveBeenCalled();
		} finally {
			materialize.mockRestore();
		}
		expect(readFileSync(join(worktree, "draft.txt"), "utf8")).toBe("must remain\n");
	});

	test("a failed cancel does not announce success or erase recovery evidence", async () => {
		const env = await createMergePair();
		const { sessionId } = await startConflictedSession(env);
		const session = await sessionRow(sessionId);
		const before = await workspaceState(env);
		const failure = new Error("injected restore failure");
		const abort = spyOn(chapterMerge, "abortInteractiveSnapshotMerge").mockRejectedValue(failure);
		try {
			await expect(chapterBatchMerge.resolveDecision(sessionId, "cancel")).rejects.toBe(failure);
		} finally {
			abort.mockRestore();
		}
		expect(await workspaceState(env)).toEqual(before);
		expect(await sessionRow(sessionId)).toEqual(session);
	});

	test("simultaneous cancellations cannot both consume the old restore coordinates", async () => {
		const env = await createMergePair();
		const { sessionId } = await startConflictedSession(env);
		const original = chapterMerge.abortInteractiveSnapshotMerge.bind(chapterMerge);
		const abort = spyOn(chapterMerge, "abortInteractiveSnapshotMerge").mockImplementation(
			async (...args) => {
				await original(...args);
				writeFileSync(
					join(env.target.worktree, "after-first-cancel.txt"),
					"keep this later work\n",
				);
			},
		);
		try {
			await Promise.all([
				chapterBatchMerge.resolveDecision(sessionId, "cancel"),
				chapterBatchMerge.resolveDecision(sessionId, "cancel"),
			]);
			expect(abort).toHaveBeenCalledTimes(1);
		} finally {
			abort.mockRestore();
		}
		expect(readFileSync(join(env.target.worktree, "after-first-cancel.txt"), "utf8")).toBe(
			"keep this later work\n",
		);
		expect((await sessionRow(sessionId)).status).toBe("cancelled");
	});

	test("a cancellation queued behind a successful continue cannot undo the resolved merge", async () => {
		const env = await createMergePair();
		const { sessionId } = await startConflictedSession(env);
		writeFileSync(join(env.target.worktree, BASE_FILE), BASE_CONTENT.replace("l5", "l5-RESOLVED"));
		const abort = spyOn(chapterMerge, "abortInteractiveSnapshotMerge");
		try {
			await Promise.all([
				chapterBatchMerge.resolveDecision(sessionId, "continue"),
				chapterBatchMerge.resolveDecision(sessionId, "cancel"),
			]);
			expect(abort).not.toHaveBeenCalled();
		} finally {
			abort.mockRestore();
		}
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf8")).toContain("l5-RESOLVED");
		expect((await chapterRow(env.source.id)).status).toBe("merged");
		expect((await sessionRow(sessionId)).preMergeTree).toBeNull();
	});

	test("completion refuses a persisted conflict list with missing coverage", async () => {
		const env = await createMergePair();
		const { state } = await startConflictedSession(env);
		writeFileSync(join(env.target.worktree, BASE_FILE), "apparently resolved\n");
		await expect(
			chapterMerge.completeInteractiveSnapshotMergeById(env.source.id, env.target.id, "merge", {
				...state,
				conflictFiles: [],
			}),
		).rejects.toMatchObject({ messageCode: "GIT_TREE_MERGE_CONFLICTS_UNLISTED" });
		expect((await chapterRow(env.source.id)).status).not.toBe("merged");
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf8")).toBe(
			"apparently resolved\n",
		);
	});

	test("a resolved conflict clears the coordinates, so a later restart cannot undo it", async () => {
		const env = await createMergePair();
		const { sessionId } = await startConflictedSession(env);

		// Resolve the conflict the way a user or narrator would: markers gone.
		writeFileSync(join(env.target.worktree, BASE_FILE), BASE_CONTENT.replace("l5", "l5-RESOLVED"));
		await chapterBatchMerge.resolveDecision(sessionId, "continue");

		const row = await sessionRow(sessionId);
		// The merge landed, so the restore instruction must not outlive it.
		expect(row.preMergeTree).toBeNull();
		expect(row.conflictTree).toBeNull();
		expect((await chapterRow(env.source.id)).status).toBe("merged");

		// The sweep now has nothing to act on, so the resolution survives.
		await chapterBatchMerge.cleanupStaleSessions();
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).toContain("l5-RESOLVED");
	});
});

/**
 * The reverse merge that undoes a commit-free merge, and the base it is computed from.
 *
 * Both cases here failed with the original base (`mergedSourceSnapshotSha`) and pass
 * with the merge result. They are separated from the general unmerge cases above
 * because neither is about the unmerge *flow* — both are about the three sides handed
 * to git, where a plausible-looking choice yields a plausible-looking wrong answer.
 */
describe("reversing a commit-free merge computes against the merge result", () => {
	test("does not resurrect an edit the target made before the merge and undid after", async () => {
		const env = await createMergePair();
		// The target edits l2 before the merge…
		writeFileSync(join(env.target.worktree, BASE_FILE), BASE_CONTENT.replace("l2", "TARGET-EDIT"));
		// …the source touches a line far away, so the two never overlap.
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		expect(
			(await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id })).success,
		).toBe(true);
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).toContain("TARGET-EDIT");

		// After the merge the target changes its mind and puts l2 back.
		writeFileSync(
			join(env.target.worktree, BASE_FILE),
			readFileSync(join(env.target.worktree, BASE_FILE), "utf-8").replace("TARGET-EDIT", "l2"),
		);

		const result = await chapterMerge.unmerge(env.source.id);
		expect(result.ok).toBe(true);
		tempDirs.push(present((await chapterRow(env.source.id)).worktreePath, "restored worktree"));

		const after = readFileSync(join(env.target.worktree, BASE_FILE), "utf-8");
		// With the source snapshot as base, source→theirs still differs by TARGET-EDIT on a
		// path the source never touched, so git reintroduces it as a theirs-side change and
		// the deliberately-undone edit comes back from the dead.
		expect(after).not.toContain("TARGET-EDIT");
		expect(after).toContain("\nl2\n");
		// And the source's contribution is still what got rolled back.
		expect(after).not.toContain("l9-feature");
	});

	test("reports no conflict when the source only added files", async () => {
		const env = await createMergePair();
		// The target has a pre-merge edit; the source adds a file and touches nothing else.
		writeFileSync(join(env.target.worktree, BASE_FILE), BASE_CONTENT.replace("l2", "TARGET-EDIT"));
		writeFileSync(join(env.source.worktree, "feature.txt"), "new from feature\n");
		expect(
			(await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id })).success,
		).toBe(true);
		expect(existsSync(join(env.target.worktree, "feature.txt"))).toBe(true);

		// The target keeps working on its own line, still nowhere near the source.
		writeFileSync(
			join(env.target.worktree, BASE_FILE),
			readFileSync(join(env.target.worktree, BASE_FILE), "utf-8").replace(
				"TARGET-EDIT",
				"TARGET-EDIT2",
			),
		);

		// With the source snapshot as base this reported a conflict in app.txt — a file the
		// merge never touched — and the unmerge refused outright.
		const result = await chapterMerge.unmerge(env.source.id);
		expect(result.ok).toBe(true);
		tempDirs.push(present((await chapterRow(env.source.id)).worktreePath, "restored worktree"));

		expect(existsSync(join(env.target.worktree, "feature.txt"))).toBe(false);
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).toContain("TARGET-EDIT2");
	});

	test("refuses rather than guesses when the merge result snapshot is gone", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id });

		// A row whose merge result no longer resolves — a swept shadow repo, a hand edit.
		await db
			.update(chapters)
			.set({ mergeSnapshotCommitSha: "0".repeat(40) })
			.where(eq(chapters.id, env.source.id));

		// Every other candidate base produces a plausible but wrong tree, so declining is
		// the only safe answer. `mergedSourceSnapshotSha` in particular is not a usable
		// fallback: it is the source lineage's sha *inside the target's* shadow repository,
		// so it is gone in exactly this situation — and even when present it is the base
		// this function's doc comment rules out.
		const message = await chapterMerge.unmerge(env.source.id).then(
			() => "",
			(err: unknown) => (err instanceof Error ? err.message : String(err)),
		);
		expect(message).toMatch(/cannot be reversed automatically/i);
		// A refusal has to be actionable, not merely a refusal: it names the snapshot that
		// is missing and states that nothing was changed, so the user knows the target is
		// still intact and what to compare it against.
		expect(message).toContain("000000000000");
		expect(message).toMatch(/nothing has been changed/i);
		expect((await chapterRow(env.source.id)).status).toBe("merged");
	});
});

/**
 * Preconditions whose absence puts a chapter somewhere no later operation can reach.
 *
 * Grouped together because they share a shape: each guards a state that is not merely
 * wrong but *unrepairable* — a merge commit no branch points at, or a project trunk
 * with no operation left that will accept it.
 */
describe("merge preconditions", () => {
	test("refuses a target worktree that is not on the target's branch", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, "committed.txt"), "from feature\n");
		await git(["add", "-A"], env.source.worktree);
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "feature work"],
			env.source.worktree,
		);
		// Detach the target's HEAD, as a `git checkout <sha>` in the terminal would.
		const head = await git(["rev-parse", "HEAD"], env.target.worktree);
		await git(["checkout", "--detach", head], env.target.worktree);
		const targetRow = await chapterRow(env.target.id);

		await expect(
			chapterMerge.merge(env.source.id, { targetChapterId: env.target.id, mode: "commit" }),
		).rejects.toThrow(/detached/i);

		// Nothing was recorded, so the source is still mergeable once HEAD is reattached.
		// Silently succeeding here produced a commit on no branch, with the source retired
		// and its worktree deleted.
		expect((await chapterRow(env.source.id)).status).toBe("active");
		expect(await git(["rev-parse", "HEAD"], env.target.worktree)).toBe(head);
		expect(targetRow.branch).toBeTruthy();
	});

	test("refuses the root chapter as a merge source", async () => {
		const env = await createMergePair();
		// The root chapter's worktree is the project's own git directory.
		await db.update(chapters).set({ isRoot: 1 }).where(eq(chapters.id, env.source.id));

		await expect(
			chapterMerge.merge(env.source.id, { targetChapterId: env.target.id }),
		).rejects.toThrow(/root chapter/i);
		// Retiring it would null worktreePath while `git worktree remove` fatals on the main
		// working tree, and neither dormant nor delete accepts a root chapter afterwards.
		const row = await chapterRow(env.source.id);
		expect(row.status).toBe("active");
		expect(row.worktreePath).toBeTruthy();
	});

	test("the conflict preview accepts exactly what the merge accepts", async () => {
		const env = await createMergePair();
		// Dormant is a legal merge source, so a preview that rejects it makes the UI refuse
		// an operation the API performs — and the only way through is to skip the check.
		await db.update(chapters).set({ status: "dormant" }).where(eq(chapters.id, env.source.id));

		const check = await chapterMerge.checkConflicts(env.source.id, env.target.id);
		expect(check.hasConflicts).toBe(false);

		// And both refuse a root source, with the same message.
		await db
			.update(chapters)
			.set({ status: "active", isRoot: 1 })
			.where(eq(chapters.id, env.source.id));
		await expect(chapterMerge.checkConflicts(env.source.id, env.target.id)).rejects.toThrow(
			/root chapter/i,
		);
	});
});

/**
 * Cleaning up after a merge that conflicted in commit mode.
 *
 * The squash case is the one that mattered: `--squash --no-commit` writes no
 * `MERGE_HEAD`, so `git merge --abort` exits 128 — and while that failure was
 * swallowed, the markers stayed on disk until the next unattended save committed them
 * as authored code.
 */
describe("commit-mode conflict cleanup", () => {
	/** Commit conflicting content on both branches so a commit-mode merge collides. */
	async function seedConflictingCommits(env: Awaited<ReturnType<typeof createMergePair>>) {
		const commit = async (worktree: string, content: string, message: string) => {
			writeFileSync(join(worktree, BASE_FILE), content);
			await git(["add", "-A"], worktree);
			await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message], worktree);
		};
		await commit(env.source.worktree, BASE_CONTENT.replace("l5", "l5-FEATURE"), "feature edit");
		await commit(env.target.worktree, BASE_CONTENT.replace("l5", "l5-TRUNK"), "trunk edit");
	}

	test("a conflicted squash leaves no markers and no unmerged index entries", async () => {
		const env = await createMergePair();
		await seedConflictingCommits(env);
		const preMergeHead = await git(["rev-parse", "HEAD"], env.target.worktree);

		const result = await chapterMerge.merge(env.source.id, {
			targetChapterId: env.target.id,
			strategy: "squash",
			mode: "commit",
		});
		expect(result.success).toBe(false);
		expect(result.conflictFiles).toEqual([BASE_FILE]);

		// `git merge --abort` fatals here, so before the fix all three of these held.
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).not.toContain("<<<<<<<");
		expect(await gitService.getConflictFiles(env.target.worktree)).toEqual([]);
		expect(await git(["rev-parse", "HEAD"], env.target.worktree)).toBe(preMergeHead);

		// The decisive assertion: an unattended save must now be a no-op rather than a
		// commit of conflict markers. `autoCommit` refuses mid-conflict, so reaching this
		// line at all requires the cleanup to have worked.
		expect(await gitService.autoCommit(env.target.worktree, "auto-save while dormant")).toBeNull();
		expect(await git(["rev-parse", "HEAD"], env.target.worktree)).toBe(preMergeHead);
	});

	test("a conflicted squash keeps the target's uncommitted work on untouched paths", async () => {
		const env = await createMergePair();
		await seedConflictingCommits(env);
		// Work in progress on a path the merge never touches. `reset --hard` would erase
		// it; `reset --merge` resets only the paths that differ from the target commit, so
		// it has to survive — that preservation is the whole point of this rung.
		writeFileSync(join(env.target.worktree, "notes.txt"), "seed\n");
		await git(["add", "-A"], env.target.worktree);
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "add notes"],
			env.target.worktree,
		);
		writeFileSync(join(env.target.worktree, "notes.txt"), "seed\nuncommitted line\n");
		// Untracked too: no reset removes these, but a cleanup that reached for
		// `git clean` would.
		writeFileSync(join(env.target.worktree, "scratch.txt"), "untracked scratch\n");

		const result = await chapterMerge.merge(env.source.id, {
			targetChapterId: env.target.id,
			strategy: "squash",
			mode: "commit",
		});
		expect(result.success).toBe(false);
		// Nothing was destroyed, so there is nothing to warn about.
		expect(result.warning).toBeUndefined();
		expect(readFileSync(join(env.target.worktree, "notes.txt"), "utf-8")).toBe(
			"seed\nuncommitted line\n",
		);
		expect(readFileSync(join(env.target.worktree, "scratch.txt"), "utf-8")).toBe(
			"untracked scratch\n",
		);
		// And the conflict itself is still gone.
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).not.toContain("<<<<<<<");
		expect(await gitService.getConflictFiles(env.target.worktree)).toEqual([]);
	});

	test("falls back to a hard reset, and says so, when reset --merge refuses", async () => {
		const env = await createMergePair();
		await seedConflictingCommits(env);
		writeFileSync(join(env.target.worktree, "notes.txt"), "seed\n");
		await git(["add", "-A"], env.target.worktree);
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "add notes"],
			env.target.worktree,
		);
		const preMergeHead = await git(["rev-parse", "HEAD"], env.target.worktree);

		// `reset --merge` refuses when the index holds an entry matching neither HEAD nor
		// the merge result. Simulated rather than constructed from git state: the natural
		// shape for it (a staged-then-modified file) also makes git refuse to *start* the
		// merge, so the two cannot be reproduced together through the public path.
		//
		// Stubs the `*Unlocked` variant because that is what the cleanup path calls: it runs
		// inside a `worktreeLock` block, so the locked wrapper would wait on its own caller.
		// Stubbing the wrapper instead would silently stop intercepting and the rung under
		// test would never be reached.
		const resetMerge = gitService.resetMergeUnlocked;
		gitService.resetMergeUnlocked = async () => {
			throw new Error("Entry 'notes.txt' not uptodate. Cannot merge.");
		};
		let result: Awaited<ReturnType<typeof chapterMerge.merge>>;
		try {
			result = await chapterMerge.merge(env.source.id, {
				targetChapterId: env.target.id,
				strategy: "squash",
				mode: "commit",
			});
		} finally {
			gitService.resetMergeUnlocked = resetMerge;
		}

		expect(result.success).toBe(false);
		// Escalating rather than giving up: markers left on disk is the worst outcome.
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).not.toContain("<<<<<<<");
		expect(await gitService.getConflictFiles(env.target.worktree)).toEqual([]);
		expect(await git(["rev-parse", "HEAD"], env.target.worktree)).toBe(preMergeHead);
		// The hard reset is the one rung that can destroy something, so it must name the
		// snapshot that holds the pre-reset state.
		expect(result.warning).toMatch(/hard reset/i);
		expect(result.warning).toMatch(/snapshot [0-9a-f]{12}/);
	});

	test("a conflicted non-squash merge is aborted without a spurious warning", async () => {
		const env = await createMergePair();
		await seedConflictingCommits(env);
		writeFileSync(join(env.target.worktree, "notes.txt"), "seed\n");
		await git(["add", "-A"], env.target.worktree);
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "add notes"],
			env.target.worktree,
		);
		writeFileSync(join(env.target.worktree, "notes.txt"), "seed\nuncommitted line\n");
		// Captured after the setup commits, so it is the HEAD the merge actually starts from.
		const preMergeHead = await git(["rev-parse", "HEAD"], env.target.worktree);

		const result = await chapterMerge.merge(env.source.id, {
			targetChapterId: env.target.id,
			mode: "commit",
		});
		expect(result.success).toBe(false);
		// `merge --abort` works for this strategy and keeps uncommitted work, so there is
		// nothing to warn about.
		expect(result.warning).toBeUndefined();
		expect(readFileSync(join(env.target.worktree, "notes.txt"), "utf-8")).toBe(
			"seed\nuncommitted line\n",
		);
		expect(readFileSync(join(env.target.worktree, BASE_FILE), "utf-8")).not.toContain("<<<<<<<");
		expect(await gitService.getConflictFiles(env.target.worktree)).toEqual([]);
		expect(await git(["rev-parse", "HEAD"], env.target.worktree)).toBe(preMergeHead);
	});
});

/**
 * Undoing a merge that produced real git commits.
 *
 * The fast-forward case is the dangerous one: it makes no merge commit, so
 * `mergeCommitSha` names the source branch's tip and reverting it undoes one of
 * several appended commits.
 */
describe("undoing a commit-mode merge", () => {
	/** Commit `count` separate commits on the source branch, leaving the target behind. */
	async function commitOnSource(
		env: Awaited<ReturnType<typeof createMergePair>>,
		count: number,
	): Promise<void> {
		for (let i = 1; i <= count; i++) {
			writeFileSync(join(env.source.worktree, `step-${i}.txt`), `step ${i}\n`);
			await git(["add", "-A"], env.source.worktree);
			await git(
				["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", `step ${i}`],
				env.source.worktree,
			);
		}
	}

	test("refuses to unmerge a multi-commit fast-forward once the target has advanced", async () => {
		const env = await createMergePair();
		await commitOnSource(env, 3);
		// The target has done nothing, so this fast-forwards and appends all three commits
		// with no merge commit of its own.
		const merged = await chapterMerge.merge(env.source.id, {
			targetChapterId: env.target.id,
			mode: "commit",
		});
		expect(merged.success).toBe(true);
		expect(existsSync(join(env.target.worktree, "step-1.txt"))).toBe(true);

		// The target commits afterwards, which rules out the reset branch of unmerge.
		writeFileSync(join(env.target.worktree, "trunk-work.txt"), "later\n");
		await git(["add", "-A"], env.target.worktree);
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "trunk work"],
			env.target.worktree,
		);

		// Reverting `mergeCommitSha` would drop step-3 and leave step-1 and step-2 in the
		// target while the database stops recording where they came from.
		await expect(chapterMerge.unmerge(env.source.id)).rejects.toThrow(/fast-forward/i);
		expect((await chapterRow(env.source.id)).status).toBe("merged");
		// All three are still there, which is the point: nothing was half-undone.
		expect(existsSync(join(env.target.worktree, "step-1.txt"))).toBe(true);
		expect(existsSync(join(env.target.worktree, "step-3.txt"))).toBe(true);
	});

	test("still reverts a real merge commit when the target has advanced", async () => {
		const env = await createMergePair();
		await commitOnSource(env, 2);
		// A commit on the target first, so the merge cannot fast-forward.
		writeFileSync(join(env.target.worktree, "trunk-first.txt"), "trunk\n");
		await git(["add", "-A"], env.target.worktree);
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "trunk first"],
			env.target.worktree,
		);

		expect(
			(await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id, mode: "commit" }))
				.success,
		).toBe(true);
		writeFileSync(join(env.target.worktree, "trunk-later.txt"), "later\n");
		await git(["add", "-A"], env.target.worktree);
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "trunk later"],
			env.target.worktree,
		);

		// A merge commit is revertable with `-m 1` however many commits it brought in, so
		// the fast-forward guard must not fire here.
		const result = await chapterMerge.unmerge(env.source.id);
		expect(result.ok).toBe(true);
		tempDirs.push(present((await chapterRow(env.source.id)).worktreePath, "restored worktree"));
		expect(existsSync(join(env.target.worktree, "step-1.txt"))).toBe(false);
		expect(existsSync(join(env.target.worktree, "trunk-later.txt"))).toBe(true);
	});

	test("a commit-mode merge clears any snapshot coordinates left by an earlier one", async () => {
		const env = await createMergePair();
		// Round one: a commit-free merge, then undo it. Nothing should remain, but this is
		// the path that used to leave a coordinate behind.
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id });
		await chapterMerge.unmerge(env.source.id);
		const restored = present((await chapterRow(env.source.id)).worktreePath, "restored worktree");
		tempDirs.push(restored);

		// A stale coordinate is planted directly, standing in for any path that leaves one:
		// what matters is that markMerged does not trust the row it is overwriting.
		await db
			.update(chapters)
			.set({
				mergeSnapshotCommitSha: "1".repeat(40),
				preMergeTargetSnapshotSha: "2".repeat(40),
				mergedSourceSnapshotSha: "3".repeat(40),
			})
			.where(eq(chapters.id, env.source.id));

		// Round two: a real commit-mode merge.
		writeFileSync(join(restored, "committed.txt"), "from feature\n");
		await git(["add", "-A"], restored);
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "feature work"],
			restored,
		);
		expect(
			(await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id, mode: "commit" }))
				.success,
		).toBe(true);

		const row = await chapterRow(env.source.id);
		expect(row.mergeCommitSha).toBeTruthy();
		// `unmerge` routes on this field alone, so a leftover value would reverse a merge
		// that no longer exists over the target's current work.
		expect(row.mergeSnapshotCommitSha).toBeNull();
		expect(row.preMergeTargetSnapshotSha).toBeNull();
		expect(row.mergedSourceSnapshotSha).toBeNull();
	});
});

describe("dormant and wake without a commit", () => {
	test("a chapter whose pre-dormant commit failed still gets its work back", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l2", "l2-dormant"));
		writeFileSync(join(env.source.worktree, "uncommitted.txt"), "never committed\n");

		// Reproduce the tolerated failure: `dormant` logs it and proceeds to delete the
		// worktree anyway, which is what makes the snapshot the only remaining copy.
		// `autoCommitUnlocked` is the seam: `dormant` holds `worktreeLock` around it, so the
		// locked wrapper is never reached from that path.
		const autoCommit = gitService.autoCommitUnlocked;
		const mergeAbort = gitService.mergeAbort;
		gitService.autoCommitUnlocked = async () => {
			throw new Error("simulated index lock");
		};
		gitService.mergeAbort = async () => {
			throw new Error("simulated abort failure");
		};
		try {
			await chapterCleanup.dormant(env.source.id);
		} finally {
			gitService.autoCommitUnlocked = autoCommit;
			gitService.mergeAbort = mergeAbort;
		}

		const dormantRow = await chapterRow(env.source.id);
		expect(dormantRow.status).toBe("dormant");
		// Recorded precisely because the branch tip does not carry the work.
		expect(dormantRow.dormantSnapshotCommitSha).toBeTruthy();

		await chapterCleanup.wake(env.source.id);

		const woken = await chapterRow(env.source.id);
		const worktree = present(woken.worktreePath, "woken worktree");
		tempDirs.push(worktree);
		expect(readFileSync(join(worktree, BASE_FILE), "utf-8")).toContain("l2-dormant");
		expect(readFileSync(join(worktree, "uncommitted.txt"), "utf-8")).toBe("never committed\n");
		// Consumed: a later dormant cycle whose commit succeeds must not restore this.
		expect(woken.dormantSnapshotCommitSha).toBeNull();
	});

	test("a successful pre-dormant commit records no restore instruction", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, "committed-by-dormant.txt"), "auto-saved\n");

		await chapterCleanup.dormant(env.source.id);

		const row = await chapterRow(env.source.id);
		expect(row.status).toBe("dormant");
		// git holds the work, so restoring on wake would rewrite a correct worktree.
		expect(row.dormantSnapshotCommitSha).toBeNull();

		await chapterCleanup.wake(env.source.id);
		const woken = await chapterRow(env.source.id);
		const worktree = present(woken.worktreePath, "woken worktree");
		tempDirs.push(worktree);
		expect(existsSync(join(worktree, "committed-by-dormant.txt"))).toBe(true);
	});
});
