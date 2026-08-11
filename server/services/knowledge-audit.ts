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
import { and, desc, eq, lt, or } from "drizzle-orm";
import { db } from "../db";
import { knowledgeAclEvents } from "../db/schema";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";

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
	void db
		.insert(knowledgeAclEvents)
		.values({
			id: generateId(),
			actorUserId: input.actorUserId ?? null,
			actorRole: input.actorRole ?? null,
			eventType: input.eventType,
			subjectType: input.subjectType ?? null,
			subjectId: input.subjectId ?? null,
			targetType: input.targetType ?? null,
			targetId: input.targetId ?? null,
			detailJson: input.detail ?? null,
			createdAt: new Date().toISOString(),
		})
		.then(undefined, (err: unknown) => {
			// Log loudly (an audit gap matters) but never propagate.
			logger.error("Failed to record knowledge ACL audit event", {
				eventType: input.eventType,
				error: err instanceof Error ? err.message : String(err),
			});
		});
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
	const conds = [];
	if (opts.eventType) conds.push(eq(knowledgeAclEvents.eventType, opts.eventType));
	if (opts.subjectId) conds.push(eq(knowledgeAclEvents.subjectId, opts.subjectId));
	if (opts.targetId) conds.push(eq(knowledgeAclEvents.targetId, opts.targetId));
	if (opts.actorUserId) conds.push(eq(knowledgeAclEvents.actorUserId, opts.actorUserId));
	if (opts.cursorCreatedAt && opts.cursorId) {
		// Strictly "older than the cursor": either an earlier timestamp, or the same timestamp with
		// a smaller id (the tie-breaker that makes the order total).
		conds.push(
			or(
				lt(knowledgeAclEvents.createdAt, opts.cursorCreatedAt),
				and(
					eq(knowledgeAclEvents.createdAt, opts.cursorCreatedAt),
					lt(knowledgeAclEvents.id, opts.cursorId),
				),
			),
		);
	}
	const rows = await db.query.knowledgeAclEvents.findMany({
		where: conds.length > 0 ? and(...conds) : undefined,
		orderBy: [desc(knowledgeAclEvents.createdAt), desc(knowledgeAclEvents.id)],
		limit: limit + 1,
	});
	const hasMore = rows.length > limit;
	const events = hasMore ? rows.slice(0, limit) : rows;
	const last = events[events.length - 1];
	return {
		events,
		hasMore,
		nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
	};
}

export const knowledgeAudit = {
	recordKnowledgeAclEvent,
	listKnowledgeAclEvents,
};
