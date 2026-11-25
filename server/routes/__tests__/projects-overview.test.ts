/**
 * The redesigned project pages' reads (R2):
 *
 *  - `GET /projects/summaries`: per readable project, running sessions (no coordinators), teams,
 *    what waits for the caller (members only) and the last activity, in one request;
 *  - `GET /projects/:id/attention`: pending calls across the project's sessions and team trees
 *    that the caller may decide, then ready items of their teams; members only (reader 403,
 *    stranger 404);
 *  - `GET /projects/:id/sessions`: 进行中 (running, then the last 7 days) / 全部 / 我的, keyset
 *    pages, no coordinators, subagents, archived or unreadable sessions; readers may list it;
 *  - `GET /projects/:id/teams?counts=true`: each team's card numbers, the pending count for
 *    members only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";
import { initTeamRepo } from "../../services/teams/__tests__/team-repo.fixture";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-project-overview-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectRoutes } = await import("../projects");
const { projectTeamRoutes } = await import("../project-teams");
const { db } = await import("../../db");
const { eq } = await import("drizzle-orm");
const {
	aclGrants,
	narratorMessages,
	narratorProjectLinks,
	narrators,
	narratorToolCalls,
	projects,
	teamWorkItems,
	users,
} = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { overviewAccessStats } = await import("../../services/project-overview");
const { canWriteProject, projectsWritableBy } = await import("../../services/project-acl");

const OWNER = "overview-owner";
const MEMBER = "overview-member";
const READER = "overview-reader";
const OUTSIDER = "overview-outsider";

const repo = join(testHome, "repo");
let projectId: string;
let otherProjectId: string;
let teamId: string;
let workerId: string;
const sessions: Record<string, string> = {};

afterAll(() => {
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
	app.onError((error) =>
		error instanceof AppError
			? Response.json({ error: error.message, code: error.code }, { status: error.statusCode })
			: Response.json({ error: String(error) }, { status: 500 }),
	);
	app.route("/projects", projectTeamRoutes);
	app.route("/projects", projectRoutes);
	return app;
}

async function call(
	userId: string,
	path: string,
	init: { method?: string; body?: unknown } = {},
	// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
): Promise<{ status: number; body: any }> {
	const { method = "GET", body } = init;
	const response = await appAs(userId).request(`http://localhost${path}`, {
		method,
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	return { status: response.status, body: await response.json() };
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

async function session(
	key: string,
	values: {
		owner: string;
		status?: string;
		updatedAt?: string;
		project?: string;
		link?: boolean;
		visibility?: "private" | "project" | "public";
		writeAudience?: "owner" | "project" | "public";
	},
) {
	const id = generateId();
	const at = values.updatedAt ?? new Date().toISOString();
	const project = values.project ?? projectId;
	await db.insert(narrators).values({
		id,
		title: key,
		status: (values.status ?? "idle") as "idle",
		cwd: repo,
		ownerUserId: values.owner,
		visibility: values.visibility ?? "project",
		writeAudience: values.writeAudience ?? "project",
		contextProjectId: values.link ? null : project,
		createdAt: at,
		updatedAt: at,
	});
	if (values.link)
		await db.insert(narratorProjectLinks).values({
			narratorId: id,
			projectId: project,
			role: "primary",
			source: "cwd",
			directory: repo,
			updatedAt: at,
		});
	sessions[key] = id;
	return id;
}

let clock = Date.now();
async function pendingCall(narratorId: string, input: Record<string, unknown>, toolName = "Bash") {
	const id = generateId();
	const messageId = generateId();
	clock += 1000;
	const at = new Date(clock).toISOString();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [],
		createdAt: at,
	});
	await db.insert(narratorToolCalls).values({
		id,
		narratorId,
		messageId,
		toolUseId: `use-${id}`,
		toolName,
		status: "pending",
		inputJson: input,
		permissionStartedAt: at,
		createdAt: at,
	});
	return id;
}

beforeAll(async () => {
	initTeamRepo(repo);
	const now = new Date().toISOString();
	for (const id of [OWNER, MEMBER, READER, OUTSIDER])
		await db
			.insert(users)
			.values({ id, username: `${id}-name`, passwordHash: "x", role: "user", createdAt: now });
	projectId = generateId();
	otherProjectId = generateId();
	for (const [id, name] of [
		[projectId, "overview project"],
		[otherProjectId, "other project"],
	] as const)
		await db.insert(projects).values({
			id,
			name,
			gitPath: id === projectId ? repo : join(testHome, "other"),
			defaultBranch: "main",
			ownerUserId: OWNER,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		});
	for (const [principalId, capability, scopeId] of [
		[MEMBER, "write", projectId],
		[READER, "read", projectId],
		[MEMBER, "write", otherProjectId],
	] as const)
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId,
			principalType: "user",
			principalId,
			capability,
			createdAt: now,
		});
	const created = await call(OWNER, `/projects/${projectId}/teams`, {
		method: "POST",
		body: { name: "Release team" },
	});
	expect(created.status).toBe(201);
	teamId = created.body.id;
	// The coordinator runs: it is on the team card, never in the session list or its counts.
	await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, teamId));
	workerId = await session("worker", { owner: OWNER, status: "working" });
	await db
		.update(narrators)
		.set({
			type: "subagent",
			variant: "subagent:general",
			aclRootNarratorId: teamId,
			parentNarratorId: teamId,
			contextProjectId: null,
		})
		.where(eq(narrators.id, workerId));

	await session("running-member", { owner: MEMBER, status: "working", link: true });
	await session("waiting-owner", { owner: OWNER, status: "waiting" });
	await session("recent-owner", { owner: OWNER, updatedAt: daysAgo(2) });
	await session("old-member", { owner: MEMBER, updatedAt: daysAgo(30) });
	await session("private-owner", {
		owner: OWNER,
		status: "working",
		visibility: "private",
		writeAudience: "owner",
	});
	await session("archived", { owner: MEMBER, status: "archived" });
	await session("elsewhere", { owner: MEMBER, status: "working", project: otherProjectId });
});

describe("access", () => {
	test("attention is for members; readers get 403 and strangers 404", async () => {
		expect((await call(OWNER, `/projects/${projectId}/attention`)).status).toBe(200);
		expect((await call(MEMBER, `/projects/${projectId}/attention`)).status).toBe(200);
		expect((await call(READER, `/projects/${projectId}/attention`)).status).toBe(403);
		expect((await call(OUTSIDER, `/projects/${projectId}/attention`)).status).toBe(404);
		expect((await call(OWNER, "/projects/no-such-project/attention")).status).toBe(404);
	});

	test("the session list is for readers; strangers of a private project get 404", async () => {
		expect((await call(READER, `/projects/${projectId}/sessions`)).status).toBe(200);
		expect((await call(OUTSIDER, `/projects/${projectId}/sessions`)).status).toBe(404);
		expect((await call(OWNER, `/projects/${projectId}/sessions?view=nope`)).status).toBe(400);
		expect((await call(OWNER, `/projects/${projectId}/sessions?cursor=%7B`)).status).toBe(400);
		expect((await call(OWNER, `/projects/${projectId}/sessions?limit=101`)).status).toBe(400);
	});

	test("a public project: a non-member reads its sessions but gets 403 for attention", async () => {
		const publicId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: publicId,
			name: "public project",
			gitPath: join(testHome, "public"),
			ownerUserId: OWNER,
			visibility: "public",
			createdAt: now,
			updatedAt: now,
		});
		expect((await call(OUTSIDER, `/projects/${publicId}/sessions`)).status).toBe(200);
		expect((await call(OUTSIDER, `/projects/${publicId}/attention`)).status).toBe(403);
		expect((await call(OWNER, `/projects/${publicId}/attention`)).status).toBe(200);
		const summaries = (await call(OUTSIDER, "/projects/summaries")).body.summaries;
		expect(summaries.map((row: { projectId: string }) => row.projectId)).toEqual([publicId]);
		await db.delete(projects).where(eq(projects.id, publicId));
	});

	test("summaries leave out projects the caller cannot read", async () => {
		const outsider = await call(OUTSIDER, "/projects/summaries");
		expect(outsider.status).toBe(200);
		expect(outsider.body.summaries).toEqual([]);
		expect((await call(OUTSIDER, `/projects/${projectId}/teams?counts=true`)).status).toBe(404);
		const reader = await call(READER, "/projects/summaries");
		expect(reader.body.summaries.map((row: { projectId: string }) => row.projectId)).toEqual([
			projectId,
		]);
	});
});

describe("sessions", () => {
	const titles = (body: { items: { title: string }[] }) => body.items.map((row) => row.title);

	test("进行中: running first, then the last 7 days; no coordinator, worker, archived or old", async () => {
		const page = await call(OWNER, `/projects/${projectId}/sessions?view=active`);
		expect(page.status).toBe(200);
		const shown = titles(page.body);
		expect(shown.slice(0, 3).sort()).toEqual(["private-owner", "running-member", "waiting-owner"]);
		expect(shown.slice(3)).toEqual(["recent-owner"]);
		expect(page.body.items.slice(0, 3).every((row: { group: string }) => row.group === "running"));
		expect(page.body.items[3].group).toBe("recent");
		for (const absent of ["Release team", "worker", "archived", "old-member", "elsewhere"])
			expect(shown).not.toContain(absent);
		expect(page.body.counts).toEqual({ active: 4, all: 5, mine: 3 });
	});

	test("another member does not see a private session; 我的 is their own", async () => {
		const active = await call(MEMBER, `/projects/${projectId}/sessions?view=active`);
		expect(titles(active.body)).not.toContain("private-owner");
		const mine = await call(MEMBER, `/projects/${projectId}/sessions?view=mine`);
		expect(titles(mine.body).sort()).toEqual(["old-member", "running-member"]);
		expect(mine.body.counts.mine).toBe(2);
		const row = mine.body.items.find((item: { title: string }) => item.title === "running-member");
		expect(row.owner).toMatchObject({ userId: MEMBER, username: `${MEMBER}-name` });
	});

	test("pages follow a keyset cursor across the running and recent phases", async () => {
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let index = 0; index < 10; index++) {
			const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
			const page = await call(OWNER, `/projects/${projectId}/sessions?view=active&limit=1${query}`);
			expect(page.status).toBe(200);
			if (index > 0) expect(page.body.counts).toBeNull();
			seen.push(...titles(page.body));
			cursor = page.body.nextCursor;
			if (!cursor) break;
		}
		expect(seen).toHaveLength(4);
		expect(seen.at(-1)).toBe("recent-owner");
		expect(new Set(seen).size).toBe(4);
	});

	test("a cursor of another view is refused", async () => {
		const first = await call(OWNER, `/projects/${projectId}/sessions?view=active&limit=1`);
		const cursor = encodeURIComponent(first.body.nextCursor);
		expect(
			(await call(OWNER, `/projects/${projectId}/sessions?view=all&cursor=${cursor}`)).status,
		).toBe(400);
		// And the other way round: 进行中 does not restart on a 全部 cursor.
		const all = await call(OWNER, `/projects/${projectId}/sessions?view=all&limit=1`);
		const allCursor = encodeURIComponent(all.body.nextCursor);
		expect(
			(await call(OWNER, `/projects/${projectId}/sessions?view=active&cursor=${allCursor}`)).status,
		).toBe(400);
	});
});

describe("attention", () => {
	test("calls across sessions and team trees, each with where it comes from", async () => {
		const sessionCall = await pendingCall(sessions["running-member"] as string, {
			command: "pnpm test",
		});
		const workerCall = await pendingCall(workerId, { file_path: "docs/adr.md" }, "Edit");
		const privateCall = await pendingCall(sessions["private-owner"] as string, {
			command: "rm -rf build",
		});
		await pendingCall(sessions.elsewhere as string, { command: "elsewhere" });
		const readyId = generateId();
		const at = new Date().toISOString();
		await db.insert(teamWorkItems).values({
			id: readyId,
			teamId,
			projectId,
			title: "Ready item",
			state: "ready",
			reviewRounds: 1,
			lastReview: "clear",
			createdAt: at,
			updatedAt: at,
		});

		const member = await call(MEMBER, `/projects/${projectId}/attention`);
		expect(member.status).toBe(200);
		const ids = member.body.entries.map(
			(entry: { kind: string; approval?: { id: string }; item?: { id: string } }) =>
				entry.kind === "merge" ? `merge:${entry.item?.id}` : entry.approval?.id,
		);
		// The owner's private session is not theirs to decide; another project's call is not here.
		expect(ids).toEqual([sessionCall, workerCall, `merge:${readyId}`]);
		const [fromSession, fromTeam, merge] = member.body.entries;
		expect(fromSession.source).toEqual({
			kind: "session",
			narratorId: sessions["running-member"],
			title: "running-member",
			ownerName: `${MEMBER}-name`,
		});
		expect(fromSession.approval).toMatchObject({ kind: "tool", preview: "pnpm test", depth: 0 });
		expect(fromTeam.source).toEqual({ kind: "team", teamId, name: "Release team" });
		expect(fromTeam.approval).toMatchObject({ depth: 1, preview: "docs/adr.md" });
		expect(merge).toMatchObject({ kind: "merge", base: "main", source: { teamId } });
		expect(member.body.more).toBe(false);

		const owner = await call(OWNER, `/projects/${projectId}/attention`);
		expect(
			owner.body.entries.some(
				(entry: { approval?: { id: string } }) => entry.approval?.id === privateCall,
			),
		).toBe(true);
	});

	test("the list numbers agree: waiting for members, nothing for readers", async () => {
		const member = (await call(MEMBER, "/projects/summaries")).body.summaries;
		const own = member.find((row: { projectId: string }) => row.projectId === projectId);
		expect(own).toMatchObject({ runningSessionCount: 2, teamCount: 1, waitingCount: 3 });
		expect(own.lastActivityAt).toBeString();
		const other = member.find((row: { projectId: string }) => row.projectId === otherProjectId);
		expect(other).toMatchObject({ runningSessionCount: 1, teamCount: 0, waitingCount: 1 });
		const reader = (await call(READER, "/projects/summaries")).body.summaries[0];
		expect(reader).toMatchObject({ projectId, runningSessionCount: 2, waitingCount: 0 });
		const owner = (await call(OWNER, "/projects/summaries")).body.summaries.find(
			(row: { projectId: string }) => row.projectId === projectId,
		);
		expect(owner).toMatchObject({ runningSessionCount: 3, waitingCount: 4 });
	});
});

describe("team cards", () => {
	test("counts per team; the pending count for members only", async () => {
		const member = await call(MEMBER, `/projects/${projectId}/teams?counts=true`);
		expect(member.status).toBe(200);
		const card = member.body.teams[0].card;
		expect(card.readyCount).toBe(1);
		expect(card.columnCounts.review).toBe(1);
		expect(card.runningCount).toBe(2);
		expect(card.pendingApprovalCount).toBe(1);
		const reader = await call(READER, `/projects/${projectId}/teams?counts=true`);
		expect(reader.body.teams[0].card.pendingApprovalCount).toBeNull();
		// Without `counts`, the list stays as it was.
		const plain = await call(MEMBER, `/projects/${projectId}/teams`);
		expect(plain.body.teams[0].card).toBeUndefined();
		expect((await call(OUTSIDER, `/projects/${projectId}/teams?counts=true`)).status).toBe(404);
	});
});

describe("bounded work", () => {
	test("access is judged once per session, not once per call, in a few batches", async () => {
		// Many calls from ten workers of one team (one root) and from one session.
		const workers = [workerId];
		for (let index = 0; index < 9; index++) {
			const id = await session(`helper-${index}`, { owner: OWNER, status: "working" });
			await db
				.update(narrators)
				.set({
					type: "subagent",
					variant: "subagent:general",
					aclRootNarratorId: teamId,
					parentNarratorId: workerId,
					contextProjectId: null,
				})
				.where(eq(narrators.id, id));
			workers.push(id);
		}
		for (let index = 0; index < 120; index++)
			await pendingCall(
				index % 2
					? (workers[index % workers.length] as string)
					: (sessions["running-member"] as string),
				{ command: `step ${index}` },
			);
		for (const read of [
			() => call(MEMBER, `/projects/${projectId}/attention`),
			() => call(MEMBER, "/projects/summaries"),
		]) {
			overviewAccessStats.batches = 0;
			overviewAccessStats.judged = 0;
			const response = await read();
			expect(response.status).toBe(200);
			// Roots: the team, the member's session, the owner's private one (and the other
			// project's session for the summary), plus one batch for the teams' membership.
			expect(overviewAccessStats.judged).toBeGreaterThan(0);
			expect(overviewAccessStats.judged).toBeLessThanOrEqual(6);
			expect(overviewAccessStats.batches).toBeLessThanOrEqual(7);
		}
		const attention = await call(MEMBER, `/projects/${projectId}/attention`);
		expect(attention.body.more).toBe(true);
	});

	test("project write in one batch agrees with canWriteProject", async () => {
		const rows = await db.query.projects.findMany();
		for (const userId of [OWNER, MEMBER, READER, OUTSIDER]) {
			const principal = { userId, isAdmin: false };
			const batch = await projectsWritableBy(rows, principal);
			for (const row of rows)
				expect({ userId, project: row.name, write: batch.has(row.id) }).toEqual({
					userId,
					project: row.name,
					write: await canWriteProject(row, principal),
				});
		}
	});

	test("ready items of an archived team count nowhere", async () => {
		const before = (await call(OWNER, "/projects/summaries")).body.summaries.find(
			(row: { projectId: string }) => row.projectId === projectId,
		).waitingCount;
		const archived = await call(OWNER, `/projects/${projectId}/teams`, {
			method: "POST",
			body: { name: "Archived team" },
		});
		expect(archived.status).toBe(201);
		const at = new Date().toISOString();
		await db.insert(teamWorkItems).values({
			id: generateId(),
			teamId: archived.body.id,
			projectId,
			title: "Ready in an archived team",
			state: "ready",
			createdAt: at,
			updatedAt: at,
		});
		const live = (await call(OWNER, "/projects/summaries")).body.summaries.find(
			(row: { projectId: string }) => row.projectId === projectId,
		).waitingCount;
		expect(live).toBe(before + 1);
		await db
			.update(narrators)
			.set({ status: "archived" })
			.where(eq(narrators.id, archived.body.id));
		const after = (await call(OWNER, "/projects/summaries")).body.summaries.find(
			(row: { projectId: string }) => row.projectId === projectId,
		).waitingCount;
		expect(after).toBe(before);
		const attention = await call(OWNER, `/projects/${projectId}/attention`);
		expect(
			attention.body.entries.some(
				(entry: { item?: { title: string } }) => entry.item?.title === "Ready in an archived team",
			),
		).toBe(false);
	});
});

describe("bounded reads", () => {
	test("a team card counts finished items up to 1,000; open ones exactly", async () => {
		const at = new Date().toISOString();
		const rows = Array.from({ length: 1_005 }, (_, index) => ({
			id: generateId(),
			teamId,
			projectId,
			title: `merged ${index}`,
			state: "merged" as const,
			createdAt: at,
			updatedAt: at,
		}));
		for (let index = 0; index < rows.length; index += 200)
			await db.insert(teamWorkItems).values(rows.slice(index, index + 200));
		const card = (await call(MEMBER, `/projects/${projectId}/teams?counts=true`)).body.teams.find(
			(team: { id: string }) => team.id === teamId,
		).card;
		expect(card.columnCounts.done).toBe(1_000);
		expect(card.readyCount).toBe(1);
		expect(card.lastEventAt).toBeString();
	});

	test("the overview reads never load whole project rows (chapter settings)", () => {
		const source = readFileSync(
			new URL("../../services/project-overview.ts", import.meta.url),
			"utf8",
		);
		// The shared loaders select every column, command prompts included.
		expect(source).not.toContain("loadProjectForAccess(");
		expect(source).not.toContain(".listProjects(");
		expect(source).not.toContain("chapterSettings");
		expect(source).not.toContain("db.query.projects");
	});
});
