/**
 * What a chapter-bound scheduled task does with a chapter it cannot run in.
 *
 * The interesting status is `merged`. `chapterCleanup.wake` refuses one outright —
 * waking a merged chapter erased its merge coordinates while its changes stayed
 * applied in the target, leaving `unmerge` unreachable — but `launchNarrator` still
 * routed `merged` into `wake`, and not inside a try. Every tick therefore threw a
 * ValidationError: the run was recorded as a failure instead of a skip, and the
 * message the user saw was `wake`'s prose about clicking Unmerge, which says nothing
 * about why their schedule stopped producing output.
 *
 * Both directions matter, so `dormant` is covered too: that one must still wake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { chapters, projects, type scheduledTasks } from "../../db/schema";
import { generateId } from "../../lib/id";
import { safeSpawn } from "../../lib/spawn";
import { chapterCleanup } from "../chapter-cleanup";
import { scheduledTaskService } from "../scheduled-task-service";

type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;

const tempDirs: string[] = [];
const createdProjects: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** A project with one chapter in the requested status, on a real repo. */
async function createChapter(status: "merged" | "dormant" | "abandoned"): Promise<{
	projectId: string;
	chapterId: string;
	gitPath: string;
}> {
	const gitPath = mkdtempSync(join(tmpdir(), "nf-sched-"));
	tempDirs.push(gitPath);
	await git(["init"], gitPath);
	await git(["config", "user.email", "test@example.com"], gitPath);
	await git(["config", "user.name", "Test"], gitPath);
	writeFileSync(join(gitPath, "app.txt"), "seed\n");
	await git(["add", "-A"], gitPath);
	await git(["commit", "-m", "seed"], gitPath);

	const now = new Date().toISOString();
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Scheduled project",
		gitPath,
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(projectId);

	const suffix = `sched-${generateId().slice(0, 6)}`;
	const branch = `chapter/${suffix}`;
	await git(["branch", branch], gitPath);
	tempDirs.push(resolve(gitPath, ".worktrees", suffix));

	const chapterId = generateId();
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "Scheduled chapter",
		branch,
		baseBranch: "main",
		worktreePath: null,
		status,
		role: "branch",
		// A merged chapter carries the coordinates `unmerge` needs; they must survive.
		...(status === "merged" ? { mergeCommitSha: "0".repeat(40) } : {}),
		createdAt: now,
		updatedAt: now,
	});

	return { projectId, chapterId, gitPath };
}

function chapterTask(projectId: string, chapterId: string): ScheduledTaskRow {
	const now = new Date().toISOString();
	return {
		id: generateId(),
		name: "Nightly check",
		enabled: true,
		cronExpr: "0 3 * * *",
		timezone: null,
		prompt: "run the checks",
		systemPrompt: null,
		model: null,
		permissionMode: "bypassPermissions",
		locale: "en",
		runContext: "chapter",
		cwd: null,
		projectId,
		chapterId,
		narratorMode: "new",
		reuseNarratorId: null,
		createdBy: null,
		lastRunAt: null,
		nextRunAt: null,
		lastNarratorId: null,
		lastStatus: null,
		lastError: null,
		createdAt: now,
		updatedAt: now,
	} as ScheduledTaskRow;
}

afterEach(async () => {
	for (const projectId of createdProjects.splice(0)) {
		await db.delete(chapters).where(eq(chapters.projectId, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("a chapter-bound scheduled task on a merged chapter", () => {
	test("skips with an actionable reason instead of throwing wake's error", async () => {
		const env = await createChapter("merged");
		const wake = chapterCleanup.wake;
		let wakeCalls = 0;
		chapterCleanup.wake = async (id: string) => {
			wakeCalls++;
			return wake.call(chapterCleanup, id);
		};
		let result: Awaited<ReturnType<typeof scheduledTaskService.launchNarrator>>;
		try {
			// Not `rejects`: the whole point is that this resolves. The call is outside any
			// try in `launchNarrator`, so routing merged into `wake` made it throw.
			result = await scheduledTaskService.launchNarrator(chapterTask(env.projectId, env.chapterId));
		} finally {
			chapterCleanup.wake = wake;
		}

		expect(result.status).toBe("skipped");
		expect(result.narratorId).toBeNull();
		// Names the state and the action, rather than telling a schedule to click Unmerge.
		expect(result.error).toMatch(/merged/i);
		expect(result.error).toMatch(/unmerge/i);
		// `wake` is never consulted, so it cannot reject and it cannot mutate anything.
		expect(wakeCalls).toBe(0);

		// The merge coordinates survive, so unmerge stays possible.
		const row = await db.query.chapters.findFirst({ where: eq(chapters.id, env.chapterId) });
		expect(row?.status).toBe("merged");
		expect(row?.mergeCommitSha).toBeTruthy();
	});

	test("does not create a narrator for the skipped run", async () => {
		const env = await createChapter("merged");
		const result = await scheduledTaskService.launchNarrator(
			chapterTask(env.projectId, env.chapterId),
		);
		expect(result.status).toBe("skipped");
		// Bailing before narrator resolution is what keeps a permanently-failing schedule
		// from accumulating narrators on a chapter that cannot run.
		const owned = await db.query.narrators.findMany({
			where: (n, { eq: e }) => e(n.chapterId, env.chapterId),
		});
		expect(owned).toHaveLength(0);
	});
});

describe("a chapter-bound scheduled task on a chapter in another non-active status", () => {
	test("a dormant chapter is still woken", async () => {
		const env = await createChapter("dormant");
		const wake = chapterCleanup.wake;
		const seen: string[] = [];
		// Stubbed to throw a sentinel after recording: the assertion is only about `wake`
		// being reached for `dormant`, and letting the real flow continue would create a
		// narrator and dispatch a prompt to a live model.
		chapterCleanup.wake = async (id: string) => {
			seen.push(id);
			throw new Error("sentinel: wake reached");
		};
		try {
			await expect(
				scheduledTaskService.launchNarrator(chapterTask(env.projectId, env.chapterId)),
			).rejects.toThrow(/sentinel/);
		} finally {
			chapterCleanup.wake = wake;
		}
		expect(seen).toEqual([env.chapterId]);
	});

	test("an abandoned chapter is skipped and never reaches wake", async () => {
		const env = await createChapter("abandoned");
		const wake = chapterCleanup.wake;
		let wakeCalls = 0;
		chapterCleanup.wake = async (id: string) => {
			wakeCalls++;
			return wake.call(chapterCleanup, id);
		};
		let result: Awaited<ReturnType<typeof scheduledTaskService.launchNarrator>>;
		try {
			result = await scheduledTaskService.launchNarrator(chapterTask(env.projectId, env.chapterId));
		} finally {
			chapterCleanup.wake = wake;
		}
		expect(result.status).toBe("skipped");
		expect(result.error).toMatch(/abandoned/i);
		expect(wakeCalls).toBe(0);
	});
});
