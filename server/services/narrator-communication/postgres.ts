import { COMMUNICATION_LIMITS, canonicalCommunicationPair } from "@shared/narrator-communication";
import { type SQL, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { withPgRetry } from "../../db/pg-retry";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { parseRuntimePolicyTraits } from "../../lib/runtime-policy-trait";
import { executionPrincipalOf } from "../../lib/runtime-source";
import { resolveRuntimePolicy } from "../agent-runtime/policy";
import type { PgRuntimeTx } from "../agent-runtime/postgres-runtime-queue";
import type { NarratorPrincipal } from "../narrator-acl";
import { bindPlaceholders, narratorProjectIdText } from "../read/acl-sql";
import type { CommunicationCandidateSearchOptions } from "../search/communication-candidates";
import {
	communicationAuthorityText,
	communicationWritableText,
	communicationWritePredicate,
} from "./predicates";
import type { PreparedUserConnections } from "./service";

export type CommunicationPgTx = Pick<PgRuntimeTx, "execute">;
/** All authorization predicates share one snapshot. Retry the WHOLE section on 40001. */
export function withCommunicationPgTransaction<T>(
	database: BunSQLDatabase,
	body: (tx: PgRuntimeTx) => Promise<T>,
): Promise<T> {
	return withPgRetry(
		() => database.transaction((tx) => body(tx), { isolationLevel: "serializable" }),
		{
			label: "communication.authorized",
			maxRetries: 3,
		},
	);
}
const deny = (): never => {
	throw new AppError(
		"Communication target is unavailable or disconnected",
		403,
		"COMMUNICATION_DENIED",
	);
};
const decode = (value: unknown): unknown => {
	try {
		return typeof value === "string" ? JSON.parse(value) : value;
	} catch {
		return deny();
	}
};
async function rows(tx: CommunicationPgTx, statement: SQL): Promise<Record<string, unknown>[]> {
	return Array.from(await tx.execute(statement)) as Record<string, unknown>[];
}
async function principal(tx: CommunicationPgTx, userId: string): Promise<NarratorPrincipal> {
	const [row] = await rows(tx, sql`SELECT id, role FROM users WHERE id = ${userId} FOR SHARE`);
	if (!row) deny();
	return { userId: String(row.id), isAdmin: row.role === "admin" };
}
async function write(
	tx: CommunicationPgTx,
	id: string,
	actor: NarratorPrincipal,
	liveEndpoint = false,
): Promise<void> {
	if (
		!(
			await rows(
				tx,
				sql`SELECT n.id FROM narrators n WHERE n.id = ${id} ${liveEndpoint ? sql`AND n.status <> 'archived'` : sql``} AND ${actor.isAdmin ? sql`1=1` : bindPlaceholders(communicationWritableText("n"), actor.userId)} FOR SHARE`,
			)
		).length
	)
		deny();
}
async function root(tx: CommunicationPgTx, id: string): Promise<string> {
	const seen = new Set<string>();
	let current = id;
	while (seen.size < COMMUNICATION_LIMITS.maxDepth) {
		if (seen.has(current)) deny();
		seen.add(current);
		const [node] = await rows(
			tx,
			sql`SELECT parent_narrator_id FROM narrator_communication_nodes WHERE narrator_id = ${current} FOR SHARE`,
		);
		if (!node) deny();
		if (node.parent_narrator_id === null) return current;
		current = String(node.parent_narrator_id);
	}
	return deny();
}
export async function assertCommunicationReachablePg(
	tx: CommunicationPgTx,
	source: string,
	target: string,
): Promise<void> {
	if (source === target) deny();
	for (const id of [source, target])
		if (
			!(
				await rows(
					tx,
					sql`SELECT narrator_id FROM narrator_communication_nodes WHERE narrator_id = ${id} FOR SHARE`,
				)
			).length
		)
			deny();
	const [lo, hi] = canonicalCommunicationPair(source, target);
	// A precise contact is not a forest traversal or an ACL grant.
	if (
		(
			await rows(
				tx,
				sql`SELECT id FROM narrator_communication_peers WHERE endpoint_lo = ${lo} AND endpoint_hi = ${hi} FOR SHARE`,
			)
		).length
	)
		return;
	if ((await root(tx, source)) !== (await root(tx, target))) deny();
}
async function executionActor(tx: CommunicationPgTx, source: string): Promise<NarratorPrincipal> {
	const [row] = await rows(
		tx,
		sql`SELECT owner_user_id, runtime_registration_json FROM narrators WHERE id = ${source} AND status <> 'archived' AND NOT hidden_from_lists FOR SHARE`,
	);
	if (!row) deny();
	const execution = executionPrincipalOf({
		ownerUserId: row.owner_user_id as string | null,
		runtimeRegistrationJson: decode(row.runtime_registration_json),
	});
	const executionUserId = execution?.userId;
	if (!executionUserId) return deny();
	const actor = await principal(tx, executionUserId);
	await write(tx, source, actor);
	const [preferences] = await rows(
		tx,
		sql`SELECT traits FROM user_preferences WHERE user_id = ${actor.userId} FOR SHARE`,
	);
	const declarations = [...parseRuntimePolicyTraits(decode(preferences?.traits) ?? [])];
	let current: string | null = source;
	const seen = new Set<string>();
	while (current !== null) {
		if (seen.has(current) || seen.size >= COMMUNICATION_LIMITS.maxDepth) deny();
		seen.add(current);
		const [layer] = await rows(
			tx,
			sql`SELECT n.traits, n.policy_source_narrator_id, (SELECT p.traits FROM projects p WHERE p.id = ${sql.raw(narratorProjectIdText("n"))}) AS project_traits FROM narrators n WHERE n.id = ${current} AND ${sql.raw(communicationAuthorityText("n"))} FOR SHARE`,
		);
		if (!layer) deny();
		declarations.push(
			...parseRuntimePolicyTraits(decode(layer.traits) ?? []),
			...parseRuntimePolicyTraits(decode(layer.project_traits) ?? []),
		);
		current = layer.policy_source_narrator_id as string | null;
	}
	const policy = resolveRuntimePolicy(declarations);
	if (policy.tools.builtin !== "all" && !policy.tools.builtin.includes("Send")) deny();
	return actor;
}
export async function communicationCandidateSearchGuardPg(
	tx: CommunicationPgTx,
	source: string,
	userId: string,
	{
		liveTargetId,
		purpose,
	}: { liveTargetId?: string; purpose?: CommunicationCandidateSearchOptions["purpose"] } = {},
) {
	const viewer = await principal(tx, userId);
	const manual = purpose === "manual-connect";
	await write(tx, source, viewer, manual);
	const actor = manual ? viewer : await executionActor(tx, source); // Also checks the source is live.
	if (
		liveTargetId !== undefined &&
		!(
			await rows(
				tx,
				sql`SELECT id FROM narrators WHERE id = ${liveTargetId} AND status <> 'archived' FOR SHARE`,
			)
		).length
	)
		deny();
	const predicate = communicationWritePredicate("n", actor);
	const viewerWrite =
		viewer.userId === actor.userId
			? { sql: "1=1", params: [] as string[] }
			: communicationWritePredicate("n", viewer);
	return {
		sql: manual
			? predicate.sql
			: `(${viewerWrite.sql}) AND (${predicate.sql}) AND ${communicationAuthorityText("n")}`,
		params: [...viewerWrite.params, ...predicate.params],
		viewerIsAdmin: viewer.isAdmin,
		authorizationKey: JSON.stringify(manual ? [purpose, viewer] : [viewer, actor]),
		backend: "postgres" as const,
	};
}
export async function assertCommunicationSendAuthorizedPg(
	tx: CommunicationPgTx,
	source: string,
	target: string,
	allowArchivedForFailure = false,
): Promise<void> {
	const actor = await executionActor(tx, source);
	await write(tx, target, actor);
	if (
		!(
			await rows(
				tx,
				sql`SELECT n.id FROM narrators n WHERE n.id = ${target} ${allowArchivedForFailure ? sql`` : sql`AND n.status <> 'archived'`} AND NOT n.hidden_from_lists AND ${sql.raw(communicationAuthorityText("n"))} FOR SHARE`,
			)
		).length
	)
		deny();
	await assertCommunicationReachablePg(tx, source, target);
}
export async function assertUserCommunicationAdmissionPg(
	tx: CommunicationPgTx,
	prepared: PreparedUserConnections,
): Promise<void> {
	if (prepared.targetNarratorIds.length > COMMUNICATION_LIMITS.maxReferences) deny();
	const actor = await principal(tx, prepared.userId);
	await write(tx, prepared.sourceNarratorId, actor);
	for (const target of prepared.targetNarratorIds) await write(tx, target, actor);
}
export async function commitUserCommunicationAdmissionPg(
	tx: CommunicationPgTx,
	prepared: PreparedUserConnections,
	provenance: { admissionId: string; messageId?: string; now?: string },
): Promise<string[]> {
	const targets = [...new Set(prepared.targetNarratorIds)].filter(
		(id) => id !== prepared.sourceNarratorId,
	);
	if (targets.length > COMMUNICATION_LIMITS.maxReferences) deny();
	const actor = await principal(tx, prepared.userId);
	// Read and lock live statuses in the existing endpoint ACL queries before any no-op.
	await write(tx, prepared.sourceNarratorId, actor, targets.length > 0);
	const dirty = new Set<string>();
	for (const target of targets) {
		await write(tx, target, actor, true);
		if ((await root(tx, prepared.sourceNarratorId)) === (await root(tx, target))) continue;
		const [lo, hi] = canonicalCommunicationPair(prepared.sourceNarratorId, target);
		const inserted = await rows(
			tx,
			sql`INSERT INTO narrator_communication_peers (id, endpoint_lo, endpoint_hi, created_by, source, admission_id, message_id, created_at) VALUES (${generateId()}, ${lo}, ${hi}, ${actor.userId}, 'admission', ${provenance.admissionId}, ${provenance.messageId ?? null}, ${provenance.now ?? new Date().toISOString()}) ON CONFLICT DO NOTHING RETURNING id`,
		);
		if (inserted.length) {
			dirty.add(prepared.sourceNarratorId);
			dirty.add(target);
		}
	}
	return [...dirty];
}
