/**
 * Append-only audit trail for knowledge AUTHORIZATION changes.
 *
 * The knowledge base gates content on two axes (classification level + controlled tags), but every
 * mutation of that gate used to be untraceable: after the fact, nothing recorded who granted an
 * account access to a compartment, or who declassified an entry. This module is the single writer.
 *
 * Design constraints:
 *  - **Redacted by construction.** Only level NAMES, tag IDS and boolean flags go into
 *    `detailJson`. Never entry titles, bodies or anything that would let a reader of the audit log
 *    learn content they cannot access.
 *  - **Never fails the operation it describes.** Writes are fire-and-forget with a swallowed
 *    error: a full disk must not turn a grant edit into a 500. The trade is explicit — an audit
 *    gap is preferable to breaking the ACL surface itself. (If audit-or-nothing is ever required,
 *    that becomes a deliberate change here, not an accident.)
 *  - **Off the transaction.** Callers invoke this AFTER their write commits, so an audit insert
 *    can never extend a write lock (see CLAUDE.md's main-thread rules).
 *  - **Bounded reads.** Listing is admin-only and cursor-paginated; `detailJson` is small by
 *    construction so there is no large-field concern.
 */
import { and, eq, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { aclEvents, type knowledgeAclEvents } from "../db/schema";
// Row generation, fire-and-forget semantics and failure logging now live in the shared
// audit implementation; this module only translates the knowledge vocabulary.
import { recordAclEvent } from "./acl/acl-audit";

/**
 * The fixed vocabulary used by the writers. The column is free text so a new ACL surface can be
 * audited without a migration, but everything in-tree uses one of these.
 */
export type KnowledgeAclEventType =
	| "grant_added"
	| "grant_removed"
	| "grants_bulk_added"
	| "user_acl_replaced"
	| "entry_acl_updated"
	| "collection_acl_updated"
	| "entry_owner_transferred"
	| "collection_owner_transferred"
	/**
	 * A collection was deleted, taking every entry inside it (FK cascade) with it.
	 *
	 * Audited despite not being a *grant* change because deletion is the most destructive way to
	 * end an authorization: it removes the gate and the gated content in one step, and the route is
	 * open to a collection owner, not just an admin.
	 */
	| "collection_deleted";

export interface KnowledgeAclAuditInput {
	/** Who acted. Null for a system/automated path. */
	actorUserId?: string | null;
	actorRole?: string | null;
	eventType: KnowledgeAclEventType;
	/** Whose authority moved (the principal), when applicable. */
	subjectType?: "user" | "role" | null;
	subjectId?: string | null;
	/** What the change was on, when applicable. */
	targetType?: "entry" | "collection" | "grant" | null;
	targetId?: string | null;
	/** Redacted detail — level names / tag ids / flags only. */
	detail?: Record<string, unknown> | null;
}

/**
 * Record one authorization change. Fire-and-forget by design (see the module header).
 *
 * Deliberately synchronous-looking (returns void, not a promise) so call sites cannot accidentally
 * make the audited operation wait on the audit write.
 */
export function recordKnowledgeAclEvent(input: KnowledgeAclAuditInput): void {
	// Writes to the unified `acl_events` table so project, narrator and knowledge
	// authorization changes are one auditable stream — "who granted whom what, and
	// when" is asked across resources, not per resource.
	//
	// The signature is unchanged, and the knowledge vocabulary is preserved: the
	// event type keeps a `knowledge_` prefix and the old `targetType`/`targetId` pair
	// maps onto the generic `scopeType`/`scopeId`. Fire-and-forget and the redaction
	// rules come from the shared implementation.
	recordAclEvent({
		actor: input.actorUserId
			? { userId: input.actorUserId, isAdmin: input.actorRole === "admin" }
			: null,
		eventType: prefixKnowledgeEventType(input.eventType),
		subject:
			input.subjectType && input.subjectId
				? { type: input.subjectType, id: input.subjectId }
				: undefined,
		scopeType: mapTargetToScopeType(input.targetType),
		scopeId: input.targetId ?? null,
		outcome: outcomeOf(input.eventType),
		detail: input.detail ?? undefined,
	});
}

/**
 * Keep knowledge event types distinguishable now that one table holds every domain's
 * events. Already-prefixed values pass through so callers can migrate gradually.
 */
function prefixKnowledgeEventType(eventType: string): string {
	return eventType.startsWith("knowledge_") ? eventType : `knowledge_${eventType}`;
}

/**
 * Map the knowledge target vocabulary onto generic scopes.
 *
 * `grant` has no scope of its own in the unified model — a grant IS the thing being
 * recorded — so it is filed under the knowledge collection space, which is where
 * knowledge grants live. The grant id remains in `scopeId`, so nothing is lost.
 */
function mapTargetToScopeType(targetType: string | null | undefined): string {
	switch (targetType) {
		case "entry":
			return "knowledge_entry";
		case "collection":
			return "knowledge_collection";
		case "grant":
			return "knowledge_grant";
		default:
			return "knowledge";
	}
}

/**
 * Derive the generic outcome from the knowledge event type.
 *
 * The unified table records an outcome so events from every domain can be filtered
 * the same way ("show me everything revoked last week"). Unknown types report
 * `updated`, the least specific value, rather than guessing at a grant or a revoke.
 */
function outcomeOf(
	eventType: string,
): "granted" | "revoked" | "replaced" | "transferred" | "updated" {
	if (eventType.includes("removed") || eventType.includes("deleted")) return "revoked";
	if (eventType.includes("bulk_added") || eventType.includes("added")) return "granted";
	if (eventType.includes("replaced")) return "replaced";
	if (eventType.includes("transferred")) return "transferred";
	return "updated";
}

/** Page size cap for the audit list. */
const AUDIT_LIST_MAX = 100;

export interface ListKnowledgeAclEventsOptions {
	limit?: number;
	/** Keyset cursor from a previous page: `{ createdAt, id }` of the last row seen. */
	cursorCreatedAt?: string;
	cursorId?: string;
	eventType?: string;
	subjectId?: string;
	targetId?: string;
	actorUserId?: string;
}

/**
 * Newest-first audit page.
 *
 * Keyset (not OFFSET) pagination on `(createdAt, id)` — matching `idx_kacl_events_created` — so
 * paging stays O(page) as the log grows, and `LIMIT n + 1` reports "there is more" without a
 * COUNT(*) over the whole table.
 */
export async function listKnowledgeAclEvents(opts: ListKnowledgeAclEventsOptions = {}): Promise<{
	events: (typeof knowledgeAclEvents.$inferSelect)[];
	hasMore: boolean;
	nextCursor: { createdAt: string; id: string } | null;
}> {
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), AUDIT_LIST_MAX);
	// Reads the unified table but keeps returning the knowledge-shaped rows the admin
	// UI already renders, so the storage move is invisible to callers. Only knowledge
	// scopes are considered: this endpoint is the knowledge audit view, and leaking
	// project membership changes into it would be a disclosure, not a feature.
	const conds = [sql`${aclEvents.scopeType} LIKE 'knowledge%'`];
	if (opts.eventType) {
		conds.push(eq(aclEvents.eventType, prefixKnowledgeEventType(opts.eventType)));
	}
	if (opts.subjectId) conds.push(eq(aclEvents.subjectId, opts.subjectId));
	if (opts.targetId) conds.push(eq(aclEvents.scopeId, opts.targetId));
	if (opts.actorUserId) conds.push(eq(aclEvents.actorUserId, opts.actorUserId));
	if (opts.cursorCreatedAt && opts.cursorId) {
		// Strictly "older than the cursor": either an earlier timestamp, or the same
		// timestamp with a smaller id (the tie-breaker that makes the order total).
		conds.push(
			or(
				lt(aclEvents.createdAt, opts.cursorCreatedAt),
				and(eq(aclEvents.createdAt, opts.cursorCreatedAt), lt(aclEvents.id, opts.cursorId)),
			) as never,
		);
	}

	const rows = await db.query.aclEvents.findMany({
		where: and(...conds),
		orderBy: (e, { desc }) => [desc(e.createdAt), desc(e.id)],
		limit: limit + 1,
	});

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page.at(-1);
	return {
		events: page.map(
			(row) =>
				({
					id: row.id,
					actorUserId: row.actorUserId,
					actorRole: row.actorRole,
					// Reported without the storage prefix, so the UI's vocabulary is unchanged.
					eventType: row.eventType.replace(/^knowledge_/, ""),
					subjectType: row.subjectType,
					subjectId: row.subjectId,
					targetType: scopeTypeToTarget(row.scopeType),
					targetId: row.scopeId,
					detailJson: row.detailJson,
					createdAt: row.createdAt,
				}) as typeof knowledgeAclEvents.$inferSelect,
		),
		hasMore,
		nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
	};
}

/** Inverse of {@link mapTargetToScopeType}, for reporting. */
function scopeTypeToTarget(scopeType: string): "entry" | "collection" | "grant" | null {
	switch (scopeType) {
		case "knowledge_entry":
			return "entry";
		case "knowledge_collection":
			return "collection";
		case "knowledge_grant":
			return "grant";
		default:
			return null;
	}
}

export const knowledgeAudit = {
	recordKnowledgeAclEvent,
	listKnowledgeAclEvents,
};
