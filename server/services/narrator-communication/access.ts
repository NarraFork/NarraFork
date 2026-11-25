import { sql } from "drizzle-orm";
import { AppError, NotFoundError } from "../../lib/errors";
import { parseRuntimePolicyTraits } from "../../lib/runtime-policy-trait";
import { executionPrincipalOf } from "../../lib/runtime-source";
import { readRuntimeRegistrationColumn } from "../../lib/validators/runtime-registration";
import { resolveRuntimePolicy } from "../agent-runtime/policy";
import type { NarratorPrincipal } from "../narrator-acl";
import { bindPlaceholders, narratorProjectIdText } from "../read/acl-sql";
import {
	communicationAuthorityText,
	communicationReadableText,
	communicationWritableText,
	communicationWritePredicate,
} from "./predicates";
import {
	assertCommunicationReachableTx,
	type CommunicationExecutor,
	communicationDenied,
} from "./store";

export * from "./predicates";

export function currentCommunicationPrincipalTx(
	tx: Pick<CommunicationExecutor, "all">,
	userId: string,
): NarratorPrincipal {
	const [user] = tx.all<{ id: string; role: string }>(
		sql`SELECT id, role FROM users WHERE id = ${userId} LIMIT 1`,
	);
	if (!user) communicationDenied();
	return { userId: user.id, isAdmin: user.role === "admin" };
}
export function assertCommunicationAccessTx(
	tx: Pick<CommunicationExecutor, "all">,
	id: string,
	principal: NarratorPrincipal,
	need: "read" | "write",
): void {
	const text = need === "write" ? communicationWritableText("n") : communicationReadableText("n");
	if (
		!tx.all(
			sql`SELECT n.id FROM narrators n WHERE n.id = ${id} AND ${principal.isAdmin ? sql`1 = 1` : bindPlaceholders(text, principal.userId)} LIMIT 1`,
		)[0]
	)
		throw new NotFoundError("Narrator", id);
}
export function decodeCommunicationJson(value: unknown): unknown {
	try {
		return typeof value === "string" ? JSON.parse(value) : value;
	} catch {
		return communicationDenied();
	}
}
/** The source's persisted run identity, never the author of the latest incoming message. */
export function assertCommunicationSendAuthorizedTx(
	tx: CommunicationExecutor,
	sourceId: string,
	targetId: string,
): void {
	const [source] = tx.all<{ ownerUserId: string | null; runtimeRegistrationJson: unknown }>(
		sql`SELECT owner_user_id AS ownerUserId, runtime_registration_json AS runtimeRegistrationJson FROM narrators WHERE id = ${sourceId} AND status <> 'archived' AND hidden_from_lists = 0 LIMIT 1`,
	);
	if (!source) communicationDenied();
	const principal = executionPrincipalOf({
		...source,
		runtimeRegistrationJson: decodeCommunicationJson(source.runtimeRegistrationJson),
	});
	if (!principal?.userId) communicationDenied();
	const current = currentCommunicationPrincipalTx(tx, principal.userId);
	assertCommunicationAccessTx(tx, sourceId, current, "write");
	assertCommunicationAccessTx(tx, targetId, current, "write");
	assertCommunicationCeilingTx(tx, sourceId, principal.userId);
	if (
		!tx.all(
			sql`SELECT n.id FROM narrators n WHERE n.id = ${targetId} AND n.status <> 'archived' AND n.hidden_from_lists = 0 AND ${sql.raw(communicationAuthorityText("n"))} LIMIT 1`,
		)[0]
	)
		communicationDenied();
	assertCommunicationReachableTx(tx, sourceId, targetId);
}
export function assertCommunicationCeilingTx(
	tx: Pick<CommunicationExecutor, "all">,
	sourceId: string,
	userId: string,
): void {
	const declarations: ReturnType<typeof parseRuntimePolicyTraits> = [];
	const [user] = tx.all<{ traits: unknown }>(
		sql`SELECT traits FROM user_preferences WHERE user_id = ${userId} LIMIT 1`,
	);
	declarations.push(...parseRuntimePolicyTraits(decodeCommunicationJson(user?.traits) ?? []));
	const seen = new Set<string>();
	let id: string | null = sourceId;
	while (id !== null) {
		if (seen.has(id) || seen.size >= 16) communicationDenied();
		seen.add(id);
		const [row]: Array<
			{ traits: unknown; sourceId: string | null; projectTraits: unknown } | undefined
		> = tx.all<{ traits: unknown; sourceId: string | null; projectTraits: unknown }>(
			sql`SELECT n.traits, n.policy_source_narrator_id AS sourceId, p.traits AS projectTraits FROM narrators n LEFT JOIN projects p ON p.id = ${sql.raw(narratorProjectIdText("n"))} WHERE n.id = ${id} AND ${sql.raw(communicationAuthorityText("n"))} LIMIT 1`,
		);
		if (!row) communicationDenied();
		declarations.push(
			...parseRuntimePolicyTraits(decodeCommunicationJson(row.traits) ?? []),
			...parseRuntimePolicyTraits(decodeCommunicationJson(row.projectTraits) ?? []),
		);
		id = row.sourceId;
	}
	const policy = resolveRuntimePolicy(declarations);
	if (policy.tools.builtin !== "all" && !policy.tools.builtin.includes("Send"))
		communicationDenied();
}
/** Used ONCE for missing legacy rows. Restoring an existing node uses immutable originalParent only. */
export function originalCommunicationDelegator(row: {
	type: string;
	variant?: string;
	parentNarratorId: string | null;
	runtimeRegistrationJson: unknown;
}): string | null {
	if (
		(row.type !== "subagent" &&
			row.variant !== "subagent" &&
			!row.variant?.startsWith("subagent:")) ||
		!row.parentNarratorId
	)
		return null;
	try {
		return readRuntimeRegistrationColumn(row.runtimeRegistrationJson)?.controller?.narratorId ===
			row.parentNarratorId
			? row.parentNarratorId
			: null;
	} catch {
		return null;
	}
}
export async function communicationCandidateSearchGuard(
	sourceNarratorId: string,
	principal: NarratorPrincipal,
	options: { signal?: AbortSignal; deadlineAt: number; backend?: "sqlite" | "postgres" },
): Promise<{
	sql: string;
	params: Array<string | number | null>;
	viewerIsAdmin: boolean;
	authorizationKey: string;
	backend: "sqlite" | "postgres";
}> {
	options.signal?.throwIfAborted();
	if (options.deadlineAt <= Date.now())
		throw new AppError("Communication search timed out", 504, "SEARCH_QUERY_TIMEOUT");
	const { db, activeDatabaseBackend, postgresRuntime } = await import("../../db");
	if (activeDatabaseBackend === "postgres") {
		if (!postgresRuntime || postgresRuntime.closed)
			throw new AppError("Communication unavailable", 503, "COMMUNICATION_UNAVAILABLE");
		const { communicationCandidateSearchGuardPg, withCommunicationPgTransaction } = await import(
			"./postgres"
		);
		return withCommunicationPgTransaction(postgresRuntime.client.db, (tx) =>
			communicationCandidateSearchGuardPg(tx, sourceNarratorId, principal.userId),
		);
	}
	return db.transaction((tx) => {
		const viewer = currentCommunicationPrincipalTx(tx, principal.userId);
		assertCommunicationAccessTx(tx, sourceNarratorId, viewer, "write");
		const [row] = tx.all<{ ownerUserId: string | null; registration: unknown }>(
			sql`SELECT owner_user_id AS ownerUserId, runtime_registration_json AS registration FROM narrators WHERE id = ${sourceNarratorId} LIMIT 1`,
		);
		if (!row) communicationDenied();
		const execution = executionPrincipalOf({
			ownerUserId: row.ownerUserId,
			runtimeRegistrationJson: decodeCommunicationJson(row.registration),
		});
		if (!execution?.userId) communicationDenied();
		const actor = currentCommunicationPrincipalTx(tx, execution.userId);
		assertCommunicationAccessTx(tx, sourceNarratorId, actor, "write");
		assertCommunicationCeilingTx(tx, sourceNarratorId, execution.userId);
		const write = communicationWritePredicate("n", actor);
		const viewerWrite =
			viewer.userId === actor.userId
				? { sql: "1=1", params: [] as string[] }
				: communicationWritePredicate("n", viewer);
		return {
			sql: `(${viewerWrite.sql}) AND (${write.sql}) AND ${communicationAuthorityText("n")}`,
			params: [...viewerWrite.params, ...write.params],
			viewerIsAdmin: viewer.isAdmin,
			authorizationKey: JSON.stringify([viewer, actor, row.registration]),
			backend: "sqlite" as const,
		};
	});
}
