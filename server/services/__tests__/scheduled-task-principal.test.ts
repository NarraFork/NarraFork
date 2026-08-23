/**
 * Which principal a scheduled task runs as.
 *
 * A task carries only `created_by`, so the scheduler has to reconstruct an ACL principal
 * before it can ask whether that person may drive the narrator it wants to reuse. It used
 * to pass `{ userId: task.createdBy, isAdmin: false }` — and `isAdmin: false` is not a
 * neutral default, it is a claim that the creator is not an administrator.
 *
 * That claim is wrong for exactly the population where it does damage. Every narrator
 * predating access control has `owner_user_id = NULL`, so an admin-created task hit a
 * session with no owner, no write audience admitting it and no explicit grant: the run
 * was skipped with "Task creator no longer has write access to this chapter's narrator",
 * addressed to the one person who could open that very session in the UI and type into
 * it. Nothing about the message points at the ACL layer, which is why it reads as a
 * scheduler bug.
 *
 * The other direction has to keep holding, or fixing this would turn a schedule into a
 * way to inject prompts into a colleague's private session: a NON-admin creator with no
 * access must still be refused, and the refusal must still not create a narrator on that
 * chapter.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/scheduled-task-principal.test.ts
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { chapters, narrators, projects, type scheduledTasks, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { safeSpawn } from "../../lib/spawn";

type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;

/**
 * `sendMessage` is replaced module-wide rather than patched on the imported namespace.
 *
 * ESM exports are read-only bindings, so assigning to the namespace object throws; and
 * more importantly the service captured its own binding at import time, so even a
 * writable namespace would not redirect the call it actually makes.
 *
 * Dispatching for real is not an option: it starts an agent loop against a live model.
 * The stub records which narrator was chosen and throws a sentinel, which makes "reuse
 * succeeded, and this is the session it picked" observable — the decision under test is
 * the last thing before this call.
 */
const realNarratorSession = { ...(await import("../narrator-session")) };
let sentTo: string | null = null;
mock.module("../narrator-session", () => ({
	...realNarratorSession,
	sendMessage: async (narratorId: string) => {
		sentTo = narratorId;
		throw new Error("sentinel: sendMessage reached");
	},
}));

const { scheduledTaskService } = await import("../scheduled-task-service");

const TAG = Date.now();
const tempDirs: string[] = [];
const createdProjects: string[] = [];
const createdUsers: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
	const result = await safeSpawn({ cmd: ["git", ...args], cwd, timeout: 15_000 });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

async function makeUser(role: "admin" | "user"): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `sched-${role}-${TAG}-${generateId(6)}`,
		passwordHash: "x",
		role,
		createdAt: new Date().toISOString(),
	});
	createdUsers.push(id);
	return id;
}

/**
 * An ACTIVE chapter on a real repository, plus one primary narrator on it.
 *
 * Active because the status branches are covered elsewhere; this suite is only about the
 * reuse decision, which is the first thing after them.
 */
async function makeChapterWithNarrator(narratorFields: {
	ownerUserId: string | null;
	visibility: "private" | "project" | "public";
	writeAudience: "owner" | "project" | "public";
}): Promise<{ projectId: string; chapterId: string; narratorId: string }> {
	const gitPath = mkdtempSync(join(tmpdir(), "nf-sched-principal-"));
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
		name: `sched-principal-${TAG}`,
		gitPath,
		// Owned by nobody and private, like a pre-ACL project that was never re-homed.
		// This keeps the project gate from being the thing under test: only an admin or
		// an explicit member passes it, which is exactly the situation being reproduced.
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(projectId);

	const chapterId = generateId();
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "Scheduled chapter",
		branch: `chapter/sched-${generateId(6)}`,
		baseBranch: "main",
		worktreePath: null,
		status: "active",
		role: "branch",
		createdAt: now,
		updatedAt: now,
	});

	const narratorId = generateId();
	await db.insert(narrators).values({
		id: narratorId,
		chapterId,
		title: "Existing session",
		variant: "primary",
		type: "primary",
		ownerUserId: narratorFields.ownerUserId,
		visibility: narratorFields.visibility,
		writeAudience: narratorFields.writeAudience,
		createdAt: now,
		updatedAt: now,
	});

	return { projectId, chapterId, narratorId };
}

function chapterTask(
	projectId: string,
	chapterId: string,
	createdBy: string | null,
): ScheduledTaskRow {
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
		createdBy,
		lastRunAt: null,
		nextRunAt: null,
		lastNarratorId: null,
		lastStatus: null,
		lastError: null,
		createdAt: now,
		updatedAt: now,
	} as ScheduledTaskRow;
}

/** Run `launchNarrator` and report whether it reused a session or refused. */
async function launchAndCaptureTarget(
	task: ScheduledTaskRow,
): Promise<
	{ outcome: "sent"; narratorId: string } | { outcome: "skipped"; error: string | undefined }
> {
	sentTo = null;
	try {
		const result = await scheduledTaskService.launchNarrator(task);
		return { outcome: "skipped", error: result.error };
	} catch (err) {
		if (sentTo && String(err).includes("sentinel")) {
			return { outcome: "sent", narratorId: sentTo };
		}
		throw err;
	}
}

afterEach(async () => {
	for (const projectId of createdProjects.splice(0)) {
		await db.delete(narrators).where(eq(narrators.chapterId, projectId));
		const rows = await db.query.chapters.findMany({
			where: eq(chapters.projectId, projectId),
			columns: { id: true },
		});
		for (const row of rows) {
			await db.delete(narrators).where(eq(narrators.chapterId, row.id));
		}
		await db.delete(chapters).where(eq(chapters.projectId, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const userId of createdUsers.splice(0)) {
		await db.delete(users).where(eq(users.id, userId));
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

afterAll(() => {
	mock.module("../narrator-session", () => realNarratorSession);
	mock.restore();
});

describe("the principal a scheduled task is judged as", () => {
	test("an admin creator may reuse an ownerless pre-ACL narrator", async () => {
		// The exact shape `backfillNarratorVisibility` leaves behind: published, unowned.
		const env = await makeChapterWithNarrator({
			ownerUserId: null,
			visibility: "public",
			writeAudience: "owner",
		});
		const admin = await makeUser("admin");

		const result = await launchAndCaptureTarget(chapterTask(env.projectId, env.chapterId, admin));

		// Hard-coding `isAdmin: false` made this the skip branch, telling an administrator
		// they had lost access to a session they can drive by hand.
		expect(result.outcome).toBe("sent");
		if (result.outcome === "sent") expect(result.narratorId).toBe(env.narratorId);
	});

	test("a non-admin creator with no access is still refused", async () => {
		const env = await makeChapterWithNarrator({
			ownerUserId: await makeUser("user"),
			visibility: "private",
			writeAudience: "owner",
		});
		const stranger = await makeUser("user");

		const result = await launchAndCaptureTarget(
			chapterTask(env.projectId, env.chapterId, stranger),
		);

		expect(result.outcome).toBe("skipped");
		if (result.outcome === "skipped") expect(result.error).toMatch(/write access/i);
	});

	test("the refusal creates no narrator on that chapter", async () => {
		const env = await makeChapterWithNarrator({
			ownerUserId: await makeUser("user"),
			visibility: "private",
			writeAudience: "owner",
		});
		const stranger = await makeUser("user");

		await launchAndCaptureTarget(chapterTask(env.projectId, env.chapterId, stranger));

		// A schedule that cannot reuse must not quietly accumulate sessions instead, which
		// would also route the prompt around the very ACL that just refused it.
		const rows = await db.query.narrators.findMany({
			where: eq(narrators.chapterId, env.chapterId),
			columns: { id: true },
		});
		expect(rows.map((row) => row.id)).toEqual([env.narratorId]);
	});

	test("a task whose creator was deleted is refused rather than treated as admin", async () => {
		const env = await makeChapterWithNarrator({
			ownerUserId: await makeUser("user"),
			visibility: "private",
			writeAudience: "owner",
		});

		// `created_by` is `set null` on user deletion, so this is a reachable state and the
		// fail-closed direction has to be the empty principal, not a missing-row shortcut.
		const result = await launchAndCaptureTarget(chapterTask(env.projectId, env.chapterId, null));

		expect(result.outcome).toBe("skipped");
		if (result.outcome === "skipped") expect(result.error).toMatch(/write access/i);
	});

	test("a demotion applies on the next tick, not at task-edit time", async () => {
		const env = await makeChapterWithNarrator({
			ownerUserId: null,
			visibility: "public",
			writeAudience: "owner",
		});
		const wasAdmin = await makeUser("admin");
		const task = chapterTask(env.projectId, env.chapterId, wasAdmin);
		// Reuse works while the role stands.
		expect((await launchAndCaptureTarget(task)).outcome).toBe("sent");

		await db.update(users).set({ role: "user" }).where(eq(users.id, wasAdmin));

		// The role is read live for this reason: a snapshot taken when the task was created
		// would keep an ex-administrator driving unowned sessions indefinitely.
		const after = await launchAndCaptureTarget(task);
		expect(after.outcome).toBe("skipped");
	});
});
