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
 * candidate is judged by the narrator ACL's own rules, all at once (`judgeNarratorAccessBatch`:
 * a handful of queries for the whole set, about 2 ms for 100 candidates):
 *   - the coordinator's owner;
 *   - explicit user grants on the coordinator (distinct users, members' capabilities first, at
 *     most {@link TEAM_MEMBERS_LIST_LIMIT}; read grants are skipped for members-only reads, so
 *     onlookers can never crowd a member out — except project read grants under a `public`
 *     write audience, which do make members);
 *   - the people who spoke among the coordinator's latest {@link TEAM_SPOKE_WINDOW} messages;
 *   - when the coordinator belongs to a project and an audience reaches beyond its owner
 *     (project or public): the project's owner and explicit user grants, same ordering.
 * Someone who reaches the team only through a `public` audience and has not spoken recently
 * is not listed; `more` says when a source was cut off. People found only through the project
 * are left out for a reader outside the project's door, and counted rather than named in the
 * team status when the coordinator is readable outside the project. Everything is a primary-key
 * probe or an index range with a LIMIT: `acl_grants (scope_type, scope_id)`,
 * `narrator_messages (narrator_id, created_at)`. SQLite only, like the team surface.
 */

import {
	TEAM_MEMBERS_LIST_LIMIT,
	TEAM_SPOKE_WINDOW,
	type TeamMember,
	type TeamMemberRole,
} from "@shared/project-teams";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { aclGrants, narratorMessages, narrators, projects, users } from "../../db/schema";
import {
	judgeNarratorAccessBatch,
	NARRATOR_ACL_COLUMNS,
	type NarratorAclRow,
	type NarratorPrincipal,
} from "../narrator-acl";
import { resolveProjectIdForNarratorId } from "../narrator-project";
import { resolveProjectGate } from "../project-acl";

export interface TeamMembersRead {
	members: TeamMember[];
	/** A source was cut off at its limit, or more people were found than are returned. */
	more: boolean;
	visibility: string;
	writeAudience: string;
	/** Everyone found with access, by role (named or not); a lower bound when `more`. */
	counts: { members: number; onlookers: number };
	/** People with access found only through the project and not named (see options). */
	hidden: number;
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

/**
 * The distinct users granted on one scope, members' capabilities first (`write` / `manage`
 * before `read`), then by id, at most `limit + 1` (the extra one says "more"). `membersOnly`
 * leaves read-only grants out entirely: a read grant can never make a member, so it must never
 * crowd one out of a bounded read. One range of `acl_grants (scope_type, scope_id)`.
 */
function grantees(
	scopeType: "narrator" | "project",
	scopeId: string,
	limit: number,
	membersOnly: boolean,
): string[] {
	const rank = sql<number>`min(case when ${aclGrants.capability} in ('write', 'manage') then 0 else 1 end)`;
	return db
		.select({ userId: aclGrants.principalId, rank })
		.from(aclGrants)
		.where(
			and(
				eq(aclGrants.scopeType, scopeType),
				eq(aclGrants.scopeId, scopeId),
				eq(aclGrants.principalType, "user"),
				isNull(aclGrants.domainKind),
				membersOnly ? inArray(aclGrants.capability, ["write", "manage"]) : undefined,
			),
		)
		.groupBy(aclGrants.principalId)
		.orderBy(asc(rank), asc(aclGrants.principalId))
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

/** Where a candidate was found: the coordinator's own ACL, the conversation, or the project. */
type CandidateSource = "narrator" | "speaker" | "project";

export interface ReadTeamMembersOptions {
	/** Candidates taken from each source, and people returned (default 100). */
	limit?: number;
	/** Only people who may write (notifications): read grants are not even looked at. */
	membersOnly?: boolean;
	/**
	 * Who is asking. A caller who cannot pass the project's door (a public coordinator read by
	 * someone outside the project) is not shown people found only through the project.
	 */
	viewer?: NarratorPrincipal;
	/**
	 * Name people found only through the project? `false` counts them instead (`hidden`): the
	 * team status is written once for everyone who can read the coordinator.
	 */
	nameProjectOnly?: boolean;
}

/**
 * The team's people with their role and when they last spoke, members first.
 *
 * Candidates (each source bounded by `limit`): the coordinator's owner and explicit grants
 * (members' grants first), the people who spoke among the latest messages, and — when the
 * coordinator belongs to a project and either audience reaches beyond its owner — the project's
 * owner and grants. All candidates are judged together by `judgeNarratorAccessBatch` (the
 * narrator ACL's own rules, a handful of queries for the whole set).
 */
export async function readTeamMembers(
	teamId: string,
	options: ReadTeamMembersOptions = {},
): Promise<TeamMembersRead | null> {
	const limit = options.limit ?? TEAM_MEMBERS_LIST_LIMIT;
	const membersOnly = options.membersOnly === true;
	const coordinator = (await db.query.narrators.findFirst({
		where: eq(narrators.id, teamId),
		columns: NARRATOR_ACL_COLUMNS,
	})) as NarratorAclRow | undefined;
	if (!coordinator) return null;

	let more = false;
	const sources = new Map<string, Set<CandidateSource>>();
	const add = (ids: string[], source: CandidateSource) => {
		if (ids.length > limit) more = true;
		for (const id of ids.slice(0, limit)) {
			const known = sources.get(id);
			if (known) known.add(source);
			else sources.set(id, new Set([source]));
		}
	};
	if (coordinator.ownerUserId) add([coordinator.ownerUserId], "narrator");
	add(grantees("narrator", teamId, limit, membersOnly), "narrator");
	const spoken = readLastSpoken(teamId);
	add([...spoken.keys()], "speaker");
	const audiences = [coordinator.visibility, coordinator.writeAudience];
	const projectId =
		audiences.includes("project") || audiences.includes("public")
			? await resolveProjectIdForNarratorId(teamId)
			: null;
	if (projectId) {
		const project = db
			.select({ owner: projects.ownerUserId })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1)
			.get();
		if (project?.owner) add([project.owner], "project");
		// A `public` write audience lets anyone through the project's door write, so a project
		// READ grant can make a member there: members-only reads keep read grants in that case
		// (write / manage still first) and let the batch judge decide.
		add(
			grantees("project", projectId, limit, membersOnly && coordinator.writeAudience !== "public"),
			"project",
		);
	}

	// Someone outside the project's door sees only what the coordinator's own ACL and its
	// conversation already show them.
	let viewerSeesProject = true;
	if (projectId && options.viewer)
		viewerSeesProject = (await resolveProjectGate(projectId, options.viewer)).read;
	const projectOnly = (id: string) => {
		const found = sources.get(id);
		return !!found && found.size === 1 && found.has("project");
	};
	const candidates = [...sources.keys()].filter((id) => viewerSeesProject || !projectOnly(id));

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
	const principals = candidates.flatMap((userId) => {
		const user = people.get(userId);
		return user ? [{ userId, isAdmin: user.role === "admin" }] : [];
	});
	const verdicts = await judgeNarratorAccessBatch(coordinator, principals);
	const members: TeamMember[] = [];
	let hidden = 0;
	const counts = { member: 0, onlooker: 0 };
	for (const { userId } of principals) {
		const user = people.get(userId);
		const verdict = verdicts.get(userId);
		if (!user || !verdict) continue;
		const role: TeamMemberRole | null = verdict.write
			? "member"
			: verdict.read && !membersOnly
				? "onlooker"
				: null;
		if (!role) continue;
		counts[role]++;
		if (options.nameProjectOnly === false && projectOnly(userId)) {
			hidden++;
			continue;
		}
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
		counts: { members: counts.member, onlookers: counts.onlooker },
		hidden,
	};
}

/** The team's members (write access) among the people {@link readTeamMembers} finds. */
export async function readTeamMemberIds(teamId: string, limit: number): Promise<string[]> {
	const read = await readTeamMembers(teamId, { limit, membersOnly: true });
	return (read?.members ?? []).filter((member) => member.role === "member").map((m) => m.userId);
}
