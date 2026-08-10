/**
 * Chapter lifecycle: the points where a transition could destroy work or leak a
 * resource with no way back.
 *
 * The cases are organised around those failure modes rather than around the API:
 *
 *   - going dormant when neither the commit nor the snapshot captured the workspace,
 *     which used to delete the worktree anyway;
 *   - going dormant when the worktree removal itself fails, which used to null
 *     `worktreePath` and leave the chapter permanently unwakeable while the orphan
 *     sweep deleted the only remaining copy;
 *   - git-ignored files, which no snapshot and no `git add -A` ever sees;
 *   - the archive those files live in outliving the chapter, which left plaintext
 *     credentials on disk after the user deleted the chapter or the project;
 *   - waking a chapter whose branch-derived worktree path collides with another
 *     chapter's live worktree, which used to delete that chapter's workspace;
 *   - deleting a chapter whose `ON DELETE NO ACTION` dependents block the delete;
 *   - a fork or review rollback stranding the shadow repository it created;
 *   - forking a dormant chapter, which is exactly what auto-dormant produces;
 *   - forking at a subagent message, which resolved globally and then silently fell
 *     back to HEAD.
 *
 * Everything runs against real git worktrees, real shadow repositories and real DB
 * rows, because in every case the question is whether the git-level and SQL-level
 * pieces compose correctly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	chapters,
	containerInstances,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	portAllocations,
	projects,
	terminals,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { getNarraforkPath } from "../../lib/narrafork-home";
import { safeSpawn } from "../../lib/spawn";
import { chapterCleanup } from "../chapter-cleanup";
import { chapterFork } from "../chapter-fork";
import { chapterService } from "../chapter-service";
import { ensureChapterSnapshot } from "../chapter-snapshot-ref";
import { gitService } from "../git-service";
import { reviewService } from "../review-service";
import {
	SNAPSHOT_HEAD_REF,
	snapshotIncomingRef,
	worktreeTreeSnapshot,
} from "../worktree-tree-snapshot";

const tempDirs: string[] = [];
const createdProjects: string[] = [];
const createdNarrators: string[] = [];
const archiveDirs: string[] = [];

const BASE_FILE = "app.txt";
const BASE_CONTENT = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n";

function present<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}

async function git(args: string[], cwd: string): Promise<string> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	return result.stdout.trim();
}

/**
 * Capture slot for the worktree path a spy observes.
 *
 * A mutable object rather than a `let`, because the assignment happens inside a
 * callback: TypeScript narrows a `let string | null` back to `null` at the use site
 * since it cannot see that the callback ran.
 */
function observedTarget(): { path: string | null } {
	return { path: null };
}

/** A project whose repo has one commit, plus one branch chapter on a linked worktree. */
async function createChapterEnv(options: { gitignore?: string } = {}): Promise<{
	projectId: string;
	gitPath: string;
	chapterId: string;
	worktree: string;
	branch: string;
}> {
	const gitPath = mkdtempSync(join(tmpdir(), "nf-lifecycle-"));
	tempDirs.push(gitPath);
	await git(["init"], gitPath);
	await git(["config", "user.email", "test@example.com"], gitPath);
	await git(["config", "user.name", "Test"], gitPath);
	writeFileSync(join(gitPath, BASE_FILE), BASE_CONTENT);
	if (options.gitignore) writeFileSync(join(gitPath, ".gitignore"), options.gitignore);
	await git(["add", "-A"], gitPath);
	await git(["commit", "-m", "seed"], gitPath);

	const now = new Date().toISOString();
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Lifecycle project",
		gitPath,
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(projectId);

	const suffix = `feature-${generateId().slice(0, 6)}`;
	const branch = `chapter/${suffix}`;
	const worktree = resolve(gitPath, ".worktrees", suffix);
	const added = await safeSpawn({
		cmd: ["git", "worktree", "add", worktree, "-b", branch],
		cwd: gitPath,
		timeout: 15_000,
	});
	if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
	tempDirs.push(worktree);

	const chapterId = generateId();
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "Feature",
		branch,
		baseBranch: "main",
		worktreePath: worktree,
		status: "active",
		role: "branch",
		createdAt: now,
		updatedAt: now,
	});
	archiveDirs.push(getNarraforkPath("dormant-ignored", chapterId));

	return { projectId, gitPath, chapterId, worktree, branch };
}

async function chapterRow(id: string) {
	const row = await db.query.chapters.findFirst({ where: eq(chapters.id, id) });
	return present(row, `chapter ${id}`);
}

/**
 * A primary narrator for `chapterId` with one top-level message and one subagent
 * message.
 *
 * The subagent message is the interesting one: it exists in `narrator_messages`
 * (so a global lookup finds it) but has a `parentToolUseId` and no ref in the
 * primary narrator's timeline, which is exactly the shape that used to resolve to
 * nothing everywhere downstream.
 */
async function seedNarratorWithSubagentMessage(chapterId: string): Promise<{
	narratorId: string;
	topLevelMessageId: string;
	subagentMessageId: string;
}> {
	const now = new Date().toISOString();
	const narratorId = generateId();
	await db.insert(narrators).values({
		id: narratorId,
		chapterId,
		type: "primary",
		variant: "primary",
		createdAt: now,
		updatedAt: now,
	});
	createdNarrators.push(narratorId);

	const topLevelMessageId = generateId();
	await db.insert(narratorMessages).values({
		id: topLevelMessageId,
		narratorId,
		role: "assistant",
		contentJson: [{ type: "text", text: "top level" }],
		contentText: "top level",
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: generateId(),
		narratorId,
		messageId: topLevelMessageId,
		seq: 0,
	});

	// A subagent narrator owns the message, and no ref links it to the primary's
	// timeline — which is precisely how the real subagent path records it.
	const subagentNarratorId = generateId();
	await db.insert(narrators).values({
		id: subagentNarratorId,
		chapterId,
		type: "subagent",
		variant: "subagent:general",
		subagentType: "general",
		parentNarratorId: narratorId,
		createdAt: now,
		updatedAt: now,
	});
	createdNarrators.push(subagentNarratorId);

	const subagentMessageId = generateId();
	await db.insert(narratorMessages).values({
		id: subagentMessageId,
		narratorId: subagentNarratorId,
		role: "assistant",
		parentToolUseId: `toolu_${generateId().slice(0, 10)}`,
		contentJson: [{ type: "text", text: "subagent output" }],
		contentText: "subagent output",
		createdAt: now,
	});

	return { narratorId, topLevelMessageId, subagentMessageId };
}

afterEach(async () => {
	// Narrators (and every message/ref they own) go first: they hold FKs onto chapters,
	// and forks create narrators this suite never registered, so they have to be swept
	// by chapter rather than by tracked id.
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
			await db.delete(terminals).where(eq(terminals.chapterId, row.id));
			await db.delete(containerInstances).where(eq(containerInstances.chapterId, row.id));
			await db.delete(portAllocations).where(eq(portAllocations.chapterId, row.id));
			const owned = await db
				.select({ id: narrators.id })
				.from(narrators)
				.where(eq(narrators.chapterId, row.id));
			for (const n of owned) {
				if (!createdNarrators.includes(n.id)) createdNarrators.push(n.id);
			}
		}
		for (const row of rows) {
			await db.update(chapters).set({ parentChapterId: null }).where(eq(chapters.id, row.id));
			await db.update(chapters).set({ reviewSourceChapterId: null }).where(eq(chapters.id, row.id));
		}
	}
	// Phased rather than per-narrator, because the references cross narrators: a forked
	// narrator's refs point at its parent's messages, and a subagent's row points at its
	// parent narrator. Deleting one narrator completely at a time therefore trips a FK.
	const narratorIds = createdNarrators.splice(0);
	for (const narratorId of narratorIds) {
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId));
	}
	for (const narratorId of narratorIds) {
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
	}
	for (const narratorId of narratorIds) {
		await db.update(narrators).set({ parentNarratorId: null }).where(eq(narrators.id, narratorId));
	}
	for (const narratorId of narratorIds) {
		await db.delete(narrators).where(eq(narrators.id, narratorId));
	}
	for (const projectId of createdProjects.splice(0)) {
		await db.delete(chapters).where(eq(chapters.projectId, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const dir of tempDirs.splice(0)) {
		await worktreeTreeSnapshot.destroy(dir, undefined, { force: true }).catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
	for (const dir of archiveDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("dormant refuses when nothing holds the work", () => {
	test("a failed commit AND a failed snapshot keep the chapter active with its worktree", async () => {
		const env = await createChapterEnv();
		writeFileSync(join(env.worktree, "uncommitted.txt"), "only copy\n");

		// Both preservation mechanisms broken at once: this is the state in which the
		// previous code deleted the worktree anyway, because the snapshot failure was a
		// warn and the commit failure only set a flag.
		// Stubs `autoCommitUnlocked`, which is what `dormant` calls: it takes `worktreeLock`
		// itself, so the locked wrapper would wait on its own caller. Stubbing the wrapper
		// would silently stop intercepting and the failure under test would never occur.
		const autoCommit = gitService.autoCommitUnlocked;
		const mergeAbort = gitService.mergeAbort;
		const capture = worktreeTreeSnapshot.tryCapture;
		const advance = worktreeTreeSnapshot.advanceSnapshotRef;
		const getRef = worktreeTreeSnapshot.getRef;
		gitService.autoCommitUnlocked = async () => {
			throw new Error("simulated index lock");
		};
		gitService.mergeAbort = async () => {
			throw new Error("simulated abort failure");
		};
		worktreeTreeSnapshot.tryCapture = async () => null;
		worktreeTreeSnapshot.advanceSnapshotRef = async () => null;
		worktreeTreeSnapshot.getRef = async () => null;
		try {
			await expect(chapterCleanup.dormant(env.chapterId)).rejects.toThrow(/Refusing/i);
		} finally {
			gitService.autoCommitUnlocked = autoCommit;
			gitService.mergeAbort = mergeAbort;
			worktreeTreeSnapshot.tryCapture = capture;
			worktreeTreeSnapshot.advanceSnapshotRef = advance;
			worktreeTreeSnapshot.getRef = getRef;
		}

		const row = await chapterRow(env.chapterId);
		// Still usable, and the only copy of the work is still on disk.
		expect(row.status).toBe("active");
		expect(row.worktreePath).toBe(env.worktree);
		expect(readFileSync(join(env.worktree, "uncommitted.txt"), "utf-8")).toBe("only copy\n");
	});

	test("a failed commit with a working snapshot still goes dormant", async () => {
		const env = await createChapterEnv();
		writeFileSync(join(env.worktree, "uncommitted.txt"), "snapshot has it\n");

		// See the note above: `dormant` calls the unlocked variant from inside its own
		// `worktreeLock` block.
		const autoCommit = gitService.autoCommitUnlocked;
		const mergeAbort = gitService.mergeAbort;
		gitService.autoCommitUnlocked = async () => {
			throw new Error("simulated index lock");
		};
		gitService.mergeAbort = async () => {
			throw new Error("simulated abort failure");
		};
		try {
			const report = await chapterCleanup.dormant(env.chapterId);
			// The snapshot is the only copy, so wake has to restore it.
			expect(report.snapshotOnly).toBe(true);
		} finally {
			gitService.autoCommitUnlocked = autoCommit;
			gitService.mergeAbort = mergeAbort;
		}

		const row = await chapterRow(env.chapterId);
		expect(row.status).toBe("dormant");
		expect(row.dormantSnapshotCommitSha).toBeTruthy();
	});
});

describe("dormant when the worktree cannot be removed", () => {
	test("keeps worktreePath and the active status so the chapter stays wakeable", async () => {
		const env = await createChapterEnv();
		writeFileSync(join(env.worktree, BASE_FILE), "edited\n");

		const removeWorktree = gitService.removeWorktree;
		gitService.removeWorktree = async () => {
			throw new Error("simulated removal failure");
		};
		try {
			await expect(chapterCleanup.dormant(env.chapterId)).rejects.toThrow(/worktree/i);
		} finally {
			gitService.removeWorktree = removeWorktree;
		}

		const row = await chapterRow(env.chapterId);
		// Nulling worktreePath here was unrecoverable: wake's `worktree add` fails
		// forever on the existing path, and the orphan sweep deletes the directory.
		expect(row.worktreePath).toBe(env.worktree);
		expect(row.status).toBe("active");
		expect(existsSync(join(env.worktree, BASE_FILE))).toBe(true);
	});

	test("wake reclaims a leftover directory at the target path", async () => {
		const env = await createChapterEnv();
		await chapterCleanup.dormant(env.chapterId);

		// The exact residue a failed/interrupted removal leaves: a directory sitting
		// where `git worktree add` wants to go. Plain `add` reports "already exists" and
		// `--force` does not help.
		const dormantRow = await chapterRow(env.chapterId);
		expect(dormantRow.worktreePath).toBeNull();
		rmSync(env.worktree, { recursive: true, force: true });
		writeFileSync(join(env.gitPath, ".worktrees", "placeholder.txt"), "x\n");
		await safeSpawn({ cmd: ["mkdir", "-p", env.worktree], timeout: 10_000 });
		writeFileSync(join(env.worktree, "leftover.txt"), "stale\n");

		await chapterCleanup.wake(env.chapterId);

		const woken = await chapterRow(env.chapterId);
		const worktree = present(woken.worktreePath, "woken worktree");
		tempDirs.push(worktree);
		expect(woken.status).toBe("active");
		// The branch was checked out cleanly rather than merged into the stale residue.
		expect(readFileSync(join(worktree, BASE_FILE), "utf-8")).toBe(BASE_CONTENT);
	});

	test("wake recovers from a stale worktree registration", async () => {
		const env = await createChapterEnv();
		await chapterCleanup.dormant(env.chapterId);

		// Registration without a directory: git reports "missing but already
		// registered" until something prunes.
		const suffix = env.branch.split("/").slice(1).join("/");
		const path = resolve(env.gitPath, ".worktrees", suffix);
		await safeSpawn({
			cmd: ["git", "worktree", "add", "--detach", path],
			cwd: env.gitPath,
			timeout: 15_000,
		});
		rmSync(path, { recursive: true, force: true });

		await chapterCleanup.wake(env.chapterId);
		const woken = await chapterRow(env.chapterId);
		tempDirs.push(present(woken.worktreePath, "woken worktree"));
		expect(woken.status).toBe("active");
	});
});

describe("dormant preserves git-ignored files", () => {
	test("archives ignored content and restores it on wake", async () => {
		const env = await createChapterEnv({ gitignore: "secret.env\nbuild/\n" });
		writeFileSync(join(env.worktree, "secret.env"), "TOKEN=abc123\n");
		writeFileSync(join(env.worktree, BASE_FILE), "committed by dormant\n");

		const report = await chapterCleanup.dormant(env.chapterId);
		// `worktree remove --force` deletes ignored content, snapshots exclude it and
		// `add -A` skips it — so without this archive the file had no copy anywhere.
		expect(report.ignored.archived).toContain("secret.env");
		expect(existsSync(join(env.worktree, "secret.env"))).toBe(false);

		const wake = await chapterCleanup.wake(env.chapterId);
		// Nothing was declined, so there is nothing to tell the user about.
		expect(wake.warnings).toEqual([]);
		const woken = await chapterRow(env.chapterId);
		const worktree = present(woken.worktreePath, "woken worktree");
		tempDirs.push(worktree);
		expect(readFileSync(join(worktree, "secret.env"), "utf-8")).toBe("TOKEN=abc123\n");
		// Consumed, so a later cycle cannot resurrect a stale copy.
		expect(existsSync(getNarraforkPath("dormant-ignored", env.chapterId))).toBe(false);
	});

	test("reports oversized ignored trees instead of copying them", async () => {
		const env = await createChapterEnv({ gitignore: "node_modules/\n" });
		const pkgDir = join(env.worktree, "node_modules", "big");
		await safeSpawn({ cmd: ["mkdir", "-p", pkgDir], timeout: 10_000 });
		// Over the per-entry budget, so it must be named as skipped rather than copied:
		// dependency trees are reproducible and archiving them would be the real bug.
		writeFileSync(join(pkgDir, "bundle.js"), "x".repeat(9 * 1024 * 1024));

		const report = await chapterCleanup.dormant(env.chapterId);
		expect(report.ignored.skipped).toContain("node_modules");
		expect(report.ignored.archived).not.toContain("node_modules");
	});

	test("skips a tree that is small but has too many entries to stat", async () => {
		const env = await createChapterEnv({ gitignore: ".cache/\n" });
		const cacheDir = join(env.worktree, ".cache");
		mkdirSync(cacheDir, { recursive: true });
		// Comfortably inside the 8MB budget, yet over the entry cap. The byte budget alone
		// bounded the wrong quantity: this shape cost one synchronous lstat per file on the
		// thread that also serves HTTP/WS/SQLite, during an unattended auto-dormant.
		for (let i = 0; i < 5_200; i++) writeFileSync(join(cacheDir, `k${i}`), "1");

		const report = await chapterCleanup.dormant(env.chapterId);
		expect(report.ignored.skipped).toContain(".cache");
		expect(report.ignored.archived).not.toContain(".cache");
		// And it really was not copied — the cap must reject, not silently half-archive.
		expect(existsSync(join(getNarraforkPath("dormant-ignored", env.chapterId), ".cache"))).toBe(
			false,
		);
	});

	test("keeps the archived copy when the worktree already has that path", async () => {
		const env = await createChapterEnv({ gitignore: "config.local.json\n" });
		writeFileSync(join(env.worktree, "config.local.json"), '{"local":true}\n');
		await chapterCleanup.dormant(env.chapterId);
		const archive = getNarraforkPath("dormant-ignored", env.chapterId);
		expect(existsSync(join(archive, "config.local.json"))).toBe(true);

		// The path became tracked while the chapter slept, so git checks its own version
		// out and the restore must decline to overwrite it. What must NOT happen is the
		// old behaviour: `cpSync` silently skipped the file and the archive was deleted
		// anyway, destroying the user's only copy with no warning anywhere.
		writeFileSync(join(env.gitPath, "config.local.json"), '{"tracked":true}\n');
		writeFileSync(join(env.gitPath, ".gitignore"), "");
		await git(["add", "-A"], env.gitPath);
		await git(["commit", "-m", "track the former local config"], env.gitPath);
		await git(["branch", "-f", env.branch, "HEAD"], env.gitPath);

		const wake = await chapterCleanup.wake(env.chapterId);
		const woken = await chapterRow(env.chapterId);
		const worktree = present(woken.worktreePath, "woken worktree");
		tempDirs.push(worktree);

		// Git's version wins in the worktree — it is the branch's content.
		expect(readFileSync(join(worktree, "config.local.json"), "utf-8")).toBe('{"tracked":true}\n');
		// But the user's copy still exists, and the wake said so.
		expect(existsSync(join(archive, "config.local.json"))).toBe(true);
		expect(readFileSync(join(archive, "config.local.json"), "utf-8")).toBe('{"local":true}\n');
		expect(wake.warnings.join("\n")).toMatch(/config\.local\.json/);
	});
});

describe("the ignored-file archive does not outlive its chapter", () => {
	test("deleting the chapter deletes the archive", async () => {
		const env = await createChapterEnv({ gitignore: "secret.env\n" });
		writeFileSync(join(env.worktree, "secret.env"), "TOKEN=abc123\n");
		await chapterCleanup.dormant(env.chapterId);
		const archive = getNarraforkPath("dormant-ignored", env.chapterId);
		expect(readFileSync(join(archive, "secret.env"), "utf-8")).toBe("TOKEN=abc123\n");

		await chapterService.remove(env.chapterId);

		// The archive lives outside the repo, so removing the worktree never touched it,
		// and only a wake consumed it — which a deleted chapter can never have. It used to
		// keep the user's plaintext token on disk forever.
		expect(existsSync(archive)).toBe(false);
		expect(
			await db.query.chapters.findFirst({ where: eq(chapters.id, env.chapterId) }),
		).toBeUndefined();
	});

	test("deleting the chapter's project deletes the archive", async () => {
		const env = await createChapterEnv({ gitignore: "secret.env\n" });
		writeFileSync(join(env.worktree, "secret.env"), "TOKEN=project\n");
		await chapterCleanup.dormant(env.chapterId);
		const archive = getNarraforkPath("dormant-ignored", env.chapterId);
		expect(existsSync(archive)).toBe(true);

		await chapterService.removeForProjectDeletion(env.chapterId, env.gitPath);

		expect(existsSync(archive)).toBe(false);
		expect(
			await db.query.chapters.findFirst({ where: eq(chapters.id, env.chapterId) }),
		).toBeUndefined();
	});

	test("batch cleanup deletes the archive when it abandons the chapter", async () => {
		const env = await createChapterEnv({ gitignore: "secret.env\n" });
		writeFileSync(join(env.worktree, "secret.env"), "TOKEN=abandoned\n");
		await chapterCleanup.dormant(env.chapterId);
		const archive = getNarraforkPath("dormant-ignored", env.chapterId);
		expect(existsSync(archive)).toBe(true);

		const report = await chapterCleanup.batchCleanup([env.chapterId]);
		expect(report.cleaned).toContain(env.chapterId);

		// `abandoned` is terminal — `wake` only accepts `dormant` — so nothing would ever
		// have read this archive again.
		expect((await chapterRow(env.chapterId)).status).toBe("abandoned");
		expect(existsSync(archive)).toBe(false);
	});
});

describe("waking a chapter whose derived worktree path is another chapter's", () => {
	test("refuses instead of deleting the live worktree it collides with", async () => {
		// `worktreePath` is derived, never stored: `.worktrees/<branch minus its prefix>`.
		// `chapter/collide` and `review/collide` therefore resolve to the same directory.
		const env = await createChapterEnv();
		const suffix = `collide-${generateId().slice(0, 6)}`;
		const shared = resolve(env.gitPath, ".worktrees", suffix);
		const now = new Date().toISOString();

		// The dormant chapter that will be woken, on `chapter/<suffix>`.
		await git(["branch", `chapter/${suffix}`], env.gitPath);
		const dormantId = generateId();
		await db.insert(chapters).values({
			id: dormantId,
			projectId: env.projectId,
			title: "Dormant claimant",
			branch: `chapter/${suffix}`,
			baseBranch: "main",
			worktreePath: null,
			status: "dormant",
			role: "branch",
			createdAt: now,
			updatedAt: now,
		});
		archiveDirs.push(getNarraforkPath("dormant-ignored", dormantId));

		// The active chapter that actually owns that directory, on `review/<suffix>`.
		const added = await safeSpawn({
			cmd: ["git", "worktree", "add", shared, "-b", `review/${suffix}`],
			cwd: env.gitPath,
			timeout: 15_000,
		});
		if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
		tempDirs.push(shared);
		writeFileSync(join(shared, "uncommitted.txt"), "the other chapter's work\n");
		const activeId = generateId();
		await db.insert(chapters).values({
			id: activeId,
			projectId: env.projectId,
			title: "Active owner",
			branch: `review/${suffix}`,
			baseBranch: "main",
			worktreePath: shared,
			status: "active",
			role: "review",
			createdAt: now,
			updatedAt: now,
		});
		archiveDirs.push(getNarraforkPath("dormant-ignored", activeId));

		await expect(chapterCleanup.wake(dormantId)).rejects.toThrow(/already in use/i);

		// The reclaim path used to run `remove --force` plus `rmSync` on this directory,
		// taking the other chapter's uncommitted work with it.
		expect(readFileSync(join(shared, "uncommitted.txt"), "utf-8")).toBe(
			"the other chapter's work\n",
		);
		expect(readFileSync(join(shared, BASE_FILE), "utf-8")).toBe(BASE_CONTENT);
		const owner = await chapterRow(activeId);
		expect(owner.status).toBe("active");
		expect(owner.worktreePath).toBe(shared);
		// And the refused chapter is unchanged rather than half-woken.
		const refused = await chapterRow(dormantId);
		expect(refused.status).toBe("dormant");
		expect(refused.worktreePath).toBeNull();
	});

	test("still reclaims a leftover directory that no chapter claims", async () => {
		const env = await createChapterEnv();
		await chapterCleanup.dormant(env.chapterId);
		rmSync(env.worktree, { recursive: true, force: true });
		mkdirSync(env.worktree, { recursive: true });
		writeFileSync(join(env.worktree, "leftover.txt"), "stale\n");

		// The guard must only fire on a real collision: an unclaimed directory is still
		// this chapter's own residue and reclaiming it is the documented recovery.
		await chapterCleanup.wake(env.chapterId);
		const woken = await chapterRow(env.chapterId);
		tempDirs.push(present(woken.worktreePath, "woken worktree"));
		expect(woken.status).toBe("active");
	});
});

describe("waking a merged chapter", () => {
	test("is refused and points at unmerge", async () => {
		const env = await createChapterEnv();
		const now = new Date().toISOString();
		// A merged chapter, as `merge` leaves it.
		await db
			.update(chapters)
			.set({
				status: "merged",
				worktreePath: null,
				mergedIntoChapterId: env.chapterId,
				mergeCommitSha: "0".repeat(40),
				updatedAt: now,
			})
			.where(eq(chapters.id, env.chapterId));

		await expect(chapterCleanup.wake(env.chapterId)).rejects.toThrow(/unmerge/i);

		const row = await chapterRow(env.chapterId);
		// The coordinates survive, so unmerge remains possible. Clearing them while
		// leaving the target untouched is what made unmerge permanently unreachable.
		expect(row.status).toBe("merged");
		expect(row.mergedIntoChapterId).toBe(env.chapterId);
		expect(row.mergeCommitSha).toBeTruthy();
	});
});

describe("deleting a chapter with NO ACTION dependents", () => {
	test("clears port allocations, container instances and terminals first", async () => {
		const env = await createChapterEnv();
		const now = new Date().toISOString();
		// All three FKs are `ON DELETE NO ACTION`, so any surviving row aborts the
		// `DELETE FROM chapters` with FOREIGN KEY constraint failed — after the worktree
		// and branch have already been removed.
		await db.insert(portAllocations).values({
			port: 19_999,
			chapterId: env.chapterId,
			serviceName: "web",
			allocatedAt: now,
		});
		await db.insert(containerInstances).values({
			id: generateId(),
			chapterId: env.chapterId,
			serviceName: "web",
			status: "running",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(terminals).values({
			id: generateId(),
			chapterId: env.chapterId,
			name: "shell",
			status: "exited",
			createdAt: now,
		});

		await chapterService.remove(env.chapterId);

		expect(
			await db.query.chapters.findFirst({ where: eq(chapters.id, env.chapterId) }),
		).toBeUndefined();
		expect(
			await db.query.portAllocations.findFirst({
				where: eq(portAllocations.chapterId, env.chapterId),
			}),
		).toBeUndefined();
		expect(
			await db.query.containerInstances.findFirst({
				where: eq(containerInstances.chapterId, env.chapterId),
			}),
		).toBeUndefined();
		expect(
			await db.query.terminals.findFirst({ where: eq(terminals.chapterId, env.chapterId) }),
		).toBeUndefined();
	});
});

describe("rollback cleans up the shadow repository it created", () => {
	test("a failed fork leaves no orphan shadow repo", async () => {
		const env = await createChapterEnv();
		writeFileSync(join(env.worktree, BASE_FILE), "parent state\n");
		await ensureChapterSnapshot(env.worktree);

		// Fail after the snapshot copy has already created the child's shadow repo and
		// written `refs/nf/head` into it. Neither automatic cleanup path can reach such a
		// repo afterwards: `gcAll` only removes directories missing a HEAD, and the
		// orphan sweep only walks `.worktrees` directories that still exist.
		const observed = observedTarget();
		const restoreInto = worktreeTreeSnapshot.restoreInto;
		worktreeTreeSnapshot.restoreInto = async (from, to, tree) => {
			observed.path = to;
			return restoreInto.call(worktreeTreeSnapshot, from, to, tree);
		};
		const { chapterEdgeService } = await import("../chapter-edge-service");
		const createForkEdge = chapterEdgeService.createForkEdge;
		chapterEdgeService.createForkEdge = async () => {
			throw new Error("simulated fork failure after snapshot copy");
		};
		try {
			await expect(chapterFork.fork(env.chapterId, { inheritMode: "fresh" })).rejects.toThrow(
				/simulated fork failure/,
			);
		} finally {
			worktreeTreeSnapshot.restoreInto = restoreInto;
			chapterEdgeService.createForkEdge = createForkEdge;
		}

		const path = present(observed.path, "child worktree path");
		// Nothing on disk, and nothing recorded in the DB either.
		expect(await worktreeTreeSnapshot.getRef(path, "refs/nf/head")).toBeNull();
		expect(existsSync(path)).toBe(false);
	});

	test("a failed review leaves no orphan shadow repo", async () => {
		const env = await createChapterEnv();
		writeFileSync(join(env.worktree, BASE_FILE), "under review\n");
		await ensureChapterSnapshot(env.worktree);

		const observed = observedTarget();
		const restoreInto = worktreeTreeSnapshot.restoreInto;
		worktreeTreeSnapshot.restoreInto = async (from, to, tree) => {
			observed.path = to;
			return restoreInto.call(worktreeTreeSnapshot, from, to, tree);
		};
		const buildDiffContext = reviewService.buildDiffContext;
		reviewService.buildDiffContext = async () => {
			throw new Error("simulated review failure after snapshot copy");
		};
		try {
			await expect(reviewService.createReview(env.chapterId)).rejects.toThrow(
				/simulated review failure/,
			);
		} finally {
			worktreeTreeSnapshot.restoreInto = restoreInto;
			reviewService.buildDiffContext = buildDiffContext;
		}

		const path = present(observed.path, "review worktree path");
		expect(await worktreeTreeSnapshot.getRef(path, "refs/nf/head")).toBeNull();
		expect(existsSync(path)).toBe(false);
	});
});

describe("forking a dormant chapter", () => {
	test("forks from the branch tip without waking the parent", async () => {
		const env = await createChapterEnv();
		writeFileSync(join(env.worktree, "feature.txt"), "committed work\n");
		await chapterCleanup.dormant(env.chapterId);
		const dormant = await chapterRow(env.chapterId);
		expect(dormant.status).toBe("dormant");
		expect(dormant.worktreePath).toBeNull();

		// Auto-dormant produces exactly this state at a default of 10 active worktrees,
		// and refusing it forced a wake — rebuilding a worktree and mutating the parent
		// just to read its branch tip.
		const child = await chapterFork.fork(env.chapterId, { inheritMode: "fresh" });
		const childPath = present(child.worktreePath, "child worktree");
		tempDirs.push(childPath);

		// The dormant auto-commit put the work on the branch, so the fork has it.
		expect(readFileSync(join(childPath, "feature.txt"), "utf-8")).toBe("committed work\n");
		// The parent is untouched: still dormant, still without a worktree.
		const parentAfter = await chapterRow(env.chapterId);
		expect(parentAfter.status).toBe("dormant");
		expect(parentAfter.worktreePath).toBeNull();
	});

	test("reviewing a dormant chapter is allowed too", async () => {
		const env = await createChapterEnv();
		await chapterCleanup.dormant(env.chapterId);
		// Only the guard is under test here; the review flow itself needs a live model,
		// so it is expected to fail later — just not on the status check.
		const error = await reviewService.createReview(env.chapterId).catch((err) => err);
		expect(String(error)).not.toMatch(/Can only review/i);
	});
});

describe("forking at a message that is not the chapter's", () => {
	test("rejects a subagent message instead of silently falling back to HEAD", async () => {
		const env = await createChapterEnv();
		const seeded = await seedNarratorWithSubagentMessage(env.chapterId);
		// Uncommitted parent work that the silent HEAD fallback used to discard without
		// producing a single warning.
		writeFileSync(join(env.worktree, "uncommitted.txt"), "must not be lost\n");
		await ensureChapterSnapshot(env.worktree);

		await expect(
			chapterFork.fork(env.chapterId, {
				inheritMode: "fresh",
				forkAtMessageId: seeded.subagentMessageId,
			}),
		).rejects.toThrow(/subagent/i);

		// Nothing was created, and the parent still has its work.
		expect(readFileSync(join(env.worktree, "uncommitted.txt"), "utf-8")).toBe("must not be lost\n");
	});

	test("rejects a message belonging to another chapter's narrator", async () => {
		const env = await createChapterEnv();
		// This chapter has its own narrator, so the rejection is about membership rather
		// than about the chapter simply having no conversation.
		await seedNarratorWithSubagentMessage(env.chapterId);
		const other = await createChapterEnv();
		const foreign = await seedNarratorWithSubagentMessage(other.chapterId);

		await expect(
			chapterFork.fork(env.chapterId, {
				inheritMode: "fresh",
				forkAtMessageId: foreign.topLevelMessageId,
			}),
		).rejects.toThrow(/does not belong/i);
	});

	test("still accepts a top-level message from this chapter", async () => {
		const env = await createChapterEnv();
		const seeded = await seedNarratorWithSubagentMessage(env.chapterId);
		writeFileSync(join(env.worktree, BASE_FILE), "state at fork point\n");
		await ensureChapterSnapshot(env.worktree);

		const child = await chapterFork.fork(env.chapterId, {
			inheritMode: "fresh",
			forkAtMessageId: seeded.topLevelMessageId,
		});
		const childPath = present(child.worktreePath, "child worktree");
		tempDirs.push(childPath);
		expect(existsSync(join(childPath, BASE_FILE))).toBe(true);
	});
});

describe("adoptParentLineage ref hygiene", () => {
	test("uses a key derived from the child, so repeat forks do not accumulate refs", async () => {
		const env = await createChapterEnv();
		writeFileSync(join(env.worktree, BASE_FILE), "parent state\n");
		await ensureChapterSnapshot(env.worktree);

		const first = await chapterFork.fork(env.chapterId, { inheritMode: "fresh" });
		tempDirs.push(present(first.worktreePath, "first child"));
		const second = await chapterFork.fork(env.chapterId, { inheritMode: "fresh" });
		tempDirs.push(present(second.worktreePath, "second child"));

		// One ref per child, named after the child rather than a random id, so a retried
		// fork overwrites its own ref instead of adding another one (each of which keeps a
		// whole tree reachable forever, since gcAll runs --no-prune).
		expect(
			await worktreeTreeSnapshot.getRef(env.worktree, snapshotIncomingRef(`fork-${first.id}`)),
		).toBeTruthy();
		expect(
			await worktreeTreeSnapshot.getRef(env.worktree, snapshotIncomingRef(`fork-${second.id}`)),
		).toBeTruthy();
	});

	test("deleting a child drops its fork ref from the parent, leaving siblings alone", async () => {
		const env = await createChapterEnv();
		writeFileSync(join(env.worktree, BASE_FILE), "parent state\n");
		await ensureChapterSnapshot(env.worktree);

		const doomed = await chapterFork.fork(env.chapterId, { inheritMode: "fresh" });
		tempDirs.push(present(doomed.worktreePath, "doomed child"));
		const keeper = await chapterFork.fork(env.chapterId, { inheritMode: "fresh" });
		tempDirs.push(present(keeper.worktreePath, "surviving child"));

		await chapterService.remove(doomed.id);

		// The ref is a GC root inside a repository this deletion does not otherwise touch,
		// so leaving it behind pinned the parent's snapshot commit and every tree under it
		// on disk for a chapter that no longer exists.
		expect(
			await worktreeTreeSnapshot.getRef(env.worktree, snapshotIncomingRef(`fork-${doomed.id}`)),
		).toBeNull();
		// Scoped to the deleted child: a sibling's lineage must survive its neighbour's
		// deletion, which is the failure mode a blanket clean-up would introduce.
		expect(
			await worktreeTreeSnapshot.getRef(env.worktree, snapshotIncomingRef(`fork-${keeper.id}`)),
		).toBeTruthy();
	});

	test("refuses to delete the refs that carry a workspace's own lineage", async () => {
		const env = await createChapterEnv();
		writeFileSync(join(env.worktree, BASE_FILE), "parent state\n");
		const snapshot = await ensureChapterSnapshot(env.worktree);
		expect(snapshot).toBeTruthy();

		// `head` is the chain every later capture builds on: dropping it would make the
		// existing lineage unreachable and silently restart ancestry, which is precisely
		// the loss the snapshot DAG exists to prevent. Auxiliary refs are the caller's to
		// remove; these two are not.
		await expect(worktreeTreeSnapshot.deleteRef(env.worktree, SNAPSHOT_HEAD_REF)).rejects.toThrow(
			/Refusing to delete the lineage ref/,
		);
		expect(await worktreeTreeSnapshot.getRef(env.worktree, SNAPSHOT_HEAD_REF)).toBeTruthy();
	});

	test("dropping an absent ref succeeds, so clean-up cannot fail on a second pass", async () => {
		const env = await createChapterEnv();
		const missing = snapshotIncomingRef("fork-never-existed");
		// Clean-up paths run more than once (a retried delete, an orphan sweep), and must
		// not fail because the thing they are collecting is already gone.
		await worktreeTreeSnapshot.deleteRef(env.worktree, missing);
		await worktreeTreeSnapshot.deleteRef(env.worktree, missing);
		expect(await worktreeTreeSnapshot.getRef(env.worktree, missing)).toBeNull();
	});
});
