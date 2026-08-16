/**
 * Project membership: the mutations behind the project access panel.
 *
 * Only the owner, an admin, or someone holding a `manage` grant reaches these. A
 * write member works in the project but cannot decide who else may — the same
 * "acting in a resource is not administering it" split the narrator and knowledge
 * layers use.
 *
 * Every change is audited and announced. The audit exists because "who let this
 * person into the project" is exactly the question asked after something goes
 * wrong, and the announcement exists because a member who just lost access is
 * otherwise left holding a UI full of things that will 404 on the next click.
 */

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { aclGrants, chapters, narrators, projects, users } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { broadcastToUser } from "../websocket/narrator-ws";
import { recordAclEvent } from "./acl/acl-audit";
import { canManageProject, type ProjectPrincipal } from "./project-acl";
import { getRecentTabUserIds, pruneUnreadableProjectTabs } from "./recent-tabs-service";

/** The three membership tiers, mirroring the generic capabilities. */
export type ProjectRole = "read" | "write" | "manage";

export interface ProjectMemberView {
	grantId: string;
	userId: string;
	username: string | null;
	avatarColor: string | null;
	avatarImageId: string | null;
	role: ProjectRole;
	createdAt: string;
}

export interface ProjectAccessView {
	projectId: string;
	visibility: string;
	owner: {
		userId: string;
		username: string | null;
		avatarColor: string | null;
		avatarImageId: string | null;
	} | null;
	members: ProjectMemberView[];
	/** Whether the requesting user may change any of the above. */
	canManage: boolean;
}

type ProjectRow = typeof projects.$inferSelect;

/**
 * The `acl_grants` rows that mean "a person is a member of this project".
 *
 * `domain_kind is null` is the load-bearing half: the same table holds
 * knowledge-base credentials whose `capability` column is a placeholder, and those
 * must never appear in — or be editable from — a project's member list.
 */
function projectMemberScope(projectId: string) {
	return and(
		eq(aclGrants.scopeType, "project"),
		eq(aclGrants.scopeId, projectId),
		eq(aclGrants.principalType, "user"),
		isNull(aclGrants.domainKind),
	);
}

async function loadProject(projectId: string): Promise<ProjectRow> {
	const row = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
	if (!row) throw new NotFoundError("Project", projectId);
	return row;
}

/**
 * Refuse unless the principal may change membership.
 *
 * A plain validation error rather than the 404 used for read denial: the caller has
 * already been allowed to see the project, so hiding the reason would only confuse.
 */
async function assertCanManage(row: ProjectRow, principal: ProjectPrincipal): Promise<void> {
	if (await canManageProject(row, principal)) return;
	throw new ValidationError(
		row.ownerUserId === null
			? "This project has no owner; an administrator must assign one before its membership can be changed"
			: "Only the project owner, a manager or an administrator can change who may access this project",
	);
}

/** Current membership state, for the access panel. */
export async function getProjectAccess(
	projectId: string,
	principal: ProjectPrincipal,
): Promise<ProjectAccessView> {
	const row = await loadProject(projectId);
	const grants = await db
		.select({
			grantId: aclGrants.id,
			userId: aclGrants.principalId,
			role: aclGrants.capability,
			createdAt: aclGrants.createdAt,
			username: users.username,
			avatarColor: users.avatarColor,
			avatarImageId: users.avatarImageId,
		})
		.from(aclGrants)
		.leftJoin(users, eq(users.id, aclGrants.principalId))
		.where(projectMemberScope(projectId));

	const owner = row.ownerUserId
		? ((await db.query.users.findFirst({
				where: eq(users.id, row.ownerUserId),
				columns: { id: true, username: true, avatarColor: true, avatarImageId: true },
			})) ?? null)
		: null;

	// One row per (user, capability), so a user granted both read and write appears
	// twice in storage. The panel wants one entry per person at their highest tier.
	const byUser = new Map<string, ProjectMemberView>();
	for (const grant of grants) {
		const role = grant.role as ProjectRole;
		const existing = byUser.get(grant.userId);
		if (existing && rankOfRole(existing.role) >= rankOfRole(role)) continue;
		byUser.set(grant.userId, {
			grantId: grant.grantId,
			userId: grant.userId,
			username: grant.username ?? null,
			avatarColor: grant.avatarColor ?? null,
			avatarImageId: grant.avatarImageId ?? null,
			role,
			createdAt: grant.createdAt,
		});
	}

	return {
		projectId,
		visibility: row.visibility,
		owner: owner
			? {
					userId: owner.id,
					username: owner.username,
					avatarColor: owner.avatarColor,
					avatarImageId: owner.avatarImageId,
				}
			: null,
		members: [...byUser.values()],
		canManage: await canManageProject(row, principal),
	};
}

function rankOfRole(role: ProjectRole): number {
	return role === "manage" ? 3 : role === "write" ? 2 : 1;
}

export async function setProjectVisibility(
	projectId: string,
	visibility: "private" | "public",
	principal: ProjectPrincipal,
): Promise<ProjectAccessView> {
	const row = await loadProject(projectId);
	await assertCanManage(row, principal);
	if (row.visibility !== visibility) {
		await db
			.update(projects)
			.set({ visibility, updatedAt: new Date().toISOString() })
			.where(eq(projects.id, projectId));
		recordAclEvent({
			actor: principal,
			eventType: "project_visibility_changed",
			scopeType: "project",
			scopeId: projectId,
			outcome: "updated",
			detail: { from: row.visibility, to: visibility },
		});
		// Narrowing to private can strip access from people currently working here, so the
		// same stale-tab cleanup applies. Only non-members are affected, and the prune
		// re-checks the gate per user, so members keep their tabs.
		if (visibility === "private") {
			await pruneProjectTabsFor(await usersWithTabsInProject(projectId), projectId);
		}
		await announceProjectAccessChange(projectId, "visibility_changed");
	}
	return await getProjectAccess(projectId, principal);
}

export interface ProjectMemberBatchOutcome {
	added: string[];
	/** Already held this exact role. */
	skipped: string[];
	/** Unknown user, or the owner (who needs no grant). */
	failed: string[];
}

/**
 * Add or change members.
 *
 * Validation happens before the writes so one bad id cannot abort the batch, and
 * each user's outcome is reported individually. A role change REPLACES the previous
 * tier rather than adding to it: leaving a stale lower-tier row would make the
 * member list ambiguous and a later downgrade ineffective.
 */
export async function setProjectMembers(
	projectId: string,
	userIds: string[],
	role: ProjectRole,
	principal: ProjectPrincipal,
): Promise<ProjectMemberBatchOutcome> {
	const row = await loadProject(projectId);
	await assertCanManage(row, principal);

	// Preserve caller order while collapsing duplicates.
	const wanted = [...new Set(userIds)];
	const known = new Set(
		(await db.select({ id: users.id }).from(users).where(inArray(users.id, wanted))).map(
			(user) => user.id,
		),
	);
	const held = await db
		.select({ userId: aclGrants.principalId, role: aclGrants.capability, id: aclGrants.id })
		.from(aclGrants)
		.where(and(projectMemberScope(projectId), inArray(aclGrants.principalId, wanted)));
	const heldByUser = new Map<string, { id: string; role: string }[]>();
	for (const grant of held) {
		const list = heldByUser.get(grant.userId) ?? [];
		list.push({ id: grant.id, role: grant.role });
		heldByUser.set(grant.userId, list);
	}

	const outcome: ProjectMemberBatchOutcome = { added: [], skipped: [], failed: [] };
	const now = new Date().toISOString();
	for (const userId of wanted) {
		if (!known.has(userId) || userId === row.ownerUserId) {
			outcome.failed.push(userId);
			continue;
		}
		const existing = heldByUser.get(userId) ?? [];
		if (existing.length === 1 && existing[0].role === role) {
			outcome.skipped.push(userId);
			continue;
		}
		// Replace whatever tier they had, so exactly one row survives per member.
		if (existing.length > 0) {
			await db.delete(aclGrants).where(
				inArray(
					aclGrants.id,
					existing.map((grant) => grant.id),
				),
			);
		}
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: userId,
			capability: role,
			grantedBy: principal.userId,
			createdAt: now,
		});
		outcome.added.push(userId);
	}

	if (outcome.added.length > 0) {
		recordAclEvent({
			actor: principal,
			eventType: "project_members_added",
			scopeType: "project",
			scopeId: projectId,
			outcome: "granted",
			// One row for the whole batch, and only ids + the tier: an audit trail must not
			// become a second copy of who works on what.
			detail: { role, userIds: outcome.added },
		});
		await announceProjectAccessChange(projectId, "members_changed", outcome.added);
	}
	return outcome;
}

/** Remove a member entirely. */
export async function removeProjectMember(
	projectId: string,
	userId: string,
	principal: ProjectPrincipal,
): Promise<void> {
	const row = await loadProject(projectId);
	await assertCanManage(row, principal);

	const removed = await db
		.delete(aclGrants)
		.where(and(projectMemberScope(projectId), eq(aclGrants.principalId, userId)))
		.returning({ id: aclGrants.id });
	if (removed.length === 0) throw new NotFoundError("Project member", userId);

	recordAclEvent({
		actor: principal,
		eventType: "project_member_removed",
		subject: { type: "user", id: userId },
		scopeType: "project",
		scopeId: projectId,
		outcome: "revoked",
	});
	// Their narrator grants inside this project survive but are now void, because the
	// project gate refuses first. Nothing to clean up; the gate is the enforcement.
	//
	// Recent tabs are the exception: they are persisted server-side, so without this the
	// removed member keeps a row of tabs for this project that 404 on click.
	await pruneProjectTabsFor([userId], projectId);
	await announceProjectAccessChange(projectId, "members_changed", [userId]);
}

/**
 * Hand the project to another user, or (admins only) leave it ownerless.
 *
 * Also the repair path for projects that predate access control: they carry no
 * owner, so an admin assigns one and the new owner manages membership normally.
 */
export async function transferProjectOwner(
	projectId: string,
	newOwnerUserId: string | null,
	principal: ProjectPrincipal,
): Promise<ProjectAccessView> {
	const row = await loadProject(projectId);
	await assertCanManage(row, principal);

	// Least-privilege tightening: ownership transfer is a privilege escalation —
	// the new owner gains full control over all members — so only the current
	// owner or an admin may execute it. A `manage` member can administrate
	// membership but must not be able to seize the project itself.
	if (!principal.isAdmin && row.ownerUserId !== principal.userId) {
		throw new ValidationError(
			"Only the current project owner or an administrator can transfer ownership",
		);
	}

	if (newOwnerUserId === null && !principal.isAdmin) {
		throw new ValidationError("Only an administrator can leave a project without an owner");
	}
	if (newOwnerUserId !== null) {
		const target = await db.query.users.findFirst({
			where: eq(users.id, newOwnerUserId),
			columns: { id: true },
		});
		if (!target) throw new NotFoundError("User", newOwnerUserId);
	}

	await db
		.update(projects)
		.set({ ownerUserId: newOwnerUserId, updatedAt: new Date().toISOString() })
		.where(eq(projects.id, projectId));

	recordAclEvent({
		actor: principal,
		eventType: "project_owner_transferred",
		subject: newOwnerUserId ? { type: "user", id: newOwnerUserId } : undefined,
		scopeType: "project",
		scopeId: projectId,
		outcome: "transferred",
		detail: { from: row.ownerUserId, to: newOwnerUserId },
	});

	// Both ends are told: one may have just gained full authority, the other lost it.
	const affected = [row.ownerUserId, newOwnerUserId].filter((id): id is string => id !== null);
	await announceProjectAccessChange(projectId, "owner_changed", affected);
	return await getProjectAccess(projectId, principal);
}

/** Remove every project grant held by a user. Called when the user is deleted. */
export async function purgeProjectGrantsForUser(userId: string): Promise<number> {
	const removed = await db
		.delete(aclGrants)
		.where(
			and(
				eq(aclGrants.scopeType, "project"),
				eq(aclGrants.principalType, "user"),
				eq(aclGrants.principalId, userId),
			),
		)
		.returning({ id: aclGrants.id });
	return removed.length;
}

/**
 * Prune now-unopenable recent tabs, never letting that failure undo the ACL change.
 *
 * Cleanup is cosmetic — the gate already refuses these resources — so a failure here
 * must not roll back a completed revocation. Logged rather than thrown.
 */
async function pruneProjectTabsFor(userIds: string[], projectId: string): Promise<void> {
	for (const userId of new Set(userIds)) {
		try {
			await pruneUnreadableProjectTabs(userId, projectId);
		} catch (err) {
			logger.warn("Failed to prune recent tabs after project access change", {
				projectId,
				userId,
				error: String(err),
			});
		}
	}
}

/**
 * Who currently holds a recent tab pointing into this project.
 *
 * Used when tightening visibility, where the affected set is not a known list of
 * users: anyone who ever opened a tab here may have just lost it. The per-user gate
 * re-check inside the prune decides who actually did.
 */
async function usersWithTabsInProject(projectId: string): Promise<string[]> {
	const found = new Set<string>(await getRecentTabUserIds("project", projectId));

	// A project tab is not the only way in: chapter and session tabs point into the
	// project too, and someone who only ever opened a chapter would otherwise keep a
	// dead tab. Bounded by the project's own chapters/narrators, and only the ids are
	// read — no large fields.
	const chapterIds = (
		await db
			.select({ id: chapters.id })
			.from(chapters)
			.where(eq(chapters.projectId, projectId))
			.limit(TAB_SCAN_ENTITY_LIMIT)
	).map((row) => row.id);
	for (const chapterId of chapterIds) {
		for (const userId of await getRecentTabUserIds("chapter", chapterId)) found.add(userId);
	}

	const narratorIds = (
		await db
			.select({ id: narrators.id })
			.from(narrators)
			.where(
				chapterIds.length > 0
					? or(eq(narrators.contextProjectId, projectId), inArray(narrators.chapterId, chapterIds))
					: eq(narrators.contextProjectId, projectId),
			)
			.limit(TAB_SCAN_ENTITY_LIMIT)
	).map((row) => row.id);
	for (const narratorId of narratorIds) {
		for (const userId of await getRecentTabUserIds("narrator", narratorId)) found.add(userId);
	}

	return [...found];
}

/**
 * Cap on how many chapters/narrators are scanned when hunting for stale tabs.
 *
 * This runs on a visibility change, not a hot path, but it must not turn into an
 * unbounded scan on a large project. Past the cap some dead tabs survive, which is a
 * cosmetic miss — the gate still refuses the resource itself.
 */
const TAB_SCAN_ENTITY_LIMIT = 500;

/**
 * Tell affected clients that project access changed.
 *
 * Carries no membership detail — only "re-read your access" — so a recipient cannot
 * learn who else is in the project from the notification. Never throws: a failed
 * announcement must not roll back a completed authorization change, which is the
 * state clients converge on anyway.
 */
async function announceProjectAccessChange(
	projectId: string,
	reason: "visibility_changed" | "members_changed" | "owner_changed",
	affectedUserIds: string[] = [],
): Promise<void> {
	const recipients = new Set(affectedUserIds);
	try {
		for (const userId of recipients) {
			broadcastToUser(userId, { type: "project_access_changed", projectId, reason });
		}
	} catch (err) {
		logger.warn("Failed to announce project access change", {
			projectId,
			reason,
			error: String(err),
		});
	}

	// The project gate is an ancestor of every collection with `inheritProjectGate`, so a
	// membership change silently alters those users' readable knowledge set without any
	// knowledge grant moving. Without this, clients kept showing a stale library until a
	// manual refetch. Emitted only when such a collection exists, so projects that never
	// used the knowledge base stay quiet.
	if (recipients.size === 0) return;
	try {
		const inheriting = await db.query.knowledgeCollections.findFirst({
			where: (c, { and: a, eq: e }) => a(e(c.projectId, projectId), e(c.inheritProjectGate, true)),
			columns: { id: true },
		});
		if (!inheriting) return;
		eventBus.emit({
			type: "knowledge:acl_changed",
			userIds: [...recipients],
			reason: "project_gate_changed",
		});
	} catch (err) {
		// A missed refresh hint is a staleness bug, never an authorization hole: the gate is
		// re-evaluated server-side on the next read regardless.
		logger.warn("Failed to announce knowledge gate change", {
			projectId,
			error: String(err),
		});
	}
}
