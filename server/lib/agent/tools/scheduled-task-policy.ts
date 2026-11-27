import { createHash } from "node:crypto";
import { normalizeRunContext } from "@shared/scheduled-task-run-context";
import {
	describeScheduleEn,
	parseSchedule,
	type TaskSchedule,
} from "@shared/scheduled-task-schedule";
import type { ScheduledTaskPrincipal } from "../../../services/scheduled-task-acl";
import {
	normalizeLegacyPermissionMode,
	type PermissionMode,
	resolveEffectiveRelaxedPlan,
} from "../../permission-modes";
import {
	checkSchedule,
	defaultAnchor,
	previewOccurrences,
	resolveTimeZone,
} from "../../schedule-engine";
import type { ToolContext } from "../types";
import { isScheduledTaskReadAction } from "./scheduled-task-actions";
import {
	type ScheduledTaskFields,
	scheduledTaskFieldsSchema,
	scheduledTaskParametersSchema,
	validateScheduledTaskArguments,
} from "./scheduled-task-schema";

export type ScheduledTaskPolicyContext = Pick<
	ToolContext,
	"narratorId" | "userId" | "runtimePolicy"
> &
	Partial<Pick<ToolContext, "cwd" | "locale">>;

async function callerContext(ctx: ScheduledTaskPolicyContext) {
	const [
		{ db },
		{ narrators },
		{ eq },
		{ resolveNarratorProjectId },
		{ resolveNarratorCapabilities },
		{ integrationResourceBindingService },
	] = await Promise.all([
		import("@server/db"),
		import("@server/db/schema"),
		import("drizzle-orm"),
		import("../../../services/narrator-project"),
		import("../../../services/trait-layer-service"),
		import("../../../services/integration-resource-binding-service"),
	]);
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, ctx.narratorId),
		columns: {
			id: true,
			title: true,
			cwd: true,
			contextProjectId: true,
			permissionMode: true,
			traits: true,
			relaxedPlan: true,
			model: true,
			defaultDeviceId: true,
			oauthOwnerGrantId: true,
			oauthPolicySnapshotJson: true,
		},
	});
	if (!row) throw new Error("Calling narrator no longer exists.");
	const [projectId, capabilities, binding] = await Promise.all([
		resolveNarratorProjectId(row),
		resolveNarratorCapabilities(row.id, ctx.userId ?? null),
		integrationResourceBindingService.get("narrator", row.id),
	]);
	return {
		...row,
		projectId,
		capabilities,
		externallyBound: !!binding || !!row.oauthOwnerGrantId || !!row.oauthPolicySnapshotJson,
	};
}

type Caller = Awaited<ReturnType<typeof callerContext>>;

/** Conservative, deliberately not a rank: dontAsk/default grant different behaviors. */
export function expandsScheduledTaskPermission(from: PermissionMode, to: PermissionMode): boolean {
	if (from === to || to === "readOnly" || from === "bypassPermissions") return false;
	if (from === "acceptEdits" && to === "default") return false;
	return true;
}

function isRestrictedPolicy(policy: NonNullable<ToolContext["runtimePolicy"]>): boolean {
	return (
		policy.tools.builtin !== "all" ||
		policy.tools.mcpNames !== "all" ||
		policy.tools.mcp !== "nonDenied" ||
		policy.tools.readOnly ||
		policy.readOnlyGitShell ||
		policy.searchOnly ||
		!policy.continuation.promoteTodo ||
		policy.continuation.maxPasses !== null ||
		Object.values(policy.capabilities).some((value) => value === false || value === "disabled")
	);
}

async function assertDelegable(caller: Caller, ctx: ScheduledTaskPolicyContext): Promise<void> {
	const { getDisabledToolSet, getBlockedSkills } = await import("../../narrator-custom-traits");
	const traits = caller.capabilities.traits.traits;
	const blocked = getBlockedSkills(traits);
	if (
		caller.externallyBound ||
		caller.defaultDeviceId ||
		isRestrictedPolicy(caller.capabilities.policy) ||
		(ctx.runtimePolicy && isRestrictedPolicy(ctx.runtimePolicy)) ||
		getDisabledToolSet(traits).size ||
		blocked.all ||
		blocked.names.size
	) {
		throw new Error(
			"This session has a hard capability/OAuth/device/tool restriction. Safe delegation of that restriction to scheduled tasks is not supported; it cannot create or expand scheduled execution authority.",
		);
	}
	const { executionPolicyRepository } = await import(
		"../../../services/execution-policy/repository"
	);
	const rules = await executionPolicyRepository.load(caller.id);
	// Global deny rules apply to every future session. Narrator/project denies
	// are not persisted on tasks, so delegating them would erase a hard fence.
	if (
		[...rules.directoryBlacklist, ...rules.commandBlacklist].some(
			(rule) => rule.enabled && rule.source !== "global",
		)
	) {
		throw new Error(
			"This session has a hard capability restriction from narrator/project deny rules that scheduled tasks cannot safely inherit.",
		);
	}
}

/** Service-side second gate. No dependency on scheduled-task-service, so CRUD may call it safely. */
export async function assertNarratorMayDelegateScheduledTask(
	narratorId: string,
	userId: string,
): Promise<void> {
	const ctx = { narratorId, userId };
	const caller = await callerContext(ctx);
	await assertMutationMode(caller);
	await assertDelegable(caller, ctx);
	const { lookupScheduledRun } = await import("../../../services/scheduled-task-run-service");
	if (await lookupScheduledRun(narratorId))
		throw new Error(
			"An active scheduled run cannot create or modify scheduled tasks; it may only disable itself.",
		);
}

async function assertMutationMode(caller: Caller): Promise<void> {
	const { isPlanModeTrait } = await import("../../narrator-utils");
	if (
		caller.permissionMode === "readOnly" ||
		caller.permissionMode === "dontAsk" ||
		caller.capabilities.policy.tools.readOnly ||
		caller.capabilities.policy.readOnlyGitShell ||
		(isPlanModeTrait(caller.traits) &&
			!resolveEffectiveRelaxedPlan(caller.permissionMode, caller.relaxedPlan))
	) {
		throw new Error(
			"Scheduled task mutations are denied in readOnly, dontAsk or strict plan mode.",
		);
	}
}

export function previewScheduledTask(
	fields: Pick<ScheduledTaskFields, "schedule" | "cronExpr" | "timezone">,
	options: { requireFuture?: boolean; firedCount?: number; count?: number } = {},
) {
	const timezone = resolveTimeZone(fields.timezone);
	let source: unknown =
		fields.schedule ??
		(fields.cronExpr ? { kind: "cron", expr: fields.cronExpr, end: { type: "never" } } : undefined);
	if (fields.schedule?.kind === "repeat" && !fields.schedule.anchorAt)
		source = {
			...fields.schedule,
			anchorAt: defaultAnchor(timezone, new Date(), fields.schedule.startAt),
		};
	const parsed = parseSchedule(source);
	if (!parsed.ok) throw new Error(`Invalid schedule: ${parsed.issue.code} (${parsed.issue.path}).`);
	const validation = checkSchedule(parsed.schedule, timezone, {
		requireFuture: options.requireFuture,
	});
	if (!validation.ok)
		throw new Error(
			`Invalid ${parsed.schedule.kind === "cron" ? "cron expression / " : ""}schedule: ${validation.code} (${validation.path}; ${timezone}).`,
		);
	return {
		schedule: parsed.schedule,
		timezone,
		description: describeScheduleEn(parsed.schedule, timezone),
		...previewOccurrences(parsed.schedule, timezone, {
			count: options.count ?? 3,
			firedCount: options.firedCount,
		}),
	};
}

function approvalFields(fields: ScheduledTaskFields, canSeePrompt: boolean): ScheduledTaskFields {
	if (canSeePrompt) return fields;
	const visible = { ...fields };
	delete visible.prompt;
	delete visible.systemPrompt;
	return visible;
}

/** Both the approval path and execute path call this, with a live user role and task ACL. */
export async function resolveScheduledTaskApproval(
	ctx: ScheduledTaskPolicyContext,
	raw: Record<string, unknown>,
): Promise<{
	input: Record<string, unknown>;
	approval: Record<string, unknown> & {
		expectedTarget?: { id: string; fingerprint: string } | null;
	};
	principal: ScheduledTaskPrincipal;
}> {
	const {
		resolveTaskPrincipal,
		assertTaskAccess,
		assertTaskProjectWrite,
		canEditTask,
		taskOwnerId,
	} = await import("../../../services/scheduled-task-acl");
	const principal = await resolveTaskPrincipal(ctx.userId);
	const { scheduledTaskService: service } = await import(
		"../../../services/scheduled-task-service"
	);
	const parsed = scheduledTaskParametersSchema.parse(raw);
	validateScheduledTaskArguments(parsed);
	const { action, id } = parsed;
	// Disable acts only on persisted task state; ignored patches must not redirect
	// its project lookup or expose unreviewed fields in the approval.
	if (action === "disable") parsed.task = undefined;
	const { lookupScheduledRun } = await import("../../../services/scheduled-task-run-service");
	const active = await lookupScheduledRun(ctx.narratorId);
	if (active && !(id === active.taskId && ["get", "runs", "disable"].includes(action)))
		throw new Error(
			"An active scheduled run may only read its own task/history, report its result, or disable itself.",
		);
	if (isScheduledTaskReadAction(action)) {
		if (id) await assertTaskAccess(await service.get(id), principal);
		return { input: parsed, approval: {}, principal };
	}

	const caller = await callerContext(ctx);
	await assertMutationMode(caller);
	// Disabling reduces authority. Every other mutation could create, arm, execute or erase it.
	if (action !== "disable") await assertDelegable(caller, ctx);
	const existing = id ? await service.get(id) : undefined;
	if (id)
		await assertTaskAccess(
			existing,
			principal,
			["enable", "disable"].includes(action) ? "pause" : "edit",
		);
	const canSeePrompt = !existing || canEditTask(existing, principal);
	const before = existing
		? scheduledTaskFieldsSchema.parse({
				...existing,
				runContext: normalizeRunContext(existing.runContext),
				schedule: existing.schedule ?? undefined,
				cronExpr: existing.schedule ? undefined : existing.cronExpr,
			})
		: undefined;
	let fields: ScheduledTaskFields = { ...before, ...parsed.task };
	if (parsed.task?.cronExpr) delete fields.schedule;
	if (parsed.task?.schedule) delete fields.cronExpr;
	const existingMode = fields.narratorMode === "existing";
	if (action === "create") {
		fields = {
			...(existingMode
				? { model: null, modelPolicy: "follow" as const }
				: {
						permissionMode: normalizeLegacyPermissionMode(caller.permissionMode),
						cwd: ctx.cwd ?? caller.cwd,
						projectId: caller.projectId,
						runContext: caller.projectId ? ("project" as const) : ("standalone" as const),
						model: caller.model,
						modelPolicy: "sync" as const,
					}),
			narratorMode: "new",
			targetNarratorId: null,
			contextPolicy: "keep",
			onBusy: "skip",
			busyWaitMinutes: 30,
			requireReport: true,
			onBlocked: "auto",
			blockedWaitMinutes: 30,
			maxRunMinutes: 60,
			notifyOnSuccess: false,
			enabled: true,
			...fields,
		};
	}
	if (existingMode && before?.narratorMode !== "existing" && !parsed.task?.modelPolicy)
		fields.modelPolicy = "follow";
	if (!existingMode && parsed.task?.narratorMode) fields.targetNarratorId = null;

	const { resolveScheduledTaskTarget } = await import("../../../services/scheduled-task-target");
	const needsTarget = existingMode && action !== "disable" && action !== "delete";
	let resolvedTarget: Awaited<ReturnType<typeof resolveScheduledTaskTarget>> | undefined;
	const ownerUserId = existing ? taskOwnerId(existing) : principal.userId;
	if (existingMode) {
		if (!fields.targetNarratorId && needsTarget)
			throw new Error("existing mode requires task.targetNarratorId.");
		if (fields.targetNarratorId) {
			try {
				resolvedTarget = await resolveScheduledTaskTarget(principal, fields.targetNarratorId);
				if (needsTarget) {
					const owner = await resolveTaskPrincipal(ownerUserId);
					if (owner.userId !== principal.userId) {
						const forOwner = await resolveScheduledTaskTarget(owner, fields.targetNarratorId);
						if (forOwner.fingerprint !== resolvedTarget.fingerprint)
							throw new Error("Target configuration changed while preparing approval. Try again.");
					}
				}
			} catch (error) {
				// A task must remain removable/pausable after its target disappears or revokes access.
				if (needsTarget) throw error;
			}
		}
		// Existing sessions own their environment. Never persist the caller's scope or
		// accept task settings as an override for the target's execution authority.
		fields.cwd = null;
		fields.projectId = null;
		fields.runContext = "standalone";
		fields.systemPrompt = null;
		delete fields.permissionMode;
	} else {
		if (fields.cwd == null && (action === "create" || parsed.task?.cwd === null))
			fields.cwd = ctx.cwd ?? caller.cwd;
		if (fields.permissionMode == null)
			fields.permissionMode = normalizeLegacyPermissionMode(caller.permissionMode);
	}
	let project: { gitPath: string | null } | undefined;
	if (!existingMode && fields.runContext === "project") {
		if (action === "disable") {
			// The task's pause ACL is sufficient to stop execution, even after project
			// write access is revoked. Read only the root needed to display its scope.
			const [{ db }, { projects }, { eq }] = await Promise.all([
				import("@server/db"),
				import("@server/db/schema"),
				import("drizzle-orm"),
			]);
			project = fields.projectId
				? await db.query.projects.findFirst({
						where: eq(projects.id, fields.projectId),
						columns: { gitPath: true },
					})
				: undefined;
		} else project = await assertTaskProjectWrite(fields.projectId, principal);
	} else fields.projectId = null;
	// Legacy tasks without a stored cwd run at the project root or server home.
	// Existing tasks instead use the target's live environment, without a project-write gate.
	const effectiveCwd = existingMode
		? (resolvedTarget?.target.cwd ?? null)
		: (fields.cwd ?? project?.gitPath ?? (await import("../../platform")).getHome());
	const target = resolvedTarget
		? {
				id: resolvedTarget.target.id,
				title: resolvedTarget.target.title,
				cwd: resolvedTarget.target.cwd,
				projectId: resolvedTarget.projectId,
				model: resolvedTarget.target.model,
				permissionMode: normalizeLegacyPermissionMode(resolvedTarget.target.permissionMode),
			}
		: null;
	let beforeTarget: { id: string; title: string | null } | null = null;
	if (before?.narratorMode === "existing" && before.targetNarratorId) {
		if (target?.id === before.targetNarratorId)
			beforeTarget = { id: target.id, title: target.title };
		else {
			try {
				const previous = await resolveScheduledTaskTarget(principal, before.targetNarratorId);
				beforeTarget = { id: previous.target.id, title: previous.target.title };
			} catch {
				// Do not reveal inaccessible target details or block changing away from it.
			}
		}
	}
	if (action === "enable" || action === "disable") fields.enabled = action === "enable";
	const preview = previewScheduledTask(fields, {
		requireFuture:
			action === "create" ||
			!!parsed.task?.schedule ||
			!!parsed.task?.cronExpr ||
			parsed.task?.timezone !== undefined,
		firedCount:
			action === "update" &&
			(parsed.task?.schedule || parsed.task?.cronExpr || parsed.task?.timezone !== undefined)
				? 0
				: existing?.firedCount,
	});
	fields = { ...fields, schedule: preview.schedule, timezone: preview.timezone };
	delete fields.cronExpr;
	const changed = Object.keys(fields).filter(
		(key) =>
			JSON.stringify(before?.[key as keyof ScheduledTaskFields]) !==
			JSON.stringify(fields[key as keyof ScheduledTaskFields]),
	);
	const inheritsModel = existingMode && (fields.modelPolicy === "follow" || !fields.model);
	const effectiveFields: ScheduledTaskFields = {
		...fields,
		cwd: effectiveCwd,
		...(target
			? {
					projectId: target.projectId,
					runContext: target.projectId ? "project" : "standalone",
					permissionMode: target.permissionMode,
					...(inheritsModel ? { model: target.model } : {}),
				}
			: {}),
	};
	const approval = {
		version: 1,
		action,
		id,
		task: approvalFields(effectiveFields, canSeePrompt),
		before: before ? approvalFields(before, canSeePrompt) : null,
		canSeePrompt,
		// Keep confidential fields in the freshness boundary without returning their
		// contents to project managers who may pause but may not inspect the prompt.
		expectedTaskFingerprint: before
			? createHash("sha256").update(JSON.stringify(before)).digest("hex")
			: null,
		changed,
		target,
		beforeTarget,
		inheritedFields: existingMode
			? [
					"cwd",
					"projectId",
					"runContext",
					"systemPrompt",
					"permissionMode",
					...(inheritsModel ? ["model"] : []),
				]
			: [],
		expectedTarget:
			needsTarget && resolvedTarget
				? { id: resolvedTarget.target.id, fingerprint: resolvedTarget.fingerprint }
				: null,
		expectedOwnerUserId: ownerUserId,
		description: preview.description,
		occurrences: preview.occurrences,
		finite: preview.finite,
		total: preview.total,
		endsAt: preview.endsAt,
		exhausted: preview.exhausted,
		callerPermissionMode: caller.permissionMode,
		elevated: expandsScheduledTaskPermission(
			normalizeLegacyPermissionMode(caller.permissionMode),
			normalizeLegacyPermissionMode(effectiveFields.permissionMode),
		),
		outsideScope:
			effectiveCwd !== (ctx.cwd ?? caller.cwd) || effectiveFields.projectId !== caller.projectId,
		selfDisable: !!active && action === "disable",
		// An approved update may not silently apply to a subsequently edited task.
		expectedUpdatedAt: existing?.updatedAt ?? null,
	};
	const task =
		action === "create"
			? fields
			: action === "update"
				? {
						...parsed.task,
						...(parsed.task?.schedule || parsed.task?.cronExpr
							? { schedule: preview.schedule, cronExpr: undefined }
							: {}),
						...(parsed.task?.timezone !== undefined ? { timezone: preview.timezone } : {}),
						...(parsed.task?.cwd === null ? { cwd: fields.cwd } : {}),
						...(existingMode && before?.narratorMode !== "existing" && !parsed.task?.modelPolicy
							? { modelPolicy: "follow" as const }
							: {}),
						...(!existingMode && parsed.task?.narratorMode ? { targetNarratorId: null } : {}),
					}
				: parsed.task;
	if (task && existingMode && (action === "create" || action === "update")) {
		task.cwd = null;
		task.projectId = null;
		task.runContext = "standalone";
		task.systemPrompt = null;
		delete task.permissionMode;
	}
	return { input: { ...parsed, task, _scheduledTaskApproval: approval }, approval, principal };
}

/** Approval metadata never grants authority; it only makes stale approvals fail closed. */
export function assertScheduledTaskApprovalFresh(
	raw: Record<string, unknown>,
	approval: Record<string, unknown>,
): void {
	const previous = raw._scheduledTaskApproval;
	if (!previous || typeof previous !== "object") return;
	const approved = previous as Record<string, unknown>;
	// Zod produces a stable field order; re-resolving defaults may otherwise reorder
	// equivalent objects and reject every approved creation as stale.
	const staleContext = [
		"action",
		"id",
		"expectedUpdatedAt",
		"expectedOwnerUserId",
		"expectedTaskFingerprint",
		"canSeePrompt",
		"callerPermissionMode",
		"elevated",
		"outsideScope",
		"selfDisable",
	].filter((key) => approved[key] !== approval[key]);
	const previousTarget = approved.expectedTarget as { id?: unknown; fingerprint?: unknown } | null;
	const currentTarget = approval.expectedTarget as { id?: unknown; fingerprint?: unknown } | null;
	if (
		previousTarget?.id !== currentTarget?.id ||
		previousTarget?.fingerprint !== currentTarget?.fingerprint
	)
		staleContext.push("target");
	if (
		JSON.stringify(scheduledTaskFieldsSchema.parse(approved.task)) !==
		JSON.stringify(scheduledTaskFieldsSchema.parse(approval.task))
	)
		staleContext.push("task");
	if (staleContext.length)
		throw new Error(
			`Task configuration or session authority changed since approval (${staleContext.join(", ")}). Submit a new request for review.`,
		);
}

export type { TaskSchedule };
