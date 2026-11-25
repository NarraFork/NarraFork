/**
 * Project teams under `/api/projects/:projectId/teams` (docs/PROJECT_TEAMS-PLAN.md, P1).
 *
 * Access: listing and creating need the project (read / write); everything about one team
 * follows its coordinator narrator's ACL — readers see it, writers (members) change it, others
 * get 404. The team page's reads (P4: summary, board, activity) follow the same ACL; pending
 * approvals and the running list for "pause all" are for members only (403 for an onlooker).
 * The whole surface is refused on PostgreSQL with 503 before any access check, like the
 * narrator surface the team rides on and the project mutations.
 */

import { PROJECT_TEAM_CARDS_LIMIT } from "@shared/project-overview";
import type {
	TeamListResponse,
	TeamOverlapResponse,
	TeamWorkReturnResponse,
} from "@shared/project-teams";
import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { narratorPrincipalOf } from "../lib/narrator-access";
import { projectPrincipalOf, requireProjectAccess } from "../lib/project-access";
import {
	createProjectTeamSchema,
	listProjectTeamsQuerySchema,
	releaseTeamLockSchema,
	returnTeamWorkItemSchema,
	teamActivityQuerySchema,
	teamBoardQuerySchema,
	teamWorkDiffQuerySchema,
	teamWorkStatsQuerySchema,
	updateProjectTeamSchema,
	upgradeProjectTeamSchema,
} from "../lib/validators";
import { hasProjectAccess } from "../services/project-acl";
import {
	readTeamActivity,
	readTeamApprovals,
	readTeamBoardColumn,
	readTeamCards,
	readTeamMembersPage,
	readTeamPageSummary,
	readTeamRunning,
} from "../services/teams/team-board";
import { disbandTeam, upgradeSessionToTeam } from "../services/teams/team-conversion";
import { forceReleaseExclusiveLock, readProjectOverlaps } from "../services/teams/team-overlap";
import {
	archiveTeam,
	createTeam,
	getTeam,
	listProjectTeams,
	unarchiveTeam,
	updateTeam,
} from "../services/teams/team-service";
import {
	readWorkFileDiff,
	readWorkItemDetail,
	readWorkStats,
	returnWorkItemAsPerson,
} from "../services/teams/team-work-view";
import { requireSqliteProjectMutation } from "./projects";

export const projectTeamRoutes = new Hono();

projectTeamRoutes.use("/:projectId/teams/*", async (_c, next) => {
	requireSqliteProjectMutation("Project teams");
	return next();
});
projectTeamRoutes.use("/:projectId/teams", async (_c, next) => {
	requireSqliteProjectMutation("Project teams");
	return next();
});
projectTeamRoutes.use("/:projectId/team-overlaps", async (_c, next) => {
	requireSqliteProjectMutation("Project teams");
	return next();
});
projectTeamRoutes.use("/:projectId/team-locks/*", async (_c, next) => {
	requireSqliteProjectMutation("Project teams");
	return next();
});

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new ValidationError("Request body must be JSON");
	}
}

projectTeamRoutes.get("/:projectId/teams", async (c) => {
	const projectId = c.req.param("projectId");
	await requireProjectAccess(c, projectId, "read");
	const parsed = listProjectTeamsQuerySchema.safeParse({
		status: c.req.query("status") ?? undefined,
		limit: c.req.query("limit") ?? undefined,
		cursor: c.req.query("cursor") ?? undefined,
		counts: c.req.query("counts") ?? undefined,
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { counts, ...options } = parsed.data;
	const result: TeamListResponse = await listProjectTeams(projectId, narratorPrincipalOf(c), {
		...options,
		// Card numbers cost a few indexed reads per team: a page of them is at most 24 teams.
		limit: counts ? Math.min(options.limit, PROJECT_TEAM_CARDS_LIMIT) : options.limit,
	});
	if (!counts) return c.json(result);
	const cards = await readTeamCards(
		result.teams.map((team) => ({ id: team.id, member: team.access === "write" })),
		c.req.raw.signal,
	);
	return c.json({
		...result,
		teams: result.teams.map((team) => ({ ...team, card: cards.get(team.id) })),
	});
});

/**
 * Create a team, or (with `fromNarratorId`) turn an existing session into its coordinator: the
 * session's owner or an admin, an idle ordinary session of this project (`team-conversion.ts`).
 */
projectTeamRoutes.post("/:projectId/teams", async (c) => {
	const projectId = c.req.param("projectId");
	await requireProjectAccess(c, projectId, "write");
	const body = await jsonBody(c);
	if (body && typeof body === "object" && "fromNarratorId" in body) {
		const upgrade = upgradeProjectTeamSchema.safeParse(body);
		if (!upgrade.success) throw new ValidationError(upgrade.error.message);
		const team = await upgradeSessionToTeam({ projectId, ...upgrade.data }, narratorPrincipalOf(c));
		return c.json(team, 201);
	}
	const parsed = createProjectTeamSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const team = await createTeam({ projectId, ...parsed.data }, narratorPrincipalOf(c));
	return c.json(team, 201);
});

projectTeamRoutes.get("/:projectId/teams/:teamId", async (c) => {
	const team = await getTeam(
		c.req.param("teamId"),
		narratorPrincipalOf(c),
		c.req.param("projectId"),
	);
	return c.json(team);
});

projectTeamRoutes.patch("/:projectId/teams/:teamId", async (c) => {
	const parsed = updateProjectTeamSchema.safeParse(await jsonBody(c));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const team = await updateTeam(
		c.req.param("teamId"),
		narratorPrincipalOf(c),
		parsed.data,
		c.req.param("projectId"),
	);
	return c.json(team);
});

projectTeamRoutes.post("/:projectId/teams/:teamId/archive", async (c) => {
	const team = await archiveTeam(
		c.req.param("teamId"),
		narratorPrincipalOf(c),
		c.req.param("projectId"),
	);
	return c.json(team);
});

projectTeamRoutes.post("/:projectId/teams/:teamId/unarchive", async (c) => {
	const team = await unarchiveTeam(
		c.req.param("teamId"),
		narratorPrincipalOf(c),
		c.req.param("projectId"),
	);
	return c.json(team);
});

/**
 * Disband the team and keep its coordinator as an ordinary session: the session's owner or an
 * admin, the coordinator idle, no live work. The team's work items and activity are deleted.
 */
projectTeamRoutes.post("/:projectId/teams/:teamId/disband", async (c) => {
	const projectId = c.req.param("projectId");
	await requireProjectAccess(c, projectId, "write");
	return c.json(await disbandTeam(c.req.param("teamId"), narratorPrincipalOf(c), projectId));
});

// ── P4: the team page (read-only, bounded, cursor-paged) ─────────────────────

projectTeamRoutes.get("/:projectId/teams/:teamId/summary", async (c) => {
	c.header("Cache-Control", "no-store");
	return c.json(
		await readTeamPageSummary(
			c.req.param("teamId"),
			narratorPrincipalOf(c),
			c.req.param("projectId"),
		),
	);
});

projectTeamRoutes.get("/:projectId/teams/:teamId/board", async (c) => {
	const parsed = teamBoardQuerySchema.safeParse({
		column: c.req.query("column") ?? undefined,
		limit: c.req.query("limit") ?? undefined,
		cursor: c.req.query("cursor") ?? undefined,
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	c.header("Cache-Control", "no-store");
	return c.json(
		await readTeamBoardColumn(
			c.req.param("teamId"),
			narratorPrincipalOf(c),
			c.req.param("projectId"),
			parsed.data,
		),
	);
});

projectTeamRoutes.get("/:projectId/teams/:teamId/events", async (c) => {
	const parsed = teamActivityQuerySchema.safeParse({
		limit: c.req.query("limit") ?? undefined,
		cursor: c.req.query("cursor") ?? undefined,
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	c.header("Cache-Control", "no-store");
	return c.json(
		await readTeamActivity(
			c.req.param("teamId"),
			narratorPrincipalOf(c),
			c.req.param("projectId"),
			parsed.data,
		),
	);
});

projectTeamRoutes.get("/:projectId/teams/:teamId/approvals", async (c) => {
	c.header("Cache-Control", "no-store");
	return c.json(
		await readTeamApprovals(
			c.req.param("teamId"),
			narratorPrincipalOf(c),
			c.req.param("projectId"),
		),
	);
});

/**
 * The team's people (M1): members (write on the coordinator) and onlookers (read), with when
 * each last spoke. Readable by both; access is changed through the narrator sharing routes.
 */
projectTeamRoutes.get("/:projectId/teams/:teamId/members", async (c) => {
	c.header("Cache-Control", "no-store");
	return c.json(
		await readTeamMembersPage(
			c.req.param("teamId"),
			narratorPrincipalOf(c),
			c.req.param("projectId"),
		),
	);
});

/** The tree's running sessions for "pause all" (members only; at most 500, with `more`). */
projectTeamRoutes.get("/:projectId/teams/:teamId/running", async (c) => {
	c.header("Cache-Control", "no-store");
	return c.json(
		await readTeamRunning(c.req.param("teamId"), narratorPrincipalOf(c), c.req.param("projectId")),
	);
});

// ── R: the redesigned team page (work list sizes, the work item drawer, return) ──────────────

/** Lines added / removed and files changed of up to 50 work items (readers; bounded git). */
projectTeamRoutes.get("/:projectId/teams/:teamId/work-stats", async (c) => {
	const parsed = teamWorkStatsQuerySchema.safeParse({ ids: c.req.query("ids") ?? "" });
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	c.header("Cache-Control", "no-store");
	return c.json(
		await readWorkStats(
			c.req.param("teamId"),
			narratorPrincipalOf(c),
			c.req.param("projectId"),
			parsed.data.ids,
		),
	);
});

/** The work item drawer: branch, commits ahead, changed files, review rounds, its timeline. */
projectTeamRoutes.get("/:projectId/teams/:teamId/work/:itemId", async (c) => {
	c.header("Cache-Control", "no-store");
	return c.json(
		await readWorkItemDetail(
			c.req.param("teamId"),
			narratorPrincipalOf(c),
			c.req.param("projectId"),
			c.req.param("itemId"),
		),
	);
});

/** One changed file's diff, read when the drawer opens it (capped). */
projectTeamRoutes.get("/:projectId/teams/:teamId/work/:itemId/diff", async (c) => {
	const parsed = teamWorkDiffQuerySchema.safeParse({ path: c.req.query("path") ?? "" });
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	c.header("Cache-Control", "no-store");
	return c.json(
		await readWorkFileDiff(
			c.req.param("teamId"),
			narratorPrincipalOf(c),
			c.req.param("projectId"),
			c.req.param("itemId"),
			parsed.data.path,
		),
	);
});

/**
 * A member sends a work item in review or ready back to work with a reason: recorded as a
 * blocker round by that person; the coordinator gets the reason to relay to the worker.
 */
projectTeamRoutes.post("/:projectId/teams/:teamId/work/:itemId/return", async (c) => {
	const parsed = returnTeamWorkItemSchema.safeParse(await jsonBody(c));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const result: TeamWorkReturnResponse = await returnWorkItemAsPerson(
		c.req.param("teamId"),
		narratorPrincipalOf(c),
		c.req.param("projectId"),
		c.req.param("itemId"),
		parsed.data.reason,
	);
	return c.json(result);
});

/**
 * Who is changing what across the project's teams (X): files touched by two or more active work
 * items, the exclusive paths and the lock. Project read; each team's items are shown as far as
 * the caller may read that team's coordinator. Reads stored paths only (no git).
 */
projectTeamRoutes.get("/:projectId/team-overlaps", async (c) => {
	const projectId = c.req.param("projectId");
	const project = await requireProjectAccess(c, projectId, "read");
	const canManageProject = await hasProjectAccess(project, projectPrincipalOf(c), "manage");
	const result: TeamOverlapResponse = await readProjectOverlaps(projectId, narratorPrincipalOf(c), {
		canManageProject,
	});
	return c.json(result);
});

/** A person with project manage access releases the exclusive lock from its holder (recorded). */
projectTeamRoutes.post("/:projectId/team-locks/release", async (c) => {
	const projectId = c.req.param("projectId");
	await requireProjectAccess(c, projectId, "manage");
	const parsed = releaseTeamLockSchema.safeParse(await jsonBody(c));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const result = await forceReleaseExclusiveLock({
		projectId,
		workItemId: parsed.data.workItemId,
		userId: projectPrincipalOf(c).userId,
		reason: parsed.data.reason,
	});
	return c.json(result);
});
