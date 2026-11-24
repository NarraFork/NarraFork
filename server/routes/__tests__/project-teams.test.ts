/**
 * Project teams (docs/PROJECT_TEAMS-PLAN.md, P1) through `/projects/:projectId/teams`.
 *
 *  - creating a team creates the coordinator narrator (`team` trait, cwd = the project's git
 *    directory) and the team row in one transaction: a failing team row leaves no narrator;
 *  - the team name is the coordinator's title, so renaming the session renames the team;
 *  - access is the coordinator's narrator ACL: members (write) change it, read-only people see
 *    it and get 403 on changes, everyone else gets 404 and does not see it in the list;
 *  - archiving the coordinator archives the team, from the team route or any other path;
 *  - a coordinator with live work items cannot be deleted, nor a project that has teams.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-project-teams-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectTeamRoutes } = await import("../project-teams");
const { projectRoutes } = await import("../projects");
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { eq } = await import("drizzle-orm");
const { aclGrants, narrators, projects, projectTeams, teamWorkEvents, teamWorkItems, users } =
	await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { narratorService } = await import("../../services/narrator-service");
const { createTeam, readTeamBrief, startTeamStatusSync } = await import(
	"../../services/teams/team-service"
);
const { runAsTeamStatusActor } = await import("../../services/teams/team-records");
const { interruptAndArchiveSubagent } = await import("../../services/subagent-lifecycle");

const OWNER = "team-owner";
const MEMBER = "team-member";
const READER = "team-reader";
const OUTSIDER = "team-outsider";

const repo = join(testHome, "repo");
let projectId: string;
let stopSync: () => void = () => {};

afterAll(() => {
	stopSync();
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/projects", projectTeamRoutes);
	app.route("/projects", projectRoutes);
	app.route("/narrators", narratorRoutes);
	return app;
}

async function call(
	userId: string,
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const { method = "GET", body } = init;
	const response = await appAs(userId).request(`http://localhost${path}`, {
		method,
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function grantProject(userId: string, capability: "read" | "write") {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: userId,
		capability,
		createdAt: new Date().toISOString(),
	});
}

async function newTeam(name: string, extra: Record<string, unknown> = {}) {
	const created = await call(OWNER, `/projects/${projectId}/teams`, {
		method: "POST",
		body: { name, ...extra },
	});
	expect(created.status).toBe(201);
	return created.body as { id: string } & Record<string, unknown>;
}

async function statusEvents(teamId: string) {
	const rows = await db.query.teamWorkEvents.findMany({
		where: eq(teamWorkEvents.teamId, teamId),
	});
	return rows
		.filter((row) => row.kind === "team.archived" || row.kind === "team.unarchived")
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.kind.localeCompare(b.kind))
		.map((row) => [row.kind, row.actorKind, row.actorId]);
}

beforeAll(async () => {
	mkdirSync(repo, { recursive: true });
	const now = new Date().toISOString();
	for (const id of [OWNER, MEMBER, READER, OUTSIDER]) {
		await db.insert(users).values({
			id,
			username: `${id}-${Date.now()}`,
			passwordHash: "x",
			role: "user",
			createdAt: now,
		});
	}
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "team project",
		gitPath: repo,
		defaultBranch: "trunk",
		ownerUserId: OWNER,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	await grantProject(MEMBER, "write");
	await grantProject(READER, "read");
	stopSync = startTeamStatusSync();
});

describe("creating a team", () => {
	test("creates the coordinator narrator and the team row together", async () => {
		const team = await newTeam("Alpha", {
			brief: "Run the tests.",
			settings: { mergeNeedsPerson: true },
		});
		expect(team).toMatchObject({
			projectId,
			name: "Alpha",
			baseBranch: "trunk",
			status: "active",
			access: "write",
			brief: "Run the tests.",
			settings: { mergeNeedsPerson: true },
			briefBytes: 14,
			createdBy: OWNER,
		});
		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, team.id) });
		expect(narrator?.title).toBe("Alpha");
		expect(narrator?.traits).toContain("team");
		expect(narrator?.variant).toBe("primary");
		expect(narrator?.cwd).toBe(repo);
		expect(narrator?.contextProjectId).toBe(projectId);
		expect(narrator?.ownerUserId).toBe(OWNER);
		// Project-page defaults: the project's write members are the team's members.
		expect(narrator?.visibility).toBe("project");
		expect(narrator?.writeAudience).toBe("project");
		const events = await db.query.teamWorkEvents.findMany({
			where: eq(teamWorkEvents.teamId, team.id),
		});
		expect(events.map((event) => event.kind)).toEqual(["team.created"]);
		expect(readTeamBrief(team.id)).toBe("Run the tests.");
		expect(readTeamBrief("not-a-team")).toBeNull();
	});

	test("a team row that cannot be written leaves no coordinator behind", async () => {
		const name = `Atomic ${generateId()}`;
		// Over the 4 KB column check: the route refuses it, so go to the service directly to
		// make the team insert fail inside the narrator's transaction.
		await expect(
			createTeam({ projectId, name, brief: "x".repeat(5000) }, { userId: OWNER, isAdmin: false }),
		).rejects.toThrow();
		const leftover = await db.query.narrators.findFirst({ where: eq(narrators.title, name) });
		expect(leftover).toBeUndefined();
	});

	test("needs project write; validates the body", async () => {
		expect(
			(await call(READER, `/projects/${projectId}/teams`, { method: "POST", body: { name: "R" } }))
				.status,
		).toBeOneOf([403, 404]);
		expect(
			(
				await call(OUTSIDER, `/projects/${projectId}/teams`, {
					method: "POST",
					body: { name: "O" },
				})
			).status,
		).toBe(404);
		const member = await call(MEMBER, `/projects/${projectId}/teams`, {
			method: "POST",
			body: { name: "Member's team" },
		});
		expect(member.status).toBe(201);
		expect(member.body.createdBy).toBe(MEMBER);
		for (const body of [
			{},
			{ name: "" },
			{ name: "x", brief: "é".repeat(2049) },
			{ name: "x", baseBranch: "../main" },
			{ name: "x", baseBranch: "-main" },
			{ name: "x", settings: { unknown: 1 } },
			{ name: "x", settings: { coordinatorLimits: { editLines: 0 } } },
			{ name: "x", extra: true },
		]) {
			const response = await call(OWNER, `/projects/${projectId}/teams`, { method: "POST", body });
			expect(response.status).toBe(400);
		}
	});
});

describe("team name and access", () => {
	test("renaming the coordinator renames the team", async () => {
		const team = await newTeam("Before");
		await narratorService.updateTitle(team.id, "After");
		const fetched = await call(OWNER, `/projects/${projectId}/teams/${team.id}`);
		expect(fetched.body.name).toBe("After");
		const listed = await call(OWNER, `/projects/${projectId}/teams?status=all&limit=100`);
		const row = (listed.body.teams as Array<{ id: string; name: string }>).find(
			(entry) => entry.id === team.id,
		);
		expect(row?.name).toBe("After");
	});

	test("members write, read-only people look, others get 404", async () => {
		const team = await newTeam("Access");
		const path = `/projects/${projectId}/teams/${team.id}`;

		expect((await call(MEMBER, path)).body.access).toBe("write");
		const patched = await call(MEMBER, path, { method: "PATCH", body: { brief: "Member rules" } });
		expect(patched.status).toBe(200);
		expect(patched.body.brief).toBe("Member rules");

		const read = await call(READER, path);
		expect(read.status).toBe(200);
		expect(read.body.access).toBe("read");
		expect((await call(READER, path, { method: "PATCH", body: { brief: "no" } })).status).toBe(403);
		expect((await call(READER, `${path}/archive`, { method: "POST" })).status).toBe(403);

		expect((await call(OUTSIDER, path)).status).toBe(404);
		expect((await call(OUTSIDER, path, { method: "PATCH", body: { brief: "no" } })).status).toBe(
			404,
		);
		expect((await call(OUTSIDER, `/projects/${projectId}/teams`)).status).toBe(404);

		// The team belongs to this project only.
		expect((await call(OWNER, `/projects/not-this-project/teams/${team.id}`)).status).toBe(404);
		// A plain session is no team.
		const plain = generateId();
		const now = new Date().toISOString();
		await db
			.insert(narrators)
			.values({ id: plain, ownerUserId: OWNER, createdAt: now, updatedAt: now });
		expect((await call(OWNER, `/projects/${projectId}/teams/${plain}`)).status).toBe(404);
	});

	test("a private coordinator is visible to its owner only", async () => {
		const team = await newTeam("Private", { visibility: "private", writeAudience: "owner" });
		expect((await call(MEMBER, `/projects/${projectId}/teams/${team.id}`)).status).toBe(404);
		const ids = async (userId: string) =>
			(
				(await call(userId, `/projects/${projectId}/teams?status=all&limit=100`)).body
					.teams as Array<{
					id: string;
				}>
			).map((entry) => entry.id);
		expect(await ids(OWNER)).toContain(team.id);
		expect(await ids(MEMBER)).not.toContain(team.id);
		expect(await ids(READER)).not.toContain(team.id);
	});

	test("the list pages by team id with a cursor and carries no brief", async () => {
		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const response = await call(
				OWNER,
				`/projects/${projectId}/teams?status=all&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
			);
			const page = response.body.teams as Array<Record<string, unknown>>;
			expect(page.length).toBeLessThanOrEqual(2);
			for (const entry of page) {
				expect(entry.brief).toBeUndefined();
				expect(typeof entry.briefBytes).toBe("number");
				seen.push(entry.id as string);
			}
			cursor = response.body.nextCursor as string | null;
		} while (cursor);
		expect(seen).toEqual([...seen].sort());
		expect(new Set(seen).size).toBe(seen.length);
		const total = await db.select().from(projectTeams).where(eq(projectTeams.projectId, projectId));
		expect(seen.length).toBe(total.length);
	});
});

describe("archive and delete", () => {
	test("archiving from the team route archives the coordinator and freezes the team", async () => {
		const team = await newTeam("Archive me");
		const path = `/projects/${projectId}/teams/${team.id}`;
		const archived = await call(OWNER, `${path}/archive`, { method: "POST" });
		expect(archived.status).toBe(200);
		expect(archived.body.status).toBe("archived");
		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, team.id) });
		expect(narrator?.status).toBe("archived");
		expect((await call(OWNER, path, { method: "PATCH", body: { brief: "x" } })).status).toBe(409);

		const active = await call(OWNER, `/projects/${projectId}/teams?status=active&limit=100`);
		expect((active.body.teams as Array<{ id: string }>).map((t) => t.id)).not.toContain(team.id);
		const archivedList = await call(
			OWNER,
			`/projects/${projectId}/teams?status=archived&limit=100`,
		);
		expect((archivedList.body.teams as Array<{ id: string }>).map((t) => t.id)).toContain(team.id);

		const back = await call(OWNER, `${path}/unarchive`, { method: "POST" });
		expect(back.body.status).toBe("active");
		// Each change is recorded once, as the person who made it (not as the sync listener).
		expect(await statusEvents(team.id)).toEqual([
			["team.archived", "person", OWNER],
			["team.unarchived", "person", OWNER],
		]);
	});

	test("archiving through the narrator routes is the person's change too", async () => {
		const team = await newTeam("Narrator route");
		expect((await call(MEMBER, `/narrators/${team.id}/archive`, { method: "PATCH" })).status).toBe(
			200,
		);
		expect((await call(OWNER, `/projects/${projectId}/teams/${team.id}`)).body.status).toBe(
			"archived",
		);
		expect(
			(await call(MEMBER, `/narrators/${team.id}/unarchive`, { method: "PATCH" })).status,
		).toBe(200);
		expect(await statusEvents(team.id)).toEqual([
			["team.archived", "person", MEMBER],
			["team.unarchived", "person", MEMBER],
		]);
	});

	test("the person does not leak into work their request started", async () => {
		const team = await newTeam("No leak");
		let fired: Promise<unknown> = Promise.resolve();
		// Something scheduled inside a person's status call (a run, a wake-up, a later turn)
		// that archives the coordinator after that call has returned.
		await runAsTeamStatusActor({ kind: "person", id: MEMBER }, async () => {
			fired = new Promise((resolve) =>
				setTimeout(() => resolve(narratorService.updateStatus(team.id, "archived")), 5),
			);
		});
		await fired;
		expect(await statusEvents(team.id)).toEqual([["team.archived", "system", null]]);
	});

	test("Agent control records the agent", async () => {
		const team = await newTeam("Agent control");
		const controller = generateId();
		await runAsTeamStatusActor({ kind: "agent", id: controller }, () =>
			interruptAndArchiveSubagent(team.id),
		);
		await runAsTeamStatusActor({ kind: "agent", id: controller }, () =>
			narratorService.updateStatus(team.id, "idle"),
		);
		expect(await statusEvents(team.id)).toEqual([
			["team.archived", "agent", controller],
			["team.unarchived", "agent", controller],
		]);
		// The Agent tool's archive and unarchive run as the calling agent.
		const taskSource = await Bun.file(
			new URL("../../lib/agent/tools/task.ts", import.meta.url),
		).text();
		expect(
			taskSource.split('runAsTeamStatusActor({ kind: "agent", id: ctx.narratorId }').length - 1,
		).toBe(2);
	});

	test("narrator routes change status as the caller only around the status write", async () => {
		const source = await Bun.file(new URL("../narrators.ts", import.meta.url)).text();
		// No request-wide actor: interaction and explicit unarchive each use their own bounded helper.
		expect(source).not.toMatch(/narratorRoutes\.use\([^)]*runAsTeamStatusActor/);
		expect(source.split('narratorService.updateStatus(id, "idle")').length - 1).toBe(1);
		expect(source.split("unarchiveAsCaller(c, id)").length - 1).toBeGreaterThanOrEqual(10);
		expect(source).toContain(
			'transitionNarratorArchiveGroup(narratorPrincipalOf(c), c.req.param("id"), "idle")',
		);
	});

	test("the status people see is the coordinator's, whatever the stored mirror says", async () => {
		const team = await newTeam("Mirror");
		// A stale mirror (e.g. a missed event): the coordinator is active, so is the team.
		await db
			.update(projectTeams)
			.set({ status: "archived" })
			.where(eq(projectTeams.narratorId, team.id));
		const path = `/projects/${projectId}/teams/${team.id}`;
		expect((await call(OWNER, path)).body.status).toBe("active");
		const active = await call(OWNER, `/projects/${projectId}/teams?status=active&limit=100`);
		expect((active.body.teams as Array<{ id: string }>).map((t) => t.id)).toContain(team.id);
		expect((await call(OWNER, path, { method: "PATCH", body: { brief: "ok" } })).status).toBe(200);
	});

	test("archiving the narrator by any other path archives the team", async () => {
		const team = await newTeam("Elsewhere");
		await narratorService.updateStatus(team.id, "archived");
		const row = await db.query.projectTeams.findFirst({
			where: eq(projectTeams.narratorId, team.id),
		});
		expect(row?.status).toBe("archived");
		await narratorService.updateStatus(team.id, "idle");
		const again = await db.query.projectTeams.findFirst({
			where: eq(projectTeams.narratorId, team.id),
		});
		expect(again?.status).toBe("active");
		// No person behind these changes: the system's.
		expect(await statusEvents(team.id)).toEqual([
			["team.archived", "system", null],
			["team.unarchived", "system", null],
		]);
	});

	test("a coordinator with live work items cannot be deleted; without, its team goes with it", async () => {
		const team = await newTeam("Delete me");
		const now = new Date().toISOString();
		const item = generateId();
		await db.insert(teamWorkItems).values({
			id: item,
			teamId: team.id,
			projectId,
			title: "in flight",
			state: "in_progress",
			createdAt: now,
			updatedAt: now,
		});
		await expect(narratorService.remove(team.id)).rejects.toMatchObject({
			code: "TEAM_HAS_LIVE_WORK",
			statusCode: 409,
		});
		expect(await db.query.narrators.findFirst({ where: eq(narrators.id, team.id) })).toBeDefined();
		// A raw delete is refused by the foreign key, not cascaded.
		expect(() => db.delete(narrators).where(eq(narrators.id, team.id)).run()).toThrow();

		await db.update(teamWorkItems).set({ state: "cancelled" }).where(eq(teamWorkItems.id, item));
		await narratorService.remove(team.id);
		expect(
			await db.query.narrators.findFirst({ where: eq(narrators.id, team.id) }),
		).toBeUndefined();
		expect(
			await db.query.projectTeams.findFirst({ where: eq(projectTeams.narratorId, team.id) }),
		).toBeUndefined();
		expect(
			await db.query.teamWorkItems.findFirst({ where: eq(teamWorkItems.id, item) }),
		).toBeUndefined();
		expect(
			await db.query.teamWorkEvents.findFirst({ where: eq(teamWorkEvents.teamId, team.id) }),
		).toBeUndefined();
	});

	test("a finished item that still records a worktree also blocks deletion", async () => {
		const team = await newTeam("Worktree kept");
		const now = new Date().toISOString();
		const resource = generateId();
		const { narratorWorktreeResources } = await import("../../db/schema");
		await db.insert(narratorWorktreeResources).values({
			id: resource,
			deviceId: "local",
			repositoryKey: "repo",
			worktreePath: join(repo, ".worktrees", resource),
			state: "ready",
			createRequestId: resource,
		});
		await db.insert(teamWorkItems).values({
			id: generateId(),
			teamId: team.id,
			projectId,
			title: "merged but not cleaned",
			state: "merged",
			worktreeResourceId: resource,
			createdAt: now,
			updatedAt: now,
		});
		await expect(narratorService.remove(team.id)).rejects.toMatchObject({
			code: "TEAM_HAS_LIVE_WORK",
		});
	});

	test("a project with teams cannot be deleted", async () => {
		const response = await call(OWNER, `/projects/${projectId}`, { method: "DELETE" });
		expect(response.status).toBe(409);
		expect(response.body.code).toBe("PROJECT_HAS_TEAMS");
		expect(await db.query.projects.findFirst({ where: eq(projects.id, projectId) })).toBeDefined();
	});
});
