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
import { TUTORIAL_PROVIDER_PREFIX, TUTORIAL_TRAIT } from "@shared/tutorial/lessons";
import { TUTORIAL_SANDBOX_COMMITS, TUTORIAL_SANDBOX_FILES } from "@shared/tutorial/sandbox-files";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { chapters, narrators, projects, users } from "../../db/schema";
import { resolveProviderAndModel } from "../../lib/agent/provider";
import { TutorialProvider, tutorialModelForSubagent } from "../../lib/agent/tutorial-provider";
import { generateId } from "../../lib/id";
import {
	resolveEffectiveSubagentModelPolicy,
	resolveSubagentModelFromPolicy,
} from "../../lib/narrator-custom-traits";
import { settings } from "../../lib/settings";
import { gitService } from "../git-service";
import {
	ensureSandbox,
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

	test("each start creates a fresh narrator", async () => {
		// A lesson replays its script from turn 0, and the turn index is derived from
		// conversation history — a reused session would resume mid-script.
		const userId = await freshUser();
		const first = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		const second = await startLesson({ userId, lessonId: LESSON, locale: "en" });
		expect(second.narratorId).not.toBe(first.narratorId);
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
