/**
 * Where a narrator's runtime relationships come from: its policy (and model) source,
 * its controller and the model pool it follows a source within.
 *
 * Every relationship is read from explicit storage — the `policy_source_narrator_id`
 * column and the runtime registration — never inferred from parent/variant/type.
 * Rows written before registrations existed are materialized into that storage once
 * (`legacy-delegation-materializer`).
 */
import { and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { narratorMessages, narrators } from "../db/schema";
import {
	type RunDeliverTo,
	type RuntimeRegistration,
	readRuntimeRegistrationColumn,
} from "./validators/runtime-registration";

export { MAX_POLICY_SOURCE_DEPTH } from "./validators/runtime-registration";

export interface RuntimeSourceRow {
	policySourceNarratorId?: string | null;
	runtimeRegistrationJson?: unknown;
}

/** Policy (and model) source of a narrator, or null when it follows nobody. */
export function policySourceIdOf(row: RuntimeSourceRow): string | null {
	// An unreadable registration is never treated as "nothing registered".
	readRuntimeRegistrationColumn(row.runtimeRegistrationJson);
	return row.policySourceNarratorId ?? null;
}

/** Rows whose policy source is `sourceId`. */
export function policyDependentsWhere(sourceId: string): SQL | undefined {
	return eq(narrators.policySourceNarratorId, sourceId);
}

/** Session-level control grant. Invalid registrations throw. */
export function controllerOf(row: RuntimeSourceRow): RuntimeRegistration["controller"] | null {
	return readRuntimeRegistrationColumn(row.runtimeRegistrationJson)?.controller ?? null;
}

/**
 * The team a narrator belongs to, named by its root: the narrator holding its session
 * control grant, else the recipient of its run, else the narrator itself. The grant
 * comes first because it is durable, while each run may deliver elsewhere. A team
 * member is any other narrator with the same root; a root is never its own member.
 */
export function teamRootOf(row: RuntimeSourceRow & { id: string }): string {
	return (
		controllerOf(row)?.narratorId ??
		readRuntimeRegistrationColumn(row.runtimeRegistrationJson)?.run?.deliverTo?.narratorId ??
		row.id
	);
}

/** Whether `row` is a member of `rootId`'s team. */
export function isTeamMember(row: RuntimeSourceRow & { id: string }, rootId: string): boolean {
	return row.id !== rootId && teamRootOf(row) === rootId;
}

/**
 * SQL form of {@link isTeamMember}. Delegation records its grant and its run's
 * recipient together with `parent_narrator_id`, so that index narrows the scan and the
 * registration decides membership.
 */
export function teamMembersWhere(rootId: string): SQL | undefined {
	return and(
		eq(narrators.parentNarratorId, rootId),
		sql`coalesce(json_extract(${narrators.runtimeRegistrationJson}, '$.controller.narratorId'), json_extract(${narrators.runtimeRegistrationJson}, '$.run.deliverTo.narratorId')) = ${rootId}`,
	);
}

/**
 * Model pool a narrator follows its source within, fixed at creation. Null means no
 * pool: following a source then simply uses the source's model.
 */
export function modelPoolKeyOf(row: RuntimeSourceRow): string | null {
	return readRuntimeRegistrationColumn(row.runtimeRegistrationJson)?.modelPool ?? null;
}

/** Where the current run's result is delivered (independent of historical mounts). */
export function runDeliverToOf(row: RuntimeSourceRow): RunDeliverTo | undefined {
	return readRuntimeRegistrationColumn(row.runtimeRegistrationJson)?.run?.deliverTo;
}

/**
 * A transcript may remain mounted under a historical tool after its live run has gone
 * away (imports/archives). This fact grants no delivery or control authority.
 */
export type OwnTurnPlacement = string | [string, string] | null;

export function ownTurnPlacementOf(row: RuntimeSourceRow): OwnTurnPlacement {
	const registration = readRuntimeRegistrationColumn(row.runtimeRegistrationJson);
	const historical = registration?.historyPlacement?.toolUseId;
	const current = registration?.run?.deliverTo?.toolUseId;
	// History and delivery are independent facts. Never replace the historical mount
	// when a new destination is registered; both own placements remain visible.
	if (historical) return current && current !== historical ? [historical, current] : historical;
	return current ?? null;
}

/**
 * The one "top-level message" rule of a session, for every kind of session alike:
 * a row is the session's own turn when it has no placement, or when it is placed under
 * either this session's historical mount or its current delivery mount
 * (`ownTurnPlacementOf`). Anything else is a nested transcript. Nothing here depends on
 * how the session was created. SQL form: `topLevelSql` / `ownTurnSql`.
 */
export function isTopLevelMessage(
	message: { parentToolUseId?: string | null },
	placement: OwnTurnPlacement | undefined,
): boolean {
	return (
		!message.parentToolUseId ||
		(Array.isArray(placement)
			? placement.includes(message.parentToolUseId)
			: !!placement && message.parentToolUseId === placement)
	);
}

/**
 * SQL form of {@link isTopLevelMessage} over `narrator_messages.parent_tool_use_id`.
 */
export function ownTurnSql(placement: OwnTurnPlacement): SQL | undefined {
	if (Array.isArray(placement))
		return or(
			isNull(narratorMessages.parentToolUseId),
			inArray(narratorMessages.parentToolUseId, placement),
		);
	return placement
		? or(isNull(narratorMessages.parentToolUseId), eq(narratorMessages.parentToolUseId, placement))
		: isNull(narratorMessages.parentToolUseId);
}

/** Columns every function above may read. */
export const RUNTIME_SOURCE_COLUMNS = {
	policySourceNarratorId: true,
	runtimeRegistrationJson: true,
} as const;

/**
 * This session's execution identity, never a message/notice author's identity.
 * `undefined` is unknown; `{ userId: null }` is explicitly anonymous. Outside a
 * registered run, the row's own owner is the identity. Never borrow a source's.
 */
export function executionPrincipalOf(row: {
	runtimeRegistrationJson?: unknown;
	ownerUserId?: string | null;
}): { userId: string | null } | undefined {
	const principal = readRuntimeRegistrationColumn(row.runtimeRegistrationJson)?.run?.principal;
	return principal ?? (row.ownerUserId ? { userId: row.ownerUserId } : undefined);
}
