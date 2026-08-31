/**
 * Interactive tutorial API.
 *
 * Authentication is inherited: `app.ts` gates all of `/api/*` behind
 * `requireSessionAuth`, and every handler here scopes its work to
 * `c.get("user").sub`. The tutorial sandbox is per-user, so there is no path that
 * takes a user id from the request.
 *
 * Deliberately no admin gate: learning to use the product is not privileged, and
 * the sandbox only ever touches NarraFork's own data directory.
 */

import {
	getTutorialLesson,
	getTutorialLessonSummaries,
	TUTORIAL_TRACKS,
} from "@shared/tutorial/lessons";
import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { getUserLanguage } from "../lib/i18n";
import { logger } from "../lib/logger";
import { tutorialIdSchema, tutorialProgressSchema } from "../lib/validators";
import {
	getLessonSession,
	getProgress,
	getSandboxStatus,
	recordProgress,
	resetLessonProgress,
	startLesson,
} from "../services/tutorial-service";

export const tutorialRoutes = new Hono();

/** Reject a malformed id before it reaches a lookup. */
function requireLessonId(raw: string): string {
	const parsed = tutorialIdSchema.safeParse(raw);
	if (!parsed.success) throw new ValidationError(`Invalid lesson id: ${raw}`);
	return parsed.data;
}

/** Catalog + this user's progress + whether the sandbox is already provisioned. */
tutorialRoutes.get("/", async (c) => {
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const [progress, sandbox] = await Promise.all([getProgress(userId), getSandboxStatus(userId)]);
	return c.json({
		tracks: TUTORIAL_TRACKS,
		lessons: getTutorialLessonSummaries(locale),
		progress,
		sandbox: { exists: sandbox.exists, projectId: sandbox.projectId },
	});
});

tutorialRoutes.get("/:lessonId", async (c) => {
	const userId = c.get("user").sub;
	const locale = await getUserLanguage(userId);
	const lessonId = requireLessonId(c.req.param("lessonId"));
	const lesson = getTutorialLesson(lessonId, locale);
	if (!lesson) return c.json({ error: "Tutorial lesson not found" }, 404);
	const progress = await getProgress(userId);
	// The session the lesson would CONTINUE, if one exists. Included here rather than
	// behind a second request because the page needs it to decide what to render at
	// all: without it a returning user sees a start screen, and starting again writes
	// a new lesson boundary that rewinds the script they were halfway through.
	const session = await getLessonSession({ userId, lessonId, locale });
	return c.json({ lesson, progress: progress[lessonId] ?? null, session });
});

/**
 * Provision what the lesson needs and return where to mount it.
 *
 * Synchronous rather than SSE: the sandbox is a local `git init` plus one commit
 * of four small files, which is far cheaper than the clone path that justified
 * streaming in `projects.ts`. The slow-path log below is what would tell us if
 * that assumption ever stopped holding.
 */
tutorialRoutes.post("/:lessonId/start", async (c) => {
	const userId = c.get("user").sub;
	const lessonId = requireLessonId(c.req.param("lessonId"));
	const locale = await getUserLanguage(userId);

	const startedAt = Date.now();
	const session = await startLesson({ userId, lessonId, locale });
	const elapsedMs = Date.now() - startedAt;
	// Provisioning runs git in a subprocess on the request path. If it ever grows
	// past a couple of seconds this endpoint needs to become streaming, so make the
	// cost visible instead of waiting for a user to report a hang.
	if (elapsedMs > 2000) {
		logger.warn("Tutorial lesson start was slow", { userId, lessonId, elapsedMs });
	}

	return c.json(session, 201);
});

tutorialRoutes.patch("/:lessonId/progress", async (c) => {
	const userId = c.get("user").sub;
	const lessonId = requireLessonId(c.req.param("lessonId"));
	const body = await c.req.json().catch(() => ({}));
	const parsed = tutorialProgressSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const progress = await recordProgress({
		userId,
		lessonId,
		completedStepIds: parsed.data.completedStepIds,
		...(parsed.data.completed !== undefined ? { completed: parsed.data.completed } : {}),
	});
	return c.json({ ok: true, progress: progress[lessonId] ?? null });
});

/**
 * Forget a lesson's progress.
 *
 * Only the progress record: the narrators the lesson created are left alone. They
 * are ordinary narrators the user may still want to read, and deleting sessions
 * as a side effect of "let me try that again" would destroy work the user never
 * asked to lose. Replaying simply creates a new narrator.
 */
tutorialRoutes.post("/:lessonId/reset", async (c) => {
	const userId = c.get("user").sub;
	const lessonId = requireLessonId(c.req.param("lessonId"));
	await resetLessonProgress(userId, lessonId);
	return c.json({ ok: true });
});

/**
 * Where the sandbox lives, so the UI can tell the user what deleting it removes.
 *
 * Deletion itself is deliberately NOT here: it would mean a second, thinner
 * implementation of project teardown (worktrees, containers, port allocations,
 * tree snapshots) that would drift from `DELETE /api/projects/:id`. The UI links
 * to the real project deletion instead, and `ensureSandbox` rebuilds on the next
 * lesson start.
 */
tutorialRoutes.get("/sandbox/status", async (c) => {
	const userId = c.get("user").sub;
	const status = await getSandboxStatus(userId);
	return c.json(status);
});
