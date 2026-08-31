/**
 * Tutorial sandbox provisioning and lesson lifecycle.
 *
 * The load-bearing assertions here are the three model suppressions. Each one
 * fails by silently sending tutorial traffic to a real API and billing the user —
 * a working provider answering a tutorial prompt looks exactly like a working
 * tutorial, so none of them produce an error to notice.
 *
 * Runs against a real isolated DB under the temp NARRAFORK_HOME established by
 * `tests/preload.ts`, and really does run `git init` — the point is that the
 * sandbox is a real repository.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
	TUTORIAL_LESSON_BOUNDARY_BLOCK,
	TUTORIAL_PROVIDER_PREFIX,
	TUTORIAL_TRAIT,
} from "@shared/tutorial/lessons";
import { TUTORIAL_SANDBOX_COMMITS, TUTORIAL_SANDBOX_FILES } from "@shared/tutorial/sandbox-files";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { chapters, narratorMessages, narrators, projects, users } from "../../db/schema";
import { resolveProviderAndModel } from "../../lib/agent/provider";
import {
	TutorialProvider,
	tutorialModelForLesson,
	tutorialModelForSubagent,
} from "../../lib/agent/tutorial-provider";
import { generateId } from "../../lib/id";
import {
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelFromPolicy,
} from "../../lib/narrator-custom-traits";
import { settings } from "../../lib/settings";
import { gitService } from "../git-service";
import {
	ensureSandbox,
	getLessonSession,
	getProgress,
	getSandboxStatus,
	recordProgress,
	resetLessonProgress,
	startLesson,
	tutorialSandboxPath,
	tutorialSubagentTraits,
} from "../tutorial-service";

/**
 * A real `users` row per case.
 *
 * Real rather than a synthetic id because `projects.ownerUserId` and
 * `narrators.ownerUserId` are foreign keys — a made-up id fails the constraint,
 * which is itself worth knowing: the sandbox is genuinely owned by a user, not
 * parked under a placeholder.
 *
 * One user per case so no two can see each other's sandbox.
 */
async function freshUser(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `tutorial-${generateId(8)}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

const LESSON = "first-turn";

describe("ensureSandbox", () => {
	test("provisions a real git repository with the seeded files", async () => {
		const userId = await freshUser();
		const sandbox = await ensureSandbox(userId);

		expect(sandbox.gitPath).toBe(tutorialSandboxPath(userId));
		expect(existsSync(resolve(sandbox.gitPath, ".git"))).toBe(true);
		for (const file of TUTORIAL_SANDBOX_FILES) {
			expect(existsSync(resolve(sandbox.gitPath, file.path)), file.path).toBe(true);
		}
	});

	test("is idempotent — a second call reuses the same project and chapter", async () => {
		const userId = await freshUser();
		const first = await ensureSandbox(userId);
		const second = await ensureSandbox(userId);
		expect(second.projectId).toBe(first.projectId);
		expect(second.chapterId).toBe(first.chapterId);

		const rows = await db.query.projects.findMany({
			where: eq(projects.ownerUserId, userId),
			columns: { id: true },
		});
		expect(rows.length).toBe(1);
	});

	test("concurrent calls provision exactly one sandbox", async () => {
		// Two lesson launches racing would both see "no sandbox" and both run
		// `git init` on the same directory, leaving one project row pointing at a
		// repository the other half-created.
		const userId = await freshUser();
		const results = await Promise.all([
			ensureSandbox(userId),
			ensureSandbox(userId),
			ensureSandbox(userId),
		]);
		const projectIds = new Set(results.map((r) => r.projectId));
		expect(projectIds.size).toBe(1);
	});

	test("repairs a deleted directory without orphaning the project row", async () => {
		// The row survives a directory the user deleted by hand. Re-provisioning the
		// project instead of repairing it would leave its chapters pointing at a
		// project that no longer exists.
		const userId = await freshUser();
		const first = await ensureSandbox(userId);
		await rm(first.gitPath, { recursive: true, force: true });
		expect(existsSync(first.gitPath)).toBe(false);

		const repaired = await ensureSandbox(userId);
		expect(repaired.projectId).toBe(first.projectId);
		expect(repaired.chapterId).toBe(first.chapterId);
		expect(existsSync(resolve(repaired.gitPath, ".git"))).toBe(true);
	});

	test("seeds a multi-commit history", async () => {
		// The NarraFlow lessons are about history. A single "Initial commit" ancestor
		// demonstrates forking without showing why anyone would fork.
		const userId = await freshUser();
		const sandbox = await ensureSandbox(userId);
		const log = await gitService.getLog(sandbox.gitPath, { limit: 20 });
		expect(log.length).toBeGreaterThanOrEqual(TUTORIAL_SANDBOX_COMMITS.length);
		const messages = log.map((commit) => commit.message);
		for (const commit of TUTORIAL_SANDBOX_COMMITS) {
			expect(messages, commit.message).toContain(commit.message);
		}
	});

	test("leaves the worktree clean", async () => {
		// A dirty tree after provisioning would make the first chapter lesson open on
		// uncommitted changes the user never made, which reads as a product bug.
		const userId = await freshUser();
		const sandbox = await ensureSandbox(userId);
		expect((await gitService.getStatus(sandbox.gitPath)).trim()).toBe("");
	});

	test("the project is marked as a tutorial sandbox", async () => {
		// The marker is how the UI can label it and how `findSandboxProject` finds it
		// again; without it a second call would provision a duplicate.
		const userId = await freshUser();
		const { projectId } = await ensureSandbox(userId);
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, projectId),
			columns: { traits: true },
		});
		expect(project?.traits ?? []).toContain(TUTORIAL_TRAIT);
	});

	test("the root chapter does not get an auto-created narrator", async () => {
		// `createRootChapter` would build one on `settings.agent.defaultModel` — a
		// REAL model, billed, with no script to play.
		const userId = await freshUser();
		const { projectId, chapterId } = await ensureSandbox(userId);
		expect(chapterId).toBeTruthy();

		const chapterNarrators = await db.query.narrators.findMany({
			where: eq(narrators.chapterId, chapterId),
			columns: { id: true, model: true },
		});
		expect(chapterNarrators).toHaveLength(0);

		const root = await db.query.chapters.findFirst({
			where: and(eq(chapters.projectId, projectId), eq(chapters.isRoot, 1)),
			columns: { id: true },
		});
		expect(root?.id).toBe(chapterId);
	});
});

describe("getLessonSession", () => {
	test("reports nothing before the lesson is started", async () => {
		const userId = await freshUser();
		expect(await getLessonSession({ userId, lessonId: LESSON, locale: "en" })).toBeNull();
	});

	test("does not provision anything just by being asked", async () => {
		// Opening a lesson page must stay free. Provisioning here would run `git init`
		// for every lesson somebody merely looked at.
		const userId = await freshUser();
		await getLessonSession({ userId, lessonId: "tool-calls", locale: "en" });
		expect((await getSandboxStatus(userId)).exists).toBe(false);
	});

	test("reports the running session so a returning user resumes it", async () => {
		const userId = await freshUser();
		const started = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const session = await getLessonSession({ userId, lessonId: LESSON, locale: "en" });
		expect(session?.narratorId).toBe(started.narratorId);
	});

	test("a lesson the user never started reports nothing, even though the slot has a narrator", async () => {
		// The slot's narrator serves every lesson in it. Reporting it for an unstarted
		// lesson would auto-mount a session with no boundary row for that lesson, so the
		// script would answer with its "this lesson is finished" fallback before the
		// user sent anything.
		const userId = await freshUser();
		await startLesson({ userId, lessonId: "tool-calls", locale: "en" });
		expect(await getLessonSession({ userId, lessonId: "permissions", locale: "en" })).toBeNull();
	});

	test("an unknown lesson is rejected", async () => {
		expect(
			getLessonSession({ userId: await freshUser(), lessonId: "nope", locale: "en" }),
		).rejects.toThrow();
	});
});

describe("getSandboxStatus", () => {
	test("reports absence before provisioning and presence after", async () => {
		const userId = await freshUser();
		const before = await getSandboxStatus(userId);
		expect(before.exists).toBe(false);
		expect(before.projectId).toBeNull();

		await ensureSandbox(userId);
		const after = await getSandboxStatus(userId);
		expect(after.exists).toBe(true);
		expect(after.projectId).toBeTruthy();
	});

	test("a deleted directory is reported as absent even though the row remains", async () => {
		const userId = await freshUser();
		const sandbox = await ensureSandbox(userId);
		await rm(sandbox.gitPath, { recursive: true, force: true });
		const status = await getSandboxStatus(userId);
		expect(status.exists).toBe(false);
		// The row is still there, which is what lets `ensureSandbox` repair in place.
		expect(status.projectId).toBe(sandbox.projectId);
	});
});

describe("startLesson", () => {
	test("the narrator's model routes to the scripted provider", async () => {
		const userId = await freshUser();
		const session = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, session.narratorId),
			columns: { model: true, title: true, permissionMode: true, traits: true },
		});
		expect(narrator?.model?.startsWith(`${TUTORIAL_PROVIDER_PREFIX}:`)).toBe(true);
		expect(resolveProviderAndModel(narrator?.model ?? "").adapter).toBeInstanceOf(TutorialProvider);
	});

	test("a non-empty title is written, which suppresses title generation", async () => {
		// Title generation runs on `settings.agent.summaryModel` — a real model the
		// tutorial model cannot redirect. `narrator-session`'s check only fires when
		// the narrator has no title, so writing one is the suppression.
		const userId = await freshUser();
		const session = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, session.narratorId),
			columns: { title: true },
		});
		expect((narrator?.title ?? "").trim().length).toBeGreaterThan(0);
	});

	test("permission mode stays at default so approval cards still appear", async () => {
		// Permission cards are a lesson, not an obstacle.
		const userId = await freshUser();
		const session = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, session.narratorId),
			columns: { permissionMode: true },
		});
		expect(narrator?.permissionMode).toBe("default");
	});

	test("locale is carried in the model value", async () => {
		const userId = await freshUser();
		const session = await startLesson({ userId, lessonId: LESSON, locale: "zh-CN" });
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, session.narratorId),
			columns: { model: true },
		});
		expect(narrator?.model).toContain("zh-CN");
	});

	test("the standalone trait survives the traits rewrite", async () => {
		// `startLesson` rewrites the whole `traits` column to refresh the subagent pools.
		// It used to build the baseline from the `existing` narrator, which is undefined on
		// the create path — so the write erased what `createNarrator` had just stored.
		// `standalone` is the casualty that matters: `db/index.ts` runs a startup backfill
		// asserting every chapter-less narrator carries it, so a tutorial narrator became a
		// standing violation, reclassified as chapter-bound until the next restart. Nothing
		// errored, which is why only an assertion on the stored row can catch it.
		const userId = await freshUser();
		const session = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, session.narratorId),
			columns: { chapterId: true, traits: true },
		});
		// Precondition: this lesson is the standalone one, or the assertion below is vacuous.
		expect(narrator?.chapterId).toBeNull();
		expect(narrator?.traits ?? []).toContain("standalone");
		// The pools must still be there — the rewrite has to ADD, not replace.
		expect(narrator?.traits ?? []).toContain(TUTORIAL_TRAIT);
	});

	test("a reused narrator keeps standalone across a second start", async () => {
		// The reuse path reads the row too, so a regression that only fixed the create path
		// would still drop the trait on the second start of the same slot.
		const userId = await freshUser();
		await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const session = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, session.narratorId),
			columns: { traits: true },
		});
		expect(narrator?.traits ?? []).toContain("standalone");
	});

	test("a second start reuses the same narrator", async () => {
		// Continuity is the point: the tutorial teaches that a narrator is a durable
		// session, and a new one per lesson contradicts the lesson while also throwing
		// away everything the user just did.
		const userId = await freshUser();
		const first = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const second = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		expect(second.narratorId).toBe(first.narratorId);
	});

	test("consecutive chapter lessons both start", async () => {
		// The regression this reuse fixes: a chapter may hold only ONE primary
		// narrator, so creating one per lesson made the SECOND chapter-bound lesson
		// fail with "Chapter already has a primary narrator" — every lesson after
		// `tool-calls` was unreachable, and the failure surfaced as a lesson error
		// rather than anything pointing at the cause.
		const userId = await freshUser();
		const first = await startLesson({ userId, lessonId: "tool-calls", locale: "en" });
		const second = await startLesson({ userId, lessonId: "permissions", locale: "en" });
		const third = await startLesson({ userId, lessonId: "interrupt-and-queue", locale: "en" });
		expect(second.narratorId).toBe(first.narratorId);
		expect(third.narratorId).toBe(first.narratorId);
		expect(second.chapterId).toBe(first.chapterId);
	});

	test("a chapter lesson and a standalone lesson use separate narrators", async () => {
		// A chapter lesson's tools must operate on the sandbox worktree; a standalone
		// lesson has no chapter at all. Sharing one row would mean either handing the
		// standalone lesson a worktree it does not need or unbinding the chapter one.
		const userId = await freshUser();
		const standalone = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const chapterBound = await startLesson({ userId, lessonId: "tool-calls", locale: "en" });
		expect(chapterBound.narratorId).not.toBe(standalone.narratorId);
		expect(standalone.chapterId).toBeNull();
		expect(chapterBound.chapterId).toBeTruthy();
	});

	test("the reused narrator's model and subagent pools follow the new lesson", async () => {
		// Traits name the LESSON. A reused narrator still holding the previous
		// lesson's pools would send this lesson's subagents to the wrong script — and
		// a lesson id that no longer exists means no script at all.
		const userId = await freshUser();
		await startLesson({ userId, lessonId: "tool-calls", locale: "en" });
		const session = await startLesson({ userId, lessonId: "permissions", locale: "en" });
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, session.narratorId),
			columns: { model: true, traits: true },
		});
		expect(narrator?.model).toBe(tutorialModelForLesson("permissions", "en"));
		const explore = resolveEffectiveSubagentModelPolicy(narrator?.traits ?? [], "explore");
		expect(explore.models[0]?.model).toBe(tutorialModelForSubagent("permissions", "en", "explore"));
	});

	test("each start writes a lesson boundary the turn counter can find", async () => {
		// Load-bearing for the reuse: `scriptTurnIndex` counts assistant turns only
		// after the latest boundary. Without this row a reused session plays the
		// lesson's "this script is finished" fallback instead of turn 0 — no error,
		// just a lesson that appears to be over before it starts.
		const userId = await freshUser();
		const session = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		await startLesson({ userId, lessonId: LESSON, locale: "en" });

		const rows = await db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, session.narratorId),
			columns: { contentJson: true },
		});
		const boundaries = rows.filter((row) =>
			(Array.isArray(row.contentJson) ? row.contentJson : []).some(
				(block) => (block as { type?: string })?.type === TUTORIAL_LESSON_BOUNDARY_BLOCK,
			),
		);
		expect(boundaries).toHaveLength(2);
	});

	test("the reused narrator is put back into a clean lesson state", async () => {
		// A user who switched to bypassPermissions during one lesson would otherwise
		// never see the approval card the permissions lesson is entirely about, and a
		// narrator left in plan mode would refuse the writes a later script performs.
		const userId = await freshUser();
		const first = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		await db
			.update(narrators)
			.set({ permissionMode: "bypassPermissions", planMode: true })
			.where(eq(narrators.id, first.narratorId));

		await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, first.narratorId),
			columns: { permissionMode: true, planMode: true },
		});
		expect(narrator?.permissionMode).toBe("default");
		expect(narrator?.planMode).toBe(false);
	});

	test("a narrator on a real model is never reused", async () => {
		// Pointing a real model at a tutorial session is exactly the silent billing
		// this module exists to prevent, so a row whose model drifted off the scripted
		// provider must be left alone rather than adopted.
		const userId = await freshUser();
		const first = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		await db
			.update(narrators)
			.set({ model: "anthropic:claude-opus-4.6" })
			.where(eq(narrators.id, first.narratorId));

		const second = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		expect(second.narratorId).not.toBe(first.narratorId);
	});

	test("concurrent starts do not create two narrators for one chapter", async () => {
		// Both would find no tutorial narrator and both create one; the second insert
		// then hits the one-primary-per-chapter rule and the user is told a lesson
		// cannot start for a reason unrelated to the lesson.
		const userId = await freshUser();
		const results = await Promise.all([
			startLesson({ userId, lessonId: "tool-calls", locale: "en" }),
			startLesson({ userId, lessonId: "permissions", locale: "en" }),
		]);
		expect(new Set(results.map((r) => r.narratorId)).size).toBe(1);
	});

	test("a standalone lesson does not provision the sandbox", async () => {
		// `first-turn` needs no project. Provisioning a git repository for it would
		// make the cheapest lesson the slowest one.
		const userId = await freshUser();
		const session = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		expect(session.projectId).toBeNull();
		expect(session.chapterId).toBeNull();
		expect((await getSandboxStatus(userId)).exists).toBe(false);
	});

	test("an unknown lesson is rejected", async () => {
		expect(
			startLesson({ userId: await freshUser(), lessonId: "no-such-lesson", locale: "en" }),
		).rejects.toThrow();
	});
});

describe("subagent model lockdown", () => {
	test("a started lesson pins every pool to a scripted model", async () => {
		// The pool is what stops a subagent reaching a real API. Asserted on the
		// narrator a real `startLesson` produced, not on a hand-built trait, so the
		// wiring between the two is covered too.
		const userId = await freshUser();
		const session = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, session.narratorId),
			columns: { traits: true },
		});
		const traits = narrator?.traits ?? [];

		for (const type of ["explore", "plan", "search", "review", "general"]) {
			const policy = resolveEffectiveSubagentModelPolicy(traits, type);
			expect(policy.source, type).toBe("custom");
			expect(policy.models, type).toHaveLength(1);
			const model = policy.models[0]?.model ?? "";
			expect(model.startsWith(`${TUTORIAL_PROVIDER_PREFIX}:`), type).toBe(true);
			expect(resolveProviderAndModel(model).adapter, type).toBeInstanceOf(TutorialProvider);
		}
	});

	test("each type gets its OWN model value, carrying its type", async () => {
		// The subagent's type is not otherwise visible to the provider, so this is what
		// lets an explore agent play a read-only script and a general agent a writing
		// one. One shared value would still lock the models, but every subagent would
		// recite the same lines — teaching that the type distinction is cosmetic.
		const traits = tutorialSubagentTraits([], { lessonId: "subagent-types", locale: "en" });
		const seen = new Set<string>();
		for (const type of ["explore", "plan", "search", "review", "general"]) {
			const models = resolveEffectiveSubagentModelPolicy(traits, type).models.map((m) => m.model);
			expect(models, type).toHaveLength(1);
			expect(models[0], type).toContain(`/${type}`);
			seen.add(models[0]);
		}
		expect(seen.size).toBe(5);
	});

	test("a configured per-type subagent model cannot win over the pool", async () => {
		// This is the failure the trait exists to prevent: `subagent-runner` ranks
		// `settings.agent.subagentModels[type]` ABOVE the parent narrator's model, so
		// without the pool an admin's explore preference would send tutorial subagents
		// to a real API. The preload restores settings after each test.
		const traits = tutorialSubagentTraits([], { lessonId: "subagent-types", locale: "en" });
		settings.agent.subagentModels = {
			explore: "anthropic:claude-opus-4.6",
			plan: "anthropic:claude-opus-4.6",
		};

		const policy = resolveEffectiveSubagentModelPolicy(traits, "explore");
		const resolved = resolveSubagentModelFromPolicy({
			policy,
			candidates: ["anthropic:claude-opus-4.6", "tutorial:guide/subagent-types/en"],
		});
		expect(resolved).toBe(tutorialModelForSubagent("subagent-types", "en", "explore"));
	});

	test("an explicitly requested real model is refused", async () => {
		// The Agent tool lets the model name a subagent model. A scripted turn should
		// never do that, but the pool must not depend on the script behaving.
		const traits = tutorialSubagentTraits([], { lessonId: "subagent-types", locale: "en" });
		const policy = resolveEffectiveSubagentModelPolicy(traits, "general");
		const resolved = resolveSubagentModelFromPolicy({
			policy,
			explicitModel: "openai:gpt-5.5",
			candidates: [tutorialModelForSubagent("subagent-types", "en", "general")],
		});
		expect(resolved).toBeUndefined();
	});

	test("every pooled model still routes to the scripted provider", () => {
		// The values are assembled by string concatenation, so a malformed one would
		// resolve to a real provider (or throw) rather than to the tutorial.
		const traits = tutorialSubagentTraits([], { lessonId: "subagent-types", locale: "en" });
		for (const type of ["explore", "plan", "search", "review", "general"]) {
			const model = resolveEffectiveSubagentModelPolicy(traits, type).models[0]?.model ?? "";
			expect(resolveProviderAndModel(model).adapter, type).toBeInstanceOf(TutorialProvider);
		}
	});

	test("existing traits are preserved when the pool is added", () => {
		const traits = tutorialSubagentTraits(["standalone", TUTORIAL_TRAIT], {
			lessonId: "subagent-types",
			locale: "en",
		});
		expect(traits).toContain("standalone");
		expect(traits).toContain(TUTORIAL_TRAIT);
	});
});

describe("progress", () => {
	test("starts empty and records completed steps", async () => {
		const userId = await freshUser();
		expect(await getProgress(userId)).toEqual({});

		await recordProgress({ userId, lessonId: LESSON, completedStepIds: ["send"] });
		const progress = await getProgress(userId);
		expect(progress[LESSON]?.completedStepIds).toContain("send");
	});

	test("is additive — a replay cannot un-complete a step", async () => {
		const userId = await freshUser();
		await recordProgress({ userId, lessonId: LESSON, completedStepIds: ["send", "observe"] });
		await recordProgress({ userId, lessonId: LESSON, completedStepIds: ["send"] });
		const progress = await getProgress(userId);
		expect(progress[LESSON]?.completedStepIds.sort()).toEqual(["observe", "send"]);
	});

	test("completing every step stamps completedAt", async () => {
		const userId = await freshUser();
		await recordProgress({
			userId,
			lessonId: LESSON,
			completedStepIds: ["send", "observe", "idle"],
		});
		expect((await getProgress(userId))[LESSON]?.completedAt).toBeTruthy();
	});

	test("completedAt is not stamped while steps remain", async () => {
		const userId = await freshUser();
		await recordProgress({ userId, lessonId: LESSON, completedStepIds: ["send"] });
		expect((await getProgress(userId))[LESSON]?.completedAt).toBeUndefined();
	});

	test("an unknown step id is rejected", async () => {
		// Accepting arbitrary ids would let a stale client mark a lesson complete with
		// steps it never performed, and the ids would never match a real step again.
		expect(
			recordProgress({ userId: await freshUser(), lessonId: LESSON, completedStepIds: ["nope"] }),
		).rejects.toThrow();
	});

	test("an unknown lesson id is rejected", async () => {
		expect(
			recordProgress({
				userId: await freshUser(),
				lessonId: "no-such-lesson",
				completedStepIds: [],
			}),
		).rejects.toThrow();
	});

	test("reset clears one lesson and leaves the others", async () => {
		const userId = await freshUser();
		await recordProgress({ userId, lessonId: LESSON, completedStepIds: ["send"] });
		const after = await resetLessonProgress(userId, LESSON);
		expect(after[LESSON]).toBeUndefined();
		expect(await getProgress(userId)).toEqual({});
	});

	test("concurrent writes do not lose steps", async () => {
		// Read-modify-write on a shared JSON blob: without the per-user lock the last
		// writer would overwrite the other's step.
		const userId = await freshUser();
		await Promise.all([
			recordProgress({ userId, lessonId: LESSON, completedStepIds: ["send"] }),
			recordProgress({ userId, lessonId: LESSON, completedStepIds: ["observe"] }),
			recordProgress({ userId, lessonId: LESSON, completedStepIds: ["idle"] }),
		]);
		const progress = await getProgress(userId);
		expect(progress[LESSON]?.completedStepIds.sort()).toEqual(["idle", "observe", "send"]);
	});
});
