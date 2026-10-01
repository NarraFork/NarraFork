import { DEFAULT_LOCALE, type Locale } from "@shared/i18n-locales";
import { formatOriginLabel } from "@shared/message-origin";
import type { ScheduledTaskCleanupPolicy } from "@shared/scheduled-task-cleanup";
import { and, asc, desc, eq, lt, lte } from "drizzle-orm";
import { db } from "../db";
import { narrators, scheduledTaskRuns, scheduledTasks, users } from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
import { nextCronRun } from "../lib/cron";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getHome } from "../lib/platform";
import { chapterCleanup } from "./chapter-cleanup";
import { canWriteNarrator, type NarratorPrincipal } from "./narrator-acl";
import { narratorService } from "./narrator-service";
import { isLoopRunning, sendMessage } from "./narrator-session";
import { cleanupScheduledTaskNarrators } from "./scheduled-task-cleanup";

type ScheduledTask = typeof scheduledTasks.$inferSelect;
type ScheduledTaskRun = typeof scheduledTaskRuns.$inferSelect;

/** Max run-history rows returned in a single page. */
const RUNS_PAGE_MAX = 200;
const RUNS_PAGE_DEFAULT = 50;

/**
 * Ceiling on rows one `list()` returns.
 *
 * Tasks are created by people in the UI and by the `ScheduledTask` tool, so the row
 * count is not bounded by anything a human curates — a model in a retry loop can add
 * rows as fast as it can call the tool. An unbounded `findMany` on the request path is
 * what the repo's main-thread rule forbids, and the tool then serialises whatever comes
 * back straight into the model's context, where the cost is paid a second time.
 *
 * Deliberately high: this is a safety ceiling, not a paging window. Nobody legitimately
 * schedules 500 tasks, so a truncated list means something is wrong — hence the
 * `truncated` flag rather than a silent slice, so a caller can say so instead of
 * presenting a partial list as complete.
 */
const LIST_MAX = 500;

export interface CreateScheduledTaskInput {
	name: string;
	cronExpr: string;
	timezone?: string | null;
	prompt: string;
	systemPrompt?: string | null;
	model?: string | null;
	permissionMode?: string;
	locale?: Locale;
	runContext?: "standalone" | "chapter";
	cwd?: string | null;
	projectId?: string | null;
	chapterId?: string | null;
	narratorMode?: "new" | "reuse";
	cleanupPolicy?: ScheduledTaskCleanupPolicy;
	enabled?: boolean;
	createdBy?: string | null;
}

export type UpdateScheduledTaskInput = Partial<Omit<CreateScheduledTaskInput, "createdBy">>;

// Per-task mutex prevents a slow run from overlapping with the next tick.
const runLock = new AsyncMutex();

/**
 * In-memory consecutive failure counter per task, for circuit-breaking.
 *
 * After {@link CIRCUIT_BREAKER_THRESHOLD} consecutive failures a task is
 * automatically disabled to prevent infinite retry noise (e.g. deleted
 * chapter, broken config). The counter resets on success or process restart.
 * An in-memory approach was chosen over a schema column because:
 *  - no migration required for a defensive heuristic,
 *  - a process restart naturally resets the breaker (giving the task another
 *    chance after a deployment/fix), and
 *  - the counter is never exposed to clients — only the `enabled` flag matters.
 */
const consecutiveFailures = new Map<string, number>();
const CIRCUIT_BREAKER_THRESHOLD = 5;

function now(): string {
	return new Date().toISOString();
}

/**
 * The ACL principal a task runs as: its creator, with the creator's LIVE role.
 *
 * The role is read from `users` rather than assumed, because `isAdmin: false` is not a
 * neutral default here — it is a claim that the creator is not an administrator. An
 * admin-created task was therefore judged as a plain user against its own narrator, and
 * on a session with no owner (every narrator that predates access control has
 * `owner_user_id = NULL`) there was nothing left to pass: not owner, not the write
 * audience, no explicit grant. The run reported "creator no longer has write access" to
 * the very person who could drive that session by hand in the UI, which is why the
 * message reads as a lie rather than as a permission problem.
 *
 * Live rather than snapshotted at creation time, matching `chat-service`'s
 * `resolvePrincipal` and the auth middleware: a demotion has to reach the scheduler on
 * the next tick, not whenever the task is next edited.
 *
 * A task with no `createdBy` (created before the column, or whose user was deleted)
 * resolves to the empty id and no admin flag. That is the fail-closed direction: it
 * matches no owner and no grant, so such a task can only reuse a session that is
 * genuinely open to everyone, and otherwise gets a fresh narrator of its own.
 */
async function principalForTask(task: ScheduledTask): Promise<NarratorPrincipal> {
	const userId = task.createdBy ?? "";
	if (!userId) return { userId: "", isAdmin: false };
	const user = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { role: true },
	});
	return { userId, isAdmin: user?.role === "admin" };
}

export const scheduledTaskService = {
	/**
	 * Every task, up to {@link LIST_MAX}.
	 *
	 * `truncated` reports whether rows were left behind, which is the part callers must
	 * not drop: a list that is silently short reads as "these are all the tasks", and
	 * the thing it hides is a schedule the user believes is armed.
	 */
	async list(): Promise<{ tasks: ScheduledTask[]; truncated: boolean }> {
		// `LIMIT n + 1` rather than a separate COUNT: one extra row answers "is there
		// more" without a second scan of the table.
		const rows = await db.query.scheduledTasks.findMany({
			orderBy: (t) => [asc(t.createdAt)],
			limit: LIST_MAX + 1,
		});
		if (rows.length > LIST_MAX) {
			logger.warn("scheduled task list truncated", { limit: LIST_MAX });
			return { tasks: rows.slice(0, LIST_MAX), truncated: true };
		}
		return { tasks: rows, truncated: false };
	},

	async get(id: string): Promise<ScheduledTask | undefined> {
		return db.query.scheduledTasks.findFirst({ where: eq(scheduledTasks.id, id) });
	},

	async create(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
		const runContext = input.runContext ?? "standalone";
		if (runContext === "chapter" && (!input.projectId || !input.chapterId)) {
			throw new ValidationError("chapter runContext requires projectId and chapterId");
		}
		const nextRunAt = nextCronRun(input.cronExpr, input.timezone);
		if (!nextRunAt) throw new ValidationError("Invalid cron expression");

		const ts = now();
		const row: ScheduledTask = {
			id: generateId(),
			name: input.name,
			enabled: input.enabled ?? true,
			cronExpr: input.cronExpr,
			timezone: input.timezone ?? null,
			prompt: input.prompt,
			systemPrompt: input.systemPrompt ?? null,
			model: input.model ?? null,
			permissionMode: input.permissionMode ?? "bypassPermissions",
			locale: input.locale ?? DEFAULT_LOCALE,
			runContext,
			cwd: input.cwd ?? null,
			projectId: input.projectId ?? null,
			chapterId: input.chapterId ?? null,
			narratorMode: input.narratorMode ?? "new",
			cleanupPolicy: input.cleanupPolicy ?? { mode: "none" },
			reuseNarratorId: null,
			createdBy: input.createdBy ?? null,
			lastRunAt: null,
			nextRunAt: input.enabled === false ? null : nextRunAt,
			lastNarratorId: null,
			lastStatus: null,
			lastError: null,
			createdAt: ts,
			updatedAt: ts,
		};
		await db.insert(scheduledTasks).values(row);
		return row;
	},

	async update(id: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
		const existing = await this.get(id);
		if (!existing) throw new NotFoundError("ScheduledTask", id);

		const runContext = input.runContext ?? existing.runContext;
		const projectId = input.projectId !== undefined ? input.projectId : existing.projectId;
		const chapterId = input.chapterId !== undefined ? input.chapterId : existing.chapterId;
		if (runContext === "chapter" && (!projectId || !chapterId)) {
			throw new ValidationError("chapter runContext requires projectId and chapterId");
		}

		const cronExpr = input.cronExpr ?? existing.cronExpr;
		const timezone = input.timezone !== undefined ? input.timezone : existing.timezone;
		const enabled = input.enabled ?? existing.enabled;

		// Recompute nextRunAt whenever schedule or enabled state changes.
		let nextRunAt = existing.nextRunAt;
		if (
			input.cronExpr !== undefined ||
			input.timezone !== undefined ||
			input.enabled !== undefined
		) {
			if (!enabled) {
				nextRunAt = null;
			} else {
				const computed = nextCronRun(cronExpr, timezone);
				if (!computed) throw new ValidationError("Invalid cron expression");
				nextRunAt = computed;
			}
		}

		const patch: Partial<ScheduledTask> = {
			...(input.name !== undefined && { name: input.name }),
			...(input.cronExpr !== undefined && { cronExpr: input.cronExpr }),
			...(input.timezone !== undefined && { timezone: input.timezone }),
			...(input.prompt !== undefined && { prompt: input.prompt }),
			...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
			...(input.model !== undefined && { model: input.model }),
			...(input.permissionMode !== undefined && { permissionMode: input.permissionMode }),
			...(input.locale !== undefined && { locale: input.locale }),
			...(input.runContext !== undefined && { runContext: input.runContext }),
			...(input.cwd !== undefined && { cwd: input.cwd }),
			...(input.projectId !== undefined && { projectId: input.projectId }),
			...(input.chapterId !== undefined && { chapterId: input.chapterId }),
			...(input.narratorMode !== undefined && { narratorMode: input.narratorMode }),
			...(input.cleanupPolicy !== undefined && { cleanupPolicy: input.cleanupPolicy }),
			...(input.enabled !== undefined && { enabled: input.enabled }),
			nextRunAt,
			updatedAt: now(),
		};
		await db.update(scheduledTasks).set(patch).where(eq(scheduledTasks.id, id));
		const updated = await this.get(id);
		if (!updated) throw new NotFoundError("ScheduledTask", id);
		return updated;
	},

	async setEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
		return this.update(id, { enabled });
	},

	async delete(id: string): Promise<void> {
		const existing = await this.get(id);
		if (!existing) throw new NotFoundError("ScheduledTask", id);
		// Explicit detach also covers SQLite ALTER ADD REFERENCES migrations whose
		// generator omits ON DELETE SET NULL. Deleting a task never deletes sessions.
		db.transaction((tx) => {
			tx.update(narrators)
				.set({ scheduledTaskId: null })
				.where(eq(narrators.scheduledTaskId, id))
				.run();
			tx.delete(scheduledTasks).where(eq(scheduledTasks.id, id)).run();
		});
	},

	/** Tasks that are enabled and due (nextRunAt <= now). */
	async listDue(at: Date = new Date()): Promise<ScheduledTask[]> {
		return db.query.scheduledTasks.findMany({
			where: and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, at.toISOString())),
		});
	},

	/**
	 * Re-arm next run times on startup. We intentionally do NOT backfill missed
	 * runs while the server was down — only schedule the next future fire to
	 * avoid a thundering herd of catch-up runs at boot.
	 */
	async recoverOnStartup(): Promise<void> {
		const tasks = await db.query.scheduledTasks.findMany({
			where: eq(scheduledTasks.enabled, true),
		});
		const at = new Date();
		for (const task of tasks) {
			const next = nextCronRun(task.cronExpr, task.timezone, at);
			await db
				.update(scheduledTasks)
				.set({ nextRunAt: next, updatedAt: now() })
				.where(eq(scheduledTasks.id, task.id));
		}
		if (tasks.length > 0) {
			logger.info(`Re-armed ${tasks.length} scheduled task(s)`);
		}
	},

	/**
	 * Execute a task: spawn (or reuse) a narrator and inject the prompt to
	 * auto-start its agent loop. Records the outcome and re-arms nextRunAt.
	 * `manual` runs skip the schedule re-arm gate but still update lastRun state.
	 */
	async runTask(id: string, opts: { manual?: boolean } = {}): Promise<void> {
		await runLock.acquire(id, async () => {
			const task = await this.get(id);
			if (!task) throw new NotFoundError("ScheduledTask", id);

			// Re-arm the next scheduled run up front (even if this run fails/skips),
			// so a persistent failure doesn't wedge the schedule.
			const nextRunAt = task.enabled ? nextCronRun(task.cronExpr, task.timezone) : null;

			const startedAt = now();
			const startMs = Date.now();
			let status: "success" | "failed" | "skipped" = "success";
			let error: string | null = null;
			let narratorId: string | null = null;
			let reuseNarratorId = task.reuseNarratorId;

			try {
				const result = await this.launchNarrator(task);
				status = result.status;
				narratorId = result.narratorId;
				error = result.error ?? null;
				if (result.reuseNarratorId !== undefined) reuseNarratorId = result.reuseNarratorId;
				// Audit trail: scheduled tasks run unattended, often under bypassPermissions,
				// so record every dispatch (who created it, which narrator, outcome) for traceability.
				logger.info("Scheduled task run", {
					taskId: id,
					name: task.name,
					status,
					narratorId,
					runContext: task.runContext,
					permissionMode: task.permissionMode,
					createdBy: task.createdBy,
					manual: opts.manual === true,
				});
			} catch (err) {
				status = "failed";
				error = err instanceof Error ? err.message : String(err);
				logger.error("Scheduled task run failed", { taskId: id, error });
			}

			const finishedAt = now();

			await db
				.update(scheduledTasks)
				.set({
					lastRunAt: finishedAt,
					lastStatus: status,
					lastError: error,
					lastNarratorId: narratorId ?? task.lastNarratorId,
					reuseNarratorId,
					// A manual trigger doesn't disturb the cron cadence unless enabled.
					...(opts.manual ? {} : { nextRunAt }),
					updatedAt: finishedAt,
				})
				.where(eq(scheduledTasks.id, id));

			// Persist a run-history row. Wrapped in try/catch so a history write
			// failure never bubbles up and disrupts the schedule.
			try {
				await db.insert(scheduledTaskRuns).values({
					id: generateId(),
					taskId: id,
					narratorId,
					status,
					error,
					runContext: task.runContext,
					manual: opts.manual === true,
					startedAt,
					finishedAt,
					durationMs: Date.now() - startMs,
					createdAt: finishedAt,
				});
			} catch (err) {
				logger.error("Failed to record scheduled task run history", {
					taskId: id,
					error: err instanceof Error ? err.message : String(err),
				});
			}

			// Circuit breaker: auto-disable after repeated consecutive failures.
			// Prevents infinite retry noise from permanently broken tasks (e.g.
			// deleted chapter, invalid config). Success resets the counter.
			if (status === "failed") {
				const count = (consecutiveFailures.get(id) ?? 0) + 1;
				consecutiveFailures.set(id, count);
				if (count >= CIRCUIT_BREAKER_THRESHOLD) {
					logger.warn("Scheduled task auto-disabled after consecutive failures", {
						taskId: id,
						name: task.name,
						consecutiveFailures: count,
					});
					await db
						.update(scheduledTasks)
						.set({ enabled: false, nextRunAt: null, updatedAt: now() })
						.where(eq(scheduledTasks.id, id));
					consecutiveFailures.delete(id);
				}
			} else if (status === "success") {
				consecutiveFailures.delete(id);
			}

			// Success means dispatched, not loop-complete. The planner protects in-flight loops.
			// Failed dispatches still have durable creation provenance and can be retained/cleaned.
			try {
				await cleanupScheduledTaskNarrators(id);
			} catch (err) {
				logger.warn("Scheduled task narrator cleanup failed", { taskId: id, error: String(err) });
			}
		});
	},

	/**
	 * List run-history rows for a task, newest first. Cursor-paginated via the
	 * `createdAt` of the last row seen (LIMIT n+1 to detect more; no COUNT).
	 */
	async listRuns(
		taskId: string,
		opts: { limit?: number; cursor?: string | null } = {},
	): Promise<{ runs: ScheduledTaskRun[]; nextCursor: string | null }> {
		const limit = Math.min(Math.max(opts.limit ?? RUNS_PAGE_DEFAULT, 1), RUNS_PAGE_MAX);
		const where = opts.cursor
			? and(eq(scheduledTaskRuns.taskId, taskId), lt(scheduledTaskRuns.createdAt, opts.cursor))
			: eq(scheduledTaskRuns.taskId, taskId);
		const rows = await db.query.scheduledTaskRuns.findMany({
			where,
			orderBy: (t) => [desc(t.createdAt)],
			limit: limit + 1,
		});
		const hasMore = rows.length > limit;
		const runs = hasMore ? rows.slice(0, limit) : rows;
		const nextCursor = hasMore ? (runs[runs.length - 1]?.createdAt ?? null) : null;
		return { runs, nextCursor };
	},

	/**
	 * Core narrator launch logic. Returns the run outcome without touching the
	 * task row (the caller persists state).
	 */
	async launchNarrator(task: ScheduledTask): Promise<{
		status: "success" | "skipped";
		narratorId: string | null;
		error?: string;
		reuseNarratorId?: string | null;
	}> {
		// Resolve the target narrator id (reuse existing or create new).
		let narratorId: string | null = null;
		let newReuseId: string | null | undefined;

		if (task.runContext === "chapter") {
			if (!task.chapterId) {
				return { status: "skipped", narratorId: null, error: "Missing chapterId" };
			}
			// Wake the chapter if dormant so the worktree exists.
			const chapter = await db.query.chapters.findFirst({
				where: (c, { eq: e }) => e(c.id, task.chapterId as string),
			});
			if (!chapter) {
				return { status: "skipped", narratorId: null, error: "Chapter not found" };
			}
			// Merged is reported as a skip rather than passed to `wake`.
			//
			// `wake` refuses a merged chapter outright (waking one erased the merge
			// coordinates while its changes stayed applied downstream, making `unmerge`
			// unreachable). This call is not inside a try, so including "merged" here turned
			// every tick into a thrown ValidationError: the run failed instead of skipping,
			// and the recorded error was `wake`'s prose about unmerge — accurate for someone
			// who clicked Wake, meaningless as the outcome of a schedule.
			if (chapter.status === "merged") {
				return {
					status: "skipped",
					narratorId: null,
					error: "Chapter is merged; unmerge it before this task can run",
				};
			}
			if (chapter.status === "dormant") {
				await chapterCleanup.wake(task.chapterId);
			} else if (chapter.status !== "active") {
				return {
					status: "skipped",
					narratorId: null,
					error: `Chapter is ${chapter.status}, cannot run`,
				};
			}
			// Reuse the chapter's existing primary narrator if present — but only if the
			// task's creator may actually drive it. Otherwise a scheduled task would be a
			// way to inject messages into someone else's private session.
			const existing = await narratorService.listByChapter(task.chapterId);
			const reusable = existing[0]
				? await canWriteNarrator(existing[0], await principalForTask(task))
				: false;
			if (existing.length > 0 && reusable) {
				narratorId = existing[0].id;
			} else if (existing.length > 0) {
				return {
					status: "skipped",
					narratorId: null,
					error: "Task creator no longer has write access to this chapter's narrator",
				};
			} else {
				const created = await narratorService.create({
					chapterId: task.chapterId,
					model: task.model ?? undefined,
					systemPrompt: task.systemPrompt ?? undefined,
					permissionMode: task.permissionMode,
					startInPlanMode: false,
					title: task.name,
					extraTraits: ["scheduled"],
					scheduledTaskId: task.id,
					// Whoever configured the task owns the sessions it spawns — the same id
					// already used as the run's message author and ACL principal.
					ownerUserId: task.createdBy ?? null,
				});
				narratorId = created.id;
			}
		} else {
			// standalone
			if (task.narratorMode === "reuse" && task.reuseNarratorId) {
				// getById throws NotFoundError when the remembered narrator was deleted;
				// swallow it so we fall back to creating a fresh narrator below instead
				// of failing the run permanently.
				const existing = await narratorService.getById(task.reuseNarratorId).catch(() => null);
				// Same guard as the chapter branch: the remembered narrator may since have
				// been transferred or un-shared, and a task must not keep writing to a
				// session its creator can no longer reach. Falls through to a fresh one.
				const mayReuse =
					existing !== null && (await canWriteNarrator(existing, await principalForTask(task)));
				if (existing && mayReuse && existing.status !== "archived") {
					narratorId = existing.id;
				}
			}
			if (!narratorId) {
				const created = await narratorService.create({
					chapterId: null,
					model: task.model ?? undefined,
					systemPrompt: task.systemPrompt ?? undefined,
					permissionMode: task.permissionMode,
					startInPlanMode: false,
					cwd: task.cwd ?? getHome(),
					title: task.name,
					extraTraits: ["scheduled"],
					scheduledTaskId: task.id,
					ownerUserId: task.createdBy ?? null,
				});
				narratorId = created.id;
				if (task.narratorMode === "reuse") newReuseId = created.id;
			}
		}

		if (!narratorId) {
			return { status: "skipped", narratorId: null, error: "Could not resolve a narrator" };
		}

		// Don't collide with an in-flight loop — skip this run instead of throwing.
		if (isLoopRunning(narratorId)) {
			return {
				status: "skipped",
				narratorId,
				error: "Narrator is already running; skipped this run",
				reuseNarratorId: newReuseId,
			};
		}

		// Scheduler-driven run: `createdBy` is whoever configured the task, not
		// someone who typed this turn, so attribute it to the scheduler.
		await sendMessage(
			narratorId,
			task.prompt,
			undefined,
			task.locale,
			false,
			null,
			task.createdBy ?? null,
			undefined,
			null,
			{ origin: "system", originLabel: formatOriginLabel("scheduledTask", task.name) },
		);

		return { status: "success", narratorId, reuseNarratorId: newReuseId };
	},
};
