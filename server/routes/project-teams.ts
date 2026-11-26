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
	TeamGithubPinResponse,
	TeamListResponse,
	TeamOverlapResponse,
	TeamWorkMergeResponse,
	TeamWorkPrRefreshResponse,
	TeamWorkReturnResponse,
} from "@shared/project-teams";
import { type Context, Hono } from "hono";
import { ForbiddenError, ValidationError } from "../lib/errors";
import { narratorPrincipalOf } from "../lib/narrator-access";
import { projectPrincipalOf, requireProjectAccess } from "../lib/project-access";
import {
	createProjectTeamSchema,
	listProjectTeamsQuerySchema,
	mergeTeamPullRequestSchema,
	releaseTeamLockSchema,
	returnTeamWorkItemSchema,
	teamActivityQuerySchema,
	teamBoardQuerySchema,
	teamGithubPinSchema,
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
	requestFastForwardAsPerson,
	requestMergeAsPerson,
	requestPrMergeAsPerson,
	requestPrRefreshAsPerson,
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
projectTeamRoutes.use("/:projectId/team-github", async (_c, next) => {
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
 * Moving the project's base branch needs project write as well as team membership: a coordinator
 * write grant held by a read-only project member is not enough (403; strangers still get 404).
 */
async function requireProjectWriteForMerge(c: Context): Promise<void> {
	const project = await requireProjectAccess(c, c.req.param("projectId") ?? "", "read");
	if (!(await hasProjectAccess(project, projectPrincipalOf(c), "write")))
		throw new ForbiddenError("Merging into the project's base branch needs project write access");
}

/**
 * A member merges a ready item into its base (M): the same access as 退回, plus project write (a
 * read-only project member never moves the base, whatever their coordinator grant). Only cheap checks run
 * here; the merge itself is a background job (202 with its phase), read back from the drawer.
 * When origin is on GitHub (G) the same request pushes the branch and opens or updates its pull
 * request (job `pull_request`). 409: `TEAM_WORK_ITEM_NOT_READY`, `TEAM_WORK_ITEM_MERGING`,
 * `TEAM_WORK_ITEM_WORKER_RUNNING`, `TEAM_MERGE_BASE_REMOTE`, `TEAM_ARCHIVED`, and for GitHub
 * `TEAM_PR_GH_MISSING`, `TEAM_PR_GH_LOGGED_OUT`, `TEAM_PR_GH_NO_PERMISSION`,
 * `TEAM_PR_REPO_ARCHIVED`, `TEAM_PR_GH_UNAVAILABLE`.
 */
projectTeamRoutes.post("/:projectId/teams/:teamId/work/:itemId/merge", async (c) => {
	await requireProjectWriteForMerge(c);
	const result: TeamWorkMergeResponse = await requestMergeAsPerson(
		c.req.param("teamId"),
		narratorPrincipalOf(c),
		c.req.param("projectId"),
		c.req.param("itemId"),
	);
	return c.json(result, 202);
});

/**
 * G: 「合并 PR」: merge a ready item's pull request on GitHub (`{ method? }`: merge, squash or rebase;
 * absent, the repository's default). The same access as the merge; a background job (202). 409:
 * those of the merge, `TEAM_PR_NOT_GITHUB`, `TEAM_PR_METHOD_NOT_ALLOWED`.
 */
projectTeamRoutes.post("/:projectId/teams/:teamId/work/:itemId/pr/merge", async (c) => {
	await requireProjectWriteForMerge(c);
	const raw = await c.req.text();
	let body: unknown = {};
	if (raw.trim()) {
		try {
			body = JSON.parse(raw);
		} catch {
			throw new ValidationError("Request body must be JSON");
		}
	}
	const parsed = mergeTeamPullRequestSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const result: TeamWorkMergeResponse = await requestPrMergeAsPerson(
		c.req.param("teamId"),
		narratorPrincipalOf(c),
		c.req.param("projectId"),
		c.req.param("itemId"),
		parsed.data.method,
	);
	return c.json(result, 202);
});

/**
 * G: the drawer opened: read the item's pull request from GitHub unless it was read in the last
 * 20 s (202; the drawer polls while `refreshing`). The same access as the merge; 409
 * `TEAM_PR_NONE` without a pull request, `TEAM_WORK_ITEM_NOT_READY`.
 */
projectTeamRoutes.post("/:projectId/teams/:teamId/work/:itemId/pr/refresh", async (c) => {
	await requireProjectWriteForMerge(c);
	const result: TeamWorkPrRefreshResponse = await requestPrRefreshAsPerson(
		c.req.param("teamId"),
		narratorPrincipalOf(c),
		c.req.param("projectId"),
		c.req.param("itemId"),
	);
	return c.json(result, 202);
});

/**
 * 「在该目录中快进」: fast-forward a prepared merge in the checkout its base is checked out in,
 * after the person confirmed. A background job like the merge (202); 409
 * `TEAM_MERGE_NOT_PREPARED` without a prepared merge.
 */
projectTeamRoutes.post("/:projectId/teams/:teamId/work/:itemId/merge/fast-forward", async (c) => {
	await requireProjectWriteForMerge(c);
	const result: TeamWorkMergeResponse = await requestFastForwardAsPerson(
		c.req.param("teamId"),
		narratorPrincipalOf(c),
		c.req.param("projectId"),
		c.req.param("itemId"),
	);
	return c.json(result, 202);
});

/**
 * G: the GitHub repository the project's pull requests go to. Reading it needs project read;
 * confirming (`PUT {target: "host/owner/repo"}`) or clearing it (`DELETE`) project manage (403
 * otherwise, 404 for a stranger). `detected` is what origin resolves to now (cached; null while
 * it is read or when origin is not on GitHub).
 */
async function githubPinResponse(projectId: string): Promise<TeamGithubPinResponse> {
	const { pinnedGithubTarget, githubTargetName } = await import(
		"../services/teams/team-github-pin"
	);
	const { peekHosting } = await import("../services/teams/team-hosting");
	const { repositoryOf } = await import("../services/teams/team-merge");
	const repo = repositoryOf(projectId);
	const hosting = repo ? peekHosting(repo) : null;
	return {
		pinned: pinnedGithubTarget(projectId),
		detected: hosting?.kind === "github" ? githubTargetName(hosting) : null,
	};
}

projectTeamRoutes.get("/:projectId/team-github", async (c) => {
	const projectId = c.req.param("projectId");
	await requireProjectAccess(c, projectId, "read");
	return c.json(await githubPinResponse(projectId));
});

projectTeamRoutes.put("/:projectId/team-github", async (c) => {
	const projectId = c.req.param("projectId");
	await requireProjectAccess(c, projectId, "manage");
	const parsed = teamGithubPinSchema.safeParse(await jsonBody(c));
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const { parseGithubTarget, setPinnedGithubTarget } = await import(
		"../services/teams/team-github-pin"
	);
	const target = parseGithubTarget(parsed.data.target);
	if (!target) throw new ValidationError("Expected host/owner/repo");
	setPinnedGithubTarget(projectId, target, projectPrincipalOf(c).userId || null);
	return c.json(await githubPinResponse(projectId));
});

projectTeamRoutes.delete("/:projectId/team-github", async (c) => {
	const projectId = c.req.param("projectId");
	await requireProjectAccess(c, projectId, "manage");
	const { setPinnedGithubTarget } = await import("../services/teams/team-github-pin");
	setPinnedGithubTarget(projectId, null, null);
	return c.json(await githubPinResponse(projectId));
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
