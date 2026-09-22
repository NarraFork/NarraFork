/**
 * Read-only diagnostics for a refused file-revert preview.
 *
 * The planner collapses ACTIVE_WRITER/BUSY into one coarse `unavailable` reason so
 * it never pretends a half-known window is an empty change set. That is correct
 * for safety and useless for the person staring at "file rollback unavailable":
 * they need to know WHICH call or lease is still holding the workspace.
 *
 * This collector only reads bounded, indexed projections. It does not settle,
 * interrupt, or authorize anything, and it never becomes a public cross-project
 * endpoint.
 */
import { and, asc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
	fileChangeOperations,
	fileChangeScopes,
	narrators,
	narratorToolCalls,
	workspaceWriteLeases,
} from "../db/schema";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import {
	compactLocks,
	hasNarratorAdmissionWork,
	isNarratorRuntimeBusy,
} from "./narrator-session-state";

/** Wire shape shared with the frontend confirm dialog. Keep kinds stable. */
export type RevertBlockerKind =
	| "running_tool"
	| "uncoordinated_activity"
	| "write_lease"
	| "pending_mutation"
	| "recovery_hold"
	| "narrator_busy"
	| "planner_busy"
	| "scope_not_active"
	| "pending_operation";

export interface RevertBlocker {
	kind: RevertBlockerKind;
	toolCallId?: string;
	toolName?: string;
	operationId?: string;
	messageId?: string;
	leaseId?: string;
	detail?: string;
}

/** Per-source caps. Total stays small enough for a confirm dialog list. */
const LIMITS = {
	runningTools: 12,
	pendingOperations: 8,
	writeLeases: 8,
	busyScopes: 6,
} as const;

const SETTLED_LEASE_STATUSES = new Set(["settled", "recovered"]);

/** Cap free-text detail before it reaches the confirm dialog. */
export function boundedDetail(value: unknown, max = 160): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Only author-written description (and, last, a search pattern) is safe to show.
 * Never surface `command` or `file_path`: shell lines can carry tokens and paths
 * are absolute filesystem locations belonging to other workspaces.
 */
function toolDetail(input: Record<string, unknown> | null): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	return boundedDetail(input.description) ?? boundedDetail(input.pattern);
}

type ScopePathRow = {
	canonicalRoot: string;
	displayRoot: string;
	pathFlavor: "posix" | "windows";
};

/**
 * True when the scope root and the narrator cwd sit on the same workspace tree
 * (either may be the parent). Used to drop foreign-workspace lease/scope rows
 * so their absolute roots never enter diagnostics.
 */
function isWorkspaceRelatedScope(narratorCwd: string, scope: ScopePathRow): boolean {
	const paths = targetPathSemantics(scope.pathFlavor);
	return (
		paths.contains(scope.canonicalRoot, narratorCwd) ||
		paths.contains(narratorCwd, scope.canonicalRoot) ||
		paths.contains(scope.displayRoot, narratorCwd) ||
		paths.contains(narratorCwd, scope.displayRoot)
	);
}

/**
 * Loose SQL prefilter for path containment (both directions, either root).
 * Exact relation is confirmed in JS with pathFlavor; this only keeps the LIMIT
 * window filled with candidates that can belong to this workspace.
 */
function workspaceRootSqlFilter(narratorCwd: string) {
	const rootA = fileChangeScopes.canonicalRoot;
	const rootB = fileChangeScopes.displayRoot;
	return sql`(
		${rootA} = ${narratorCwd}
		OR ${rootB} = ${narratorCwd}
		OR ${narratorCwd} LIKE ${rootA} || '/%'
		OR ${narratorCwd} LIKE ${rootA} || '\%'
		OR ${rootA} LIKE ${narratorCwd} || '/%'
		OR ${rootA} LIKE ${narratorCwd} || '\%'
		OR ${narratorCwd} LIKE ${rootB} || '/%'
		OR ${narratorCwd} LIKE ${rootB} || '\%'
		OR ${rootB} LIKE ${narratorCwd} || '/%'
		OR ${rootB} LIKE ${narratorCwd} || '\%'
	)`;
}

/**
 * Collect what is currently refusing a safe file rollback for this narrator.
 *
 * When `code` names a planner/concurrency busy (not workspace activity), prefer
 * that single high-signal blocker over a noisy tool inventory.
 */
export function collectRevertBlockers(narratorId: string, code?: string): RevertBlocker[] {
	const blockers: RevertBlocker[] = [];

	if (code === "REVERT_PLANNER_BUSY" || /PLANNER_BUSY/.test(code ?? "")) {
		blockers.push({
			kind: "planner_busy",
			detail: "Another revert preview preparation is already running",
		});
		return blockers;
	}

	const narratorCwd = db
		.select({ cwd: narrators.cwd })
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.get()?.cwd;

	// Include other narrators sharing this workspace: a concurrent writer is
	// exactly the ACTIVE_WRITER case users cannot see from their own timeline.
	const runningTools = db
		.select({
			id: narratorToolCalls.id,
			narratorId: narratorToolCalls.narratorId,
			toolName: narratorToolCalls.toolName,
			toolUseId: narratorToolCalls.toolUseId,
			messageId: narratorToolCalls.messageId,
			isBackground: narratorToolCalls.isBackground,
			status: narratorToolCalls.status,
			inputJson: narratorToolCalls.inputJson,
		})
		.from(narratorToolCalls)
		.where(
			and(
				sql`${narratorToolCalls.status} IN ('initializing','pending','running')`,
				narratorCwd
					? or(
							eq(narratorToolCalls.narratorId, narratorId),
							eq(narratorToolCalls.executionCwd, narratorCwd),
						)
					: eq(narratorToolCalls.narratorId, narratorId),
			),
		)
		.orderBy(asc(narratorToolCalls.createdAt), asc(narratorToolCalls.id))
		.limit(LIMITS.runningTools)
		.all();

	for (const tool of runningTools) {
		const foreign = tool.narratorId !== narratorId;
		blockers.push({
			kind: foreign ? "uncoordinated_activity" : "running_tool",
			toolCallId: tool.id,
			toolName: tool.toolName,
			messageId: tool.messageId,
			detail: boundedDetail(
				[
					foreign ? `narrator ${tool.narratorId}` : null,
					toolDetail(tool.inputJson as Record<string, unknown> | null),
				]
					.filter(Boolean)
					.join(": "),
			),
		});
	}

	const unfinishedOps = db
		.select({
			id: fileChangeOperations.id,
			toolCallId: fileChangeOperations.toolCallId,
			toolUseId: fileChangeOperations.toolUseId,
			settlement: fileChangeOperations.settlement,
			executionOutcome: fileChangeOperations.executionOutcome,
			reason: fileChangeOperations.reason,
			sourceKind: fileChangeOperations.sourceKind,
		})
		.from(fileChangeOperations)
		.where(
			and(
				eq(fileChangeOperations.narratorId, narratorId),
				or(
					ne(fileChangeOperations.settlement, "settled"),
					sql`${fileChangeOperations.finishedAt} IS NULL`,
					eq(fileChangeOperations.executionOutcome, "running"),
				),
			),
		)
		.orderBy(asc(fileChangeOperations.updatedAt), asc(fileChangeOperations.id))
		.limit(LIMITS.pendingOperations)
		.all();

	for (const op of unfinishedOps) {
		blockers.push({
			kind: "pending_operation",
			operationId: op.id,
			toolCallId: op.toolCallId ?? undefined,
			detail: boundedDetail(
				op.reason ?? `${op.sourceKind}/${op.settlement}/${op.executionOutcome}`,
			),
		});
	}

	// Prefer under-reporting over listing foreign workspaces: without a known cwd
	// (or without a related scope root) there is no safe way to attribute a lease.
	const leases = narratorCwd
		? db
				.select({
					leaseId: workspaceWriteLeases.leaseId,
					status: workspaceWriteLeases.status,
					executionEndedAt: workspaceWriteLeases.executionEndedAt,
					scopeId: workspaceWriteLeases.scopeId,
					canonicalRoot: fileChangeScopes.canonicalRoot,
					displayRoot: fileChangeScopes.displayRoot,
					pathFlavor: fileChangeScopes.pathFlavor,
				})
				.from(workspaceWriteLeases)
				.innerJoin(fileChangeScopes, eq(workspaceWriteLeases.scopeId, fileChangeScopes.id))
				.where(
					and(
						or(
							sql`${workspaceWriteLeases.status} IN ('executing','quarantined')`,
							and(
								sql`${workspaceWriteLeases.status} IN ('settled','recovered')`,
								sql`${workspaceWriteLeases.executionEndedAt} IS NULL`,
							),
						),
						workspaceRootSqlFilter(narratorCwd),
					),
				)
				.orderBy(asc(workspaceWriteLeases.updatedAt), asc(workspaceWriteLeases.leaseId))
				.limit(LIMITS.writeLeases)
				.all()
				.filter((lease) => isWorkspaceRelatedScope(narratorCwd, lease))
		: [];

	for (const lease of leases) {
		// Terminal leases with an ended execution are history, not blockers.
		if (SETTLED_LEASE_STATUSES.has(lease.status) && lease.executionEndedAt) continue;
		blockers.push({
			kind:
				lease.status === "quarantined" ||
				(SETTLED_LEASE_STATUSES.has(lease.status) && !lease.executionEndedAt)
					? "recovery_hold"
					: "write_lease",
			leaseId: lease.leaseId,
			// Never put displayRoot/canonicalRoot in detail: absolute paths of other
			// installs must not reach the confirm dialog even for related rows.
			detail: boundedDetail(`${lease.status}${lease.executionEndedAt ? "" : " (execution open)"}`),
		});
	}

	const busyScopes = narratorCwd
		? db
				.select({
					id: fileChangeScopes.id,
					status: fileChangeScopes.status,
					activeLeaseId: fileChangeScopes.activeLeaseId,
					activeMutationCount: fileChangeScopes.activeMutationCount,
					canonicalRoot: fileChangeScopes.canonicalRoot,
					displayRoot: fileChangeScopes.displayRoot,
					pathFlavor: fileChangeScopes.pathFlavor,
				})
				.from(fileChangeScopes)
				.where(
					and(
						or(
							ne(fileChangeScopes.status, "active"),
							isNotNull(fileChangeScopes.activeLeaseId),
							sql`${fileChangeScopes.activeMutationCount} > 0`,
						),
						workspaceRootSqlFilter(narratorCwd),
					),
				)
				.orderBy(asc(fileChangeScopes.updatedAt), asc(fileChangeScopes.id))
				.limit(LIMITS.busyScopes)
				.all()
				.filter((scope) => isWorkspaceRelatedScope(narratorCwd, scope))
		: [];

	for (const scope of busyScopes) {
		if (scope.activeMutationCount > 0) {
			blockers.push({
				kind: "pending_mutation",
				leaseId: scope.activeLeaseId ?? undefined,
				detail: boundedDetail(`${scope.activeMutationCount} unsettled mutation(s)`),
			});
		}
		if (scope.status !== "active") {
			blockers.push({
				kind: "scope_not_active",
				leaseId: scope.activeLeaseId ?? undefined,
				detail: boundedDetail(`scope ${scope.status}`),
			});
		}
	}

	if (
		compactLocks.has(narratorId) ||
		isNarratorRuntimeBusy(narratorId) ||
		hasNarratorAdmissionWork(narratorId)
	) {
		const parts: string[] = [];
		if (compactLocks.has(narratorId)) parts.push("compact lock");
		if (isNarratorRuntimeBusy(narratorId)) parts.push("loop or tool execution");
		if (hasNarratorAdmissionWork(narratorId)) parts.push("admission work still settling");
		blockers.push({
			kind: "narrator_busy",
			detail: boundedDetail(parts.join(", ")),
		});
	}

	return blockers;
}
