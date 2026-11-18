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

import type { TeamListResponse } from "@shared/project-teams";
import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { narratorPrincipalOf } from "../lib/narrator-access";
import { requireProjectAccess } from "../lib/project-access";
import {
	createProjectTeamSchema,
	listProjectTeamsQuerySchema,
	teamActivityQuerySchema,
	teamBoardQuerySchema,
	updateProjectTeamSchema,
} from "../lib/validators";
import {
	readTeamActivity,
	readTeamApprovals,
	readTeamBoardColumn,
	readTeamPageSummary,
	readTeamRunning,
} from "../services/teams/team-board";
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

/** The tree's running sessions for "pause all" (members only; at most 500, with `more`). */
projectTeamRoutes.get("/:projectId/teams/:teamId/running", async (c) => {
	c.header("Cache-Control", "no-store");
	return c.json(
		await readTeamRunning(c.req.param("teamId"), narratorPrincipalOf(c), c.req.param("projectId")),
	);
});
