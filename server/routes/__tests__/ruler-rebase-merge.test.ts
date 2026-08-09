/**
 * The Ruler's destructive edges: merging, rebasing over a dirty workspace, and the
 * concurrency around both.
 *
 * These cases exist because each one was a way to lose work that no error message
 * mentioned:
 *
 *   - the Ruler deleted the merged chapter's branch, and a commit-free merge needs that
 *     branch to be undoable at all — `unmergeSnapshot` rebuilds the source workspace by
 *     running `git worktree add` against it. Deleting it turned unmerge into a
 *     half-applied operation: the target reverted, the source unrecoverable;
 *   - a reapply that conflicted cleared the parked snapshot's coordinates, even though
 *     the conflict path writes nothing to disk, so the user's uncommitted work was left
 *     addressable only from a log line;
 *   - the rebase endpoint held no lock, so a second request could interleave with the
 *     reset/capture/rebase/reapply sequence of the first.
 *
 * Everything runs against real git repositories and real shadow repositories, because
 * every one of these questions is about whether the git-level pieces compose.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { chapters, projects } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { worktreeLock } from "../../lib/async-mutex";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { safeSpawn } from "../../lib/spawn";
import { chapterMerge } from "../../services/chapter-merge";
import { gitService } from "../../services/git-service";
import { worktreeTreeSnapshot } from "../../services/worktree-tree-snapshot";
import { rulerRoutes } from "../ruler";

const tempDirs: string[] = [];
const createdProjects: string[] = [];

const FILE = "app.txt";
const BASE = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";

/**
 * Mounted the way `app.ts` mounts it, so the `/:id/ruler/*` paths are the real ones.
 *
 * The error handler is the same `buildAppErrorResponse` the real app installs, and that
 * is load-bearing rather than boilerplate: several refusals on this route are thrown
 * `ValidationError`s whose whole value is the 400 status and the prose the user reads.
 * Without it Hono would report them as a bare 500 and the tests would be asserting
 * against the harness instead of against production behaviour.
 */
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "ruler-test-user", role: "user", iat: 0, exp: 0 });
	await next();
});
app.route("/api/projects", rulerRoutes);
app.onError(
	(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
);

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** Whether a ref resolves — the whole question in the merge regression. */
async function refExists(repoPath: string, ref: string): Promise<boolean> {
	const result = await safeSpawn({
		cmd: ["git", "rev-parse", "--verify", "--quiet", ref],
		cwd: repoPath,
		timeout: 15_000,
	});
	return result.exitCode === 0;
}

function present<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}

async function chapterRow(id: string) {
	return present(
		await db.query.chapters.findFirst({ where: eq(chapters.id, id) }),
		`chapter ${id}`,
	);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Env {
	projectId: string;
	gitPath: string;
	/** Root chapter — the trunk, backed by the project's own directory. */
	rootId: string;
	chapterId: string;
	branch: string;
	worktree: string;
}

/**
 * A project with its root chapter and one branch chapter on a linked worktree.
 *
 * The branch chapter's worktree deliberately sits at `<gitPath>/.worktrees/<suffix>`:
 * that is the path `unmergeSnapshot` recomputes from the branch name, so a fixture that
 * put it anywhere else would not exercise the same recreation.
 */
async function createEnv(): Promise<Env> {
	const gitPath = mkdtempSync(join(tmpdir(), "nf-ruler-"));
	tempDirs.push(gitPath);
	await git(["init", "-b", "main"], gitPath);
	await git(["config", "user.email", "test@example.com"], gitPath);
	await git(["config", "user.name", "Test"], gitPath);
	writeFileSync(join(gitPath, FILE), BASE);
	// As `project-db-sync.ensureGitignore` does for real projects. Without it the linked
	// worktrees show up as untracked in the trunk directory, which the commit-merge path
	// correctly refuses as a dirty trunk — an artefact of the fixture, not the behaviour
	// under test.
	writeFileSync(join(gitPath, ".gitignore"), ".worktrees/\n.narrafork/\n");
	await git(["add", "-A"], gitPath);
	await git(["commit", "-m", "seed"], gitPath);

	const now = new Date().toISOString();
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Ruler project",
		gitPath,
		defaultBranch: "main",
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(projectId);

	const rootId = generateId();
	await db.insert(chapters).values({
		id: rootId,
		projectId,
		title: "trunk",
		branch: "main",
		baseBranch: "main",
		worktreePath: gitPath,
		status: "active",
		role: "trunk",
		isRoot: 1,
		createdAt: now,
		updatedAt: now,
	});

	const suffix = `feature-${generateId().slice(0, 6)}`;
	const branch = `chapter/${suffix}`;
	const worktree = resolve(gitPath, ".worktrees", suffix);
	await git(["worktree", "add", worktree, "-b", branch], gitPath);
	tempDirs.push(worktree);
	const chapterId = generateId();
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "feature",
		branch,
		baseBranch: "main",
		worktreePath: worktree,
		status: "active",
		role: "branch",
		startCommitSha: await git(["rev-parse", "HEAD"], gitPath),
		createdAt: now,
		updatedAt: now,
	});

	return { projectId, gitPath, rootId, chapterId, branch, worktree };
}

/** Advance trunk so a rebase has something to replay onto. */
async function advanceTrunk(env: Env, replace: [string, string]): Promise<string> {
	writeFileSync(join(env.gitPath, FILE), BASE.replace(replace[0], replace[1]));
	await git(["add", "-A"], env.gitPath);
	await git(["commit", "-m", "trunk moves on"], env.gitPath);
	return git(["rev-parse", "HEAD"], env.gitPath);
}

async function postRebase(env: Env, chapterId = env.chapterId): Promise<Response> {
	return app.request(`/api/projects/${env.projectId}/ruler/rebase`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ chapterId }),
	});
}

async function postRebaseParked(
	env: Env,
	action: "retry" | "materialize" | "discard",
	chapterId = env.chapterId,
): Promise<Response> {
	return app.request(`/api/projects/${env.projectId}/ruler/rebase-parked`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ chapterId, action }),
	});
}

async function postRebaseResolve(
	env: Env,
	action: "abort" | "continue",
	chapterId = env.chapterId,
): Promise<Response> {
	return app.request(`/api/projects/${env.projectId}/ruler/rebase-resolve`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ chapterId, action }),
	});
}

/**
 * Leave the chapter holding parked-work coordinates.
 *
 * Produced through the real endpoint rather than by writing the columns directly: the
 * point of every case below is what happens to a *real* snapshot, and a planted sha
 * would make the resolvable and unresolvable paths indistinguishable.
 */
async function parkViaConflictedReapply(env: Env): Promise<string> {
	await advanceTrunk(env, ["l5", "l5-TRUNK"]);
	writeFileSync(join(env.worktree, FILE), BASE.replace("l5", "l5-DIRTY"));
	expect((await postRebase(env)).status).toBe(200);
	return present((await chapterRow(env.chapterId)).parkedSnapshotCommitSha, "parked snapshot");
}

afterEach(async () => {
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

describe("merging from the ruler", () => {
	test("keeps the source branch after a commit-free merge, so the merge stays undoable", async () => {
		const env = await createEnv();
		// Uncommitted on both sides — the state only a snapshot merge can represent, and
		// the state whose sole copy is the snapshot once the worktree is removed.
		writeFileSync(join(env.worktree, FILE), BASE.replace("l9", "l9-feature"));
		writeFileSync(join(env.worktree, "only-in-source.txt"), "uncommitted extra\n");

		const res = await app.request(`/api/projects/${env.projectId}/ruler/merge`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sourceChapterId: env.chapterId }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { success: boolean }).toMatchObject({ success: true });

		const merged = await chapterRow(env.chapterId);
		expect(merged.status).toBe("merged");
		// Commit-free by construction: no merge commit, snapshot coordinates instead.
		expect(merged.mergeCommitSha).toBeNull();
		expect(merged.mergeSnapshotCommitSha).toBeTruthy();

		// The regression: the branch is the only handle `unmergeSnapshot` has on the
		// source workspace, and it used to be deleted right here.
		expect(await refExists(env.gitPath, env.branch)).toBe(true);

		// And it is genuinely usable, not merely present.
		const undone = await chapterMerge.unmerge(env.chapterId);
		expect(undone.ok).toBe(true);
		const restored = await chapterRow(env.chapterId);
		expect(restored.status).toBe("active");
		const restoredWorktree = present(restored.worktreePath, "restored worktree path");
		tempDirs.push(restoredWorktree);
		expect(existsSync(restoredWorktree)).toBe(true);
		// The uncommitted work is back — the part that is unrecoverable if the branch is
		// gone, because the branch tip never held it.
		expect(readFileSync(join(restoredWorktree, FILE), "utf-8")).toContain("l9-feature");
		expect(readFileSync(join(restoredWorktree, "only-in-source.txt"), "utf-8")).toBe(
			"uncommitted extra\n",
		);
	});

	test("still deletes the branch when the merge went through commits", async () => {
		const env = await createEnv();
		// A commit merge needs both sides clean and the source's work committed; its
		// contribution then lives in trunk's history, so the branch name carries nothing.
		writeFileSync(join(env.worktree, FILE), BASE.replace("l9", "l9-feature"));
		await git(["add", "-A"], env.worktree);
		await git(["commit", "-m", "feature work"], env.worktree);

		const res = await app.request(`/api/projects/${env.projectId}/ruler/merge`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sourceChapterId: env.chapterId, mode: "commit" }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { success: boolean }).toMatchObject({ success: true });

		const merged = await chapterRow(env.chapterId);
		expect(merged.mergeSnapshotCommitSha).toBeNull();
		expect(await refExists(env.gitPath, env.branch)).toBe(false);
	});
});

describe("rebasing over a dirty workspace", () => {
	test("keeps the parked snapshot addressable when the reapply conflicts", async () => {
		const env = await createEnv();
		await advanceTrunk(env, ["l5", "l5-TRUNK"]);
		// Uncommitted, and on the same line trunk just changed: the three-way reapply has
		// a genuine overlap, which is the case that writes nothing to disk.
		writeFileSync(join(env.worktree, FILE), BASE.replace("l5", "l5-DIRTY"));

		const res = await postRebase(env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			success: boolean;
			parkedSnapshot?: string;
			parkedWorkPending?: boolean;
			parkedWorkStatus?: string;
			reapplyConflictFiles?: string[];
		};
		expect(body.success).toBe(true);
		expect(body.reapplyConflictFiles).toEqual([FILE]);
		// A conflict is a decision for the user, not a NarraFork fault. Both used to
		// surface as a bare `parkedSnapshot`.
		expect(body.parkedWorkStatus).toBe("conflict");
		expect(body.parkedWorkPending).toBe(true);

		// The regression: the coordinates must survive, because nothing was written to
		// the worktree and they are the only route back to the work.
		const row = await chapterRow(env.chapterId);
		expect(row.parkedSnapshotCommitSha).toBe(present(body.parkedSnapshot, "parked snapshot"));
		expect(row.parkedSnapshotBaseTree).toBeTruthy();
		// Nothing half-applied on disk: the rebased content, no markers.
		const onDisk = readFileSync(join(env.worktree, FILE), "utf-8");
		expect(onDisk).toContain("l5-TRUNK");
		expect(onDisk).not.toContain("<<<<<<<");
	});

	test("refuses a second rebase while an earlier one's work is still parked", async () => {
		const env = await createEnv();
		await advanceTrunk(env, ["l5", "l5-TRUNK"]);
		writeFileSync(join(env.worktree, FILE), BASE.replace("l5", "l5-DIRTY"));
		expect((await postRebase(env)).status).toBe(200);
		const parked = present(
			(await chapterRow(env.chapterId)).parkedSnapshotCommitSha,
			"parked snapshot",
		);

		// Proceeding would park a workspace that is itself missing the earlier work.
		const res = await postRebase(env);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: "REBASE_PARKED_WORK_CONFLICT",
			conflictFiles: [FILE],
			parkedSnapshot: parked,
			parkedWorkPending: true,
		});
		// Still owed, so still recorded.
		expect((await chapterRow(env.chapterId)).parkedSnapshotCommitSha).toBe(parked);
	});

	test("hands parked work back as a conflicted tree the user can resolve", async () => {
		const env = await createEnv();
		await advanceTrunk(env, ["l5", "l5-TRUNK"]);
		writeFileSync(join(env.worktree, FILE), BASE.replace("l5", "l5-DIRTY"));
		expect((await postRebase(env)).status).toBe(200);

		const res = await app.request(`/api/projects/${env.projectId}/ruler/rebase-parked`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chapterId: env.chapterId, action: "materialize" }),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, conflictFiles: [FILE] });

		// Both sides are now on disk with markers — the same shape the snapshot-merge
		// path leaves — so the work is no longer reachable only through the DAG.
		const onDisk = readFileSync(join(env.worktree, FILE), "utf-8");
		expect(onDisk).toContain("<<<<<<<");
		expect(onDisk).toContain("l5-TRUNK");
		expect(onDisk).toContain("l5-DIRTY");
		// Debt discharged, so the next rebase is not blocked by it.
		const row = await chapterRow(env.chapterId);
		expect(row.parkedSnapshotCommitSha).toBeNull();
		expect(row.parkedSnapshotBaseTree).toBeNull();
	});

	test("discards only the snapshot the user was actually shown", async () => {
		const env = await createEnv();
		const first = await parkViaConflictedReapply(env);
		const second = `${"9".repeat(39)}a`;

		// The race, reproduced in the window where it actually happens: `discard` reads the
		// coordinates outside any lock, and a rebase holding `worktreeLock` then parks a NEW
		// snapshot and stores ITS coordinates before the discard writes. Driven from the
		// handler's own log call, which sits between that read and the write — the only
		// deterministic seam in the window, since the interleaving is otherwise decided by
		// the scheduler. `.run()` rather than `await`: the hook is synchronous, and drizzle's
		// sqlite driver executes it in place.
		const realInfo = logger.info;
		logger.info = (msg: string, data?: Record<string, unknown>) => {
			if (msg.includes("Discarding the coordinates")) {
				db.update(chapters)
					.set({ parkedSnapshotCommitSha: second })
					.where(eq(chapters.id, env.chapterId))
					.run();
			}
			realInfo(msg, data);
		};

		let res: Response;
		try {
			res = await postRebaseParked(env, "discard");
		} finally {
			logger.info = realInfo;
		}

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: "PARKED_SNAPSHOT_CHANGED",
			staleSnapshot: first,
		});
		// The regression: an unconditional `SET NULL` erased the newer pointer while the
		// response still claimed the older snapshot had been discarded, so work that was
		// never displayed to anyone became unreachable from the row.
		expect((await chapterRow(env.chapterId)).parkedSnapshotCommitSha).toBe(second);
	});

	test("discards when the coordinates still match, and only then", async () => {
		const env = await createEnv();
		const parked = await parkViaConflictedReapply(env);

		const res = await postRebaseParked(env, "discard");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, discardedSnapshot: parked });
		const row = await chapterRow(env.chapterId);
		expect(row.parkedSnapshotCommitSha).toBeNull();
		expect(row.parkedSnapshotBaseTree).toBeNull();
	});

	test("reapplies cleanly and forgets the snapshot when the work does not overlap", async () => {
		const env = await createEnv();
		await advanceTrunk(env, ["l1", "l1-TRUNK"]);
		writeFileSync(join(env.worktree, FILE), BASE.replace("l9", "l9-DIRTY"));

		const res = await postRebase(env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { success: boolean; parkedWorkPending?: boolean };
		expect(body.success).toBe(true);
		expect(body.parkedWorkPending).toBeUndefined();

		const onDisk = readFileSync(join(env.worktree, FILE), "utf-8");
		expect(onDisk).toContain("l1-TRUNK"); // what the rebase brought in
		expect(onDisk).toContain("l9-DIRTY"); // what the user had not committed
		expect((await chapterRow(env.chapterId)).parkedSnapshotCommitSha).toBeNull();
	});

	test("leaves an untracked-only workspace alone, since git rebases straight over it", async () => {
		const env = await createEnv();
		await advanceTrunk(env, ["l1", "l1-TRUNK"]);
		// Untracked and colliding with nothing. Parking it would spend a reset + clean +
		// capture round trip to achieve exactly nothing.
		writeFileSync(join(env.worktree, "scratch.txt"), "notes to self\n");

		const res = await postRebase(env);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true });
		// Byte-identical, and never parked in the first place.
		expect(readFileSync(join(env.worktree, "scratch.txt"), "utf-8")).toBe("notes to self\n");
		expect(readFileSync(join(env.worktree, FILE), "utf-8")).toContain("l1-TRUNK");
		expect((await chapterRow(env.chapterId)).parkedSnapshotCommitSha).toBeNull();
	});

	test("parks an untracked file the incoming history also creates, instead of failing", async () => {
		const env = await createEnv();
		// Trunk gains a file the chapter already has untracked. git refuses the whole
		// rebase over this ("untracked working tree files would be overwritten") even
		// though nothing is tracked-dirty, so it is the one case an untracked-only
		// workspace still has to be parked for.
		writeFileSync(join(env.gitPath, "shared.txt"), "from trunk\n");
		await git(["add", "-A"], env.gitPath);
		await git(["commit", "-m", "trunk adds shared.txt"], env.gitPath);
		const trunkTip = await git(["rev-parse", "HEAD"], env.gitPath);
		writeFileSync(join(env.worktree, "shared.txt"), "mine, uncommitted\n");

		const res = await postRebase(env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			success: boolean;
			reapplyConflictFiles?: string[];
			parkedWorkStatus?: string;
		};
		// The rebase itself went through — the collision was resolved by parking rather
		// than by handing git's (localised) refusal to the user.
		expect(body.success).toBe(true);
		expect((await chapterRow(env.chapterId)).startCommitSha).toBe(trunkTip);

		// Both versions of the colliding path existed, so this is a genuine overlap: the
		// reapply reports it and the user's bytes stay addressable.
		expect(body.reapplyConflictFiles).toEqual(["shared.txt"]);
		expect(body.parkedWorkStatus).toBe("conflict");
		expect((await chapterRow(env.chapterId)).parkedSnapshotCommitSha).toBeTruthy();
		// Trunk's version is what landed; the user's is one `rebase-parked` call away.
		expect(readFileSync(join(env.worktree, "shared.txt"), "utf-8")).toBe("from trunk\n");
	});

	test("never resets over an edit to a tracked-but-ignored path", async () => {
		const env = await createEnv();
		await advanceTrunk(env, ["l1", "l1-TRUNK"]);
		// Tracked by git despite matching an ignore rule. The shadow repository builds its
		// index under mirrored *ignore* rules rather than from the user's index, so this is
		// the shape of path that can be dirty in git's view and absent from a snapshot —
		// and `reset --hard` would then rewrite it with the edit held nowhere.
		writeFileSync(join(env.worktree, ".gitignore"), "secret.env\n");
		writeFileSync(join(env.worktree, "secret.env"), "committed\n");
		await git(["add", "-A", "-f"], env.worktree);
		await git(["commit", "-m", "track an ignored path"], env.worktree);
		writeFileSync(join(env.worktree, "secret.env"), "uncommitted edit\n");
		const headBefore = await git(["rev-parse", "HEAD"], env.worktree);

		const res = await postRebase(env);
		// Asserted as a disjunction because both outcomes are correct and which one occurs
		// is the capture layer's call, not this route's: it force-adds tracked-but-ignored
		// paths, so in practice the park succeeds. Pinning one branch would make this test
		// fail the day that changes, for a change that is not a regression. The invariant
		// worth pinning is the one both branches share — the edit is still there either
		// way, so the reset never happened without a copy.
		expect(readFileSync(join(env.worktree, "secret.env"), "utf-8")).toBe("uncommitted edit\n");
		if (res.status === 200) {
			expect(await res.json()).toMatchObject({ success: true });
			return;
		}
		// A refusal has to be actionable: a 400 whose message names the offending file,
		// which is what the Ruler shows verbatim for codes it does not recognise.
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string; code?: string };
		expect(body.code).toBe("VALIDATION_ERROR");
		expect(body.error).toContain("secret.env");
		// And refusing is inert — the rebase did not half-happen.
		expect(await git(["rev-parse", "HEAD"], env.worktree)).toBe(headBefore);
	});

	test("refuses readably while another git operation is in progress", async () => {
		const env = await createEnv();
		// Diverge both sides on the same line, then start a merge and leave it conflicted.
		writeFileSync(join(env.gitPath, FILE), BASE.replace("l5", "l5-TRUNK"));
		await git(["add", "-A"], env.gitPath);
		await git(["commit", "-m", "trunk edits l5"], env.gitPath);
		writeFileSync(join(env.worktree, FILE), BASE.replace("l5", "l5-FEATURE"));
		await git(["add", "-A"], env.worktree);
		await git(["commit", "-m", "feature edits l5"], env.worktree);
		const mergeAttempt = await safeSpawn({
			cmd: ["git", "merge", "main"],
			cwd: env.worktree,
			timeout: 15_000,
		});
		expect(mergeAttempt.exitCode).not.toBe(0);
		const headBefore = await git(["rev-parse", "HEAD"], env.worktree);

		// `reset --hard` would silently remove MERGE_HEAD — the only record of what was
		// being combined — so this must refuse rather than park.
		const res = await postRebase(env);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string; code?: string };
		expect(body.code).toBe("VALIDATION_ERROR");
		// Names the state that has to be dealt with, not just "cannot rebase".
		expect(body.error).toMatch(/MERGE_HEAD|unmerged/);
		// The half-finished merge is still there to finish or abort.
		expect(await git(["rev-parse", "HEAD"], env.worktree)).toBe(headBefore);
		expect(existsSync(join(env.worktree, FILE))).toBe(true);
		expect((await chapterRow(env.chapterId)).parkedSnapshotCommitSha).toBeNull();
	});

	test("aborting restores the parked workspace wholesale", async () => {
		const env = await createEnv();
		await parkViaConflictedReapply(env);

		const res = await postRebaseResolve(env, "abort");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { lostParkedSnapshot?: string; parkedSnapshot?: string };
		// Nothing was lost, so the loss field must be absent — otherwise the UI would
		// report a disaster on the happy path.
		expect(body.lostParkedSnapshot).toBeUndefined();
		expect(body.parkedSnapshot).toBeTruthy();

		// An abort means "as if the rebase never happened": the pre-rebase bytes, not a
		// three-way merge with them.
		expect(readFileSync(join(env.worktree, FILE), "utf-8")).toContain("l5-DIRTY");
		expect((await chapterRow(env.chapterId)).parkedSnapshotCommitSha).toBeNull();
	});

	test("says so when an abort cannot get the parked work back", async () => {
		const env = await createEnv();
		const parked = await parkViaConflictedReapply(env);

		// The pointer outliving what it points at — a swept shadow repository, a chapter
		// whose worktree was deleted and recreated. Simulated by pointing the row at a
		// snapshot that does not exist, which is exactly the state `treeOfSnapshot`
		// reports as unresolvable.
		const missing = `${"0".repeat(39)}b`;
		await db
			.update(chapters)
			.set({ parkedSnapshotCommitSha: missing })
			.where(eq(chapters.id, env.chapterId));

		const res = await postRebaseResolve(env, "abort");
		expect(res.status).toBe(200);
		// The regression: the response used to be `{ success: true, parkedSnapshot }` with
		// the failure only in a log line, so the user read it as "your workspace is back"
		// while the uncommitted work was neither on disk nor tracked any more. Same field
		// the rebase endpoint uses for this condition, which the Ruler renders as a loss.
		expect(await res.json()).toMatchObject({ success: true, lostParkedSnapshot: missing });
		// Cleared, because an unresolvable pointer would otherwise block every later
		// rebase with a debt that can never be settled.
		expect((await chapterRow(env.chapterId)).parkedSnapshotCommitSha).toBeNull();
		expect(parked).not.toBe(missing);
	});

	test("records the trunk branch tip even when the trunk worktree is detached", async () => {
		const env = await createEnv();
		const trunkTip = await advanceTrunk(env, ["l1", "l1-TRUNK"]);
		// The trunk worktree parked on an older commit. Its HEAD is no longer what the
		// rebase used, and reading it would put the chapter at the wrong point on the
		// backbone.
		await git(["checkout", "--detach", "HEAD~1"], env.gitPath);
		const detachedHead = await git(["rev-parse", "HEAD"], env.gitPath);
		expect(detachedHead).not.toBe(trunkTip);

		expect((await postRebase(env)).status).toBe(200);
		expect((await chapterRow(env.chapterId)).startCommitSha).toBe(trunkTip);
	});
});

/**
 * Whether the parked-work debt survives a page reload.
 *
 * The coordinates were persisted and every mutation reported them, but no *read*
 * endpoint did — so a refresh removed the recovery entry point while the backend still
 * considered the reapply owed and refused the next rebase with
 * REBASE_PARKED_WORK_CONFLICT. That left the user with a chapter that could not be
 * rebased and no UI able to act on the work blocking it.
 */
describe("the ruler reports parked work it is still holding", () => {
	test("both list endpoints carry parkedSnapshot for a chapter mid-recovery", async () => {
		const env = await createEnv();
		const parked = await parkViaConflictedReapply(env);

		const main = await app.request(`/api/projects/${env.projectId}/ruler`);
		expect(main.status).toBe(200);
		const mainBody = (await main.json()) as {
			activeChapters: Array<{ id: string; parkedSnapshot: string | null }>;
		};
		const listed = present(
			mainBody.activeChapters.find((ch) => ch.id === env.chapterId),
			"chapter in the ruler response",
		);
		expect(listed.parkedSnapshot).toBe(parked);

		// The segment endpoint feeds the panel the recovery UI actually lives in, so it
		// needs the same field under the same name.
		const startSha = present((await chapterRow(env.chapterId)).startCommitSha, "start commit");
		const segment = await app.request(
			`/api/projects/${env.projectId}/ruler/segment?from=${startSha}`,
		);
		expect(segment.status).toBe(200);
		const segmentBody = (await segment.json()) as {
			chapters: Array<{ id: string; parkedSnapshot: string | null }>;
		};
		expect(
			present(
				segmentBody.chapters.find((ch) => ch.id === env.chapterId),
				"chapter in the segment response",
			).parkedSnapshot,
		).toBe(parked);
	});

	test("reports null once the debt is settled, so the banner clears", async () => {
		const env = await createEnv();
		// Non-overlapping work reapplies cleanly, which is the outcome that discharges it.
		await advanceTrunk(env, ["l1", "l1-TRUNK"]);
		writeFileSync(join(env.worktree, FILE), BASE.replace("l9", "l9-DIRTY"));
		expect((await postRebase(env)).status).toBe(200);

		const res = await app.request(`/api/projects/${env.projectId}/ruler`);
		const body = (await res.json()) as {
			activeChapters: Array<{ id: string; parkedSnapshot: string | null }>;
		};
		expect(
			present(
				body.activeChapters.find((ch) => ch.id === env.chapterId),
				"chapter in the ruler response",
			).parkedSnapshot,
		).toBeNull();
	});
});

describe("rebase concurrency", () => {
	test("waits for the worktree lock instead of interleaving with whoever holds it", async () => {
		const env = await createEnv();
		await advanceTrunk(env, ["l1", "l1-TRUNK"]);
		const before = await git(["rev-parse", "HEAD"], env.worktree);

		// Stands in for anything else that serializes on this workspace — a merge, an
		// autoCommit before going dormant, a snapshot capture.
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		const holder = worktreeLock.acquire(env.worktree, () => held);
		// Let the holder actually take the lock before the request goes out.
		await sleep(20);

		const pending = postRebase(env);
		await sleep(150);
		// Nothing may have happened yet: the rebase is the first thing that moves HEAD.
		expect(await git(["rev-parse", "HEAD"], env.worktree)).toBe(before);

		release();
		await holder;
		const res = await pending;
		expect(res.status).toBe(200);
		expect(await git(["rev-parse", "HEAD"], env.worktree)).not.toBe(before);
	});

	test("serializes two rebases fired at once instead of overlapping in the worktree", async () => {
		const env = await createEnv();
		await advanceTrunk(env, ["l1", "l1-TRUNK"]);
		writeFileSync(join(env.worktree, FILE), BASE.replace("l9", "l9-DIRTY"));

		// Overlap is asserted at `git rebase` itself rather than inferred from the final
		// state, because two unserialized rebases can still *happen* to end well: the
		// second finds nothing to replay and exits cleanly. What must never occur is the
		// second request reaching the rebase while the first is between its reset and its
		// reapply — that is the window where a park overwrites live coordinates.
		//
		// Slowed down on purpose: without the delay the whole sequence finishes inside one
		// microtask run and the requests cannot interleave even unlocked, so the case
		// would pass whether or not the lock is there.
		const realRebase = gitService.rebase;
		let inFlight = 0;
		let maxInFlight = 0;
		gitService.rebase = async (worktreePath: string, ontoBranch: string) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				await sleep(200);
				return await realRebase.call(gitService, worktreePath, ontoBranch);
			} finally {
				inFlight -= 1;
			}
		};

		try {
			// The double-clicked-button case.
			const [first, second] = await Promise.all([postRebase(env), postRebase(env)]);
			expect([first.status, second.status]).toEqual([200, 200]);
			expect(maxInFlight).toBe(1);
		} finally {
			gitService.rebase = realRebase;
		}

		// No rebase was left half-finished for someone else to trip over.
		expect(existsSync(join(env.worktree, ".git", "rebase-merge"))).toBe(false);
		expect(existsSync(join(env.worktree, ".git", "rebase-apply"))).toBe(false);
		// And the uncommitted work survived both passes rather than being parked twice
		// and orphaned once.
		expect(readFileSync(join(env.worktree, FILE), "utf-8")).toContain("l9-DIRTY");
		expect((await chapterRow(env.chapterId)).parkedSnapshotCommitSha).toBeNull();
	});

	test("decides what to settle from the row as it stands inside the lock", async () => {
		const env = await createEnv();
		await advanceTrunk(env, ["l5", "l5-TRUNK"]);
		writeFileSync(join(env.worktree, FILE), BASE.replace("l5", "l5-DIRTY"));

		// The queued request's chance to observe a row it will act on later. The chapter
		// has NO parked work when both requests are issued; the first one creates some,
		// and the second must see that rather than the empty state it queued against —
		// otherwise it skips the settle entirely and parks a workspace that is missing the
		// first request's work, compounding the loss silently.
		//
		// Slowed at `git rebase` for the same reason as the case above: without it the
		// first request finishes before the second is even parsed, and the second reads a
		// fresh row either way.
		const realRebase = gitService.rebase;
		gitService.rebase = async (worktreePath: string, ontoBranch: string) => {
			await sleep(200);
			return realRebase.call(gitService, worktreePath, ontoBranch);
		};

		let second: Response;
		try {
			const [first, queued] = await Promise.all([postRebase(env), postRebase(env)]);
			expect(first.status).toBe(200);
			second = queued;
		} finally {
			gitService.rebase = realRebase;
		}

		// The second request refuses *because* it saw the debt the first one left. Reading
		// the pre-queue row instead made `parkedSnapshotCommitSha` null and sent it
		// straight past the settle branch.
		expect(second.status).toBe(409);
		const body = (await second.json()) as { error?: string; parkedSnapshot?: string };
		expect(body.error).toBe("REBASE_PARKED_WORK_CONFLICT");
		// And it named the live coordinates, not a stale or absent value.
		expect(body.parkedSnapshot).toBe(
			present((await chapterRow(env.chapterId)).parkedSnapshotCommitSha, "parked snapshot"),
		);
	});

	test("serializes an abort against a concurrent workspace holder", async () => {
		const env = await createEnv();
		await parkViaConflictedReapply(env);

		// The abort branch does `rebaseAbort` + a wholesale `restoreParkedWork`, both of
		// which write the workspace. It used to hold no lock at all, so a capture or a
		// second rebase landing between them would be overwritten by a restore that never
		// saw it.
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		const holder = worktreeLock.acquire(env.worktree, () => held);
		await sleep(20);

		const pending = postRebaseResolve(env, "abort");
		await sleep(150);
		// Still owed: nothing in the abort may have run yet.
		expect((await chapterRow(env.chapterId)).parkedSnapshotCommitSha).toBeTruthy();

		release();
		await holder;
		expect((await pending).status).toBe(200);
		expect((await chapterRow(env.chapterId)).parkedSnapshotCommitSha).toBeNull();
	});
});
