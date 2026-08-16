/**
 * Narrator sharing: the mutations behind the access panel.
 *
 * Only the owner and admins reach these (`canManageNarratorAcl`). A write grant is
 * permission to work in a session, not to pass it on — otherwise the person who
 * created a narrator would lose control of who can see it.
 *
 * Every change ends with `announceAccessChange`, which does two things that are
 * easy to forget and unpleasant to debug: it tells affected clients to re-read
 * their access, and it drops live WebSocket subscriptions that just became
 * unauthorized. Without the second, un-sharing would leave the previous viewer
 * streaming events until they happened to reload.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { aclGrants, narrators, users } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	broadcastToUser,
	dropNarratorSubscriptionsForUnauthorizedUsers,
} from "../websocket/narrator-ws";
import { canManageNarratorAcl, type NarratorPrincipal } from "./narrator-acl";

export interface NarratorGrantView {
	id: string;
	userId: string;
	username: string | null;
	avatarColor: string | null;
	avatarImageId: string | null;
	access: "read" | "write";
	createdAt: string;
}

export interface NarratorAccessView {
	narratorId: string;
	visibility: string;
	owner: {
		userId: string;
		username: string | null;
		avatarColor: string | null;
		avatarImageId: string | null;
	} | null;
	grants: NarratorGrantView[];
	/** Whether the requesting user may change any of the above. */
	canManage: boolean;
}

type NarratorRow = typeof narrators.$inferSelect;

/**
 * The `acl_grants` rows that represent "a person was given access to this
 * narrator".
 *
 * `domain_kind is null` is the important half: the unified table also holds
 * knowledge-base credentials whose `capability` column is a placeholder, and those
 * must never surface in a narrator's sharing list — nor be editable from it.
 */
function narratorUserGrantScope(narratorId: string) {
	return and(
		eq(aclGrants.scopeType, "narrator"),
		eq(aclGrants.scopeId, narratorId),
		eq(aclGrants.principalType, "user"),
		isNull(aclGrants.domainKind),
	);
}

/** Load the narrator or 404. Callers have already passed the route access gate. */
async function loadNarrator(narratorId: string): Promise<NarratorRow> {
	const row = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
	if (!row) throw new NotFoundError("Narrator", narratorId);
	return row;
}

/**
 * Refuse unless the principal may change sharing.
 *
 * A plain 403 here, not the 404 used for read denial: the caller has already been
 * allowed to see the narrator, so hiding the reason would only be confusing.
 */
function assertCanManage(row: NarratorRow, principal: NarratorPrincipal): void {
	if (canManageNarratorAcl(row, principal)) return;
	throw new ValidationError(
		row.ownerUserId === null
			? "This narrator has no owner; an administrator must assign one before it can be shared"
			: "Only the owner or an administrator can change who may access this narrator",
	);
}

/** Current sharing state, for the access panel. */
export async function getNarratorAccess(
	narratorId: string,
	principal: NarratorPrincipal,
): Promise<NarratorAccessView> {
	const row = await loadNarrator(narratorId);
	const grants = await db
		.select({
			id: aclGrants.id,
			userId: aclGrants.principalId,
			access: aclGrants.capability,
			createdAt: aclGrants.createdAt,
			username: users.username,
			avatarColor: users.avatarColor,
			avatarImageId: users.avatarImageId,
		})
		.from(aclGrants)
		.leftJoin(users, eq(users.id, aclGrants.principalId))
		.where(narratorUserGrantScope(narratorId));

	const owner = row.ownerUserId
		? ((await db.query.users.findFirst({
				where: eq(users.id, row.ownerUserId),
				columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
			})) ?? null)
		: null;

	return {
		narratorId,
		visibility: row.visibility,
		owner: owner
			? {
					userId: owner.id,
					username: owner.username,
					avatarColor: owner.avatarColor,
					avatarImageId: owner.avatarImageId,
				}
			: null,
		grants: grants.map((grant) => ({
			id: grant.id,
			userId: grant.userId,
			username: grant.username ?? null,
			avatarColor: grant.avatarColor ?? null,
			avatarImageId: grant.avatarImageId ?? null,
			access: grant.access as "read" | "write",
			createdAt: grant.createdAt,
		})),
		canManage: canManageNarratorAcl(row, principal),
	};
}

export async function setNarratorVisibility(
	narratorId: string,
	visibility: "private" | "project" | "public",
	principal: NarratorPrincipal,
): Promise<NarratorAccessView> {
	const row = await loadNarrator(narratorId);
	assertCanManage(row, principal);
	if (row.visibility !== visibility) {
		await db
			.update(narrators)
			.set({ visibility, updatedAt: new Date().toISOString() })
			.where(eq(narrators.id, narratorId));
		// Narrowing the audience can strip access from people currently watching.
		await announceAccessChange(narratorId, "visibility_changed");
	}
	return await getNarratorAccess(narratorId, principal);
}

export interface BulkGrantOutcome {
	granted: string[];
	/** Already held an identical grant — reported, not treated as an error. */
	skipped: string[];
	/** Unknown user, or the owner (who needs no grant). */
	failed: string[];
}

/**
 * Share with several users at once.
 *
 * Validation happens before the write so one bad id cannot abort the batch, and
 * each user's outcome is reported individually. Sharing with the owner is reported
 * as failed rather than silently creating a redundant row.
 */
export async function grantNarratorAccess(
	narratorId: string,
	userIds: string[],
	access: "read" | "write",
	principal: NarratorPrincipal,
): Promise<BulkGrantOutcome> {
	const row = await loadNarrator(narratorId);
	assertCanManage(row, principal);

	// Preserve caller order while collapsing duplicates, so a repeated id cannot
	// attempt the same insert twice.
	const wanted = [...new Set(userIds)];
	const known = new Set(
		(await db.select({ id: users.id }).from(users).where(inArray(users.id, wanted))).map(
			(user) => user.id,
		),
	);
	const held = new Map(
		(
			await db
				.select({ principalId: aclGrants.principalId, access: aclGrants.capability })
				.from(aclGrants)
				.where(and(narratorUserGrantScope(narratorId), inArray(aclGrants.principalId, wanted)))
		).map((grant) => [grant.principalId, grant.access]),
	);

	const outcome: BulkGrantOutcome = { granted: [], skipped: [], failed: [] };
	const now = new Date().toISOString();
	for (const userId of wanted) {
		if (!known.has(userId) || userId === row.ownerUserId) {
			outcome.failed.push(userId);
			continue;
		}
		const existing = held.get(userId);
		if (existing === access) {
			outcome.skipped.push(userId);
			continue;
		}
		if (existing) {
			await db
				.update(aclGrants)
				.set({ capability: access })
				.where(and(narratorUserGrantScope(narratorId), eq(aclGrants.principalId, userId)));
		} else {
			await db.insert(aclGrants).values({
				id: generateId(),
				scopeType: "narrator",
				scopeId: narratorId,
				principalType: "user",
				principalId: userId,
				capability: access,
				grantedBy: principal.userId,
				createdAt: now,
			});
		}
		outcome.granted.push(userId);
	}

	if (outcome.granted.length > 0) {
		await announceAccessChange(narratorId, "shared", outcome.granted);
	}
	return outcome;
}

export async function updateNarratorGrant(
	narratorId: string,
	grantId: string,
	access: "read" | "write",
	principal: NarratorPrincipal,
): Promise<NarratorGrantView[]> {
	const row = await loadNarrator(narratorId);
	assertCanManage(row, principal);
	const grant = await db.query.aclGrants.findFirst({
		where: and(eq(aclGrants.id, grantId), narratorUserGrantScope(narratorId)),
	});
	if (!grant) throw new NotFoundError("Narrator grant", grantId);

	await db.update(aclGrants).set({ capability: access }).where(eq(aclGrants.id, grantId));
	// Downgrading write → read must also end any in-flight authority the viewer has.
	await announceAccessChange(narratorId, "grant_changed", [grant.principalId]);
	return (await getNarratorAccess(narratorId, principal)).grants;
}

export async function revokeNarratorGrant(
	narratorId: string,
	grantId: string,
	principal: NarratorPrincipal,
): Promise<void> {
	const row = await loadNarrator(narratorId);
	assertCanManage(row, principal);
	const grant = await db.query.aclGrants.findFirst({
		where: and(eq(aclGrants.id, grantId), narratorUserGrantScope(narratorId)),
	});
	if (!grant) throw new NotFoundError("Narrator grant", grantId);

	await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
	await announceAccessChange(narratorId, "unshared", [grant.principalId]);
}

/**
 * Hand a narrator to another user (or, for admins, back to "no owner").
 *
 * Also the repair path for the narrators that predate access control: they carry no
 * owner, so an admin assigns one and the new owner can manage sharing normally.
 */
export async function transferNarratorOwner(
	narratorId: string,
	newOwnerUserId: string | null,
	principal: NarratorPrincipal,
): Promise<NarratorAccessView> {
	const row = await loadNarrator(narratorId);
	assertCanManage(row, principal);
	if (newOwnerUserId === null && !principal.isAdmin) {
		throw new ValidationError("Only an administrator can leave a narrator without an owner");
	}
	if (newOwnerUserId !== null) {
		const target = await db.query.users.findFirst({
			where: eq(users.id, newOwnerUserId),
			columns: { id: true },
		});
		if (!target) throw new NotFoundError("User", newOwnerUserId);
	}

	await db
		.update(narrators)
		.set({ ownerUserId: newOwnerUserId, updatedAt: new Date().toISOString() })
		.where(eq(narrators.id, narratorId));

	// The previous owner keeps no implicit access, so they are told to re-read too.
	const affected = [row.ownerUserId, newOwnerUserId].filter((id): id is string => id !== null);
	await announceAccessChange(narratorId, "owner_changed", affected);
	return await getNarratorAccess(narratorId, principal);
}

/**
 * Remove every narrator grant held by a user. Called when the user is deleted.
 *
 * Scoped to narrator grants on purpose, now that one table holds every resource's
 * grants: deleting a user must not become the path that silently drops their
 * knowledge-base clearances too. Each domain purges its own scope, so the caller in
 * `routes/admin.ts` invokes both and neither can quietly widen.
 *
 * `principal_id` is not a foreign key (it also carries role names), so the database
 * does not do this for us, and a stale row would re-grant access if an id were ever
 * reissued.
 */
export async function purgeNarratorGrantsForUser(userId: string): Promise<number> {
	const removed = await db
		.delete(aclGrants)
		.where(
			and(
				eq(aclGrants.scopeType, "narrator"),
				eq(aclGrants.principalType, "user"),
				eq(aclGrants.principalId, userId),
			),
		)
		.returning({ id: aclGrants.id });
	return removed.length;
}

/**
 * Tell clients an access change happened and evict the subscriptions it invalidated.
 *
 * The broadcast intentionally carries no grant detail — only "something changed,
 * re-read your access" — so it cannot be used to learn who else a narrator is shared
 * with. Recipients are the specifically affected users plus everyone currently
 * watching, since a visibility change affects readers who hold no grant at all.
 *
 * Never throws: an announcement failure must not roll back a completed
 * authorization change, which is the state clients will converge on anyway.
 */
async function announceAccessChange(
	narratorId: string,
	reason: "visibility_changed" | "shared" | "unshared" | "grant_changed" | "owner_changed",
	affectedUserIds: string[] = [],
): Promise<void> {
	try {
		for (const userId of new Set(affectedUserIds)) {
			broadcastToUser(userId, { type: "narrator_access_changed", narratorId, reason });
		}
		await dropNarratorSubscriptionsForUnauthorizedUsers(narratorId);
	} catch (err) {
		logger.warn("Failed to announce narrator access change", {
			narratorId,
			reason,
			error: String(err),
		});
	}
}
