/**
 * Cherry-picking into a chapter someone is working in.
 *
 * Cherry-pick keeps going through the commit path on purpose: it replays a commit
 * sequence, so commits are its entire output and there is nothing to move into snapshot
 * space. What *was* wrong is that git refuses to start it while the target worktree is
 * dirty, so cherry-picking into an active chapter failed with git's "local changes would
 * be overwritten" and no explanation — even when the uncommitted work had nothing to do
 * with the incoming commits.
 *
 * These cases pin the two outcomes that matter: the target's work survives a successful
 * pick, and a pick that conflicts leaves the target exactly as it was.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, projects } from "../db/schema";
import { generateId } from "../lib/id";
import { safeSpawn } from "../lib/spawn";
import { chapterMerge } from "./chapter-merge";
import { gitService } from "./git-service";
import { SNAPSHOT_HEAD_REF, worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const tempDirs: string[] = [];
const createdProjects: string[] = [];

const FILE = "app.txt";
const BASE = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n";

function present<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** A trunk chapter and a branch chapter, each on its own linked worktree. */
async function createPair(): Promise<{
	projectId: string;
	target: { id: string; worktree: string };
	source: { id: string; worktree: string };
}> {
	const gitPath = mkdtempSync(join(tmpdir(), "nf-cp-"));
	tempDirs.push(gitPath);
	await git(["init", "-b", "main"], gitPath);
	await git(["config", "user.email", "test@example.com"], gitPath);
	await git(["config", "user.name", "Test"], gitPath);
	writeFileSync(join(gitPath, FILE), BASE);
	await git(["add", "-A"], gitPath);
	await git(["commit", "-m", "seed"], gitPath);

	const now = new Date().toISOString();
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Cherry-pick project",
		gitPath,
		defaultBranch: "main",
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(projectId);

	const make = async (label: string, role: "trunk" | "branch") => {
		const suffix = `${label}-${generateId().slice(0, 6)}`;
		const branch = `chapter/${suffix}`;
		const worktree = resolve(gitPath, ".worktrees", suffix);
		await git(["worktree", "add", worktree, "-b", branch], gitPath);
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
	return { projectId, target, source };
}

afterEach(async () => {
	for (const projectId of createdProjects.splice(0)) {
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
		}
		await db.delete(chapters).where(eq(chapters.projectId, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const dir of tempDirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir, undefined, { force: true }).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("cherry-picking into a dirty target", () => {
	test("the target's uncommitted work survives the pick", async () => {
		const { target, source } = await createPair();
		// The source has a commit to pick, touching the top of the file.
		writeFileSync(join(source.worktree, FILE), BASE.replace("l1", "FROM-SOURCE"));
		await git(["add", "-A"], source.worktree);
		await git(["commit", "-m", "source work"], source.worktree);

		// The target is mid-edit at the bottom, plus an untracked scratch file.
		writeFileSync(join(target.worktree, FILE), BASE.replace("l10", "TARGET-WIP"));
		writeFileSync(join(target.worktree, "scratch.txt"), "notes\n");

		const result = await chapterMerge.merge(source.id, {
			targetChapterId: target.id,
			strategy: "cherry-pick",
		});
		expect(result.success).toBe(true);

		const content = readFileSync(join(target.worktree, FILE), "utf-8");
		expect(content).toContain("FROM-SOURCE"); // the picked commit
		expect(content).toContain("TARGET-WIP"); // the target's uncommitted edit
		expect(existsSync(join(target.worktree, "scratch.txt"))).toBe(true);
	});

	test("a clean target is unaffected by the parking machinery", async () => {
		const { target, source } = await createPair();
		writeFileSync(join(source.worktree, "added.txt"), "new\n");
		await git(["add", "-A"], source.worktree);
		await git(["commit", "-m", "source adds a file"], source.worktree);

		const result = await chapterMerge.merge(source.id, {
			targetChapterId: target.id,
			strategy: "cherry-pick",
		});
		expect(result.success).toBe(true);
		expect(existsSync(join(target.worktree, "added.txt"))).toBe(true);
	});

	test("an overlapping edit is reported, and the work is still recoverable", async () => {
		const { target, source } = await createPair();
		// Both sides change the same line, so reapplying the parked work cannot be automatic.
		writeFileSync(join(source.worktree, FILE), BASE.replace("l5", "SOURCE5"));
		await git(["add", "-A"], source.worktree);
		await git(["commit", "-m", "source edits l5"], source.worktree);
		writeFileSync(join(target.worktree, FILE), BASE.replace("l5", "TARGET5"));

		const result = await chapterMerge.merge(source.id, {
			targetChapterId: target.id,
			strategy: "cherry-pick",
		});

		// The pick itself concerns committed history and still succeeds; it is the reapply
		// that cannot be automatic. Reported rather than silently dropped, and the warning
		// has to name the snapshot or the user has no way to reach their bytes.
		expect(result.success).toBe(true);
		const warning = result.warning ?? "";
		expect(warning).toMatch(/snapshot [0-9a-f]{12}/);
		const snapshotId = warning.match(/snapshot ([0-9a-f]{12})/)?.[1] ?? "";

		// The warning has to point at something real, holding the edit that is no longer on
		// disk. A snapshot id that resolves to nothing is worse than no warning, because the
		// user stops looking. The failed reapply left the head at the parked commit, which
		// is what the abbreviated id in the warning names.
		const parkedCommit = await worktreeTreeSnapshot.getRef(target.worktree, SNAPSHOT_HEAD_REF);
		expect(parkedCommit?.startsWith(snapshotId)).toBe(true);
		const parkedTree = await worktreeTreeSnapshot.treeOfSnapshot(
			target.worktree,
			parkedCommit as string,
		);
		const parkedContent = await worktreeTreeSnapshot.readFileAtTree(
			target.worktree,
			parkedTree as string,
			FILE,
		);
		expect(parkedContent).toContain("TARGET5");

		// Nothing conflicted was written to disk: the picked result stands, unpolluted.
		const onDisk = readFileSync(join(target.worktree, FILE), "utf-8");
		expect(onDisk).not.toContain("<<<<<<<");
		expect(onDisk).toContain("SOURCE5");
	});
});

/**
 * Where the parked state is recorded while the cherry-pick runs.
 *
 * Parking does `reset --hard` + `clean` before the pick starts, so between those two
 * moments the workspace holds nothing and the snapshot commit is the only copy. Keeping
 * the id in a local variable made a crash or restart during `cherryPick` lose it with
 * the closure, leaving the bytes in the shadow DAG addressable from nowhere — which is
 * exactly what `schema.ts` says these two columns exist to prevent.
 */
describe("cherry-pick records where it parked the target's work", () => {
	test("the coordinates are in the row while the pick runs, and gone once it lands", async () => {
		const { target, source } = await createPair();
		writeFileSync(join(source.worktree, FILE), BASE.replace("l1", "FROM-SOURCE"));
		await git(["add", "-A"], source.worktree);
		await git(["commit", "-m", "source work"], source.worktree);
		writeFileSync(join(target.worktree, FILE), BASE.replace("l10", "TARGET-WIP"));

		// Observed mid-flight rather than inferred afterwards: the whole point is that the
		// pointer exists during the window where the disk is empty. Read inside the
		// `cherryPick` call, which is precisely that window.
		const realCherryPick = gitService.cherryPick;
		// Collected into an array rather than a nullable variable: a value only ever
		// assigned inside a callback is narrowed to `null` by control-flow analysis, so the
		// assertions below would not type-check against it.
		const parkedDuringPick: Array<{ commitSha: string | null; baseTree: string | null }> = [];
		gitService.cherryPick = async (
			worktreePath: string,
			repoPath: string,
			branch: string,
			baseSha: string,
		) => {
			const row = await db.query.chapters.findFirst({ where: eq(chapters.id, target.id) });
			parkedDuringPick.push({
				commitSha: row?.parkedSnapshotCommitSha ?? null,
				baseTree: row?.parkedSnapshotBaseTree ?? null,
			});
			return realCherryPick.call(gitService, worktreePath, repoPath, branch, baseSha);
		};

		try {
			const result = await chapterMerge.merge(source.id, {
				targetChapterId: target.id,
				strategy: "cherry-pick",
			});
			expect(result.success).toBe(true);
		} finally {
			gitService.cherryPick = realCherryPick;
		}

		const observed = present(parkedDuringPick[0], "coordinates observed during the pick");
		expect(observed.commitSha).toBeTruthy();
		expect(observed.baseTree).toBeTruthy();

		// And discharged once the work is provably back on disk. A stale pointer is not
		// inert: the Ruler's rebase endpoint would settle it and restore a workspace the
		// user has since edited past.
		const after = present(
			await db.query.chapters.findFirst({ where: eq(chapters.id, target.id) }),
			"target chapter",
		);
		expect(after.parkedSnapshotCommitSha).toBeNull();
		expect(after.parkedSnapshotBaseTree).toBeNull();
		expect(readFileSync(join(target.worktree, FILE), "utf-8")).toContain("TARGET-WIP");
	});

	test("the coordinates survive a reapply that could not complete", async () => {
		const { target, source } = await createPair();
		// Overlapping edits, so the reapply conflicts and writes nothing to disk. The
		// target's bytes then exist only in the snapshot, so the pointer has to stay.
		writeFileSync(join(source.worktree, FILE), BASE.replace("l5", "SOURCE5"));
		await git(["add", "-A"], source.worktree);
		await git(["commit", "-m", "source edits l5"], source.worktree);
		writeFileSync(join(target.worktree, FILE), BASE.replace("l5", "TARGET5"));

		const result = await chapterMerge.merge(source.id, {
			targetChapterId: target.id,
			strategy: "cherry-pick",
		});
		expect(result.success).toBe(true);
		expect(result.warning ?? "").toMatch(/snapshot [0-9a-f]{12}/);

		// Kept, because `/ruler/rebase-parked` is the way back and it needs these. Clearing
		// them here would leave the warning's snapshot id as the only trace.
		const row = present(
			await db.query.chapters.findFirst({ where: eq(chapters.id, target.id) }),
			"target chapter",
		);
		const parked = present(row.parkedSnapshotCommitSha, "parked snapshot");
		expect(row.parkedSnapshotBaseTree).toBeTruthy();
		// The id in the warning is the one recorded, or the user is sent looking in the
		// wrong place.
		expect(
			parked.startsWith(
				present(result.warning, "warning").match(/snapshot ([0-9a-f]{12})/)?.[1] ?? "x",
			),
		).toBe(true);
	});

	test("a failed pick puts the work back and clears the pointer", async () => {
		const { target, source } = await createPair();
		writeFileSync(join(source.worktree, FILE), BASE.replace("l1", "FROM-SOURCE"));
		await git(["add", "-A"], source.worktree);
		await git(["commit", "-m", "source work"], source.worktree);
		writeFileSync(join(target.worktree, FILE), BASE.replace("l10", "TARGET-WIP"));

		// A pick that throws rather than conflicting — a git invocation failure, a lock.
		// The pre-pick state is then the correct one, so it is restored wholesale and the
		// debt is discharged: a pointer left behind would make the next rebase restore a
		// workspace the user has moved on from.
		const realCherryPick = gitService.cherryPick;
		gitService.cherryPick = async () => {
			throw new Error("simulated cherry-pick failure");
		};
		try {
			await expect(
				chapterMerge.merge(source.id, { targetChapterId: target.id, strategy: "cherry-pick" }),
			).rejects.toThrow(/simulated cherry-pick failure/);
		} finally {
			gitService.cherryPick = realCherryPick;
		}

		expect(readFileSync(join(target.worktree, FILE), "utf-8")).toContain("TARGET-WIP");
		const row = present(
			await db.query.chapters.findFirst({ where: eq(chapters.id, target.id) }),
			"target chapter",
		);
		expect(row.parkedSnapshotCommitSha).toBeNull();
		expect(row.parkedSnapshotBaseTree).toBeNull();
	});
});
