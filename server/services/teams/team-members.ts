/**
 * The people of a team (docs/PROJECT_TEAMS-PLAN.md §二.1, §二.12; M1).
 *
 * There is no team membership of its own: a team's people are whoever the coordinator
 * narrator's ACL lets in. Write access makes a member (speaks in the conversation, approves
 * and answers the tree's calls), read access an onlooker. Access is granted and revoked
 * through the ordinary narrator sharing service (`narrator-sharing.ts`), never here.
 *
 * The ACL has broad audiences (`visibility`, `writeAudience`: project / public) that cannot
 * be enumerated cheaply, so the list is built from bounded candidate sources and every
 * candidate is judged by the real ACL (`canWriteNarrator` / `canReadNarrator`):
 *   - the coordinator's owner;
 *   - explicit user grants on the coordinator (at most {@link TEAM_MEMBERS_LIST_LIMIT});
 *   - when an audience reaches the project: the project's owner and explicit user grants
 *     (at most {@link TEAM_MEMBERS_LIST_LIMIT});
 *   - the people who spoke among the coordinator's latest {@link TEAM_SPOKE_WINDOW} messages.
 * Someone who reaches the team only through a `public` audience and has not spoken recently
 * is not listed; `more` says when a source was cut off. Everything is a primary-key probe or an
 * index range with a LIMIT: `acl_grants (scope_type, scope_id, …)`, `narrator_messages
 * (narrator_id, created_at)`. SQLite only, like the team surface.
 */

import {
	TEAM_MEMBERS_LIST_LIMIT,
	TEAM_SPOKE_WINDOW,
	type TeamMember,
	type TeamMemberRole,
} from "@shared/project-teams";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import { aclGrants, narratorMessages, narrators, projects, users } from "../../db/schema";
import {
	canReadNarrator,
	canWriteNarrator,
	NARRATOR_ACL_COLUMNS,
	type NarratorAclRow,
} from "../narrator-acl";
import { resolveProjectIdForNarratorId } from "../narrator-project";

export interface TeamMembersRead {
	members: TeamMember[];
	more: boolean;
	visibility: string;
	writeAudience: string;
}

/**
 * When each person last spoke in the coordinator's conversation, among its latest
 * {@link TEAM_SPOKE_WINDOW} messages: rows a person wrote (`role = 'user'`, a human origin,
 * top level, with an author). Messages the system writes for someone (a check-in, a notice)
 * are `sys` rows and do not count.
 */
export function readLastSpoken(teamId: string, window = TEAM_SPOKE_WINDOW): Map<string, string> {
	const rows = db
		.select({
			createdBy: narratorMessages.createdBy,
			createdAt: narratorMessages.createdAt,
			role: narratorMessages.role,
			origin: narratorMessages.origin,
			parentToolUseId: narratorMessages.parentToolUseId,
		})
		.from(narratorMessages)
		.where(eq(narratorMessages.narratorId, teamId))
		.orderBy(desc(narratorMessages.createdAt))
		.limit(window)
		.all();
	const spoken = new Map<string, string>();
	for (const row of rows) {
		if (row.role !== "user" || !row.createdBy || row.parentToolUseId) continue;
		if (row.origin !== null && row.origin !== "user") continue;
		if (!spoken.has(row.createdBy)) spoken.set(row.createdBy, row.createdAt);
	}
	return spoken;
}

function grantees(scopeType: "narrator" | "project", scopeId: string, limit: number) {
	return db
		.select({ userId: aclGrants.principalId })
		.from(aclGrants)
		.where(
			and(
				eq(aclGrants.scopeType, scopeType),
				eq(aclGrants.scopeId, scopeId),
				eq(aclGrants.principalType, "user"),
				isNull(aclGrants.domainKind),
			),
		)
		.limit(limit + 1)
		.all()
		.map((row) => row.userId);
}

const ROLE_ORDER: Record<TeamMemberRole, number> = { member: 0, onlooker: 1 };

/** Members first, the owner first among them, then by name (then id): a stable order. */
export function compareTeamMembers(a: TeamMember, b: TeamMember): number {
	return (
		ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
		Number(b.owner) - Number(a.owner) ||
		(a.username < b.username ? -1 : a.username > b.username ? 1 : 0) ||
		(a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
	);
}

/**
 * The team's people with their role and when they last spoke, members first. `limit` bounds
 * both the candidates taken from each source and the people returned.
 */
export async function readTeamMembers(
	teamId: string,
	options: { limit?: number } = {},
): Promise<TeamMembersRead | null> {
	const limit = options.limit ?? TEAM_MEMBERS_LIST_LIMIT;
	const coordinator = (await db.query.narrators.findFirst({
		where: eq(narrators.id, teamId),
		columns: NARRATOR_ACL_COLUMNS,
	})) as NarratorAclRow | undefined;
	if (!coordinator) return null;

	let more = false;
	const candidates: string[] = [];
	const add = (ids: string[]) => {
		if (ids.length > limit) more = true;
		for (const id of ids.slice(0, limit)) if (!candidates.includes(id)) candidates.push(id);
	};
	if (coordinator.ownerUserId) add([coordinator.ownerUserId]);
	add(grantees("narrator", teamId, limit));
	const projectWide =
		coordinator.visibility === "project" || coordinator.writeAudience === "project";
	if (projectWide) {
		const projectId = await resolveProjectIdForNarratorId(teamId);
		if (projectId) {
			const project = db
				.select({ owner: projects.ownerUserId })
				.from(projects)
				.where(eq(projects.id, projectId))
				.limit(1)
				.get();
			if (project?.owner) add([project.owner]);
			add(grantees("project", projectId, limit));
		}
	}
	const spoken = readLastSpoken(teamId);
	add([...spoken.keys()]);

	const people = new Map(
		candidates.length
			? db
					.select({
						id: users.id,
						username: users.username,
						role: users.role,
						avatarColor: users.avatarColor,
						avatarImageId: users.avatarImageId,
					})
					.from(users)
					.where(inArray(users.id, candidates))
					.all()
					.map((user) => [user.id, user])
			: [],
	);
	const members: TeamMember[] = [];
	for (const userId of candidates) {
		const user = people.get(userId);
		if (!user) continue;
		const principal = { userId, isAdmin: user.role === "admin" };
		const role: TeamMemberRole | null = (await canWriteNarrator(coordinator, principal))
			? "member"
			: (await canReadNarrator(coordinator, principal))
				? "onlooker"
				: null;
		if (!role) continue;
		members.push({
			userId,
			username: user.username,
			avatarColor: user.avatarColor ?? null,
			avatarImageId: user.avatarImageId ?? null,
			role,
			owner: coordinator.ownerUserId === userId,
			lastSpokeAt: spoken.get(userId) ?? null,
		});
	}
	members.sort(compareTeamMembers);
	if (members.length > limit) more = true;
	return {
		members: members.slice(0, limit),
		more,
		visibility: coordinator.visibility,
		writeAudience: coordinator.writeAudience,
	};
}

/** The team's members (write access) among the people {@link readTeamMembers} finds. */
export async function readTeamMemberIds(teamId: string, limit: number): Promise<string[]> {
	const read = await readTeamMembers(teamId, { limit });
	return (read?.members ?? []).filter((member) => member.role === "member").map((m) => m.userId);
}
