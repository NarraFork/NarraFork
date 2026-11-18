/**
 * Project teams under `/api/projects/:projectId/teams` (docs/PROJECT_TEAMS-PLAN.md, P1).
 *
 * Access: listing and creating need the project (read / write); everything about one team
 * follows its coordinator narrator's ACL — readers see it, writers (members) change it, others
 * get 404. The whole surface is refused on PostgreSQL with 503 before any access check, like the
 * narrator surface the team rides on and the project mutations.
 */

import type { TeamListResponse, TeamOverlapResponse } from "@shared/project-teams";
import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { narratorPrincipalOf } from "../lib/narrator-access";
import { projectPrincipalOf, requireProjectAccess } from "../lib/project-access";
import {
	createProjectTeamSchema,
	listProjectTeamsQuerySchema,
	releaseTeamLockSchema,
	updateProjectTeamSchema,
} from "../lib/validators";
import { hasProjectAccess } from "../services/project-acl";
import { forceReleaseExclusiveLock, readProjectOverlaps } from "../services/teams/team-overlap";
import {
	archiveTeam,
	createTeam,
	getTeam,
	listProjectTeams,
	unarchiveTeam,
	updateTeam,
} from "../services/teams/team-service";
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
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const result: TeamListResponse = await listProjectTeams(
		projectId,
		narratorPrincipalOf(c),
		parsed.data,
	);
	return c.json(result);
});

projectTeamRoutes.post("/:projectId/teams", async (c) => {
	const projectId = c.req.param("projectId");
	await requireProjectAccess(c, projectId, "write");
	const parsed = createProjectTeamSchema.safeParse(await jsonBody(c));
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
