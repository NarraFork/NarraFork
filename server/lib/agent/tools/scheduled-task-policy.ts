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
	normalizeScheduledTaskInput,
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

/** Both the approval path and execute path call this, with a live user role and task ACL. */
export async function resolveScheduledTaskApproval(
	ctx: ScheduledTaskPolicyContext,
	raw: Record<string, unknown>,
	toolName: "ScheduledTask" | "ScheduledTaskAdmin" = "ScheduledTask",
): Promise<{
	input: Record<string, unknown>;
	approval: Record<string, unknown>;
	principal: ScheduledTaskPrincipal;
}> {
	const { resolveTaskPrincipal, assertTaskAccess, assertTaskProjectWrite } = await import(
		"../../../services/scheduled-task-acl"
	);
	const principal = await resolveTaskPrincipal(ctx.userId);
	if (toolName === "ScheduledTaskAdmin" && !principal.isAdmin)
		throw new Error("ScheduledTaskAdmin is restricted to administrators.");
	const input = normalizeScheduledTaskInput(raw, toolName === "ScheduledTaskAdmin");
	const { scheduledTaskService: service } = await import(
		"../../../services/scheduled-task-service"
	);
	// The historical toggle action means invert current state. Freeze the target state for approval.
	if (input.action === "toggle") {
		if (typeof input.id !== "string") throw new Error("'id' is required for toggle.");
		const existing = await service.get(input.id);
		await assertTaskAccess(existing, principal, "pause");
		input.action = existing?.enabled ? "disable" : "enable";
	}
	const parsed = scheduledTaskParametersSchema.parse(input);
	validateScheduledTaskArguments(parsed);
	const { action, id } = parsed;
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
	if (action === "create") {
		fields = {
			permissionMode: normalizeLegacyPermissionMode(caller.permissionMode),
			cwd: ctx.cwd ?? caller.cwd,
			projectId: caller.projectId,
			runContext: caller.projectId ? "project" : "standalone",
			model: caller.model,
			modelPolicy: "sync",
			narratorMode: "new",
			onBlocked: "auto",
			blockedWaitMinutes: 30,
			maxRunMinutes: 60,
			notifyOnSuccess: false,
			enabled: true,
			...fields,
		};
	}
	if (fields.cwd == null && (action === "create" || parsed.task?.cwd === null))
		fields.cwd = ctx.cwd ?? caller.cwd;
	if (fields.permissionMode == null)
		fields.permissionMode = normalizeLegacyPermissionMode(caller.permissionMode);
	const project =
		fields.runContext === "project"
			? await assertTaskProjectWrite(fields.projectId, principal)
			: undefined;
	if (!project) fields.projectId = null;
	// Legacy tasks without a stored cwd run at the project root or server home,
	// not at the caller's cwd. Display that effective scope without changing it.
	const effectiveCwd = fields.cwd ?? project?.gitPath ?? (await import("../../platform")).getHome();
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
	const approval = {
		version: 1,
		action,
		id,
		task: { ...fields, cwd: effectiveCwd },
		before: before ?? null,
		changed,
		description: preview.description,
		occurrences: preview.occurrences,
		finite: preview.finite,
		total: preview.total,
		endsAt: preview.endsAt,
		exhausted: preview.exhausted,
		callerPermissionMode: caller.permissionMode,
		elevated: expandsScheduledTaskPermission(
			normalizeLegacyPermissionMode(caller.permissionMode),
			normalizeLegacyPermissionMode(fields.permissionMode),
		),
		outsideScope: effectiveCwd !== (ctx.cwd ?? caller.cwd) || fields.projectId !== caller.projectId,
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
					}
				: parsed.task;
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
		"callerPermissionMode",
		"elevated",
		"outsideScope",
		"selfDisable",
	].some((key) => approved[key] !== approval[key]);
	if (
		staleContext ||
		JSON.stringify(scheduledTaskFieldsSchema.parse(approved.task)) !==
			JSON.stringify(scheduledTaskFieldsSchema.parse(approval.task))
	)
		throw new Error(
			"Task configuration or session authority changed since approval. Submit a new request for review.",
		);
}

export type { TaskSchedule };
