/**
 * Team tabs in the sidebar's recent tabs (`type: "team"`, id = team id = coordinator id).
 *
 * A team tab is a bookmark of the team page, nothing more:
 * - It never represents the coordinator session (`represented_narrator_id` stays NULL), so the
 *   recipient lookups (`getRecentTabUserIdsFor*`) do not see it.
 * - Its title and project come from the team itself (`project_teams` + the coordinator's title),
 *   never from the client, and a tab is only stored for a team the user can read and that is not
 *   archived (`authorizeTeamTabs`).
 * - Its live state (the coordinator's status, the tree's pending approvals for members) is read
 *   only for the teams the user can still read (`enrichTeamTabs`); an unreadable team reads as
 *   no state at all.
 *
 * Bounded: every read is a primary-key `IN` over the given ids (at most one user's tabs, so at
 * most RECENT_TABS_STORAGE_LIMIT), plus one ACL judgement per team.
 *
 * This module must not import `recent-tabs-service` (that service imports it).
 */

import { RECENT_TABS_STORAGE_LIMIT } from "@shared/recent-tabs";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { narrators, projectTeams, users } from "../db/schema";
import { logger } from "../lib/logger";
import { parseSubstatus } from "../lib/narrator-utils";
import {
	judgeNarratorAccessBatch,
	type NarratorAclRow,
	type NarratorPrincipal,
} from "./narrator-acl";

/**
 * Team tabs of one runtime request whose pending approvals are counted. Each count is a bounded
 * scan (`visiblePendingCalls`); past this many team tabs the rest report no count.
 */
export const TEAM_TAB_PENDING_COUNT_LIMIT = 20;

export interface TeamTabTarget {
	teamId: string;
	projectId: string;
	coordinator: NarratorAclRow & { title: string | null; status: string; substatus: unknown };
}

/** The teams among `teamIds` that exist, with their coordinators. */
export async function loadTeamTabTargets(teamIds: string[]): Promise<Map<string, TeamTabTarget>> {
	const ids = [...new Set(teamIds)].slice(0, RECENT_TABS_STORAGE_LIMIT);
	const targets = new Map<string, TeamTabTarget>();
	if (ids.length === 0) return targets;
	const rows = await db
		.select({
			teamId: projectTeams.narratorId,
			projectId: projectTeams.projectId,
			id: narrators.id,
			ownerUserId: narrators.ownerUserId,
			visibility: narrators.visibility,
			writeAudience: narrators.writeAudience,
			type: narrators.type,
			aclRootNarratorId: narrators.aclRootNarratorId,
			contextProjectId: narrators.contextProjectId,
			title: narrators.title,
			status: narrators.status,
			substatus: narrators.substatus,
		})
		.from(projectTeams)
		.innerJoin(narrators, eq(narrators.id, projectTeams.narratorId))
		.where(inArray(projectTeams.narratorId, ids))
		.limit(ids.length);
	for (const row of rows) {
		const { teamId, projectId, ...coordinator } = row;
		targets.set(teamId, { teamId, projectId, coordinator });
	}
	return targets;
}

/** The principal of a user, or null when the user is gone. */
export async function principalOf(userId: string): Promise<NarratorPrincipal | null> {
	const user = await db
		.select({ id: users.id, role: users.role })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1)
		.get();
	return user ? { userId: user.id, isAdmin: user.role === "admin" } : null;
}

/** One user's read/write verdict on each team: the coordinator's narrator ACL, as everywhere. */
export async function teamVerdicts(
	principal: NarratorPrincipal,
	targets: Iterable<TeamTabTarget>,
): Promise<Map<string, { read: boolean; write: boolean }>> {
	const verdicts = new Map<string, { read: boolean; write: boolean }>();
	for (const target of targets) {
		const verdict = (await judgeNarratorAccessBatch(target.coordinator, [principal])).get(
			principal.userId,
		);
		verdicts.set(target.teamId, verdict ?? { read: false, write: false });
	}
	return verdicts;
}

/** Whether a team may be (or stay) in a user's sidebar: it exists, is active and is readable. */
function isPinnable(
	target: TeamTabTarget | undefined,
	verdict: { read: boolean } | undefined,
): target is TeamTabTarget {
	return !!target && target.coordinator.status !== "archived" && verdict?.read === true;
}

/**
 * Filter the team tabs of a write to the ones this user may hold, with the team's own title and
 * project. Other tabs pass through untouched. Used by the upsert and full-list restore paths.
 */
export async function authorizeTeamTabs<
	T extends { type: string; id: string; title: string; projectId?: string },
>(userId: string, tabs: T[]): Promise<T[]> {
	const teamIds = tabs.filter((tab) => tab.type === "team").map((tab) => tab.id);
	if (teamIds.length === 0) return tabs;
	const principal = await principalOf(userId);
	if (!principal) return tabs.filter((tab) => tab.type !== "team");
	const targets = await loadTeamTabTargets(teamIds);
	const verdicts = await teamVerdicts(principal, targets.values());
	return tabs.flatMap((tab) => {
		if (tab.type !== "team") return [tab];
		const target = targets.get(tab.id);
		if (!isPinnable(target, verdicts.get(tab.id))) return [];
		return [{ ...tab, title: target.coordinator.title ?? tab.title, projectId: target.projectId }];
	});
}

/**
 * Runtime state of team tabs, in place: the coordinator's `status`/`substatus`, `teamOnlooker`
 * for a reader who is not a member, and `pendingApprovalCount` (members only, like the team
 * page's top bar) with `readyItemCount` (R2: items to accept, so the tab's badge sums what the
 * team page's 「等你处理」 lists). A team the user can no longer read, or that is gone, gets no state.
 */
export async function enrichTeamTabs(
	tabs: Record<string, unknown>[],
	userId: string,
): Promise<void> {
	const teamTabs = tabs.filter((tab) => tab.type === "team" && typeof tab.id === "string");
	if (teamTabs.length === 0) return;
	for (const tab of teamTabs) {
		delete tab.status;
		delete tab.substatus;
		delete tab.teamOnlooker;
		delete tab.pendingApprovalCount;
		delete tab.readyItemCount;
	}
	const principal = await principalOf(userId);
	if (!principal) return;
	const targets = await loadTeamTabTargets(teamTabs.map((tab) => tab.id as string));
	const verdicts = await teamVerdicts(principal, targets.values());
	let counted = 0;
	for (const tab of teamTabs) {
		const target = targets.get(tab.id as string);
		const verdict = verdicts.get(tab.id as string);
		if (!target || !verdict?.read) continue;
		tab.status = target.coordinator.status;
		tab.substatus = parseSubstatus(target.coordinator.substatus);
		if (!verdict.write) {
			tab.teamOnlooker = true;
			continue;
		}
		if (counted >= TEAM_TAB_PENDING_COUNT_LIMIT) continue;
		counted++;
		try {
			const { teamPendingApprovalCount, teamReadyItemCount } = await import("./teams/team-board");
			tab.pendingApprovalCount = teamPendingApprovalCount(target.teamId);
			tab.readyItemCount = teamReadyItemCount(target.teamId);
		} catch (err) {
			logger.warn("Failed to count a team tab's pending approvals", {
				teamId: target.teamId,
				error: String(err),
			});
		}
	}
}

/**
 * Of the users holding a tab of this team, those who may no longer hold it: the team is gone or
 * archived, or they can no longer read it. Bounded by the holders passed in.
 */
export async function usersWhoLostTeam(teamId: string, holderIds: string[]): Promise<string[]> {
	if (holderIds.length === 0) return [];
	const target = (await loadTeamTabTargets([teamId])).get(teamId);
	if (!target || target.coordinator.status === "archived") return holderIds;
	const lost: string[] = [];
	for (let start = 0; start < holderIds.length; start += 100) {
		const batch = holderIds.slice(start, start + 100);
		const rows = await db
			.select({ id: users.id, role: users.role })
			.from(users)
			.where(inArray(users.id, batch))
			.limit(batch.length);
		const principals = rows.map((row) => ({ userId: row.id, isAdmin: row.role === "admin" }));
		const verdicts = await judgeNarratorAccessBatch(target.coordinator, principals);
		for (const userId of batch) if (verdicts.get(userId)?.read !== true) lost.push(userId);
	}
	return lost;
}
