/**
 * Interactive tutorial: sandbox provisioning and lesson lifecycle.
 *
 * The tutorial teaches by letting the user drive the real product, so it needs
 * real resources: a real git repository, real chapters/worktrees, real narrators.
 * This service creates them in an isolated place and — critically — makes sure
 * none of them can reach a real model.
 *
 * Three suppressions matter, because each one fails by SILENTLY billing the user
 * (a working provider answering a tutorial prompt looks like a working tutorial):
 *
 *  1. **The narrator's model** is `tutorial:guide/<lesson>/<locale>`, which
 *     `createProviderByName` resolves to the scripted provider before any
 *     configured provider is consulted.
 *  2. **Subagent models** are locked to that same value with a subagent
 *     model-restriction trait. Without it, `settings.agent.subagentModels[type]`
 *     outranks the parent's model in `subagent-runner`'s candidate chain, so a
 *     configured per-type preference would send tutorial subagents to a real API.
 *  3. **Title generation** is suppressed by writing a non-empty title at
 *     creation: `narrator-session`'s title check only fires for a narrator with no
 *     title, and titles use `settings.agent.summaryModel`, which the tutorial
 *     model does not influence.
 *
 * The root chapter's auto-narrator is also disabled (`autoCreateNarrator: false`):
 * it would be created with `settings.agent.defaultModel` — a real one.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getTutorialLesson, TUTORIAL_TRAIT } from "@shared/tutorial/lessons";
import { TUTORIAL_SANDBOX_COMMITS, TUTORIAL_SANDBOX_FILES } from "@shared/tutorial/sandbox-files";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects, userPreferences } from "../db/schema";
import { tutorialModelForLesson, tutorialModelForSubagent } from "../lib/agent/tutorial-provider";
import { AsyncMutex, userPreferencesLock } from "../lib/async-mutex";
import { NotFoundError, ValidationError } from "../lib/errors";
import { resolveUserGitIdentityEnv } from "../lib/git-identity";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getNarraforkPath } from "../lib/narrafork-home";
import {
	SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX,
	upsertEncodedTrait,
} from "../lib/narrator-custom-traits";
import type { Locale } from "../lib/prompt-i18n";
import { chapterService } from "./chapter-service";
import { gitService } from "./git-service";
import { narratorService } from "./narrator-service";

/** Every subagent pool the restriction trait must cover. */
const SUBAGENT_POOL_KEYS = ["explore", "plan", "search", "review", "general"] as const;

/**
 * Serialises provisioning per user.
 *
 * Two lesson launches racing would both see "no sandbox" and both run `git init`
 * on the same directory, leaving one project row pointing at a repository the
 * other half-created.
 */
const sandboxLock = new AsyncMutex();

export interface TutorialSandbox {
	projectId: string;
	chapterId: string;
	gitPath: string;
}

export interface TutorialLessonSession {
	lessonId: string;
	narratorId: string;
	projectId: string | null;
	chapterId: string | null;
}

export interface TutorialLessonProgress {
	completedStepIds: string[];
	completedAt?: string;
}

export type TutorialProgressMap = Record<string, TutorialLessonProgress>;

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/**
 * Per-user sandbox directory.
 *
 * Under NarraFork's own data directory rather than anywhere in the user's
 * workspace: the tutorial's agents write here for real, and a path the user might
 * mistake for their own project is exactly the wrong place for that. Per user so
 * two people learning at once cannot see each other's edits.
 */
export function tutorialSandboxPath(userId: string): string {
	return getNarraforkPath("tutorial-workspace", userId);
}

async function findSandboxProject(userId: string) {
	const rows = await db.query.projects.findMany({
		where: eq(projects.ownerUserId, userId),
		columns: { id: true, gitPath: true, traits: true, defaultBranch: true },
	});
	return rows.find((row) => (row.traits ?? []).includes(TUTORIAL_TRAIT));
}

async function writeSandboxFiles(gitPath: string, paths: readonly string[]): Promise<void> {
	const byPath = new Map(TUTORIAL_SANDBOX_FILES.map((file) => [file.path, file]));
	for (const path of paths) {
		const file = byPath.get(path);
		// A commit naming an unseeded path is a data bug caught by the guard test;
		// skipping here keeps provisioning from writing an empty file in that case.
		if (!file) continue;
		const target = resolve(gitPath, file.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, file.content, "utf-8");
	}
}

/**
 * Ensure the sandbox repository, project row and root chapter all exist.
 *
 * Idempotent, and tolerant of the two states a user can create by hand:
 *  - the project row exists but the directory was deleted → the repository is
 *    rebuilt in place (the row and its chapters stay valid);
 *  - the project row was deleted → a fresh sandbox is provisioned.
 */
export async function ensureSandbox(userId: string): Promise<TutorialSandbox> {
	return sandboxLock.acquire(userId, async () => {
		const gitPath = tutorialSandboxPath(userId);
		const existing = await findSandboxProject(userId);

		if (existing) {
			// The row survives a deleted directory, so repair rather than re-provision:
			// re-creating the project would orphan the chapters that point at it.
			if (!(await isUsableRepository(gitPath))) {
				logger.info("Rebuilding missing tutorial sandbox repository", { userId, gitPath });
				await provisionRepository(gitPath, userId);
			}
			const chapter = await findSandboxChapter(existing.id);
			if (chapter) {
				return { projectId: existing.id, chapterId: chapter.id, gitPath };
			}
			// A project without its root chapter cannot host a chapter lesson; recreate
			// just the chapter.
			const created = await chapterService.createRootChapter({
				projectId: existing.id,
				title: "Tutorial",
				gitPath,
				defaultBranch: existing.defaultBranch ?? "main",
				createdByUserId: userId,
			});
			return { projectId: existing.id, chapterId: created.id, gitPath };
		}

		await provisionRepository(gitPath, userId);
		const defaultBranch = (await gitService.getCurrentBranch(gitPath)) ?? "main";
		const now = new Date().toISOString();
		const projectId = generateId();

		await db.insert(projects).values({
			id: projectId,
			name: "Tutorial sandbox",
			description: "Created by the NarraFork interactive tutorial. Safe to delete.",
			gitPath,
			defaultBranch,
			ownerUserId: userId,
			traits: [TUTORIAL_TRAIT],
			// The root chapter would otherwise auto-create a narrator on
			// `settings.agent.defaultModel` — a REAL model, billed, with no scripted
			// turns to play. Lesson narrators are created explicitly instead.
			chapterSettings: { autoCreateNarrator: false },
			createdAt: now,
			updatedAt: now,
		});

		const chapter = await chapterService.createRootChapter({
			projectId,
			title: "Tutorial",
			gitPath,
			defaultBranch,
			createdByUserId: userId,
		});

		logger.info("Tutorial sandbox provisioned", { userId, projectId, gitPath });
		return { projectId, chapterId: chapter.id, gitPath };
	});
}

/**
 * Whether `gitPath` is a directory that currently holds a usable repository.
 *
 * The existence check is not redundant with `isGitRepo`. `isGitRepo` spawns git
 * with `cwd: gitPath`, and `Bun.spawn` on a missing cwd throws an ENOENT that
 * `lib/spawn.ts` translates into `Command "git" not found` — so a user who deleted
 * the sandbox directory would get "git is not installed" instead of a rebuild.
 * The deleted-directory case is the whole reason this repair path exists, so it
 * has to be the one case it handles correctly.
 */
async function isUsableRepository(gitPath: string): Promise<boolean> {
	if (!existsSync(gitPath)) return false;
	return gitService.isGitRepo(gitPath);
}

/**
 * Create the repository and replay the seeded history.
 *
 * Several commits rather than one because the NarraFlow lessons are *about*
 * history: a graph with a single node, or a fork whose only ancestor is "Initial
 * commit", demonstrates the mechanism without showing why anyone would want it.
 *
 * The last commit leaves the tree clean. A dirty worktree after provisioning would
 * make the first chapter lesson open on uncommitted changes the user never made,
 * which reads as a product bug rather than a lesson.
 */
async function provisionRepository(gitPath: string, userId: string): Promise<void> {
	const identity = await resolveUserGitIdentityEnv(userId);
	await gitService.initRepo(gitPath, identity ?? undefined);
	for (const commit of TUTORIAL_SANDBOX_COMMITS) {
		await writeSandboxFiles(gitPath, commit.paths);
		await gitService.stageAndCommit(
			gitPath,
			[...commit.paths],
			commit.message,
			identity ?? undefined,
		);
	}
}

async function findSandboxChapter(projectId: string) {
	return db.query.chapters.findFirst({
		where: and(eq(chapters.projectId, projectId), eq(chapters.isRoot, 1)),
		columns: { id: true, worktreePath: true },
	});
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

/**
 * Traits pinning every subagent pool to the scripted model.
 *
 * A grant, not a ban: `resolveSubagentModelFromPolicy` filters the candidate chain
 * against this pool, so a configured `settings.agent.subagentModels.explore`
 * simply fails to match and the pool's only member wins. Layer merging can only
 * narrow a pool further, never widen it, so the project/user layers cannot
 * reintroduce a real model.
 */
export function tutorialSubagentTraits(
	baseTraits: string[],
	lesson: { lessonId: string; locale: string },
): string[] {
	const pools: Record<string, Array<{ model: string; purpose?: string }>> = {};
	for (const key of SUBAGENT_POOL_KEYS) {
		// A DISTINCT model value per type, not one shared value. The subagent's type
		// is not otherwise visible to the provider, and the pool is looked up per
		// type — so this is what lets an `explore` agent play a read-only script while
		// a `general` agent plays a writing one. Using one value for all types would
		// still lock the models correctly, but every subagent would recite the same
		// lines, teaching that the type distinction is cosmetic when it is not.
		pools[key] = [
			{
				model: tutorialModelForSubagent(lesson.lessonId, lesson.locale, key),
				purpose: "Tutorial: scripted, never calls an API",
			},
		];
	}
	return upsertEncodedTrait(baseTraits, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, {
		version: 1,
		pools,
	});
}

/**
 * Create the narrator for a lesson and return where the UI should mount it.
 *
 * Each call creates a FRESH narrator rather than reusing one: a lesson replays a
 * script from turn 0, and the turn index is derived from conversation history, so
 * a reused session would resume mid-script with no way back.
 */
export async function startLesson(input: {
	userId: string;
	lessonId: string;
	locale: Locale;
}): Promise<TutorialLessonSession> {
	const lesson = getTutorialLesson(input.lessonId, input.locale);
	if (!lesson) throw new NotFoundError("Tutorial lesson", input.lessonId);

	const needsProject = lesson.needs.project === true || lesson.needs.narrator === "chapter";
	const sandbox = needsProject ? await ensureSandbox(input.userId) : null;
	const model = tutorialModelForLesson(lesson.id, input.locale);

	const narrator = await narratorService.create({
		chapterId: lesson.needs.narrator === "chapter" ? sandbox?.chapterId : null,
		type: "primary",
		model,
		// A non-empty title suppresses title generation, which would otherwise run on
		// `settings.agent.summaryModel` — a real model the tutorial model cannot
		// redirect. See the module header.
		title: lesson.title,
		// Permission cards are a lesson, not an obstacle: never bypass them.
		permissionMode: "default",
		cwd: sandbox?.gitPath,
		ownerUserId: input.userId,
		extraTraits: [],
	});

	// Written after creation because `CreateNarratorInput.extraTraits` only accepts
	// the bare `NarratorTrait` tags, not the encoded custom-trait payloads.
	const traits = tutorialSubagentTraits([...(narrator.traits ?? []), TUTORIAL_TRAIT], {
		lessonId: lesson.id,
		locale: input.locale,
	});
	await db
		.update(narrators)
		.set({ traits, updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, narrator.id));

	logger.info("Tutorial lesson started", {
		userId: input.userId,
		lessonId: lesson.id,
		narratorId: narrator.id,
	});

	return {
		lessonId: lesson.id,
		narratorId: narrator.id,
		projectId: sandbox?.projectId ?? null,
		chapterId: lesson.needs.narrator === "chapter" ? (sandbox?.chapterId ?? null) : null,
	};
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function parseProgress(raw: string | null | undefined): TutorialProgressMap {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const result: TutorialProgressMap = {};
		for (const [lessonId, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			const entry = value as { completedStepIds?: unknown; completedAt?: unknown };
			const steps = Array.isArray(entry.completedStepIds)
				? entry.completedStepIds.filter((id): id is string => typeof id === "string")
				: [];
			result[lessonId] = {
				completedStepIds: steps,
				...(typeof entry.completedAt === "string" ? { completedAt: entry.completedAt } : {}),
			};
		}
		return result;
	} catch {
		// A corrupt blob loses progress, which is a learning record, not data the
		// user cannot recreate. Failing the whole tutorial page over it would be worse.
		return {};
	}
}

export async function getProgress(userId: string): Promise<TutorialProgressMap> {
	const pref = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
		columns: { tutorialProgress: true },
	});
	return parseProgress(pref?.tutorialProgress);
}

/**
 * Record completed steps for a lesson.
 *
 * Additive: steps are unioned with what is already stored, so replaying a lesson
 * cannot un-complete it, and two tabs reporting different steps cannot clobber
 * each other.
 */
export async function recordProgress(input: {
	userId: string;
	lessonId: string;
	completedStepIds: string[];
	completed?: boolean;
}): Promise<TutorialProgressMap> {
	const lesson = getTutorialLesson(input.lessonId);
	if (!lesson) throw new NotFoundError("Tutorial lesson", input.lessonId);

	const knownStepIds = new Set(lesson.steps.map((step) => step.id));
	const unknown = input.completedStepIds.filter((id) => !knownStepIds.has(id));
	if (unknown.length > 0) {
		throw new ValidationError(`Unknown step id(s) for ${input.lessonId}: ${unknown.join(", ")}`);
	}

	// The shared per-user preferences lock, not a private one: `tutorialProgress`
	// lives in the same row as every other preference, and the general PATCH does
	// its own read-modify-write. Two independent locks would let one overwrite the
	// other's column.
	return userPreferencesLock.acquire(input.userId, async () => {
		const current = await getProgress(input.userId);
		const existing = current[input.lessonId];
		const merged = new Set([...(existing?.completedStepIds ?? []), ...input.completedStepIds]);
		const allDone = lesson.steps.every((step) => merged.has(step.id));
		const next: TutorialProgressMap = {
			...current,
			[input.lessonId]: {
				completedStepIds: [...merged],
				...(allDone || input.completed
					? { completedAt: existing?.completedAt ?? new Date().toISOString() }
					: {}),
			},
		};
		await writeProgress(input.userId, next);
		return next;
	});
}

/** Drop a lesson's progress so it can be replayed from the first step. */
export async function resetLessonProgress(
	userId: string,
	lessonId: string,
): Promise<TutorialProgressMap> {
	return userPreferencesLock.acquire(userId, async () => {
		const current = await getProgress(userId);
		const { [lessonId]: _removed, ...rest } = current;
		await writeProgress(userId, rest);
		return rest;
	});
}

async function writeProgress(userId: string, progress: TutorialProgressMap): Promise<void> {
	const serialized = JSON.stringify(progress);
	const now = new Date().toISOString();
	const existing = await db.query.userPreferences.findFirst({
		where: eq(userPreferences.userId, userId),
		columns: { id: true },
	});
	if (existing) {
		await db
			.update(userPreferences)
			.set({ tutorialProgress: serialized, updatedAt: now })
			.where(eq(userPreferences.userId, userId));
		return;
	}
	await db.insert(userPreferences).values({
		id: generateId(),
		userId,
		tutorialProgress: serialized,
		createdAt: now,
		updatedAt: now,
	});
}

/** Whether this user currently has a provisioned sandbox. */
export async function getSandboxStatus(
	userId: string,
): Promise<{ exists: boolean; projectId: string | null; gitPath: string }> {
	const gitPath = tutorialSandboxPath(userId);
	const project = await findSandboxProject(userId);
	return {
		exists: !!project && existsSync(gitPath),
		projectId: project?.id ?? null,
		gitPath,
	};
}
