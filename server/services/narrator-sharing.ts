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

import {
	clampWriteAudience,
	isWriteAudienceAllowed,
	type NarratorVisibility,
	type NarratorWriteAudience,
} from "@shared/narrator-access";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { aclGrants, narrators, users } from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	broadcastToUser,
	dropNarratorSubscriptionsForUnauthorizedUsers,
} from "../websocket/narrator-ws";
import { recordAclEvent } from "./acl/acl-audit";
import {
	canManageNarratorAcl,
	NARRATOR_ACL_COLUMNS,
	type NarratorAclRow,
	type NarratorPrincipal,
	resolveAclRootId,
} from "./narrator-acl";

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
	/** Broad READ audience: private | project | public. */
	visibility: string;
	/** Broad WRITE audience: owner | project | public. */
	writeAudience: string;
	owner: {
		userId: string;
		username: string | null;
		avatarColor: string | null;
		avatarImageId: string | null;
	} | null;
	grants: NarratorGrantView[];
	/** Whether the requesting user may change any of the above. */
	canManage: boolean;
	/**
	 * True for a subagent, whose access is decided by `delegatesToNarratorId` rather
	 * than by anything on this view. The panel uses it to explain where the real
	 * setting lives instead of rendering controls that cannot take effect.
	 */
	isDelegated: boolean;
	/** The narrator actually governing access — the root for a subagent, else itself. */
	delegatesToNarratorId: string | null;
}

type NarratorRow = NarratorAclRow;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Recheck the first authorized owner snapshot under the synchronous SQLite write lock. */
function assertCurrentManager(
	tx: DbTransaction,
	snapshot: NarratorRow,
	principal: NarratorPrincipal,
) {
	const row = tx
		.select({
			id: narrators.id,
			type: narrators.type,
			ownerUserId: narrators.ownerUserId,
			visibility: narrators.visibility,
			writeAudience: narrators.writeAudience,
		})
		.from(narrators)
		.where(eq(narrators.id, snapshot.id))
		.get();
	if (
		!row ||
		row.type !== "primary" ||
		row.ownerUserId !== snapshot.ownerUserId ||
		(!principal.isAdmin && row.ownerUserId !== principal.userId)
	) {
		// Even admins compare their original owner, including null. No access read or
		// announcement may follow a conflict (including an otherwise harmless no-op).
		throw new AppError(
			"Narrator ownership changed while sharing; reload and try again",
			409,
			"NARRATOR_OWNERSHIP_CONFLICT",
		);
	}
	return row;
}

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
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: NARRATOR_ACL_COLUMNS,
	});
	if (!row) throw new NotFoundError("Narrator", narratorId);
	return row;
}

/**
 * Refuse unless the principal may change sharing.
 *
 * A plain 403 here, not the 404 used for read denial: the caller has already been
 * allowed to see the narrator, so hiding the reason would only be confusing.
 *
 * A subagent is refused outright rather than checked. Its access is delegated to the
 * root narrator, so editing its own audiences or grants would change nothing — and a
 * control that silently does nothing is worse than an error explaining where the real
 * setting lives.
 */
async function assertCanManage(row: NarratorRow, principal: NarratorPrincipal): Promise<void> {
	if (row.type === "subagent") {
		throw new ValidationError(
			"A subagent's access follows its main session; change the sharing there instead",
		);
	}
	if (await canManageNarratorAcl(row, principal)) return;
	throw new ValidationError(
		row.ownerUserId === null
			? "This narrator has no owner; an administrator must assign one before it can be shared"
			: "Only the owner or an administrator can change who may access this narrator",
	);
}

/**
 * Current sharing state, for the access panel.
 *
 * For a subagent this reports the state of the narrator that actually governs access
 * — the root — not the subagent's own columns. Those are frozen at their strictest
 * values and play no part in any decision, so showing them would tell the user their
 * shared session is private.
 *
 * A subagent whose root cannot be resolved reports its own (deny-everything) state,
 * which is exactly what is being enforced.
 */
export async function getNarratorAccess(
	narratorId: string,
	principal: NarratorPrincipal,
): Promise<NarratorAccessView> {
	const row = await loadNarrator(narratorId);
	const governingId = (await resolveAclRootId(row)) ?? narratorId;
	const governing = governingId === narratorId ? row : await loadNarrator(governingId);
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
		.where(narratorUserGrantScope(governingId));

	const owner = governing.ownerUserId
		? ((await db.query.users.findFirst({
				where: eq(users.id, governing.ownerUserId),
				columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
			})) ?? null)
		: null;

	return {
		narratorId,
		visibility: governing.visibility,
		writeAudience: governing.writeAudience,
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
		// A subagent is never manageable in place, whoever is asking.
		canManage: row.type !== "subagent" && (await canManageNarratorAcl(row, principal)),
		isDelegated: row.type === "subagent",
		delegatesToNarratorId: governingId === narratorId ? null : governingId,
	};
}

/**
 * Change the broad READ audience.
 *
 * Narrowing it may leave the write audience wider than the new read audience, which is
 * not a legal pair. That is resolved by CLAMPING the write audience down, never by
 * refusing the request: refusing would leave the user stuck at the more open setting
 * they were trying to back out of, which is the worst direction for a safety control to
 * fail in. The clamp lands in the same UPDATE, so no observer can catch an illegal pair
 * in between, and it is audited separately so "who narrowed the write audience" has an
 * answer that does not require inferring it.
 */
export async function setNarratorVisibility(
	narratorId: string,
	visibility: NarratorVisibility,
	principal: NarratorPrincipal,
): Promise<NarratorAccessView> {
	const snapshot = await loadNarrator(narratorId);
	await assertCanManage(snapshot, principal);
	// SQLite-only handle (fail-closed when PostgreSQL is active). Never await in
	// this callback: the current policy check and update share one short write lock.
	const { row, clampedWriteAudience, writeAudienceChanged, changed } = db.transaction(
		(tx) => {
			const row = assertCurrentManager(tx, snapshot, principal);
			const clampedWriteAudience = clampWriteAudience(visibility, row.writeAudience);
			const writeAudienceChanged = clampedWriteAudience !== row.writeAudience;
			const changed = row.visibility !== visibility || writeAudienceChanged;
			if (changed) {
				tx.update(narrators)
					.set({
						visibility,
						writeAudience: clampedWriteAudience,
						updatedAt: new Date().toISOString(),
					})
					.where(eq(narrators.id, narratorId))
					.run();
			}
			return { row, clampedWriteAudience, writeAudienceChanged, changed };
		},
		{ behavior: "immediate" },
	);
	if (changed) {
		recordAclEvent({
			actor: principal,
			eventType: "narrator_visibility_changed",
			scopeType: "narrator",
			scopeId: narratorId,
			outcome: "updated",
			detail: { from: row.visibility, to: visibility },
		});
		if (writeAudienceChanged) {
			recordAclEvent({
				actor: principal,
				eventType: "narrator_write_audience_changed",
				scopeType: "narrator",
				scopeId: narratorId,
				outcome: "updated",
				// Flagged as a consequence rather than a direct request, so the trail shows
				// the user narrowed visibility and this followed.
				detail: {
					from: row.writeAudience,
					to: clampedWriteAudience,
					reason: "clamped_by_visibility",
				},
			});
		}
		// Narrowing the audience can strip access from people currently watching.
		await announceAccessChange(narratorId, "visibility_changed");
	}
	return await getNarratorAccess(narratorId, principal);
}

/**
 * Change who may DRIVE this narrator, as a broad audience.
 *
 * The counterpart to {@link setNarratorVisibility} on the other axis. Audited for the
 * same reason project visibility is: "who opened this session up for anyone to run
 * commands in" is precisely the question asked after something goes wrong, and the
 * answer has to survive the change being reverted.
 */
export async function setNarratorWriteAudience(
	narratorId: string,
	writeAudience: NarratorWriteAudience,
	principal: NarratorPrincipal,
): Promise<NarratorAccessView> {
	const snapshot = await loadNarrator(narratorId);
	await assertCanManage(snapshot, principal);
	const { row, changed } = db.transaction(
		(tx) => {
			const row = assertCurrentManager(tx, snapshot, principal);
			// Do not widen visibility implicitly. Judge the legal pair against the
			// CURRENT read audience, not a policy loaded before authorization awaited.
			if (!isWriteAudienceAllowed(row.visibility, writeAudience)) {
				throw new ValidationError(
					writeAudience === "public"
						? "This session is not visible to everyone yet; set visibility to everyone before letting everyone drive it"
						: "This session is only visible to you; set visibility to the project before letting project members drive it",
				);
			}
			const changed = row.writeAudience !== writeAudience;
			if (changed) {
				tx.update(narrators)
					.set({ writeAudience, updatedAt: new Date().toISOString() })
					.where(eq(narrators.id, narratorId))
					.run();
			}
			return { row, changed };
		},
		{ behavior: "immediate" },
	);
	if (changed) {
		recordAclEvent({
			actor: principal,
			eventType: "narrator_write_audience_changed",
			scopeType: "narrator",
			scopeId: narratorId,
			outcome: "updated",
			detail: { from: row.writeAudience, to: writeAudience },
		});
		// Narrowing it must end the authority of anyone currently driving the session,
		// including the subscriptions they are holding open.
		await announceAccessChange(narratorId, "write_audience_changed");
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
	const snapshot = await loadNarrator(narratorId);
	await assertCanManage(snapshot, principal);
	// Match the HTTP batch cap even for direct callers; keep the lock bounded.
	if (userIds.length > 50) throw new ValidationError("Share with at most 50 users at once");
	// Preserve caller order while collapsing duplicates.
	const wanted = [...new Set(userIds)];
	const outcome = db.transaction(
		(tx) => {
			const row = assertCurrentManager(tx, snapshot, principal);
			const known = new Set(
				tx
					.select({ id: users.id })
					.from(users)
					.where(inArray(users.id, wanted))
					.limit(50)
					.all()
					.map((user) => user.id),
			);
			const outcome: BulkGrantOutcome = { granted: [], skipped: [], failed: [] };
			const now = new Date().toISOString();
			for (const userId of wanted) {
				if (!known.has(userId) || userId === row.ownerUserId) {
					outcome.failed.push(userId);
					continue;
				}
				const scope = and(narratorUserGrantScope(narratorId), eq(aclGrants.principalId, userId));
				// Canonical grants have at most read/write/manage. The fourth row is
				// only an overflow sentinel: reject malformed state rather than silently
				// truncating it. Preserve the legacy Map's last-row choice otherwise.
				const heldRows = tx
					.select({ access: aclGrants.capability })
					.from(aclGrants)
					.where(scope)
					.limit(4)
					.all();
				if (heldRows.length > 3) {
					throw new ValidationError(
						"Narrator grant data is inconsistent; repair it before sharing",
					);
				}
				const held = heldRows.at(-1);
				if (held?.access === access) {
					outcome.skipped.push(userId);
					continue;
				}
				if (held) {
					tx.update(aclGrants).set({ capability: access }).where(scope).run();
				} else {
					tx.insert(aclGrants)
						.values({
							id: generateId(),
							scopeType: "narrator",
							scopeId: narratorId,
							principalType: "user",
							principalId: userId,
							capability: access,
							grantedBy: principal.userId,
							createdAt: now,
						})
						.run();
				}
				outcome.granted.push(userId);
			}
			return outcome;
		},
		{ behavior: "immediate" },
	);

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
	const snapshot = await loadNarrator(narratorId);
	await assertCanManage(snapshot, principal);
	const grant = db.transaction(
		(tx) => {
			assertCurrentManager(tx, snapshot, principal);
			const scope = and(eq(aclGrants.id, grantId), narratorUserGrantScope(narratorId));
			const grant = tx
				.select({ principalId: aclGrants.principalId })
				.from(aclGrants)
				.where(scope)
				.get();
			if (!grant) throw new NotFoundError("Narrator grant", grantId);
			tx.update(aclGrants).set({ capability: access }).where(scope).run();
			return grant;
		},
		{ behavior: "immediate" },
	);
	// Downgrading write → read must also end any in-flight authority the viewer has.
	await announceAccessChange(narratorId, "grant_changed", [grant.principalId]);
	return (await getNarratorAccess(narratorId, principal)).grants;
}

export async function revokeNarratorGrant(
	narratorId: string,
	grantId: string,
	principal: NarratorPrincipal,
): Promise<void> {
	const snapshot = await loadNarrator(narratorId);
	await assertCanManage(snapshot, principal);
	const grant = db.transaction(
		(tx) => {
			assertCurrentManager(tx, snapshot, principal);
			const scope = and(eq(aclGrants.id, grantId), narratorUserGrantScope(narratorId));
			const grant = tx
				.select({ principalId: aclGrants.principalId })
				.from(aclGrants)
				.where(scope)
				.get();
			if (!grant) throw new NotFoundError("Narrator grant", grantId);
			tx.delete(aclGrants).where(scope).run();
			return grant;
		},
		{ behavior: "immediate" },
	);
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
	await assertCanManage(row, principal);
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

	// Shared work admission allows concurrent transfers. Revalidate the authority
	// in this single-row write, rather than trusting the pre-await owner snapshot.
	// Admins also compare the loaded owner (including null), so a stale admin
	// operation cannot overwrite another completed reassignment.
	const ownerMatches = principal.isAdmin
		? row.ownerUserId === null
			? isNull(narrators.ownerUserId)
			: eq(narrators.ownerUserId, row.ownerUserId)
		: eq(narrators.ownerUserId, principal.userId);
	const changed = await db
		.update(narrators)
		.set({ ownerUserId: newOwnerUserId, updatedAt: new Date().toISOString() })
		.where(and(eq(narrators.id, narratorId), eq(narrators.type, "primary"), ownerMatches))
		.returning({ id: narrators.id });
	if (changed.length !== 1) {
		// No announcement or access-view read on failure; disclose no new owner.
		throw new AppError(
			"Narrator ownership changed during transfer; reload and try again",
			409,
			"NARRATOR_OWNERSHIP_CONFLICT",
		);
	}

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
	reason:
		| "visibility_changed"
		| "write_audience_changed"
		| "shared"
		| "unshared"
		| "grant_changed"
		| "owner_changed",
	affectedUserIds: string[] = [],
): Promise<void> {
	try {
		for (const userId of new Set(affectedUserIds)) {
			broadcastToUser(userId, { type: "narrator_access_changed", narratorId, reason });
		}
		await dropNarratorSubscriptionsForUnauthorizedUsers(narratorId);
		// Subagents delegate their access to this narrator, so tightening it revokes
		// theirs too — but their subscriptions are keyed by their own ids and would keep
		// streaming to someone who just lost access. Bounded and id-only: a sharing
		// change must not turn into an unbounded scan on a session with many subtasks.
		const subagents = await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(eq(narrators.aclRootNarratorId, narratorId))
			.limit(SUBAGENT_SUBSCRIPTION_SWEEP_LIMIT);
		for (const subagent of subagents) {
			await dropNarratorSubscriptionsForUnauthorizedUsers(subagent.id);
		}
		if (subagents.length === SUBAGENT_SUBSCRIPTION_SWEEP_LIMIT) {
			// Past the cap a stale subscription may survive until its next authorization
			// check, which still refuses. A delay, not a hole.
			logger.warn("Subagent subscription sweep hit its cap; some may lag one check", {
				narratorId,
				limit: SUBAGENT_SUBSCRIPTION_SWEEP_LIMIT,
			});
		}
	} catch (err) {
		logger.warn("Failed to announce narrator access change", {
			narratorId,
			reason,
			error: String(err),
		});
	}
}

/**
 * Cap on how many subagents get their subscriptions swept on one ACL change.
 *
 * Not a hot path, but it must not become an unbounded scan. Beyond the cap the
 * enforcement still holds — every subsequent authorization check re-reads the root.
 */
const SUBAGENT_SUBSCRIPTION_SWEEP_LIMIT = 500;
