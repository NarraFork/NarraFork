import { DEFAULT_LOCALE, type Locale } from "@shared/i18n-locales";
import type { ScheduledTaskCleanupPolicy } from "@shared/scheduled-task-cleanup";
import { normalizeRunContext, type ScheduledRunContext } from "@shared/scheduled-task-run-context";
import {
	parseSchedule,
	scheduleSignature,
	scheduleToLegacyCron,
	type TaskSchedule,
} from "@shared/scheduled-task-schedule";
import {
	type RunVerdict,
	runVerdict,
	type TaskModelPolicy,
	type TaskOnBlockedPolicy,
	taskLifecycle,
	UNFINISHED_RUN_STATUSES,
} from "@shared/scheduled-task-status";
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { db } from "../db";
import { narrators, scheduledTaskRuns, scheduledTasks, users } from "../db/schema";
import { readQuery } from "../db/worker-read";
import { AsyncMutex } from "../lib/async-mutex";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { getHome } from "../lib/platform";
import {
	checkSchedule,
	defaultAnchor,
	previewOccurrences,
	resolveTimeZone,
} from "../lib/schedule-engine";
import { settings } from "../lib/settings";
import {
	createScheduledTaskSchema,
	updateScheduledTaskSchema,
} from "../lib/validators/scheduled-tasks";
import { canReadNarrator, canWriteNarrator } from "./narrator-acl";
import { narratorService } from "./narrator-service";
import {
	assertTaskAccess,
	assertTaskProjectWrite,
	canEditTask,
	canPauseTask,
	resolveTaskPrincipal,
	type ScheduledTaskPrincipal,
	taskOwnerId,
	taskOwnerWhere,
	taskReadableWhere,
} from "./scheduled-task-acl";
import { scheduledTaskMutationLocks as locks } from "./scheduled-task-admission";
import { cancelScheduledTaskWaitingRuns } from "./scheduled-task-run-service";
import {
	missedScheduleSlice,
	nextTaskOccurrence,
	readTaskSchedule,
} from "./scheduled-task-schedule-state";
import {
	assertScheduledTaskTargetVersion,
	resolveScheduledTaskTarget,
	type ScheduledTaskExpectedTarget,
} from "./scheduled-task-target";
import { acceptScheduledTaskRun, advanceScheduledTaskRun } from "./scheduled-task-waiting";

export type ScheduledTask = typeof scheduledTasks.$inferSelect;
const LIST_MAX = 500;
const DUE_BATCH = 25;
const MISFIRE_TOLERANCE_MS = 60_000;
const ownerLocks = hotSafe("scheduled-tasks:owner-locks", () => new AsyncMutex());
const pausedSweep = hotSafe("scheduled-tasks:paused-sweep", () => ({ cursor: "" }));
function boundedSetting(value: unknown, fallback: number, max: number) {
	return typeof value === "number" && Number.isSafeInteger(value)
		? Math.min(max, Math.max(1, value))
		: fallback;
}
function minimumInterval(agent: boolean) {
	const minutes = boundedSetting(settings.scheduledTasks?.minIntervalMinutes, 1, 1440);
	return (
		60_000 *
		(agent
			? Math.max(minutes, boundedSetting(settings.scheduledTasks?.minAgentIntervalMinutes, 5, 1440))
			: minutes)
	);
}
const stamp = (previous?: string) =>
	new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
const changed = () => eventBus.emit({ type: "scheduled_task:changed" });

export interface CreateScheduledTaskInput {
	name: string;
	cronExpr?: string;
	schedule?: TaskSchedule;
	timezone?: string | null;
	prompt: string;
	systemPrompt?: string | null;
	model?: string | null;
	permissionMode?: string;
	locale?: Locale;
	runContext?: ScheduledRunContext;
	cwd?: string | null;
	projectId?: string | null;
	narratorMode?: "new" | "reuse" | "existing";
	targetNarratorId?: string | null;
	contextPolicy?: "keep" | "clear";
	onBusy?: "skip" | "wait" | "interrupt";
	busyWaitMinutes?: number;
	requireReport?: boolean;
	cleanupPolicy?: ScheduledTaskCleanupPolicy;
	enabled?: boolean;
	modelPolicy?: TaskModelPolicy;
	onBlocked?: TaskOnBlockedPolicy;
	blockedWaitMinutes?: number;
	maxRunMinutes?: number;
	notifyOnSuccess?: boolean;
}
export type UpdateScheduledTaskInput = Partial<CreateScheduledTaskInput>;
/** Bind a mutating tool call to exactly the configuration that the person approved. */
export interface ScheduledTaskMutationOptions {
	expectedUpdatedAt?: string;
	expectedTarget?: ScheduledTaskExpectedTarget;
}
export interface ScheduledTaskProvenance {
	kind: "user" | "narrator";
	narratorId?: string | null;
	messageId?: string | null;
	toolCallId?: string | null;
	toolUseId?: string | null;
	narratorTitle?: string | null;
}
export interface TaskFilters {
	lifecycle?: "active" | "paused" | "ended" | "all";
	attention?: boolean;
	creator?: "user" | "narrator" | "mine";
	owner?: string;
	projectId?: string;
	kind?: "at" | "repeat" | "cron";
	result?: RunVerdict;
	runContext?: ScheduledRunContext;
	q?: string;
	sort?: "nextRun" | "lastRun" | "createdAt" | "name";
}

/** A caller's role is refreshed at each operation, not accepted as a durable grant. */
async function actor(principal?: ScheduledTaskPrincipal) {
	return resolveTaskPrincipal(principal?.userId);
}
function modifiedBy(
	principal: ScheduledTaskPrincipal,
	action: string,
	provenance?: ScheduledTaskProvenance,
) {
	return {
		kind: provenance?.kind ?? ("user" as const),
		userId: principal.userId,
		narratorId: provenance?.narratorId,
		toolCallId: provenance?.toolCallId,
		action,
		at: stamp(),
	};
}
function conflict() {
	return new AppError(
		"Task changed or is already running; refresh before retrying",
		409,
		"SCHEDULED_TASK_CONFLICT",
	);
}
function assertApprovedVersion(task: ScheduledTask, options: ScheduledTaskMutationOptions) {
	if (options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== task.updatedAt) {
		throw conflict();
	}
}
function rowVersion(task: ScheduledTask) {
	return and(
		eq(scheduledTasks.id, task.id),
		eq(scheduledTasks.scheduleRevision, task.scheduleRevision),
		eq(scheduledTasks.updatedAt, task.updatedAt),
	);
}

/** Normalize old persisted rows atomically before a writer or startup advances their schedule. */
async function normalizeLegacyTask(task: ScheduledTask, now = new Date()): Promise<ScheduledTask> {
	if (task.schedule) return task;
	const schedule = readTaskSchedule(task);
	const creator = task.createdBy
		? await readQuery(
				db.query.users.findFirst({
					where: eq(users.id, task.createdBy),
					columns: { username: true },
				}),
				{ executionPolicy: "worker-required" },
			)
		: undefined;
	const nextAt = task.nextRunAt ? Date.parse(task.nextRunAt) : Number.NaN;
	const [updated] = await db
		.update(scheduledTasks)
		.set({
			schedule,
			scheduleKind: schedule.kind,
			ownerUserId: task.ownerUserId ?? task.createdBy,
			creatorKind: "user",
			creatorSnapshot: task.creatorSnapshot ?? { username: creator?.username },
			// nextRunAt is the old scheduler's durable boundary, including runs just dispatched.
			// Rewinding to createdAt could dispatch the same occurrence again after an upgrade.
			scheduleCursorAt:
				task.scheduleCursorAt ??
				(Number.isFinite(nextAt)
					? new Date(nextAt - 1).toISOString()
					: (task.lastRunAt ?? now.toISOString())),
		})
		.where(and(rowVersion(task), isNull(scheduledTasks.schedule)))
		.returning();
	const current =
		updated ??
		(await readQuery(db.query.scheduledTasks.findFirst({ where: eq(scheduledTasks.id, task.id) }), {
			executionPolicy: "worker-required",
		}));
	if (!current) throw new NotFoundError("ScheduledTask", task.id);
	return current;
}
function normalizeSchedule(
	input: unknown,
	timezone: string | null,
	now: Date,
	requireFuture: boolean,
	existing?: TaskSchedule,
	minIntervalMs = 60_000,
) {
	const parsed = parseSchedule(input);
	if (!parsed.ok)
		throw new ValidationError(`Invalid schedule: ${parsed.issue.code} (${parsed.issue.path})`);
	let schedule = parsed.schedule;
	if (schedule.kind === "repeat") {
		// The anchor is derived host state; never let an incidental client save move the cadence.
		schedule = {
			...schedule,
			anchorAt:
				existing?.kind === "repeat" && scheduleSignature(schedule) === scheduleSignature(existing)
					? (existing.anchorAt ?? defaultAnchor(timezone, now, schedule.startAt))
					: defaultAnchor(timezone, now, schedule.startAt),
		};
	}
	const checked = checkSchedule(schedule, timezone, { now, requireFuture, minIntervalMs });
	if (!checked.ok) throw new ValidationError(`Invalid schedule: ${checked.code} (${checked.path})`);
	return schedule;
}

function verdictExpression(
	status: SQLWrapper,
	outcome: SQLWrapper,
	requireReport: SQLWrapper,
): SQL<RunVerdict> {
	return sql<RunVerdict>`case when ${status} = 'completed' then case
		when ${outcome} in ('done','no_change') then 'succeeded'
		when ${outcome} in ('partial','blocked') then 'incomplete'
		when ${requireReport} = 0 then 'completed' else 'unconfirmed' end
		when ${status} = 'success' then 'dispatched' else ${status} end`;
}

function executionSettings(
	input: UpdateScheduledTaskInput,
	existing?: ScheduledTask,
	allowMissingTarget = false,
) {
	const narratorMode = input.narratorMode ?? existing?.narratorMode ?? "new";
	const targetNarratorId =
		narratorMode === "existing"
			? input.targetNarratorId === undefined
				? existing?.targetNarratorId
				: input.targetNarratorId
			: null;
	if (narratorMode === "existing" && !targetNarratorId && !allowMissingTarget)
		throw new ValidationError("Existing narrator mode requires a target narrator");
	return {
		narratorMode,
		targetNarratorId: targetNarratorId ?? null,
		contextPolicy: input.contextPolicy ?? existing?.contextPolicy ?? "keep",
		onBusy: input.onBusy ?? existing?.onBusy ?? "skip",
		busyWaitMinutes: input.busyWaitMinutes ?? existing?.busyWaitMinutes ?? 30,
		requireReport: input.requireReport ?? existing?.requireReport ?? true,
		modelPolicy:
			input.modelPolicy ??
			(narratorMode === "existing" && existing?.narratorMode !== "existing"
				? "follow"
				: (existing?.modelPolicy ?? "sync")),
		...(narratorMode === "existing"
			? { cwd: null, projectId: null, runContext: "standalone" as const, systemPrompt: null }
			: {}),
	};
}

async function validateExistingTarget(
	task: Pick<ScheduledTask, "narratorMode" | "targetNarratorId">,
	owner: ScheduledTaskPrincipal,
	caller?: ScheduledTaskPrincipal,
	options: ScheduledTaskMutationOptions = {},
) {
	if (task.narratorMode !== "existing") return;
	const resolved = await resolveScheduledTaskTarget(owner, task.targetNarratorId ?? "");
	if (caller && caller.userId !== owner.userId)
		await resolveScheduledTaskTarget(caller, task.targetNarratorId ?? "");
	assertScheduledTaskTargetVersion(resolved, options.expectedTarget);
	return resolved;
}

async function withExistingTargetBinding<T>(
	task: Pick<ScheduledTask, "narratorMode" | "targetNarratorId">,
	ownerId: string | null,
	caller: ScheduledTaskPrincipal,
	options: ScheduledTaskMutationOptions,
	write: () => Promise<T>,
	passive = false,
): Promise<T> {
	if (task.narratorMode !== "existing" || passive) return write();
	const { withNarratorWorkAdmission } = await import("./narrator-session-state");
	return withNarratorWorkAdmission(task.targetNarratorId ?? "", async () => {
		await validateExistingTarget(task, await resolveTaskPrincipal(ownerId), caller, options);
		return write();
	});
}

// Do not fetch prompt bodies on list endpoints. Removing them after SELECT * is too late.
const {
	prompt: _promptColumn,
	systemPrompt: _systemPromptColumn,
	...summaryColumns
} = getTableColumns(scheduledTasks);
type TaskSummary = Omit<ScheduledTask, "prompt" | "systemPrompt">;

async function decorate(task: TaskSummary | ScheduledTask, principal: ScheduledTaskPrincipal) {
	const editable = canEditTask(task, principal);
	const ownerId = taskOwnerId(task);
	const ids = [...new Set([ownerId, task.createdBy].filter((id): id is string => !!id))];
	const people = ids.length
		? await readQuery(
				db.query.users.findMany({
					where: inArray(users.id, ids),
					columns: { id: true, username: true },
					limit: 2,
				}),
				{ executionPolicy: "worker-required" },
			)
		: [];
	const owner = people.find((u) => u.id === ownerId) ?? null;
	const person = people.find((u) => u.id === task.createdBy);
	const source = task.creatorNarratorId
		? await readQuery(
				db.query.narrators.findFirst({
					where: eq(narrators.id, task.creatorNarratorId),
					columns: {
						id: true,
						title: true,
						type: true,
						ownerUserId: true,
						visibility: true,
						writeAudience: true,
						contextProjectId: true,
						aclRootNarratorId: true,
					},
				}),
				{ executionPolicy: "worker-required" },
			)
		: undefined;
	const canOpen = !!source && (await canReadNarrator(source, principal));
	const {
		creatorSnapshot,
		creatorNarratorId,
		creatorMessageId,
		creatorToolCallId,
		creatorToolUseId: _toolUseId,
		lastModifiedBy,
		...safe
	} = task;
	const schedule = readTaskSchedule(task);
	const lastRun = task.lastRunId
		? await readQuery(
				db.query.scheduledTaskRuns.findFirst({
					where: eq(scheduledTaskRuns.id, task.lastRunId),
					columns: { requireReport: true },
				}),
				{ executionPolicy: "worker-required" },
			)
		: undefined;
	return {
		...safe,
		lastRequireReport: lastRun?.requireReport ?? true,
		schedule,
		runContext: normalizeRunContext(task.runContext),
		ownerUserId: ownerId,
		owner,
		// Project observers see scheduling metadata, not potentially private execution output.
		lastError: editable ? task.lastError : null,
		lastSummary: editable ? task.lastSummary : null,
		lastModifiedBy: editable ? lastModifiedBy : null,
		creator: {
			kind: task.creatorKind,
			username: person?.username ?? creatorSnapshot?.username ?? null,
			narratorTitle: canOpen
				? (source?.title ?? null)
				: !source && editable
					? (creatorSnapshot?.narratorTitle ?? null)
					: null,
			narratorId: canOpen ? creatorNarratorId : null,
			messageId: canOpen ? creatorMessageId : null,
			toolCallId: canOpen ? creatorToolCallId : null,
			deleted: task.creatorKind === "narrator" ? !source : !person,
			canOpen,
		},
		capabilities: {
			canEdit: editable,
			canPause: await canPauseTask(task, principal),
			canRun: editable,
			canDelete: editable,
			canSeePrompt: editable,
			canTransfer: principal.isAdmin,
		},
		lifecycle: taskLifecycle(task),
	};
}

export const scheduledTaskService = {
	async get(id: string): Promise<ScheduledTask | undefined> {
		return readQuery(db.query.scheduledTasks.findFirst({ where: eq(scheduledTasks.id, id) }), {
			executionPolicy: "worker-required",
		});
	},

	async detail(id: string, principal?: ScheduledTaskPrincipal) {
		const live = await actor(principal);
		const task = await this.get(id);
		await assertTaskAccess(task, live);
		if (!task) throw new NotFoundError("ScheduledTask", id);
		const { prompt, systemPrompt, ...summary } = task;
		return {
			...(await decorate(summary, live)),
			...(canEditTask(task, live) ? { prompt, systemPrompt } : {}),
			preview: previewOccurrences(readTaskSchedule(task), task.timezone, {
				firedCount: task.firedCount,
			}),
		};
	},

	async list(principal?: ScheduledTaskPrincipal, filters: TaskFilters = {}) {
		const live = await actor(principal);
		const verdict = verdictExpression(
			scheduledTasks.lastStatus,
			scheduledTasks.lastOutcome,
			sql`coalesce((select ${scheduledTaskRuns.requireReport} from ${scheduledTaskRuns} where ${scheduledTaskRuns.id} = ${scheduledTasks.lastRunId}), 1)`,
		);
		const lifecycle = filters.lifecycle ?? "active";
		const query = filters.q?.trim();
		const match = query ? `%${query.replace(/[\\%_]/g, "\\$&")}%` : null;
		const rows = await readQuery(
			db
				.select(summaryColumns)
				.from(scheduledTasks)
				.where(
					and(
						taskReadableWhere(live),
						lifecycle === "ended"
							? isNotNull(scheduledTasks.completedAt)
							: lifecycle !== "all"
								? isNull(scheduledTasks.completedAt)
								: undefined,
						lifecycle === "paused" ? eq(scheduledTasks.enabled, false) : undefined,
						filters.attention
							? or(
									inArray(verdict, ["failed", "timed_out", "incomplete", "blocked", "interrupted"]),
									eq(scheduledTasks.pauseReason, "circuit_breaker"),
								)
							: undefined,
						filters.result ? eq(verdict, filters.result) : undefined,
						filters.creator === "mine"
							? eq(scheduledTasks.createdBy, live.userId)
							: filters.creator
								? eq(scheduledTasks.creatorKind, filters.creator)
								: undefined,
						filters.owner ? taskOwnerWhere(filters.owner) : undefined,
						filters.projectId ? eq(scheduledTasks.projectId, filters.projectId) : undefined,
						filters.kind ? eq(scheduledTasks.scheduleKind, filters.kind) : undefined,
						filters.runContext ? eq(scheduledTasks.runContext, filters.runContext) : undefined,
						match
							? or(
									sql`${scheduledTasks.name} like ${match} escape '\\'`,
									and(
										live.isAdmin ? undefined : taskOwnerWhere(live.userId),
										sql`${scheduledTasks.prompt} like ${match} escape '\\'`,
									),
								)
							: undefined,
					),
				)
				.orderBy(
					...(filters.sort === "name"
						? [asc(scheduledTasks.name), asc(scheduledTasks.id)]
						: filters.sort === "createdAt"
							? [desc(scheduledTasks.createdAt), desc(scheduledTasks.id)]
							: filters.sort === "lastRun"
								? [desc(scheduledTasks.lastRunAt), desc(scheduledTasks.id)]
								: [
										asc(sql`case when ${scheduledTasks.nextRunAt} is null then 1 else 0 end`),
										asc(scheduledTasks.nextRunAt),
										asc(scheduledTasks.id),
									]),
				)
				.limit(LIST_MAX + 1),
			{ executionPolicy: "worker-required" },
		);
		const tasks = [];
		for (const row of rows.slice(0, LIST_MAX)) tasks.push(await decorate(row, live));
		return { tasks, truncated: rows.length > LIST_MAX };
	},

	preview(input: {
		schedule: TaskSchedule;
		timezone?: string | null;
		count?: number;
		firedCount?: number;
	}) {
		const timezone = input.timezone ?? resolveTimeZone(null);
		// Preview is side-effect free: keep a valid persisted anchor supplied by an editor.
		// Creation and cadence changes still derive their own anchor on the server.
		const schedule = normalizeSchedule(input.schedule, timezone, new Date(), false, input.schedule);
		return { ...previewOccurrences(schedule, timezone, input), schedule };
	},

	async create(
		input: CreateScheduledTaskInput,
		principal?: ScheduledTaskPrincipal,
		provenance?: ScheduledTaskProvenance,
		options: ScheduledTaskMutationOptions = {},
	): Promise<ScheduledTask> {
		const live = await actor(principal);
		const parsed = createScheduledTaskSchema.safeParse(input);
		if (!parsed.success) throw new ValidationError(parsed.error.message);
		const data = { ...parsed.data, ...executionSettings(parsed.data) };
		await validateExistingTarget(data, live, live, options);
		if (provenance?.kind === "narrator") {
			if (!provenance.narratorId) throw new ForbiddenError();
			const { assertNarratorMayDelegateScheduledTask } = await import(
				"../lib/agent/tools/scheduled-task-policy"
			);
			await assertNarratorMayDelegateScheduledTask(provenance.narratorId, live.userId);
		}
		return ownerLocks.acquire(live.userId, async () => {
			const maxActive = boundedSetting(settings.scheduledTasks?.maxActivePerOwner, 100, 1000);
			const quota = await readQuery(
				db
					.select({ id: scheduledTasks.id })
					.from(scheduledTasks)
					.where(and(taskOwnerWhere(live.userId), isNull(scheduledTasks.completedAt)))
					.limit(maxActive),
				{ executionPolicy: "worker-required" },
			);
			if (quota.length >= maxActive)
				throw new ValidationError(`At most ${maxActive} unfinished scheduled tasks per owner`);
			if (data.runContext === "project") await assertTaskProjectWrite(data.projectId, live);
			const timezone = data.timezone ?? resolveTimeZone(null);
			const now = new Date();
			const schedule = normalizeSchedule(
				data.schedule ?? { kind: "cron", expr: data.cronExpr, end: { type: "never" } },
				timezone,
				now,
				data.enabled !== false,
				undefined,
				minimumInterval(provenance?.kind === "narrator"),
			);
			const creator = await readQuery(
				db.query.users.findFirst({
					where: eq(users.id, live.userId),
					columns: { username: true },
				}),
				{ executionPolicy: "worker-required" },
			);
			const ts = now.toISOString();
			const next = nextTaskOccurrence({
				schedule,
				cronExpr: "",
				timezone,
				createdAt: ts,
				firedCount: 0,
				scheduleCursorAt: ts,
				nextRunAt: null,
			});
			const [row] = await withExistingTargetBinding(data, live.userId, live, options, async () =>
				db
					.insert(scheduledTasks)
					.values({
						...data,
						id: generateId(),
						cronExpr: scheduleToLegacyCron(schedule) ?? "",
						schedule,
						scheduleKind: schedule.kind,
						timezone,
						ownerUserId: live.userId,
						createdBy: live.userId,
						creatorKind: provenance?.kind ?? "user",
						creatorNarratorId: provenance?.narratorId ?? null,
						creatorMessageId: provenance?.messageId ?? null,
						creatorToolCallId: provenance?.toolCallId ?? null,
						creatorToolUseId: provenance?.toolUseId ?? null,
						creatorSnapshot: {
							username: creator?.username,
							narratorTitle: provenance?.narratorTitle ?? undefined,
						},
						modelPolicy: data.modelPolicy ?? "sync",
						runContext: data.runContext ?? "standalone",
						projectId: data.runContext === "project" ? data.projectId : null,
						permissionMode: data.permissionMode ?? "default",
						locale: data.locale ?? DEFAULT_LOCALE,
						nextRunAt: data.enabled === false && schedule.kind !== "at" ? null : next,
						scheduleCursorAt: ts,
						completedAt: next ? null : ts,
						lastModifiedBy: modifiedBy(live, "create", provenance),
						createdAt: ts,
						updatedAt: ts,
					})
					.returning(),
			);
			changed();
			return row;
		});
	},

	async update(
		id: string,
		input: UpdateScheduledTaskInput,
		principal?: ScheduledTaskPrincipal,
		provenance?: ScheduledTaskProvenance,
		options: ScheduledTaskMutationOptions = {},
	): Promise<ScheduledTask> {
		const live = await actor(principal);
		if (provenance?.kind === "narrator") {
			if (!provenance.narratorId) throw new ForbiddenError();
			const { assertNarratorMayDelegateScheduledTask } = await import(
				"../lib/agent/tools/scheduled-task-policy"
			);
			await assertNarratorMayDelegateScheduledTask(provenance.narratorId, live.userId);
		}
		return locks.acquire(id, async () => {
			let existing = await this.get(id);
			await assertTaskAccess(existing, live, "edit");
			if (!existing) throw new NotFoundError("ScheduledTask", id);
			assertApprovedVersion(existing, options);
			const parsed = updateScheduledTaskSchema.safeParse(input);
			if (!parsed.success) throw new ValidationError(parsed.error.message);
			existing = await normalizeLegacyTask(existing);
			const data = parsed.data;
			const passiveUpdate = Object.keys(data).every(
				(key) => key === "name" || (key === "enabled" && data.enabled === false),
			);
			const execution = executionSettings(data, existing, passiveUpdate);
			const ownerId = taskOwnerId(existing);
			if (execution.narratorMode === "existing" && !passiveUpdate) {
				const owner = await resolveTaskPrincipal(ownerId);
				await validateExistingTarget(execution, owner, live, options);
			}
			const runContext =
				execution.narratorMode === "existing"
					? "standalone"
					: (data.runContext ?? normalizeRunContext(existing.runContext));
			const projectId = data.projectId === undefined ? existing.projectId : data.projectId;
			if (runContext === "project") {
				await assertTaskProjectWrite(projectId, live);
				const ownerId = taskOwnerId(existing);
				if (ownerId && ownerId !== live.userId)
					await assertTaskProjectWrite(projectId, await resolveTaskPrincipal(ownerId));
			}
			const old = readTaskSchedule(existing);
			const timezone =
				data.timezone === undefined ? existing.timezone : (data.timezone ?? resolveTimeZone(null));
			const now = new Date(stamp(existing.updatedAt));
			const schedule = normalizeSchedule(
				data.schedule ??
					(data.cronExpr !== undefined
						? { kind: "cron", expr: data.cronExpr, end: { type: "never" } }
						: old),
				timezone,
				now,
				false,
				old,
				0,
			);
			const cadenceChanged =
				scheduleSignature(old) !== scheduleSignature(schedule) || timezone !== existing.timezone;
			const scheduleChanged =
				data.schedule !== undefined ||
				data.cronExpr !== undefined ||
				data.timezone !== undefined ||
				data.enabled !== undefined;
			if (cadenceChanged)
				normalizeSchedule(
					schedule,
					timezone,
					now,
					false,
					old,
					minimumInterval(provenance?.kind === "narrator"),
				);
			if (!cadenceChanged && !existing.enabled && data.enabled === true && schedule.kind === "at") {
				await this.recordMissed(existing, now);
				existing = await this.get(id);
				if (!existing) throw new NotFoundError("ScheduledTask", id);
			}
			// Execution settings cannot be changed while the accepted snapshot is in use.
			if (existing.activeRunId && Object.keys(data).some((key) => key !== "name")) throw conflict();
			let waiting = await readQuery(
				db.query.scheduledTaskRuns.findFirst({
					where: and(eq(scheduledTaskRuns.taskId, id), eq(scheduledTaskRuns.status, "waiting")),
					columns: { id: true },
				}),
				{ executionPolicy: "worker-required" },
			);
			const enabled = data.enabled ?? existing.enabled;
			const firedCount = cadenceChanged ? 0 : existing.firedCount;
			const scheduleCursorAt =
				cadenceChanged || (!existing.enabled && enabled && schedule.kind !== "at")
					? now.toISOString()
					: existing.scheduleCursorAt;
			const next = nextTaskOccurrence({
				...existing,
				schedule,
				timezone,
				firedCount,
				scheduleCursorAt,
			});
			if (enabled && !next && !existing.activeRunId && (data.enabled === true || cadenceChanged))
				throw new ValidationError("This schedule has ended; choose a future occurrence");
			if (Object.keys(data).some((key) => key !== "name")) {
				await cancelScheduledTaskWaitingRuns(id, "Task configuration changed while waiting");
				existing = await this.get(id);
				if (!existing) throw new NotFoundError("ScheduledTask", id);
				waiting = undefined;
			}
			const version = existing;
			const [updated] = await withExistingTargetBinding(
				execution,
				taskOwnerId(version),
				live,
				options,
				async () =>
					db
						.update(scheduledTasks)
						.set({
							...data,
							...execution,
							runContext,
							projectId: runContext === "project" ? projectId : null,
							// A moved task must not keep executing in its previous workspace.
							...(execution.narratorMode !== version.narratorMode ||
							runContext !== normalizeRunContext(version.runContext) ||
							projectId !== version.projectId ||
							(data.cwd !== undefined && data.cwd !== version.cwd)
								? { reuseNarratorId: null }
								: {}),
							// A Worker read may predate a claim. Non-schedule edits must not
							// restore its old cursor, count or next occurrence after admission.
							...(scheduleChanged
								? {
										schedule,
										scheduleKind: schedule.kind,
										cronExpr: scheduleToLegacyCron(schedule) ?? "",
										timezone,
										firedCount,
										scheduleCursorAt,
										scheduleRevision: version.scheduleRevision + (cadenceChanged ? 1 : 0),
										nextRunAt: enabled || schedule.kind === "at" ? next : null,
										completedAt:
											!next && !version.activeRunId && !waiting ? now.toISOString() : null,
										enabled,
										pauseReason: enabled ? null : ("user" as const),
									}
								: {}),
							...(data.enabled === true ? { consecutiveFailures: 0 } : {}),
							lastModifiedBy: modifiedBy(live, "update", provenance),
							updatedAt: stamp(version.updatedAt),
						})
						.where(rowVersion(version))
						.returning(),
				passiveUpdate,
			);
			if (!updated) throw conflict();
			changed();
			return updated;
		});
	},

	async setEnabled(
		id: string,
		enabled: boolean,
		principal?: ScheduledTaskPrincipal,
		options: ScheduledTaskMutationOptions = {},
	): Promise<ScheduledTask> {
		const live = await actor(principal);
		return locks.acquire(id, async () => {
			let task = await this.get(id);
			await assertTaskAccess(task, live, "pause");
			if (!task) throw new NotFoundError("ScheduledTask", id);
			assertApprovedVersion(task, options);
			task = await normalizeLegacyTask(task);
			if (enabled) {
				const execution = executionSettings({}, task);
				const owner = await resolveTaskPrincipal(taskOwnerId(task));
				await validateExistingTarget(execution, owner, live, options);
				if (
					execution.narratorMode !== "existing" &&
					normalizeRunContext(task.runContext) === "project"
				) {
					await assertTaskProjectWrite(task.projectId, owner);
					await assertTaskProjectWrite(task.projectId, live);
				}
			} else {
				await cancelScheduledTaskWaitingRuns(id, "Task paused while waiting");
				task = await this.get(id);
				if (!task) throw new NotFoundError("ScheduledTask", id);
			}
			const schedule = readTaskSchedule(task);
			if (!task.enabled && schedule.kind === "at") {
				await this.recordMissed(task, new Date());
				task = await this.get(id);
				if (!task) throw new NotFoundError("ScheduledTask", id);
			}
			const now = stamp(task.updatedAt);
			const cursor =
				enabled && !task.enabled && schedule.kind !== "at" ? now : task.scheduleCursorAt;
			const next = nextTaskOccurrence({ ...task, schedule, scheduleCursorAt: cursor });
			if (enabled && (task.completedAt || !next))
				throw new ValidationError("This schedule has ended; edit it before enabling");
			const [updated] = await db
				.update(scheduledTasks)
				.set({
					enabled,
					pauseReason: enabled ? null : "user",
					nextRunAt: enabled || schedule.kind === "at" ? next : null,
					scheduleCursorAt: cursor,
					...(enabled ? { consecutiveFailures: 0 } : {}),
					lastModifiedBy: modifiedBy(live, enabled ? "enable" : "disable"),
					updatedAt: now,
				})
				.where(rowVersion(task))
				.returning();
			if (!updated) throw conflict();
			changed();
			return updated;
		});
	},

	async delete(
		id: string,
		principal?: ScheduledTaskPrincipal,
		options: ScheduledTaskMutationOptions = {},
	): Promise<void> {
		const live = await actor(principal);
		await locks.acquire(id, async () => {
			let task = await this.get(id);
			await assertTaskAccess(task, live, "edit");
			if (!task) throw new NotFoundError("ScheduledTask", id);
			assertApprovedVersion(task, options);
			if (task.activeRunId) throw conflict();
			await cancelScheduledTaskWaitingRuns(id, "Task deleted while waiting");
			task = await this.get(id);
			if (!task) throw new NotFoundError("ScheduledTask", id);
			const version = task;
			db.transaction((tx) => {
				// Some old ALTER ADD REFERENCES migrations omitted ON DELETE SET NULL.
				// A failed CAS rolls the detach back as part of this same transaction.
				tx.update(narrators)
					.set({ scheduledTaskId: null })
					.where(eq(narrators.scheduledTaskId, id))
					.run();
				const removed = tx
					.delete(scheduledTasks)
					.where(and(rowVersion(version), isNull(scheduledTasks.activeRunId)))
					.returning({ id: scheduledTasks.id })
					.all();
				if (!removed.length) throw conflict();
			});
			changed();
		});
	},

	async transfer(id: string, ownerUserId: string, principal: ScheduledTaskPrincipal) {
		const live = await actor(principal);
		if (!live.isAdmin) throw new ForbiddenError();
		const owner = await resolveTaskPrincipal(ownerUserId);
		return locks.acquire(id, async () => {
			let current = await this.get(id);
			if (!current) throw new NotFoundError("ScheduledTask", id);
			if (current.activeRunId) throw conflict();
			const execution = executionSettings({}, current);
			await validateExistingTarget(execution, owner, live);
			if (
				execution.narratorMode !== "existing" &&
				normalizeRunContext(current.runContext) === "project"
			)
				await assertTaskProjectWrite(current.projectId, owner);
			await cancelScheduledTaskWaitingRuns(id, "Task owner changed while waiting");
			current = await this.get(id);
			if (!current) throw new NotFoundError("ScheduledTask", id);
			const task = current;
			const previousOwner = taskOwnerId(task);
			const transferred = db.transaction((tx) => {
				const rows = tx
					.update(scheduledTasks)
					.set({
						ownerUserId,
						lastModifiedBy: modifiedBy(live, "transfer"),
						updatedAt: stamp(task.updatedAt),
					})
					.where(and(rowVersion(task), isNull(scheduledTasks.activeRunId)))
					.returning({ id: scheduledTasks.id })
					.all();
				if (!rows.length) throw conflict();
				if (!task.reuseNarratorId) return [];
				return tx
					.update(narrators)
					.set({ ownerUserId })
					.where(
						and(
							eq(narrators.id, task.reuseNarratorId),
							eq(narrators.scheduledTaskId, id),
							previousOwner
								? eq(narrators.ownerUserId, previousOwner)
								: isNull(narrators.ownerUserId),
						),
					)
					.returning({ id: narrators.id })
					.all();
			});
			for (const narrator of transferred)
				eventBus.emit({
					type: "narrator:access_changed",
					narratorId: narrator.id,
					reason: "owner_changed",
				});
			changed();
			eventBus.emit({ type: "scheduled_task:transferred", taskId: id });
			return this.detail(id, live);
		});
	},

	async listDue(at: Date = new Date()): Promise<ScheduledTask[]> {
		return readQuery(
			db.query.scheduledTasks.findMany({
				where: and(
					or(eq(scheduledTasks.enabled, true), eq(scheduledTasks.scheduleKind, "at")),
					isNull(scheduledTasks.completedAt),
					lte(scheduledTasks.nextRunAt, at.toISOString()),
				),
				orderBy: [asc(scheduledTasks.nextRunAt), asc(scheduledTasks.id)],
				limit: DUE_BATCH,
			}),
			{ executionPolicy: "worker-required" },
		);
	},

	/** Startup skips every elapsed occurrence; overflow stays overdue and is consumed in later bounded batches. */
	async recoverOnStartup(): Promise<void> {
		let cursor = "";
		const at = new Date();
		for (;;) {
			const rows = await readQuery(
				db
					.select({ id: scheduledTasks.id })
					.from(scheduledTasks)
					.where(gt(scheduledTasks.id, cursor))
					.orderBy(asc(scheduledTasks.id))
					.limit(DUE_BATCH),
				{ executionPolicy: "worker-required" },
			);
			if (!rows.length) break;
			for (const original of rows) {
				cursor = original.id;
				try {
					await locks.acquire(original.id, async () => {
						let task = await this.get(original.id);
						if (!task) return;
						task = await normalizeLegacyTask(task, at);
						// Explicit dates pass even while paused. Repeating pauses consume nothing.
						if (task.completedAt || (!task.enabled && readTaskSchedule(task).kind !== "at")) return;
						// All times before startup are missed, including those inside normal tick tolerance.
						// Each short transaction is bounded; yield before taking another catch-up slice.
						for (;;) {
							const due = task.nextRunAt ?? nextTaskOccurrence(task);
							if (!due || due > at.toISOString()) break;
							await this.recordMissed(task, at);
							await new Promise<void>((resolve) => setTimeout(resolve, 0));
							const current = await this.get(original.id);
							if (
								!current ||
								current.completedAt ||
								(!current.enabled && readTaskSchedule(current).kind !== "at")
							)
								break;
							task = current;
						}
					});
					await this.reconcileCompletion(original.id);
				} catch (error) {
					logger.error("Scheduled task recovery failed", {
						taskId: original.id,
						error: String(error),
					});
					if (error instanceof ValidationError) {
						// Isolate a malformed legacy schedule, rather than disabling everyone else's timer.
						await db
							.update(scheduledTasks)
							.set({
								enabled: false,
								nextRunAt: null,
								lastStatus: "failed",
								lastError: error.message.slice(0, 2000),
								updatedAt: stamp(at.toISOString()),
							})
							.where(
								and(
									eq(scheduledTasks.id, original.id),
									lte(scheduledTasks.updatedAt, at.toISOString()),
								),
							);
						changed();
						continue;
					}
					// Database failure during catch-up must not replay downtime work.
					throw error;
				}
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	},

	/** Called only under task admission. The advance and its history entry commit together. */
	async recordMissed(task: ScheduledTask, until: Date) {
		const slice = missedScheduleSlice(
			{ ...task, nextRunAt: task.nextRunAt ?? nextTaskOccurrence(task) },
			until,
		);
		if (!slice) return;
		const waiting = await readQuery(
			db.query.scheduledTaskRuns.findFirst({
				where: and(eq(scheduledTaskRuns.taskId, task.id), eq(scheduledTaskRuns.status, "waiting")),
				columns: { id: true },
			}),
			{ executionPolicy: "worker-required" },
		);
		const ts = stamp(task.updatedAt);
		const runId = generateId();
		db.transaction((tx) => {
			const rows = tx
				.update(scheduledTasks)
				.set({
					firedCount: slice.firedCount,
					scheduleCursorAt: slice.scheduleCursorAt,
					nextRunAt: task.enabled || readTaskSchedule(task).kind === "at" ? slice.nextRunAt : null,
					completedAt: !slice.nextRunAt && !task.activeRunId && !waiting ? ts : null,
					lastRunId: runId,
					lastStatus: "missed",
					lastRunAt: ts,
					lastError: null,
					lastOutcome: null,
					lastSummary: null,
					updatedAt: ts,
				})
				.where(
					and(
						rowVersion(task),
						task.nextRunAt
							? eq(scheduledTasks.nextRunAt, task.nextRunAt)
							: isNull(scheduledTasks.nextRunAt),
					),
				)
				.returning({ id: scheduledTasks.id })
				.all();
			if (!rows.length) throw conflict();
			tx.insert(scheduledTaskRuns)
				.values({
					id: runId,
					taskId: task.id,
					status: "missed",
					runContext: normalizeRunContext(task.runContext),
					requireReport: task.requireReport,
					scheduledFor: slice.first,
					missedCount: slice.count,
					finishedAt: ts,
					createdAt: ts,
				})
				.run();
		});
		changed();
	},

	/** Pausing freezes repeat counts, not a calendar end date. Sweep a bounded keyset page. */
	async reconcilePausedTasks() {
		const rows = await readQuery(
			db
				.select({ id: scheduledTasks.id })
				.from(scheduledTasks)
				.where(
					and(
						eq(scheduledTasks.enabled, false),
						isNull(scheduledTasks.completedAt),
						gt(scheduledTasks.id, pausedSweep.cursor),
					),
				)
				.orderBy(asc(scheduledTasks.id))
				.limit(DUE_BATCH),
			{ executionPolicy: "worker-required" },
		);
		pausedSweep.cursor = rows.length === DUE_BATCH ? (rows.at(-1)?.id ?? "") : "";
		for (const row of rows) await this.reconcileCompletion(row.id);
	},
	async reconcileCompletion(id: string) {
		let task = await this.get(id);
		if (!task || task.activeRunId || task.completedAt) return;
		task = await normalizeLegacyTask(task);
		const active = await readQuery(
			db
				.select({ id: scheduledTaskRuns.id })
				.from(scheduledTaskRuns)
				.where(
					and(
						eq(scheduledTaskRuns.taskId, id),
						inArray(scheduledTaskRuns.status, UNFINISHED_RUN_STATUSES),
					),
				)
				.limit(1),
			{ executionPolicy: "worker-required" },
		);
		if (active.length) return;
		const schedule = readTaskSchedule(task);
		const next = nextTaskOccurrence(
			task,
			!task.enabled && schedule.kind !== "at" ? new Date() : undefined,
		);
		const pending = task.enabled || schedule.kind === "at" ? next : null;
		if (next && task.nextRunAt === pending) return;
		await db
			.update(scheduledTasks)
			.set({
				completedAt: next ? null : stamp(),
				nextRunAt: pending,
				updatedAt: stamp(task.updatedAt),
			})
			.where(and(rowVersion(task), isNull(scheduledTasks.activeRunId)));
		changed();
	},

	async runTask(
		id: string,
		opts: ScheduledTaskMutationOptions & {
			manual?: boolean;
			principal?: ScheduledTaskPrincipal;
			at?: Date;
		} = {},
	): Promise<void> {
		const caller = opts.manual ? await actor(opts.principal) : undefined;
		const runId = await locks.acquire(id, async () => {
			let task = await this.get(id);
			if (!task) throw new NotFoundError("ScheduledTask", id);
			if (caller) await assertTaskAccess(task, caller, "edit");
			assertApprovedVersion(task, opts);
			const at = opts.at ?? new Date();
			task = await normalizeLegacyTask(task, at);
			if (!opts.manual) {
				if (task.completedAt || !task.nextRunAt || task.nextRunAt > at.toISOString()) return;
				if (!task.enabled) {
					if (readTaskSchedule(task).kind === "at") await this.recordMissed(task, at);
					return;
				}
				if (at.getTime() - new Date(task.nextRunAt).getTime() > MISFIRE_TOLERANCE_MS) {
					await this.recordMissed(task, new Date(at.getTime() - MISFIRE_TOLERANCE_MS));
					task = await this.get(id);
					if (
						!task?.nextRunAt ||
						task.nextRunAt > at.toISOString() ||
						at.getTime() - new Date(task.nextRunAt).getTime() > MISFIRE_TOLERANCE_MS
					)
						return;
				}
			}
			if (caller && task.narratorMode === "existing") {
				await validateExistingTarget(
					task,
					await resolveTaskPrincipal(taskOwnerId(task)),
					caller,
					opts,
				);
			}
			return acceptScheduledTaskRun(task, { manual: opts.manual === true, at });
		});
		if (runId) await advanceScheduledTaskRun(runId);
	},

	/** Resolve only task-created sessions; a forged reuse pointer cannot mutate an ordinary session. */
	async resolveNarrator(task: ScheduledTask, principal: ScheduledTaskPrincipal) {
		if (task.narratorMode === "existing")
			return (await resolveScheduledTaskTarget(principal, task.targetNarratorId ?? "")).target;
		let cwd = task.cwd;
		let contextProjectId: string | null = null;
		if (normalizeRunContext(task.runContext) === "project") {
			const project = await assertTaskProjectWrite(task.projectId, principal);
			contextProjectId = project.id;
			cwd ??= project.gitPath;
		}
		if (task.narratorMode === "reuse" && task.reuseNarratorId) {
			const existing = await narratorService.getById(task.reuseNarratorId).catch((error) => {
				if (error instanceof NotFoundError) return null;
				throw error;
			});
			if (
				existing &&
				existing.status !== "archived" &&
				(existing.scheduledTaskId === null || existing.scheduledTaskId === task.id) &&
				(await canWriteNarrator(existing, principal))
			)
				return existing;
		}
		return narratorService.create({
			contextProjectId,
			cwd: cwd ?? getHome(),
			model: task.model ?? undefined,
			permissionMode: task.permissionMode,
			systemPrompt: task.systemPrompt ?? undefined,
			startInPlanMode: false,
			title: task.name,
			ownerUserId: principal.userId,
			extraTraits: ["scheduled"],
			scheduledTaskId: task.id,
		});
	},

	async listRuns(
		taskId: string,
		opts: {
			limit?: number;
			cursor?: string | null;
			principal?: ScheduledTaskPrincipal;
			result?: RunVerdict;
		} = {},
	) {
		const live = await actor(opts.principal);
		const task = await this.get(taskId);
		await assertTaskAccess(task, live);
		if (!task) throw new NotFoundError("ScheduledTask", taskId);
		const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
		let cursor: { at: string; id: string } | undefined;
		if (opts.cursor) {
			try {
				if (opts.cursor.length > 300) throw new Error("oversized");
				const value = JSON.parse(Buffer.from(opts.cursor, "base64url").toString());
				if (
					typeof value.at !== "string" ||
					value.at.length > 40 ||
					Number.isNaN(Date.parse(value.at)) ||
					typeof value.id !== "string" ||
					value.id.length > 100
				)
					throw new Error("invalid");
				cursor = value;
			} catch {
				throw new ValidationError("Invalid run history cursor");
			}
		}
		const verdict = verdictExpression(
			scheduledTaskRuns.status,
			scheduledTaskRuns.outcome,
			scheduledTaskRuns.requireReport,
		);
		const rows = await readQuery(
			db
				.select()
				.from(scheduledTaskRuns)
				.where(
					and(
						eq(scheduledTaskRuns.taskId, taskId),
						cursor
							? or(
									lt(scheduledTaskRuns.createdAt, cursor.at),
									and(
										eq(scheduledTaskRuns.createdAt, cursor.at),
										lt(scheduledTaskRuns.id, cursor.id),
									),
								)
							: undefined,
						opts.result ? eq(verdict, opts.result) : undefined,
					),
				)
				.orderBy(desc(scheduledTaskRuns.createdAt), desc(scheduledTaskRuns.id))
				.limit(limit + 1),
			{ executionPolicy: "worker-required" },
		);
		const items = rows.slice(0, limit);
		const canSeeOutput = canEditTask(task, live);
		const narratorIds = [
			...new Set(items.flatMap((run) => (run.narratorId ? [run.narratorId] : []))),
		];
		const targets = narratorIds.length
			? await readQuery(
					db.query.narrators.findMany({
						where: inArray(narrators.id, narratorIds),
						limit,
						columns: {
							id: true,
							type: true,
							ownerUserId: true,
							visibility: true,
							writeAudience: true,
							contextProjectId: true,
							aclRootNarratorId: true,
						},
					}),
					{ executionPolicy: "worker-required" },
				)
			: [];
		const readableTargets = new Set<string>();
		for (const target of targets)
			if (await canReadNarrator(target, live)) readableTargets.add(target.id);
		const runs = items.map((run) => ({
			...run,
			narratorId: run.narratorId && readableTargets.has(run.narratorId) ? run.narratorId : null,
			triggerMessageId:
				run.narratorId && readableTargets.has(run.narratorId) ? run.triggerMessageId : null,
			trigger: run.manual ? "manual" : run.trigger,
			verdict: runVerdict(run.status, run.outcome, run.requireReport),
			error: canSeeOutput ? run.error : null,
			outcomeSummary: canSeeOutput ? run.outcomeSummary : null,
			autoHandled: canSeeOutput ? run.autoHandled : null,
		}));
		const last = items.at(-1);
		return {
			runs,
			nextCursor:
				rows.length > limit && last
					? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString("base64url")
					: null,
		};
	},
};
