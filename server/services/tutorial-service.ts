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
import {
	getTutorialLesson,
	TUTORIAL_LESSON_BOUNDARY_BLOCK,
	TUTORIAL_PROVIDER_PREFIX,
	TUTORIAL_TRAIT,
	tutorialLessonBoundaryText,
} from "@shared/tutorial/lessons";
import { TUTORIAL_SANDBOX_COMMITS, TUTORIAL_SANDBOX_FILES } from "@shared/tutorial/sandbox-files";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects, userPreferences } from "../db/schema";
import {
	parseTutorialModel,
	tutorialModelForLesson,
	tutorialModelForSubagent,
} from "../lib/agent/tutorial-provider";
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
import { deliverInjection } from "./narrator-injection";
import { narratorService } from "./narrator-service";
import { interruptAndWaitForIdle } from "./narrator-session";

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
 * Serialises lesson starts per user.
 *
 * Two lessons launched at once would both find no tutorial narrator for the slot
 * and both create one — and for the chapter slot the second insert then hits the
 * "one primary narrator per chapter" rule, so the user is told a lesson cannot
 * start for a reason that has nothing to do with the lesson.
 */
const lessonLock = new AsyncMutex();

/** Whether this narrator is a live tutorial session for the given slot. */
function isReusableTutorialNarrator(row: {
	status: string;
	traits: string[] | null;
	model: string | null;
}): boolean {
	if (row.status === "archived") return false;
	if (!(row.traits ?? []).includes(TUTORIAL_TRAIT)) return false;
	// A narrator whose model no longer routes to the scripted provider must not be
	// reused: pointing a real model at a tutorial session is exactly the silent
	// billing this module exists to prevent.
	return (row.model ?? "").startsWith(`${TUTORIAL_PROVIDER_PREFIX}:`);
}

/**
 * The user's existing tutorial narrator for a slot, if any.
 *
 * Two slots, not one: a `chapter` lesson needs a narrator bound to the sandbox
 * worktree (its tools must operate on real files), while a `standalone` lesson has
 * no chapter at all. Sharing one row across both would mean either giving the
 * standalone lesson a worktree it does not need or unbinding the chapter one.
 */
async function findLessonNarrator(
	userId: string,
	slot: { chapterId: string | null },
): Promise<{ id: string; traits: string[] | null; model: string | null } | undefined> {
	const rows = await db.query.narrators.findMany({
		where: and(
			eq(narrators.ownerUserId, userId),
			eq(narrators.variant, "primary"),
			slot.chapterId === null
				? isNull(narrators.chapterId)
				: eq(narrators.chapterId, slot.chapterId),
		),
		columns: { id: true, traits: true, status: true, model: true, createdAt: true },
	});
	// Newest first: if an older run left more than one behind (a chapter that was
	// recreated, a pre-reuse install), continue the most recent session rather than
	// resurrecting the oldest.
	const usable = rows
		.filter((row) => isReusableTutorialNarrator(row))
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
	return usable[0];
}

/**
 * Start a lesson on the user's tutorial narrator, creating it only if needed.
 *
 * REUSED rather than freshly created per lesson. Two reasons, and the first one is
 * a hard failure:
 *
 *  1. A chapter may hold only ONE primary narrator (`prepareNarratorCreation`), so
 *     creating one per lesson made the second chapter-bound lesson fail outright
 *     with "Chapter already has a primary narrator" — every lesson after
 *     `tool-calls` was unreachable.
 *  2. A course with no continuity teaches worse. The narrator is the thing the
 *     tutorial is teaching the user to work with; a new one per lesson contradicts
 *     the lesson that a narrator is a durable session, and the user cannot scroll
 *     back to what they just learned.
 *
 * The script still plays from turn 0 because a lesson boundary row is written
 * first and `scriptTurnIndex` counts only from there.
 */
export async function startLesson(input: {
	userId: string;
	lessonId: string;
	locale: Locale;
}): Promise<TutorialLessonSession> {
	const lesson = getTutorialLesson(input.lessonId, input.locale);
	if (!lesson) throw new NotFoundError("Tutorial lesson", input.lessonId);

	return lessonLock.acquire(input.userId, async () => {
		const needsProject = lesson.needs.project === true || lesson.needs.narrator === "chapter";
		const sandbox = needsProject ? await ensureSandbox(input.userId) : null;
		const chapterId = lesson.needs.narrator === "chapter" ? (sandbox?.chapterId ?? null) : null;
		const model = tutorialModelForLesson(lesson.id, input.locale);
		const now = new Date().toISOString();

		const existing = await findLessonNarrator(input.userId, { chapterId });
		const narratorId = existing
			? await continueLessonNarrator(existing, { model, cwd: sandbox?.gitPath ?? null, now })
			: await createLessonNarrator({ ...input, lesson, chapterId, model, sandbox });

		// Traits carry the per-type subagent model pools, which name the LESSON — so
		// they are rewritten on every start, not only at creation. A reused narrator
		// still holding the previous lesson's pools would send this lesson's subagents
		// to the wrong script (and, once a lesson id is dropped, to no script at all).
		//
		// The baseline is read back from the row rather than taken from `existing`, which
		// is undefined on the create path. Using it there reduced the baseline to
		// `[TUTORIAL_TRAIT]`, and since this is a whole-column write it erased what
		// `createNarrator` had just stored — including `standalone`, which every
		// chapter-less narrator must carry (there is a startup backfill in `db/index.ts`
		// enforcing exactly that, so a tutorial narrator became a standing violation of
		// it, silently reclassified as chapter-bound until the next restart) and `plan`
		// when `defaultStartInPlanMode` is on.
		const current = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { traits: true },
		});
		const traits = tutorialSubagentTraits(
			[...((current?.traits ?? []) as string[]), TUTORIAL_TRAIT],
			{ lessonId: lesson.id, locale: input.locale },
		);
		await db
			.update(narrators)
			.set({ traits: dedupeTraits(traits), updatedAt: now })
			.where(eq(narrators.id, narratorId));

		// Written AFTER the traits/model update so the row the provider reads first is
		// already the one this lesson expects.
		await writeLessonBoundary(narratorId, lesson.id, lesson.title, input.locale);

		logger.info("Tutorial lesson started", {
			userId: input.userId,
			lessonId: lesson.id,
			narratorId,
			reused: !!existing,
		});

		return {
			lessonId: lesson.id,
			narratorId,
			projectId: sandbox?.projectId ?? null,
			chapterId,
		};
	});
}

/** Traits are a set; the pool encoder preserves order, so dedupe keeps it stable. */
function dedupeTraits(traits: string[]): string[] {
	return [...new Set(traits)];
}

/**
 * Point an existing tutorial narrator at this lesson.
 *
 * Interrupted first: the previous lesson may have been left mid-turn (the user
 * clicked "next lesson" while a scripted turn was streaming), and a loop that is
 * still running holds the OLD model in memory — it would keep playing the previous
 * script and then write its turns after this lesson's boundary row, which is the
 * one thing the turn counter cannot recover from.
 */
async function continueLessonNarrator(
	existing: { id: string },
	update: { model: string; cwd: string | null; now: string },
): Promise<string> {
	await interruptAndWaitForIdle(existing.id);
	await db
		.update(narrators)
		.set({
			model: update.model,
			// A chapter lesson's tools must land in the sandbox worktree. Only set when
			// known: a standalone lesson has no path to offer and must not blank the one
			// a previous lesson established.
			...(update.cwd ? { cwd: update.cwd } : {}),
			// Permission cards are a lesson, not an obstacle. A user who switched this
			// session to bypassPermissions during an earlier lesson would otherwise never
			// see the approval card the permissions lesson is entirely about.
			permissionMode: "default",
			// Plan mode is entered by one lesson and must not leak into the next: a
			// narrator still in plan mode would refuse the writes a later script performs,
			// which reads as the tutorial being broken.
			planMode: false,
			previousPermissionMode: null,
			planFileId: null,
			status: "idle",
			errorMessage: null,
			updatedAt: update.now,
		})
		.where(eq(narrators.id, existing.id));
	return existing.id;
}

async function createLessonNarrator(input: {
	userId: string;
	locale: Locale;
	lesson: { id: string; title: string };
	chapterId: string | null;
	model: string;
	sandbox: TutorialSandbox | null;
}): Promise<string> {
	const narrator = await narratorService.create({
		chapterId: input.chapterId,
		type: "primary",
		model: input.model,
		// A non-empty title suppresses title generation, which would otherwise run on
		// `settings.agent.summaryModel` — a real model the tutorial model cannot
		// redirect. See the module header.
		title: input.lesson.title,
		// Permission cards are a lesson, not an obstacle: never bypass them.
		permissionMode: "default",
		cwd: input.sandbox?.gitPath,
		ownerUserId: input.userId,
		extraTraits: [],
	});
	return narrator.id;
}

/**
 * Mark where this lesson begins in the narrator's conversation.
 *
 * Load-bearing for the reuse: `scriptTurnIndex` counts assistant turns only after
 * the latest boundary, so this row is what makes a reused session still play the
 * new lesson from turn 0. Missing it produces no error — the lesson simply answers
 * with its "this script is finished" fallback line.
 *
 * `role: "sys"` so the model sees it as a system fact rather than something the
 * user said, and `schedule: "none"` so writing it never starts a turn: the user
 * has not asked for anything yet.
 */
async function writeLessonBoundary(
	narratorId: string,
	lessonId: string,
	lessonTitle: string,
	locale: Locale,
): Promise<void> {
	await deliverInjection(narratorId, {
		content: tutorialLessonBoundaryText(lessonTitle, locale),
		source: TUTORIAL_LESSON_BOUNDARY_SOURCE,
		role: "sys",
		schedule: "none",
		locale,
		extraBlocks: [{ type: TUTORIAL_LESSON_BOUNDARY_BLOCK, lessonId, lessonTitle }],
	});
}

/** Producer tag for the boundary row. */
const TUTORIAL_LESSON_BOUNDARY_SOURCE = "tutorial_lesson";

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

/**
 * The narrator a lesson would continue, without starting anything.
 *
 * The page needs this to show the ONGOING conversation when the user comes back to
 * a lesson (or reloads mid-lesson) instead of a start screen. Without it the reuse
 * is invisible: the session exists on the server, but the UI still asks the user to
 * begin and only learns the narrator id from a start call — which would write
 * another boundary row and rewind the script the user was halfway through.
 *
 * Deliberately read-only: it never provisions the sandbox and never creates a
 * narrator, so merely opening a lesson page still costs nothing.
 */
export async function getLessonSession(input: {
	userId: string;
	lessonId: string;
	locale: Locale;
}): Promise<TutorialLessonSession | null> {
	const lesson = getTutorialLesson(input.lessonId, input.locale);
	if (!lesson) throw new NotFoundError("Tutorial lesson", input.lessonId);

	const project = await findSandboxProject(input.userId);
	const wantsChapter = lesson.needs.narrator === "chapter";
	// No sandbox yet means no chapter-bound narrator can exist. Returning here also
	// avoids a chapter lookup for a project that was deleted.
	if (wantsChapter && !project) return null;

	const chapter = wantsChapter && project ? await findSandboxChapter(project.id) : null;
	if (wantsChapter && !chapter) return null;

	const existing = await findLessonNarrator(input.userId, {
		chapterId: wantsChapter ? (chapter?.id ?? null) : null,
	});
	if (!existing) return null;

	// The slot's narrator serves EVERY lesson in that slot, so its mere existence does
	// not mean THIS lesson was started. Reporting it anyway would auto-mount a session
	// for a lesson the user never began — and with no boundary row for it, the script
	// would answer with its "this lesson is finished" fallback line before the user
	// sent anything. The model value is the record of which lesson it is on.
	if (parseTutorialModel(existing.model ?? "").lessonId !== lesson.id) return null;

	return {
		lessonId: lesson.id,
		narratorId: existing.id,
		projectId: project?.id ?? null,
		chapterId: wantsChapter ? (chapter?.id ?? null) : null,
	};
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
