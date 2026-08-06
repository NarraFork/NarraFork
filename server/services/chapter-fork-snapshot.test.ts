/**
 * Forking from uncommitted state.
 *
 * The behaviour under test is the one that used to require a commit: a fork should
 * start from the parent's *actual* workspace, not from its last commit. The most
 * important case is the fork with no named fork point, which previously started at
 * HEAD and silently discarded every uncommitted change the parent had.
 *
 * These exercise `chapterFork` against real git worktrees and real shadow
 * repositories rather than mocking the snapshot layer, because the whole question is
 * whether the git-level pieces compose correctly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, projects } from "../db/schema";
import { generateId } from "../lib/id";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import { chapterFork } from "./chapter-fork";
import { ensureChapterSnapshot } from "./chapter-snapshot-ref";
import { SNAPSHOT_HEAD_REF, worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const tempDirs: string[] = [];
const snapshotPaths: string[] = [];
const createdChapters: string[] = [];
const createdProjects: string[] = [];

/** A project whose git repo has one commit, plus a trunk chapter on a worktree. */
async function createProjectWithChapter(): Promise<{
	projectId: string;
	chapterId: string;
	gitPath: string;
	worktree: string;
}> {
	const gitPath = mkdtempSync(join(tmpdir(), "nf-fork-snap-"));
	tempDirs.push(gitPath);
	await safeSpawn({ cmd: ["git", "init"], cwd: gitPath, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: gitPath });
	await safeSpawn({ cmd: ["git", "config", "user.name", "Test"], cwd: gitPath });
	writeFileSync(join(gitPath, "app.txt"), "committed\n");
	await safeSpawn({ cmd: ["git", "add", "-A"], cwd: gitPath, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "commit", "-m", "seed"], cwd: gitPath, timeout: 15_000 });

	const branch = `chapter/parent-${generateId().slice(0, 6)}`;
	const worktree = resolve(gitPath, ".worktrees", "parent");
	const added = await safeSpawn({
		cmd: ["git", "worktree", "add", worktree, "-b", branch],
		cwd: gitPath,
		timeout: 15_000,
	});
	if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
	tempDirs.push(worktree);
	snapshotPaths.push(normalizePathForComparison(worktree));

	const now = new Date().toISOString();
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Fork snapshot project",
		gitPath,
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(projectId);

	const chapterId = generateId();
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "Parent",
		branch,
		baseBranch: "main",
		worktreePath: worktree,
		status: "active",
		role: "trunk",
		createdAt: now,
		updatedAt: now,
	});
	createdChapters.push(chapterId);

	return { projectId, chapterId, gitPath, worktree };
}

/**
 * Assert a value is present and narrow it.
 *
 * Snapshot calls return null on failure by design, so without narrowing a null
 * result would surface as a type error rather than the test failure it is.
 */
function present<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}

afterEach(async () => {
	// Children are created by fork(), so sweep by project rather than by tracked id.
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
	createdChapters.splice(0);
	for (const projectId of createdProjects.splice(0)) {
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const dir of tempDirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir, undefined, { force: true }).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
	snapshotPaths.splice(0);
});

describe("forking from uncommitted state", () => {
	test("carries the parent's uncommitted changes when no fork point is named", async () => {
		const parent = await createProjectWithChapter();

		// Uncommitted work of every kind a commit-based fork would have lost: a
		// modification, a brand-new file, and a deletion.
		writeFileSync(join(parent.worktree, "app.txt"), "uncommitted edit\n");
		writeFileSync(join(parent.worktree, "added.txt"), "only in the workspace\n");
		await ensureChapterSnapshot(parent.worktree);

		const child = await chapterFork.fork(parent.chapterId, { inheritMode: "fresh" });
		expect(child.worktreePath).toBeTruthy();
		const childPath = child.worktreePath as string;
		tempDirs.push(childPath);

		// This is the defect being fixed: previously the fork started at HEAD, so the
		// file read back as "committed" and added.txt did not exist at all.
		expect(readFileSync(join(childPath, "app.txt"), "utf-8")).toBe("uncommitted edit\n");
		expect(existsSync(join(childPath, "added.txt"))).toBe(true);
		expect(readFileSync(join(childPath, "added.txt"), "utf-8")).toBe("only in the workspace\n");
	});

	test("propagates a file the parent deleted without committing", async () => {
		const parent = await createProjectWithChapter();
		writeFileSync(join(parent.worktree, "doomed.txt"), "will be deleted\n");
		await safeSpawn({ cmd: ["git", "add", "-A"], cwd: parent.worktree, timeout: 15_000 });
		await safeSpawn({
			cmd: ["git", "commit", "-m", "add doomed"],
			cwd: parent.worktree,
			timeout: 15_000,
		});

		// Deleted but not committed. A commit-based fork would resurrect it.
		rmSync(join(parent.worktree, "doomed.txt"));
		await ensureChapterSnapshot(parent.worktree);

		const child = await chapterFork.fork(parent.chapterId, { inheritMode: "fresh" });
		const childPath = child.worktreePath as string;
		tempDirs.push(childPath);

		expect(existsSync(join(childPath, "doomed.txt"))).toBe(false);
	});

	test("records the fork's snapshot pointer and shadow key", async () => {
		const parent = await createProjectWithChapter();
		writeFileSync(join(parent.worktree, "app.txt"), "parent state\n");
		const parentSnap = await ensureChapterSnapshot(parent.worktree);
		expect(parentSnap).not.toBeNull();

		const child = await chapterFork.fork(parent.chapterId, { inheritMode: "fresh" });
		const childPath = child.worktreePath as string;
		tempDirs.push(childPath);

		const row = await db.query.chapters.findFirst({
			where: eq(chapters.id, child.id),
			columns: { snapshotCommitSha: true, snapshotShadowKey: true },
		});
		// The pointer is what later forks and merges read instead of a commit, and the
		// shadow key is what stops the orphan sweep from deleting this lineage while the
		// chapter is dormant.
		expect(row?.snapshotCommitSha).toBe(present(parentSnap, "parent snapshot").commitSha);
		expect(row?.snapshotShadowKey).toBeTruthy();
	});

	test("the fork keeps a merge base with its parent, so later work can be combined", async () => {
		const parent = await createProjectWithChapter();
		writeFileSync(join(parent.worktree, "app.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
		const forkPoint = await ensureChapterSnapshot(parent.worktree);

		const child = await chapterFork.fork(parent.chapterId, { inheritMode: "fresh" });
		const childPath = child.worktreePath as string;
		tempDirs.push(childPath);

		// Both sides move on, still without committing anything.
		writeFileSync(join(parent.worktree, "app.txt"), "l1-parent\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
		const parentAfter = await ensureChapterSnapshot(parent.worktree);
		writeFileSync(join(childPath, "app.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8-child\n");
		const childAfter = await ensureChapterSnapshot(childPath);

		// The fork inherited the parent's lineage, so the two share an ancestor —
		// without that transfer every overlapping edit would look like a conflict.
		const head = await worktreeTreeSnapshot.getRef(childPath, SNAPSHOT_HEAD_REF);
		expect(head).toBe(present(childAfter, "child snapshot").commitSha);

		const incoming = await worktreeTreeSnapshot.fetchSnapshotFrom(
			parent.worktree,
			childPath,
			SNAPSHOT_HEAD_REF,
			"refs/nf/incoming/child",
		);
		expect(incoming).toBe(present(childAfter, "child snapshot").commitSha);
		const base = await worktreeTreeSnapshot.snapshotMergeBase(
			parent.worktree,
			present(parentAfter, "parent snapshot").commitSha,
			present(incoming, "fetched child lineage"),
		);
		expect(base).toBe(present(forkPoint, "fork point").commitSha);

		// And the two lines of uncommitted work merge cleanly.
		const merged = await worktreeTreeSnapshot.mergeSnapshots(
			parent.worktree,
			present(parentAfter, "parent snapshot").commitSha,
			present(incoming, "fetched child lineage"),
		);
		expect(merged.conflicts).toEqual([]);
		const combined = await worktreeTreeSnapshot.readFileAtTree(
			parent.worktree,
			merged.tree,
			"app.txt",
		);
		expect(combined).toContain("l1-parent");
		expect(combined).toContain("l8-child");
	});

	test("forking a clean parent still produces a usable worktree", async () => {
		const parent = await createProjectWithChapter();
		// No uncommitted changes at all — the previously supported path must not regress.
		const child = await chapterFork.fork(parent.chapterId, { inheritMode: "fresh" });
		const childPath = child.worktreePath as string;
		tempDirs.push(childPath);

		expect(readFileSync(join(childPath, "app.txt"), "utf-8")).toBe("committed\n");
		expect("warnings" in child ? child.warnings : []).toEqual([]);
	});

	test("does not add commits to the user's repository", async () => {
		const parent = await createProjectWithChapter();
		writeFileSync(join(parent.worktree, "app.txt"), "still uncommitted\n");
		await ensureChapterSnapshot(parent.worktree);

		const before = await safeSpawn({
			cmd: ["git", "rev-list", "--count", "HEAD"],
			cwd: parent.worktree,
			timeout: 15_000,
		});
		const child = await chapterFork.fork(parent.chapterId, { inheritMode: "fresh" });
		tempDirs.push(child.worktreePath as string);
		const after = await safeSpawn({
			cmd: ["git", "rev-list", "--count", "HEAD"],
			cwd: parent.worktree,
			timeout: 15_000,
		});

		// The whole premise: no commit was required of the user, so none was created.
		expect(after.stdout.trim()).toBe(before.stdout.trim());
		const status = await safeSpawn({
			cmd: ["git", "status", "--porcelain"],
			cwd: parent.worktree,
			timeout: 15_000,
		});
		expect(status.stdout).toContain("app.txt");
	});
});
