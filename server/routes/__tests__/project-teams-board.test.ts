/**
 * The team page's read APIs (docs/PROJECT_TEAMS-PLAN.md §二.11, §二.12; P4) through
 * `/projects/:projectId/teams/:teamId/{summary,board,events,approvals}`:
 *
 *  - access is the coordinator's ACL: a member and an onlooker read the summary, board and
 *    activity; a stranger gets 404; pending approvals are for members only (onlooker 403);
 *  - the board maps work item states to five columns, pages by a keyset cursor (open columns
 *    oldest first, finished ones newest change first) and never carries the changed paths;
 *  - the activity runs newest first with actor names, and leaves out a detail too large to list;
 *  - the approvals list covers the whole tree (coordinator, worker, helper), at most 50, shows a
 *    bounded preview of the input, and an approval goes through the ordinary permission route.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-team-board-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectTeamRoutes } = await import("../project-teams");
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { eq } = await import("drizzle-orm");
const {
	aclGrants,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	teamWorkEvents,
	teamWorkItems,
	users,
} = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { narratorService } = await import("../../services/narrator-service");
const { pendingPermissions } = await import("../../services/narrator-session-state");
const { approvalPreview } = await import("../../services/teams/team-board");
const { TEAM_APPROVALS_LIMIT } = await import("@shared/project-teams");

const OWNER = "board-owner";
const MEMBER = "board-member";
const READER = "board-reader";
const OUTSIDER = "board-outsider";

const repo = join(testHome, "repo");
let projectId: string;
let teamId: string;
let workerId: string;
let helperId: string;

afterAll(() => {
	for (const [id, pending] of pendingPermissions)
		if ([teamId, workerId, helperId].includes(pending.narratorId)) pendingPermissions.delete(id);
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
	app.route("/narrators", narratorRoutes);
	return app;
}

async function call(
	userId: string,
	path: string,
	init: { method?: string; body?: unknown } = {},
	// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
): Promise<{ status: number; body: any; cache: string | null }> {
	const { method = "GET", body } = init;
	const response = await appAs(userId).request(`http://localhost${path}`, {
		method,
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	return {
		status: response.status,
		body: await response.json(),
		cache: response.headers.get("cache-control"),
	};
}

const teamPath = (suffix: string) => `/projects/${projectId}/teams/${teamId}/${suffix}`;

// After the real "team.created" event, so seeded rows sort after it.
let clock = Date.now() + 60_000;
function tick() {
	clock += 1000;
	return new Date(clock).toISOString();
}

async function item(title: string, state: string, extra: Record<string, unknown> = {}) {
	const id = generateId();
	const at = tick();
	await db.insert(teamWorkItems).values({
		id,
		teamId,
		projectId,
		title,
		state: state as "queued",
		createdAt: at,
		updatedAt: at,
		...extra,
	});
	return id;
}

async function pendingCall(narratorId: string, input: Record<string, unknown>, toolName = "Bash") {
	const id = generateId();
	const messageId = generateId();
	const at = tick();
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
	mkdirSync(repo, { recursive: true });
	const now = new Date().toISOString();
	for (const id of [OWNER, MEMBER, READER, OUTSIDER])
		await db
			.insert(users)
			.values({ id, username: `${id}-name`, passwordHash: "x", role: "user", createdAt: now });
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "board project",
		gitPath: repo,
		defaultBranch: "main",
		ownerUserId: OWNER,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	for (const [principalId, capability] of [
		[MEMBER, "write"],
		[READER, "read"],
	] as const)
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId,
			capability,
			createdAt: now,
		});
	const created = await call(OWNER, `/projects/${projectId}/teams`, {
		method: "POST",
		body: { name: "Board team" },
	});
	expect(created.status).toBe(201);
	teamId = created.body.id;
	const worker = await narratorService.create({ title: "worker one", cwd: repo });
	workerId = worker.id;
	await db
		.update(narrators)
		.set({ type: "subagent", aclRootNarratorId: teamId, parentNarratorId: teamId })
		.where(eq(narrators.id, workerId));
	const helper = await narratorService.create({ title: "helper", cwd: repo });
	helperId = helper.id;
	await db
		.update(narrators)
		.set({ type: "subagent", aclRootNarratorId: teamId, parentNarratorId: workerId })
		.where(eq(narrators.id, helperId));
});

describe("access", () => {
	test("members and onlookers read the page; strangers get 404", async () => {
		for (const suffix of ["summary", "board?column=queued", "events"]) {
			for (const user of [OWNER, MEMBER, READER]) {
				const response = await call(user, teamPath(suffix));
				expect(response.status).toBe(200);
				expect(response.cache).toBe("no-store");
			}
			expect((await call(OUTSIDER, teamPath(suffix))).status).toBe(404);
		}
		// Another project's id in the path does not reach the team either.
		const other = await call(OWNER, `/projects/not-a-project/teams/${teamId}/summary`);
		expect(other.status).toBe(404);
	});

	test("pending approvals: members only (onlooker 403, stranger 404)", async () => {
		expect((await call(MEMBER, teamPath("approvals"))).status).toBe(200);
		expect((await call(READER, teamPath("approvals"))).status).toBe(403);
		expect((await call(OUTSIDER, teamPath("approvals"))).status).toBe(404);
		expect((await call(MEMBER, teamPath("summary"))).body.access).toBe("write");
		const reader = await call(READER, teamPath("summary"));
		expect(reader.body.access).toBe("read");
		expect(reader.body.pendingApprovalCount).toBeNull();
	});

	test("bad queries are refused", async () => {
		expect((await call(OWNER, teamPath("board"))).status).toBe(400);
		expect((await call(OWNER, teamPath("board?column=merged"))).status).toBe(400);
		expect((await call(OWNER, teamPath("board?column=queued&limit=51"))).status).toBe(400);
		expect((await call(OWNER, teamPath("board?column=queued&cursor=%7B"))).status).toBe(400);
		expect((await call(OWNER, teamPath("events?limit=0"))).status).toBe(400);
	});
});

describe("board", () => {
	test("five columns from the six states, with worker, verdict and marks", async () => {
		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, workerId));
		const queued = await item("Queued A", "queued");
		const doing = await item("Doing", "in_progress", {
			branchName: "team/doing-1a2b3c4d",
			workerNarratorId: workerId,
			headSha: "0123456789abcdef0123456789abcdef01234567",
			changedPathsJson: Array.from({ length: 200 }, (_, index) => `src/file-${index}.ts`),
			exclusiveKey: "migrations",
		});
		const reviewing = await item("Reviewing", "in_review", {
			reviewRounds: 1,
			lastReview: "clear",
		});
		const ready = await item("Ready", "ready", { reviewRounds: 2, lastReview: "clear" });
		const merged = await item("Merged", "merged");
		const cancelled = await item("Cancelled", "cancelled");

		const column = async (name: string) =>
			(await call(READER, teamPath(`board?column=${name}`))).body;
		expect((await column("queued")).items.map((card: { id: string }) => card.id)).toEqual([queued]);
		const progress = await column("in_progress");
		expect(progress.items).toHaveLength(1);
		expect(progress.items[0]).toEqual({
			id: doing,
			title: "Doing",
			kind: "change",
			state: "in_progress",
			branch: "team/doing-1a2b3c4d",
			baseRef: null,
			headSha: "0123456789ab",
			worker: { id: workerId, title: "worker one", status: "working" },
			reviewRounds: 0,
			lastReview: null,
			hasWorktree: false,
			exclusiveKey: "migrations",
			createdAt: expect.any(String),
			updatedAt: expect.any(String),
		});
		expect(JSON.stringify(progress)).not.toContain("src/file-");
		expect((await column("review")).items.map((card: { id: string }) => card.id).sort()).toEqual(
			[reviewing, ready].sort(),
		);
		expect((await column("done")).items.map((card: { id: string }) => card.id)).toEqual([merged]);
		expect((await column("cancelled")).items.map((card: { id: string }) => card.id)).toEqual([
			cancelled,
		]);

		const summary = (await call(MEMBER, teamPath("summary"))).body;
		expect(summary.columnCounts).toEqual({
			queued: 1,
			in_progress: 1,
			review: 2,
			done: 1,
			cancelled: 1,
		});
		expect(summary.runningAgents).toEqual([
			{ id: workerId, title: "worker one", status: "working" },
		]);
		expect(summary.runningCount).toBe(1);
		await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, workerId));
	});

	test("columns page by cursor: open oldest first, finished newest change first", async () => {
		const queued = [await item("Q1", "queued"), await item("Q2", "queued")];
		const done = [await item("M1", "merged"), await item("M2", "merged")];
		const pages = async (name: string) => {
			const ids: string[] = [];
			let cursor: string | null = null;
			let rounds = 0;
			do {
				const query: string = `board?column=${name}&limit=1${cursor ? `&cursor=${cursor}` : ""}`;
				const page = (await call(OWNER, teamPath(query))).body;
				expect(page.items.length).toBeLessThanOrEqual(1);
				ids.push(...page.items.map((card: { id: string }) => card.id));
				cursor = page.nextCursor;
				rounds++;
			} while (cursor && rounds < 10);
			return ids;
		};
		const queuedIds = await pages("queued");
		expect(queuedIds.slice(-2)).toEqual(queued);
		const doneIds = await pages("done");
		expect(doneIds.slice(0, 2)).toEqual([...done].reverse());
	});
});

describe("activity", () => {
	test("newest first, actor names, large details left out, cursor pages", async () => {
		const at = () => tick();
		const itemId = await item("Logged", "in_progress");
		await db.insert(teamWorkEvents).values([
			{
				id: generateId(),
				teamId,
				workItemId: itemId,
				kind: "work.review",
				actorKind: "agent",
				actorId: workerId,
				detailJson: { verdict: "blocker", issues: 2 },
				createdAt: at(),
			},
			{
				id: generateId(),
				teamId,
				workItemId: null,
				kind: "team.decision",
				actorKind: "person",
				actorId: MEMBER,
				detailJson: { summary: "Ship the board first" },
				createdAt: at(),
			},
			{
				id: generateId(),
				teamId,
				workItemId: null,
				kind: "team.brief",
				actorKind: "person",
				actorId: OWNER,
				detailJson: { text: "y".repeat(3000) },
				createdAt: at(),
			},
		]);
		const first = (await call(READER, teamPath("events?limit=2"))).body;
		expect(first.events.map((event: { kind: string }) => event.kind)).toEqual([
			"team.brief",
			"team.decision",
		]);
		expect(first.events[0]).toMatchObject({
			actorKind: "person",
			actorName: `${OWNER}-name`,
			detail: null,
			detailOmitted: true,
		});
		expect(first.events[1]).toMatchObject({
			actorName: `${MEMBER}-name`,
			detail: { summary: "Ship the board first" },
			detailOmitted: false,
		});
		expect(first.nextCursor).toBeString();
		const second = (await call(READER, teamPath(`events?limit=2&cursor=${first.nextCursor}`))).body;
		expect(second.events[0]).toMatchObject({
			kind: "work.review",
			workItemId: itemId,
			workItemTitle: "Logged",
			actorKind: "agent",
			actorName: "worker one",
			detail: { verdict: "blocker", issues: 2 },
		});
		const summary = (await call(READER, teamPath("summary"))).body;
		expect(summary.lastEventId).toBe(first.events[0].id);
	});
});

describe("approvals", () => {
	test("the whole tree, oldest first, with a bounded preview and depth", async () => {
		const lead = await pendingCall(teamId, { command: "bun test --isolate x" });
		const work = await pendingCall(workerId, {
			file_path: "/repo/a.ts",
			content: "z".repeat(9000),
		});
		const help = await pendingCall(helperId, { url: "https://example.com" }, "WebFetch");
		const outsider = await narratorService.create({ title: "elsewhere", cwd: repo });
		await pendingCall(outsider.id, { command: "rm -rf /" });
		const response = (await call(MEMBER, teamPath("approvals"))).body;
		expect(response.more).toBe(false);
		expect(response.approvals).toEqual([
			expect.objectContaining({
				id: lead,
				depth: 0,
				toolName: "Bash",
				preview: "bun test --isolate x",
				agent: expect.objectContaining({ id: teamId }),
			}),
			expect.objectContaining({ id: work, depth: 1, preview: "/repo/a.ts" }),
			expect.objectContaining({ id: help, depth: 2, toolName: "WebFetch" }),
		]);
		expect(JSON.stringify(response)).not.toContain("zzzz");
		expect((await call(MEMBER, teamPath("summary"))).body.pendingApprovalCount).toBe(3);
	});

	test("at most 50, with `more`", async () => {
		for (let index = 0; index < TEAM_APPROVALS_LIMIT; index++)
			await pendingCall(helperId, { command: `echo ${index}` });
		const response = (await call(OWNER, teamPath("approvals"))).body;
		expect(response.approvals).toHaveLength(TEAM_APPROVALS_LIMIT);
		expect(response.more).toBe(true);
		expect((await call(OWNER, teamPath("summary"))).body.pendingApprovalCount).toBe(
			TEAM_APPROVALS_LIMIT + 1,
		);
		await db
			.update(narratorToolCalls)
			.set({ status: "fail" })
			.where(eq(narratorToolCalls.narratorId, helperId));
	});

	test("a member approves through the permission route; an onlooker cannot", async () => {
		await db
			.update(narratorToolCalls)
			.set({ status: "fail" })
			.where(eq(narratorToolCalls.status, "pending"));
		const input = { command: "git status" };
		const requestId = await pendingCall(workerId, input);
		const decisions: string[] = [];
		pendingPermissions.set(requestId, {
			narratorId: workerId,
			broadcastTargetId: teamId,
			toolName: "Bash",
			toolUseId: `use-${requestId}`,
			input,
			cwd: repo,
			locale: "en",
			signal: new AbortController().signal,
			resolve: (result) => decisions.push(result.behavior),
			cleanup: () => {
				pendingPermissions.delete(requestId);
			},
		});
		const listed = (await call(MEMBER, teamPath("approvals"))).body.approvals;
		expect(listed.map((approval: { id: string }) => approval.id)).toEqual([requestId]);
		const denied = await call(READER, `/narrators/permissions/${requestId}/approve`, {
			method: "POST",
			body: {},
		});
		expect([403, 404]).toContain(denied.status);
		expect(decisions).toEqual([]);
		const approved = await call(MEMBER, `/narrators/permissions/${requestId}/approve`, {
			method: "POST",
			body: {},
		});
		expect(approved.status).toBe(200);
		expect(decisions).toEqual(["allow"]);
		expect((await call(MEMBER, teamPath("approvals"))).body.approvals).toEqual([]);
	});
});

describe("approval preview", () => {
	test("picks the telling field, clips it, and reads a cut-off prefix", () => {
		expect(approvalPreview(null)).toBe("");
		expect(approvalPreview(JSON.stringify({ command: "ls -la" }))).toBe("ls -la");
		expect(approvalPreview(JSON.stringify({ other: 1 }))).toBe('{"other":1}');
		const long = approvalPreview(JSON.stringify({ command: "a".repeat(1000) }));
		expect(long.length).toBe(300);
		expect(long.endsWith("…")).toBe(true);
		const cut = JSON.stringify({ file_path: '/x/"q".ts', content: "b".repeat(5000) }).slice(0, 100);
		expect(approvalPreview(cut)).toBe('/x/"q".ts');
	});
});
