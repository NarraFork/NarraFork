import { and, asc, eq, lte } from "drizzle-orm";
import { db } from "../db";
import { scheduledTasks } from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
import { nextCronRun } from "../lib/cron";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getHome } from "../lib/platform";
import { chapterCleanup } from "./chapter-cleanup";
import { narratorService } from "./narrator-service";
import { isLoopRunning, sendMessage } from "./narrator-session";

type ScheduledTask = typeof scheduledTasks.$inferSelect;

export interface CreateScheduledTaskInput {
	name: string;
	cronExpr: string;
	timezone?: string | null;
	prompt: string;
	systemPrompt?: string | null;
	model?: string | null;
	permissionMode?: string;
	locale?: "en" | "zh-CN";
	runContext?: "standalone" | "chapter";
	cwd?: string | null;
	projectId?: string | null;
	chapterId?: string | null;
	narratorMode?: "new" | "reuse";
	enabled?: boolean;
	createdBy?: string | null;
}

export type UpdateScheduledTaskInput = Partial<Omit<CreateScheduledTaskInput, "createdBy">>;

// Per-task mutex prevents a slow run from overlapping with the next tick.
const runLock = new AsyncMutex();

function now(): string {
	return new Date().toISOString();
}

export const scheduledTaskService = {
	async list(): Promise<ScheduledTask[]> {
		return db.query.scheduledTasks.findMany({
			orderBy: (t) => [asc(t.createdAt)],
		});
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
			locale: input.locale ?? "en",
			runContext,
			cwd: input.cwd ?? null,
			projectId: input.projectId ?? null,
			chapterId: input.chapterId ?? null,
			narratorMode: input.narratorMode ?? "new",
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
		await db.delete(scheduledTasks).where(eq(scheduledTasks.id, id));
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

			await db
				.update(scheduledTasks)
				.set({
					lastRunAt: now(),
					lastStatus: status,
					lastError: error,
					lastNarratorId: narratorId ?? task.lastNarratorId,
					reuseNarratorId,
					// A manual trigger doesn't disturb the cron cadence unless enabled.
					...(opts.manual ? {} : { nextRunAt }),
					updatedAt: now(),
				})
				.where(eq(scheduledTasks.id, id));
		});
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
			// Wake the chapter if dormant/merged so the worktree exists.
			const chapter = await db.query.chapters.findFirst({
				where: (c, { eq: e }) => e(c.id, task.chapterId as string),
			});
			if (!chapter) {
				return { status: "skipped", narratorId: null, error: "Chapter not found" };
			}
			if (chapter.status === "dormant" || chapter.status === "merged") {
				await chapterCleanup.wake(task.chapterId);
			} else if (chapter.status !== "active") {
				return {
					status: "skipped",
					narratorId: null,
					error: `Chapter is ${chapter.status}, cannot run`,
				};
			}
			// Reuse the chapter's existing primary narrator if present.
			const existing = await narratorService.listByChapter(task.chapterId);
			if (existing.length > 0) {
				narratorId = existing[0].id;
			} else {
				const created = await narratorService.create({
					chapterId: task.chapterId,
					model: task.model ?? undefined,
					systemPrompt: task.systemPrompt ?? undefined,
					permissionMode: task.permissionMode,
					startInPlanMode: false,
					title: task.name,
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
				if (existing && existing.status !== "archived") {
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

		await sendMessage(
			narratorId,
			task.prompt,
			undefined,
			task.locale,
			false,
			null,
			task.createdBy ?? null,
		);

		return { status: "success", narratorId, reuseNarratorId: newReuseId };
	},
};
