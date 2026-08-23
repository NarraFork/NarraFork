/**
 * Append-only audit of authorization changes, shared by every resource type.
 *
 * Three rules, all learned from the knowledge base's version of this:
 *
 *  1. **Redacted by construction.** `detail` carries ids, booleans, role names and
 *     counts — never titles, content or messages. An audit log that quoted content
 *     would become a way to read what the reader was never allowed to see, and
 *     admin-only reads are not enough protection for that.
 *  2. **Never fails the audited operation.** Writes are fire-and-forget and errors
 *     are logged, not thrown. A full disk must not turn "remove this person's
 *     access" into a 500 that leaves them with access.
 *  3. **Outside the transaction.** Called after the commit, so auditing never
 *     extends a write lock.
 *
 * `eventType` is free text rather than an enum so a new surface can record its own
 * event kind without a schema migration. The values in use are listed below.
 */

import { db } from "../../db";
import { aclEvents } from "../../db/schema";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";

/**
 * Event kinds currently written. Not enforced by the column — see the module note —
 * but kept here so the vocabulary stays discoverable.
 */
export const ACL_EVENT_TYPES = [
	// Projects
	"project_visibility_changed",
	"project_members_added",
	"project_member_removed",
	"project_owner_transferred",
	// Narrators
	"narrator_visibility_changed",
	"narrator_write_audience_changed",
	"narrator_shared",
	"narrator_unshared",
	"narrator_grant_changed",
	"narrator_owner_transferred",
	// Knowledge
	"knowledge_grant_added",
	"knowledge_grant_removed",
	"knowledge_grants_bulk_added",
	"knowledge_user_acl_replaced",
	"knowledge_entry_acl_updated",
	"knowledge_collection_acl_updated",
	"knowledge_owner_transferred",
] as const;

export type AclEventOutcome = "granted" | "revoked" | "replaced" | "transferred" | "updated";

export interface RecordAclEventInput {
	/** Who performed the change. Omitted for system-initiated changes (migrations). */
	actor?: { userId: string; isAdmin: boolean } | null;
	eventType: string;
	/** Whose access changed, when it is one identifiable principal. */
	subject?: { type: "user" | "role"; id: string };
	scopeType: string;
	scopeId?: string | null;
	outcome: AclEventOutcome;
	/** Redacted detail: ids, booleans, counts. Never content. */
	detail?: Record<string, unknown>;
}

/**
 * Write one audit row.
 *
 * Returns void rather than a promise on purpose: callers must not be able to `await`
 * it and accidentally make a logging failure part of their own error path.
 */
export function recordAclEvent(input: RecordAclEventInput): void {
	const row = {
		id: generateId(),
		actorUserId: input.actor?.userId ?? null,
		actorRole: input.actor ? (input.actor.isAdmin ? "admin" : "user") : null,
		eventType: input.eventType,
		subjectType: input.subject?.type ?? null,
		subjectId: input.subject?.id ?? null,
		scopeType: input.scopeType,
		scopeId: input.scopeId ?? null,
		outcome: input.outcome,
		detailJson: input.detail ?? null,
		createdAt: new Date().toISOString(),
	};

	void db
		.insert(aclEvents)
		.values(row)
		.then(undefined, (err: unknown) => {
			logger.error("Failed to record ACL audit event", {
				eventType: input.eventType,
				scopeType: input.scopeType,
				error: String(err),
			});
		});
}

/** Max rows one page of the audit log may return. */
export const ACL_EVENT_PAGE_MAX = 100;

export interface ListAclEventsOptions {
	scopeType?: string;
	scopeId?: string;
	limit?: number;
	/** Keyset cursor: `{ createdAt, id }` of the last row of the previous page. */
	cursor?: { createdAt: string; id: string };
}

/**
 * Read the audit log, newest first.
 *
 * Keyset pagination over `(createdAt, id)` rather than an offset: this table only
 * grows, and an offset scan would get slower for exactly the instances that have the
 * most to audit.
 */
export async function listAclEvents(options: ListAclEventsOptions = {}) {
	const limit = Math.min(options.limit ?? 50, ACL_EVENT_PAGE_MAX);
	const rows = await db.query.aclEvents.findMany({
		where: (e, { and, eq, lt, or }) => {
			const scope = options.scopeType ? eq(e.scopeType, options.scopeType) : undefined;
			const scoped = options.scopeId ? eq(e.scopeId, options.scopeId) : undefined;
			const after = options.cursor
				? or(
						lt(e.createdAt, options.cursor.createdAt),
						and(eq(e.createdAt, options.cursor.createdAt), lt(e.id, options.cursor.id)),
					)
				: undefined;
			return and(scope, scoped, after);
		},
		orderBy: (e, { desc }) => [desc(e.createdAt), desc(e.id)],
		limit: limit + 1,
	});

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const last = page.at(-1);
	return {
		events: page,
		hasMore,
		nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
	};
}
