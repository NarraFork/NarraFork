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
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, mergeSessions, projects } from "../db/schema";
import { generateId } from "../lib/id";
import { safeSpawn } from "../lib/spawn";
import { chapterBatchMerge } from "./chapter-batch-merge";
import { chapterCleanup } from "./chapter-cleanup";
import { chapterMerge } from "./chapter-merge";
import {
	abortSnapshotMerge,
	detectRemainingConflicts,
	materializeConflicts,
	planSnapshotMerge,
	restoreSourceSnapshot,
} from "./chapter-merge-snapshot";
import { ensureChapterSnapshot } from "./chapter-snapshot-ref";
import { gitService } from "./git-service";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const tempDirs: string[] = [];
const createdProjects: string[] = [];
/**
 * Merge sessions created directly by the interactive-lifecycle cases.
 *
 * Removed in `afterEach` because `cleanupStaleSessions` scans the WHOLE table: a row
 * left behind here would be picked up by an unrelated suite's startup sweep and made
 * to restore a worktree that no longer exists.
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

		await materializeConflicts(env.target.worktree, plan.tree);
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

		await materializeConflicts(env.target.worktree, plan.tree);
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

		// Simulate the shadow repository having been swept away.
		await worktreeTreeSnapshot.destroy(env.source.worktree, undefined, { force: true });

		const result = await chapterMerge.unmerge(env.source.id);
		expect(result.ok).toBe(true);
		expect(result.warning).toMatch(/uncommitted work could not be reapplied/i);
		const row = await chapterRow(env.source.id);
		tempDirs.push(present(row.worktreePath, "restored worktree"));
		// Degraded to the branch tip rather than leaving the chapter unusable.
		expect(row.status).toBe("active");
		expect(existsSync(join(present(row.worktreePath, "worktree"), BASE_FILE))).toBe(true);
	});

	test("waking a merged chapter also restores its uncommitted work", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l9", "l9-feature"));
		writeFileSync(join(env.source.worktree, "wake-me.txt"), "restore on wake\n");
		await chapterMerge.merge(env.source.id, { targetChapterId: env.target.id });

		await chapterCleanup.wake(env.source.id);

		const row = await chapterRow(env.source.id);
		const worktree = present(row.worktreePath, "woken worktree");
		tempDirs.push(worktree);
		expect(readFileSync(join(worktree, BASE_FILE), "utf-8")).toContain("l9-feature");
		expect(readFileSync(join(worktree, "wake-me.txt"), "utf-8")).toBe("restore on wake\n");
		// Same coordinate hygiene as unmerge, including the one wake used to miss.
		expect(row.mergeSnapshotCommitSha).toBeNull();
		expect(row.preMergeTargetSha).toBeNull();
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

	test("a restart restores the worktree instead of stranding conflict markers", async () => {
		const env = await createMergePair();
		const { sessionId } = await startConflictedSession(env);

		// The startup sweep is the only thing that runs after a restart; before this fix
		// it marked the row `error`, which made the recorded tree unreachable forever.
		await chapterBatchMerge.cleanupStaleSessions();

		const onDisk = readFileSync(join(env.target.worktree, BASE_FILE), "utf-8");
		expect(onDisk).not.toContain("<<<<<<<");
		expect(onDisk).toContain("l5-TRUNK");

		const row = await sessionRow(sessionId);
		expect(row.status).toBe("error");
		expect(row.error).toMatch(/restored to its pre-merge state/i);
		// Cleared so nothing can replay this restore over later work.
		expect(row.preMergeTree).toBeNull();
		expect(row.preMergeTargetSnapshot).toBeNull();
		expect(row.mergeSourceSnapshot).toBeNull();
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

	test("a target with no worktree is reported, not thrown, so the sweep continues", async () => {
		const env = await createMergePair();
		const { sessionId } = await startConflictedSession(env);
		// The chapter went dormant (or was deleted) between the conflict and the restart,
		// so there is nowhere to restore into. Startup must still finish cleanly.
		await db.update(chapters).set({ worktreePath: null }).where(eq(chapters.id, env.target.id));

		await chapterBatchMerge.cleanupStaleSessions();

		const row = await sessionRow(sessionId);
		expect(row.status).toBe("error");
		expect(row.error).toMatch(/may still contain conflict markers/i);
		expect(row.preMergeTree).toBeNull();
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

describe("dormant and wake without a commit", () => {
	test("a chapter whose pre-dormant commit failed still gets its work back", async () => {
		const env = await createMergePair();
		writeFileSync(join(env.source.worktree, BASE_FILE), BASE_CONTENT.replace("l2", "l2-dormant"));
		writeFileSync(join(env.source.worktree, "uncommitted.txt"), "never committed\n");

		// Reproduce the tolerated failure: `dormant` logs it and proceeds to delete the
		// worktree anyway, which is what makes the snapshot the only remaining copy.
		const autoCommit = gitService.autoCommit;
		const mergeAbort = gitService.mergeAbort;
		gitService.autoCommit = async () => {
			throw new Error("simulated index lock");
		};
		gitService.mergeAbort = async () => {
			throw new Error("simulated abort failure");
		};
		try {
			await chapterCleanup.dormant(env.source.id);
		} finally {
			gitService.autoCommit = autoCommit;
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
