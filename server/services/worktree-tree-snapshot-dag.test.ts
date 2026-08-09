/**
 * Snapshot DAG behaviour.
 *
 * These cases cover the properties that let fork and merge operate on *uncommitted*
 * work. The distinction from `worktree-tree-snapshot.test.ts` is what the two need
 * from a snapshot: a rollback knows both endpoints of the span it reverses and only
 * needs bytes, whereas combining two independently-edited workspaces needs to know
 * what they had in common — a question only ancestry can answer.
 *
 * The scenarios therefore assert on git's own computation (merge base, three-way
 * merge) rather than on our bookkeeping, because that computation is the thing being
 * relied upon.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, projects, worktreeTreeSnapshots } from "../db/schema";
import { generateId } from "../lib/id";
import { getNarraforkPath } from "../lib/narrafork-home";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import {
	SNAPSHOT_BASE_REF,
	SNAPSHOT_HEAD_REF,
	snapshotIncomingRef,
	treeSnapshotKey,
	worktreeTreeSnapshot,
} from "./worktree-tree-snapshot";

const tempDirs: string[] = [];
const snapshotPaths: string[] = [];
const createdChapters: string[] = [];
const createdProjects: string[] = [];

/**
 * A main repo plus one linked worktree — the only shape production runs.
 *
 * Chapters always live in `<project>/.worktrees/<name>`, where `.git` is a pointer
 * file. A plain `git init` directory would not exercise the exclude resolution that
 * shape requires.
 */
async function createWorktree(
	prefix: string,
	files: Record<string, string> = { "app.txt": "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n" },
): Promise<{ main: string; worktree: string }> {
	const main = mkdtempSync(join(tmpdir(), `${prefix}main-`));
	tempDirs.push(main);
	await safeSpawn({ cmd: ["git", "init"], cwd: main, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: main });
	await safeSpawn({ cmd: ["git", "config", "user.name", "Test"], cwd: main });
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(join(main, name), contents);
	}
	await safeSpawn({ cmd: ["git", "add", "-A"], cwd: main, timeout: 15_000 });
	await safeSpawn({ cmd: ["git", "commit", "-m", "seed"], cwd: main, timeout: 15_000 });

	const worktree = join(main, ".worktrees", "chapter");
	const added = await safeSpawn({
		cmd: [
			"git",
			"worktree",
			"add",
			worktree,
			"-b",
			`chapter-${Math.random().toString(36).slice(2, 8)}`,
		],
		cwd: main,
		timeout: 15_000,
	});
	if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
	tempDirs.push(worktree);
	snapshotPaths.push(normalizePathForComparison(worktree));
	return { main, worktree };
}

/**
 * Assert a value is present and narrow it.
 *
 * Every DAG call returns null on failure by design, so without narrowing each
 * assertion would compare `string | undefined` against `string | null` and the
 * real failure (a null result) would surface as a type error instead of a clear
 * test failure.
 */
function present<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}

/** Count of commits reachable from the real repo's HEAD, to prove none are added. */
async function realCommitCount(worktree: string): Promise<number> {
	const result = await safeSpawn({
		cmd: ["git", "rev-list", "--count", "HEAD"],
		cwd: worktree,
		timeout: 15_000,
	});
	return Number(result.stdout.trim());
}

/** The real repo's own view of pending changes, to prove work stays uncommitted. */
async function realStatus(worktree: string): Promise<string> {
	const result = await safeSpawn({
		cmd: ["git", "status", "--porcelain"],
		cwd: worktree,
		timeout: 15_000,
	});
	return result.stdout.trim();
}

afterEach(async () => {
	for (const id of createdChapters.splice(0)) {
		await db.delete(chapters).where(eq(chapters.id, id));
	}
	for (const id of createdProjects.splice(0)) {
		await db.delete(projects).where(eq(projects.id, id));
	}
	for (const dir of tempDirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir, undefined, { force: true }).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
	for (const path of snapshotPaths.splice(0)) {
		await db.delete(worktreeTreeSnapshots).where(eq(worktreeTreeSnapshots.worktreePath, path));
	}
});

describe("snapshot lineage", () => {
	test("advancing the ref chains each capture onto the previous one", async () => {
		const { worktree } = await createWorktree("nf-dag-chain-");

		writeFileSync(join(worktree, "app.txt"), "first\n");
		const first = await worktreeTreeSnapshot.advanceSnapshotRef(worktree);
		expect(first).not.toBeNull();

		writeFileSync(join(worktree, "app.txt"), "second\n");
		const second = await worktreeTreeSnapshot.advanceSnapshotRef(worktree);
		expect(second).not.toBeNull();
		expect(present(second, "second snapshot").commitSha).not.toBe(
			present(first, "first snapshot").commitSha,
		);

		// The ref tracks the newest snapshot, and the newest descends from the first —
		// which is the property that makes a merge base computable later.
		const head = await worktreeTreeSnapshot.getRef(worktree, SNAPSHOT_HEAD_REF);
		expect(head).toBe(present(second, "second snapshot").commitSha);
		const base = await worktreeTreeSnapshot.snapshotMergeBase(
			worktree,
			present(first, "first snapshot").commitSha,
			present(second, "second snapshot").commitSha,
		);
		expect(base).toBe(present(first, "first snapshot").commitSha);
	});

	test("an unchanged workspace does not extend the lineage", async () => {
		const { worktree } = await createWorktree("nf-dag-noop-");

		writeFileSync(join(worktree, "app.txt"), "only\n");
		const first = await worktreeTreeSnapshot.advanceSnapshotRef(worktree);
		const again = await worktreeTreeSnapshot.advanceSnapshotRef(worktree);

		// Identical content must not add a link, or the DAG would grow with every tool
		// call that happened to write nothing.
		expect(present(again, "repeat snapshot").commitSha).toBe(
			present(first, "first snapshot").commitSha,
		);
		expect(present(again, "repeat snapshot").treeHash).toBe(
			present(first, "first snapshot").treeHash,
		);
	});

	test("snapshot commits stay out of the user's repository", async () => {
		const { worktree } = await createWorktree("nf-dag-invisible-");
		const before = await realCommitCount(worktree);

		writeFileSync(join(worktree, "app.txt"), "changed\n");
		writeFileSync(join(worktree, "brand-new.txt"), "new\n");
		await worktreeTreeSnapshot.advanceSnapshotRef(worktree);

		// The whole point: state was recorded, and the user's history did not move.
		expect(await realCommitCount(worktree)).toBe(before);
		const status = await realStatus(worktree);
		expect(status).toContain("app.txt");
		expect(status).toContain("brand-new.txt");
	});

	test("a lineage survives a repack that keeps unreferenced objects", async () => {
		const { worktree } = await createWorktree("nf-dag-gc-");

		writeFileSync(join(worktree, "app.txt"), "precious\n");
		const snap = await worktreeTreeSnapshot.advanceSnapshotRef(worktree);
		expect(snap).not.toBeNull();

		await worktreeTreeSnapshot.gcAll();

		// Before refs existed, gc's prune window silently deleted snapshots the
		// database still pointed at. Both the commit and its bytes must survive.
		expect(await worktreeTreeSnapshot.hasTree(worktree, present(snap, "snapshot").treeHash)).toBe(
			true,
		);
		expect(await worktreeTreeSnapshot.getRef(worktree, SNAPSHOT_HEAD_REF)).toBe(
			present(snap, "snapshot").commitSha,
		);
		const contents = await worktreeTreeSnapshot.readFileAtTree(
			worktree,
			present(snap, "snapshot").treeHash,
			"app.txt",
		);
		expect(contents).toBe("precious\n");
	});

	test("a pre-DAG snapshot survives a repack too", async () => {
		const { worktree } = await createWorktree("nf-dag-legacy-");

		// A bare capture with no commit and no ref — exactly what older rows point at.
		writeFileSync(join(worktree, "app.txt"), "legacy\n");
		const treeHash = await worktreeTreeSnapshot.capture(worktree);

		await worktreeTreeSnapshot.gcAll();

		expect(await worktreeTreeSnapshot.hasTree(worktree, treeHash)).toBe(true);
	});

	test("rejects refs outside its own namespace", async () => {
		const { worktree } = await createWorktree("nf-dag-refguard-");
		writeFileSync(join(worktree, "app.txt"), "x\n");
		const snap = await worktreeTreeSnapshot.advanceSnapshotRef(worktree);

		// A chapter id flows into the incoming-ref name, so escaping the namespace must
		// not be possible.
		await expect(
			worktreeTreeSnapshot.setRef(worktree, "refs/heads/main", present(snap, "snapshot").commitSha),
		).rejects.toThrow(/outside refs\/nf/);
		await expect(
			worktreeTreeSnapshot.setRef(
				worktree,
				"refs/nf/../heads/main",
				present(snap, "snapshot").commitSha,
			),
		).rejects.toThrow(/Invalid snapshot ref/);
		await expect(worktreeTreeSnapshot.getRef(worktree, "HEAD")).rejects.toThrow(/outside refs\/nf/);
	});
});

describe("cross-worktree lineage transfer", () => {
	test("fetching a lineage makes a merge base computable between two worktrees", async () => {
		const parent = await createWorktree("nf-dag-fetch-parent-");
		const child = await createWorktree("nf-dag-fetch-child-");

		// Parent records some uncommitted work.
		writeFileSync(join(parent.worktree, "app.txt"), "shared-base\n");
		const parentSnap = await worktreeTreeSnapshot.advanceSnapshotRef(parent.worktree);
		expect(parentSnap).not.toBeNull();

		// The child adopts that lineage. Objects are copied, not referenced: shadow
		// repos deliberately share no object store, because linking them to the user's
		// repo would let a routine `git gc` there destroy snapshots.
		const fetched = await worktreeTreeSnapshot.fetchSnapshotFrom(
			child.worktree,
			parent.worktree,
			SNAPSHOT_HEAD_REF,
			SNAPSHOT_BASE_REF,
		);
		expect(fetched).toBe(present(parentSnap, "parent snapshot").commitSha);

		await worktreeTreeSnapshot.setRef(
			child.worktree,
			SNAPSHOT_HEAD_REF,
			present(fetched, "fetched lineage"),
		);
		writeFileSync(join(child.worktree, "app.txt"), "shared-base\nchild-line\n");
		const childSnap = await worktreeTreeSnapshot.advanceSnapshotRef(child.worktree);

		const base = await worktreeTreeSnapshot.snapshotMergeBase(
			child.worktree,
			present(childSnap, "child snapshot").commitSha,
			present(fetched, "fetched lineage"),
		);
		expect(base).toBe(present(parentSnap, "parent snapshot").commitSha);
	});

	test("the receiving repository is self-contained after a fetch", async () => {
		const parent = await createWorktree("nf-dag-selfcontained-parent-");
		const child = await createWorktree("nf-dag-selfcontained-child-");

		writeFileSync(join(parent.worktree, "app.txt"), "from-parent\n");
		const parentSnap = await worktreeTreeSnapshot.advanceSnapshotRef(parent.worktree);
		await worktreeTreeSnapshot.fetchSnapshotFrom(
			child.worktree,
			parent.worktree,
			SNAPSHOT_HEAD_REF,
			SNAPSHOT_BASE_REF,
		);

		// Destroying the source must not invalidate what the child fetched, or a fork
		// would break as soon as its parent chapter was deleted.
		await worktreeTreeSnapshot.destroy(parent.worktree, undefined, { force: true });

		const tree = await worktreeTreeSnapshot.treeOfSnapshot(
			child.worktree,
			present(parentSnap, "parent snapshot").commitSha,
		);
		expect(tree).toBe(present(parentSnap, "parent snapshot").treeHash);
		expect(
			await worktreeTreeSnapshot.readFileAtTree(
				child.worktree,
				present(tree, "resolved tree"),
				"app.txt",
			),
		).toBe("from-parent\n");
	});

	test("fetching within one repository does not deadlock", async () => {
		const { worktree } = await createWorktree("nf-dag-selffetch-");
		writeFileSync(join(worktree, "app.txt"), "x\n");
		const snap = await worktreeTreeSnapshot.advanceSnapshotRef(worktree);

		// Source and target resolve to the same shadow dir. The lock is not reentrant,
		// so this has to be recognised rather than acquired twice.
		const aliased = await worktreeTreeSnapshot.fetchSnapshotFrom(
			worktree,
			worktree,
			SNAPSHOT_HEAD_REF,
			snapshotIncomingRef("self"),
		);
		expect(aliased).toBe(present(snap, "snapshot").commitSha);
	});

	test("fetching from a worktree with no shadow repository reports nothing", async () => {
		const child = await createWorktree("nf-dag-nosource-");
		const bare = mkdtempSync(join(tmpdir(), "nf-dag-bare-"));
		tempDirs.push(bare);

		const fetched = await worktreeTreeSnapshot.fetchSnapshotFrom(
			child.worktree,
			bare,
			SNAPSHOT_HEAD_REF,
			SNAPSHOT_BASE_REF,
		);
		expect(fetched).toBeNull();
	});
});

describe("merging uncommitted work", () => {
	test("combines two lines of uncommitted work that never produced a commit", async () => {
		const trunk = await createWorktree("nf-dag-merge-trunk-");
		const branch = await createWorktree("nf-dag-merge-branch-");
		const commitsBefore = await realCommitCount(trunk.worktree);

		// A shared starting point, recorded but never committed.
		writeFileSync(join(trunk.worktree, "app.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
		const start = await worktreeTreeSnapshot.advanceSnapshotRef(trunk.worktree);

		// The branch forks from that snapshot.
		const forked = await worktreeTreeSnapshot.fetchSnapshotFrom(
			branch.worktree,
			trunk.worktree,
			SNAPSHOT_HEAD_REF,
			SNAPSHOT_BASE_REF,
		);
		await worktreeTreeSnapshot.setRef(
			branch.worktree,
			SNAPSHOT_HEAD_REF,
			present(forked, "forked lineage"),
		);
		await worktreeTreeSnapshot.materializeTree(
			branch.worktree,
			present(start, "start snapshot").treeHash,
		);

		// Both sides edit far-apart regions, and neither commits.
		writeFileSync(
			join(trunk.worktree, "app.txt"),
			"l1-trunk\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n",
		);
		const trunkSnap = await worktreeTreeSnapshot.advanceSnapshotRef(trunk.worktree);
		writeFileSync(
			join(branch.worktree, "app.txt"),
			"l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9-branch\nl10\n",
		);
		writeFileSync(join(branch.worktree, "feature.txt"), "new file\n");
		const branchSnap = await worktreeTreeSnapshot.advanceSnapshotRef(branch.worktree);

		// Merge branch into trunk.
		const incoming = await worktreeTreeSnapshot.fetchSnapshotFrom(
			trunk.worktree,
			branch.worktree,
			SNAPSHOT_HEAD_REF,
			snapshotIncomingRef("branch"),
		);
		expect(incoming).toBe(present(branchSnap, "branch snapshot").commitSha);
		const merged = await worktreeTreeSnapshot.mergeSnapshots(
			trunk.worktree,
			present(trunkSnap, "trunk snapshot").commitSha,
			present(incoming, "incoming lineage"),
		);
		expect(merged.conflicts).toEqual([]);

		await worktreeTreeSnapshot.materializeTree(trunk.worktree, merged.tree);
		const result = readFileSync(join(trunk.worktree, "app.txt"), "utf-8");
		expect(result).toContain("l1-trunk");
		expect(result).toContain("l9-branch");
		expect(existsSync(join(trunk.worktree, "feature.txt"))).toBe(true);

		// And the user's git history was never involved.
		expect(await realCommitCount(trunk.worktree)).toBe(commitsBefore);
	});

	test("a conflict is reported without touching the worktree", async () => {
		const trunk = await createWorktree("nf-dag-conflict-trunk-");
		const branch = await createWorktree("nf-dag-conflict-branch-");

		writeFileSync(join(trunk.worktree, "app.txt"), "l1\nl2\nl3\n");
		const start = await worktreeTreeSnapshot.advanceSnapshotRef(trunk.worktree);
		const forked = await worktreeTreeSnapshot.fetchSnapshotFrom(
			branch.worktree,
			trunk.worktree,
			SNAPSHOT_HEAD_REF,
			SNAPSHOT_BASE_REF,
		);
		await worktreeTreeSnapshot.setRef(
			branch.worktree,
			SNAPSHOT_HEAD_REF,
			present(forked, "forked lineage"),
		);
		await worktreeTreeSnapshot.materializeTree(
			branch.worktree,
			present(start, "start snapshot").treeHash,
		);

		// Both edit the same line.
		writeFileSync(join(trunk.worktree, "app.txt"), "l1\nTRUNK\nl3\n");
		const trunkSnap = await worktreeTreeSnapshot.advanceSnapshotRef(trunk.worktree);
		writeFileSync(join(branch.worktree, "app.txt"), "l1\nBRANCH\nl3\n");
		await worktreeTreeSnapshot.advanceSnapshotRef(branch.worktree);

		const incoming = await worktreeTreeSnapshot.fetchSnapshotFrom(
			trunk.worktree,
			branch.worktree,
			SNAPSHOT_HEAD_REF,
			snapshotIncomingRef("branch"),
		);
		const merged = await worktreeTreeSnapshot.mergeSnapshots(
			trunk.worktree,
			present(trunkSnap, "trunk snapshot").commitSha,
			present(incoming, "incoming lineage"),
		);

		expect(merged.conflicts).toEqual(["app.txt"]);
		// The conflicted tree exists but must never reach disk on its own: it holds
		// conflict markers, so writing it out would corrupt the file it claims to merge.
		expect(readFileSync(join(trunk.worktree, "app.txt"), "utf-8")).toBe("l1\nTRUNK\nl3\n");

		// It is still readable, which is what lets a caller show or resolve the conflict.
		const conflicted = await worktreeTreeSnapshot.readFileAtTree(
			trunk.worktree,
			merged.tree,
			"app.txt",
		);
		expect(conflicted).toContain("<<<<<<<");
		expect(conflicted).toContain("TRUNK");
		expect(conflicted).toContain("BRANCH");
	});

	test("recording a merge parent is what prevents a spurious later conflict", async () => {
		const trunk = await createWorktree("nf-dag-parents-trunk-");
		const branch = await createWorktree("nf-dag-parents-branch-");

		writeFileSync(join(trunk.worktree, "app.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
		const start = await worktreeTreeSnapshot.advanceSnapshotRef(trunk.worktree);
		const forked = await worktreeTreeSnapshot.fetchSnapshotFrom(
			branch.worktree,
			trunk.worktree,
			SNAPSHOT_HEAD_REF,
			SNAPSHOT_BASE_REF,
		);
		await worktreeTreeSnapshot.setRef(
			branch.worktree,
			SNAPSHOT_HEAD_REF,
			present(forked, "forked lineage"),
		);
		await worktreeTreeSnapshot.materializeTree(
			branch.worktree,
			present(start, "start snapshot").treeHash,
		);

		// Each side advances once.
		writeFileSync(join(trunk.worktree, "app.txt"), "a-trunk\nb\nc\nd\ne\nf\ng\nh\n");
		const trunk1 = await worktreeTreeSnapshot.advanceSnapshotRef(trunk.worktree);
		writeFileSync(join(branch.worktree, "app.txt"), "a\nb\nc\nd\ne\nf\ng\nh-branch\n");
		await worktreeTreeSnapshot.advanceSnapshotRef(branch.worktree);

		// The branch syncs trunk's state in.
		const trunkIn = await worktreeTreeSnapshot.fetchSnapshotFrom(
			branch.worktree,
			trunk.worktree,
			SNAPSHOT_HEAD_REF,
			snapshotIncomingRef("trunk"),
		);
		const branchHead = await worktreeTreeSnapshot.getRef(branch.worktree, SNAPSHOT_HEAD_REF);
		const synced = await worktreeTreeSnapshot.mergeSnapshots(
			branch.worktree,
			present(branchHead, "branch head"),
			present(trunkIn, "fetched trunk lineage"),
		);
		expect(synced.conflicts).toEqual([]);
		await worktreeTreeSnapshot.materializeTree(branch.worktree, synced.tree);

		// Record that sync BOTH ways and compare. Single-parent loses the fact that
		// trunk's change is already incorporated.
		const singleParent = await worktreeTreeSnapshot.commitSnapshot(
			branch.worktree,
			synced.tree,
			[present(branchHead, "branch head")],
			"sync without merge parent",
		);
		const twoParents = await worktreeTreeSnapshot.commitSnapshot(
			branch.worktree,
			synced.tree,
			[present(branchHead, "branch head"), present(trunkIn, "fetched trunk lineage")],
			"sync with merge parent",
		);

		// Trunk keeps moving, then the branch is merged back.
		writeFileSync(join(trunk.worktree, "app.txt"), "a-trunk\nb-trunk2\nc\nd\ne\nf\ng\nh\n");
		const trunk2 = await worktreeTreeSnapshot.advanceSnapshotRef(trunk.worktree);
		expect(present(trunk2, "second trunk snapshot").commitSha).not.toBe(
			present(trunk1, "first trunk snapshot").commitSha,
		);

		// Move each candidate across on its own ref so both are present in trunk's repo.
		await worktreeTreeSnapshot.setRef(branch.worktree, snapshotIncomingRef("single"), singleParent);
		await worktreeTreeSnapshot.setRef(branch.worktree, snapshotIncomingRef("two"), twoParents);
		const single = await worktreeTreeSnapshot.fetchSnapshotFrom(
			trunk.worktree,
			branch.worktree,
			snapshotIncomingRef("single"),
			snapshotIncomingRef("single"),
		);
		const two = await worktreeTreeSnapshot.fetchSnapshotFrom(
			trunk.worktree,
			branch.worktree,
			snapshotIncomingRef("two"),
			snapshotIncomingRef("two"),
		);

		const withoutParent = await worktreeTreeSnapshot.mergeSnapshots(
			trunk.worktree,
			present(trunk2, "second trunk snapshot").commitSha,
			present(single, "single-parent lineage"),
		);
		const withParent = await worktreeTreeSnapshot.mergeSnapshots(
			trunk.worktree,
			present(trunk2, "second trunk snapshot").commitSha,
			present(two, "two-parent lineage"),
		);

		// This is the reason merges must record two parents.
		expect(withoutParent.conflicts).toEqual(["app.txt"]);
		expect(withParent.conflicts).toEqual([]);
	});
});

describe("shadow repository ownership", () => {
	async function createChapterClaiming(worktree: string): Promise<void> {
		const projectId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: projectId,
			name: "DAG ownership project",
			gitPath: worktree,
			createdAt: now,
			updatedAt: now,
		});
		createdProjects.push(projectId);

		const chapterId = generateId();
		await db.insert(chapters).values({
			id: chapterId,
			projectId,
			title: "Dormant chapter",
			branch: `chapter/dag-own-${chapterId.slice(0, 6)}`,
			baseBranch: "main",
			// Dormant: the worktree is gone, but the lineage must not be.
			worktreePath: null,
			snapshotShadowKey: treeSnapshotKey("local", worktree),
			status: "dormant",
			createdAt: now,
			updatedAt: now,
		});
		createdChapters.push(chapterId);
	}

	test("keeps a shadow repository a chapter still claims", async () => {
		const { worktree } = await createWorktree("nf-dag-claimed-");
		writeFileSync(join(worktree, "app.txt"), "dormant work\n");
		const snap = await worktreeTreeSnapshot.advanceSnapshotRef(worktree);
		await createChapterClaiming(worktree);

		// The orphan sweep walks directories no *active* chapter claims, so a dormant
		// chapter whose worktree removal failed looks exactly like an abandoned one.
		// Without this guard it would take the chapter's whole lineage with it.
		const destroyed = await worktreeTreeSnapshot.destroy(worktree);
		expect(destroyed).toBe(false);
		expect(await worktreeTreeSnapshot.hasTree(worktree, present(snap, "snapshot").treeHash)).toBe(
			true,
		);
	});

	test("force removes a claimed repository, for deleting the chapter itself", async () => {
		const { worktree } = await createWorktree("nf-dag-forced-");
		writeFileSync(join(worktree, "app.txt"), "doomed\n");
		const snap = await worktreeTreeSnapshot.advanceSnapshotRef(worktree);
		await createChapterClaiming(worktree);

		const destroyed = await worktreeTreeSnapshot.destroy(worktree, undefined, { force: true });
		expect(destroyed).toBe(true);
		expect(await worktreeTreeSnapshot.hasTree(worktree, present(snap, "snapshot").treeHash)).toBe(
			false,
		);
	});

	test("removes an unclaimed repository and its recorded hashes", async () => {
		const { worktree } = await createWorktree("nf-dag-unclaimed-");
		writeFileSync(join(worktree, "app.txt"), "orphan\n");
		const snap = await worktreeTreeSnapshot.advanceSnapshotRef(worktree);

		const rows = await db
			.select({ id: worktreeTreeSnapshots.id })
			.from(worktreeTreeSnapshots)
			.where(eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(worktree)));
		expect(rows.length).toBeGreaterThan(0);

		const destroyed = await worktreeTreeSnapshot.destroy(worktree);
		expect(destroyed).toBe(true);
		expect(await worktreeTreeSnapshot.hasTree(worktree, present(snap, "snapshot").treeHash)).toBe(
			false,
		);

		// The doc comment always claimed the ledger rows went too; now they do, so no
		// later reader has to probe the filesystem to discover they are dangling.
		const after = await db
			.select({ id: worktreeTreeSnapshots.id })
			.from(worktreeTreeSnapshots)
			.where(eq(worktreeTreeSnapshots.worktreePath, normalizePathForComparison(worktree)));
		expect(after.length).toBe(0);
	});

	test("keeps a repository claimed only by a live worktreePath", async () => {
		const { worktree } = await createWorktree("nf-dag-claimed-by-path-");
		writeFileSync(join(worktree, "app.txt"), "first capture\n");
		const snap = await worktreeTreeSnapshot.advanceSnapshotRef(worktree);

		// `snapshotShadowKey` left NULL on purpose: that is the state of every chapter
		// that has not yet run something which advances the lineage, and keying ownership
		// on it alone read those as unclaimed — so the orphan sweep was entitled to delete
		// the shadow repository of an *active* chapter.
		const projectId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: projectId,
			name: "DAG path-claim project",
			gitPath: worktree,
			createdAt: now,
			updatedAt: now,
		});
		createdProjects.push(projectId);
		const chapterId = generateId();
		await db.insert(chapters).values({
			id: chapterId,
			projectId,
			title: "Active chapter with no shadow key",
			branch: `chapter/dag-path-${chapterId.slice(0, 6)}`,
			baseBranch: "main",
			worktreePath: worktree,
			snapshotShadowKey: null,
			status: "active",
			createdAt: now,
			updatedAt: now,
		});
		createdChapters.push(chapterId);

		expect(await worktreeTreeSnapshot.destroy(worktree)).toBe(false);
		expect(await worktreeTreeSnapshot.hasTree(worktree, present(snap, "snapshot").treeHash)).toBe(
			true,
		);
	});
});

/**
 * `gcAll` used to delete any shadow directory whose `HEAD` was missing. `HEAD` is a
 * 23-byte pointer nothing here dereferences, while `objects/` beside it holds every
 * snapshot the database still points at — so an interrupted write cost a chapter its
 * whole revert history.
 */
describe("shadow repository repair", () => {
	/** The shadow directory backing a workspace, found by its `HEAD`. */
	function shadowDirFor(worktree: string): string {
		const digest = createHash("sha256").update(treeSnapshotKey("local", worktree)).digest("hex");
		return getNarraforkPath("tree-snapshots", digest.slice(0, 32));
	}

	test("restores a missing HEAD instead of deleting the objects beside it", async () => {
		const { worktree } = await createWorktree("nf-dag-repair-head-");
		writeFileSync(join(worktree, "app.txt"), "work worth keeping\n");
		const snap = present(await worktreeTreeSnapshot.advanceSnapshotRef(worktree), "snapshot");

		const dir = shadowDirFor(worktree);
		rmSync(join(dir, "HEAD"), { force: true });
		await worktreeTreeSnapshot.gcAll();

		expect(existsSync(join(dir, "HEAD"))).toBe(true);
		// The point of the repair: the lineage is still readable afterwards.
		expect(await worktreeTreeSnapshot.hasTree(worktree, snap.treeHash)).toBe(true);
		expect(await worktreeTreeSnapshot.getRef(worktree, SNAPSHOT_HEAD_REF)).toBe(snap.commitSha);
	});

	test("still removes a directory with no objects and no refs", async () => {
		// Nothing to lose here, so deleting is the correct outcome — the repair must not
		// turn the sweep into a no-op that leaves junk accumulating forever.
		const empty = getNarraforkPath("tree-snapshots", `deadbeef${generateId().slice(0, 8)}`);
		mkdirSync(join(empty, "objects", "pack"), { recursive: true });
		mkdirSync(join(empty, "refs"), { recursive: true });
		try {
			await worktreeTreeSnapshot.gcAll();
			expect(existsSync(empty)).toBe(false);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
