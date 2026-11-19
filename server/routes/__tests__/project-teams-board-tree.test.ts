/**
 * The team page's reads on a big tree (P4 review round 1, B1 and S2/S3): a team whose tree holds
 * hundreds of finished subagents still shows its newest running worker, its pending approvals
 * and its running list for "pause all"; approvals hidden by a running reflection do not crowd
 * out the visible ones; questions, plans and rule requests are marked to be answered in their
 * session, with the questions as text.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-team-board-tree-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectTeamRoutes } = await import("../project-teams");
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { eq } = await import("drizzle-orm");
const { aclGrants, narratorMessages, narrators, narratorToolCalls, projects, users } = await import(
	"../../db/schema"
);
const { generateId } = await import("../../lib/id");
const { narratorService } = await import("../../services/narrator-service");
const { pendingPermissions } = await import("../../services/narrator-session-state");
const { questionPreview } = await import("../../services/teams/team-board");
const { TEAM_APPROVALS_LIMIT, TEAM_PAUSE_LIMIT } = await import("@shared/project-teams");
const { sqlite } = await import("../../db");

const OWNER = "board-owner";
const MEMBER = "board-member";
const READER = "board-reader";
const OUTSIDER = "board-outsider";

const repo = join(testHome, "repo");
let projectId: string;
let teamId: string;
let workerId: string;
let helperId: string;
const OLD_SUBAGENTS = 520;

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

/** Copies of one narrator row as finished subagents of the team (fast, in one transaction). */
function seedOldSubagents(templateId: string, count: number, status = "idle") {
	const columns = (sqlite.query("pragma table_info(narrators)").all() as { name: string }[])
		.map((column) => column.name)
		.filter((name) => name !== "id");
	const pick = (name: string) =>
		name === "type"
			? "'subagent'"
			: name === "acl_root_narrator_id" || name === "parent_narrator_id"
				? "?"
				: name === "status"
					? "?"
					: name === "handle"
						? "null"
						: name;
	const params = (id: string) => {
		const values: string[] = [id];
		for (const name of columns) {
			if (name === "acl_root_narrator_id" || name === "parent_narrator_id") values.push(teamId);
			else if (name === "status") values.push(status);
		}
		values.push(templateId);
		return values;
	};
	const statement = `insert into narrators (id, ${columns.join(",")}) select ?, ${columns.map(pick).join(",")} from narrators where id = ?`;
	sqlite.run("BEGIN");
	for (let index = 0; index < count; index++) sqlite.run(statement, params(generateId()));
	sqlite.run("COMMIT");
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
		name: "big tree project",
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
		body: { name: "Old team" },
	});
	expect(created.status).toBe(201);
	teamId = created.body.id;
	const template = await narratorService.create({ title: "old worker", cwd: repo });
	seedOldSubagents(template.id, OLD_SUBAGENTS);
	// The newest worker, created after all of them, waits for an approval.
	const worker = await narratorService.create({ title: "new worker", cwd: repo });
	workerId = worker.id;
	await db
		.update(narrators)
		.set({
			type: "subagent",
			aclRootNarratorId: teamId,
			parentNarratorId: teamId,
			status: "waiting",
			createdAt: tick(),
		})
		.where(eq(narrators.id, workerId));
	const helper = await narratorService.create({ title: "helper", cwd: repo });
	helperId = helper.id;
	await db
		.update(narrators)
		.set({ type: "subagent", aclRootNarratorId: teamId, parentNarratorId: workerId })
		.where(eq(narrators.id, helperId));
});

describe("a tree of hundreds of finished subagents", () => {
	test("the newest waiting worker is running, its approval is listed and counted", async () => {
		const tree = sqlite
			.query(
				"select count(*) as n from narrators where acl_root_narrator_id = ? and status != 'archived'",
			)
			.get(teamId) as { n: number };
		expect(tree.n).toBeGreaterThan(500);
		const requestId = await pendingCall(workerId, { command: "rm -rf build" });
		const summary = (await call(MEMBER, teamPath("summary"))).body;
		expect(summary.runningCount).toBe(1);
		expect(summary.runningAgents).toEqual([
			{ id: workerId, title: "new worker", status: "waiting" },
		]);
		expect(summary.pendingApprovalCount).toBe(1);
		const approvals = (await call(MEMBER, teamPath("approvals"))).body;
		expect(approvals.approvals.map((row: { id: string }) => row.id)).toEqual([requestId]);
		expect(approvals.approvals[0]).toMatchObject({
			depth: 1,
			kind: "tool",
			agent: { id: workerId, title: "new worker", status: "waiting" },
		});
		await db
			.update(narratorToolCalls)
			.set({ status: "fail" })
			.where(eq(narratorToolCalls.id, requestId));
	});

	test("running list: coordinator first, then newest first; more than the summary shows", async () => {
		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, teamId));
		// 30 old ones wake up: more than the summary's 20.
		const old = sqlite
			.query(
				"select id from narrators where acl_root_narrator_id = ? and status = 'idle' order by id limit 30",
			)
			.all(teamId) as { id: string }[];
		for (const row of old)
			await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, row.id));
		const summary = (await call(MEMBER, teamPath("summary"))).body;
		expect(summary.runningAgents).toHaveLength(20);
		expect(summary.runningCount).toBe(21);
		expect(summary.runningAgents[0].id).toBe(teamId);
		expect(summary.runningAgents[1].id).toBe(workerId);
		const running = await call(MEMBER, teamPath("running"));
		expect(running.status).toBe(200);
		expect(running.body.more).toBe(false);
		expect(running.body.agents).toHaveLength(32);
		expect(running.body.agents[0].id).toBe(teamId);
		expect(new Set(running.body.agents.map((agent: { id: string }) => agent.id)).size).toBe(32);
		expect(TEAM_PAUSE_LIMIT).toBe(500);
		expect((await call(READER, teamPath("running"))).status).toBe(403);
		expect((await call(OUTSIDER, teamPath("running"))).status).toBe(404);
		for (const row of old)
			await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, row.id));
		await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, teamId));
	});

	test("calls hidden by a running reflection do not crowd out the visible ones", async () => {
		const hidden: string[] = [];
		for (let index = 0; index < 120; index++) {
			const id = await pendingCall(helperId, { command: `echo ${index}` });
			hidden.push(id);
		}
		await db
			.update(narratorToolCalls)
			.set({ permissionSuggestions: [{ type: "danger_reflection", status: "running" }] })
			.where(eq(narratorToolCalls.narratorId, helperId));
		const visible = await pendingCall(workerId, { command: "bun test" });
		const approvals = (await call(MEMBER, teamPath("approvals"))).body;
		expect(approvals.approvals.map((row: { id: string }) => row.id)).toEqual([visible]);
		expect(approvals.approvals[0].depth).toBe(1);
		expect(approvals.more).toBe(false);
		expect(approvals.unscanned).toBe(false);
		expect((await call(MEMBER, teamPath("summary"))).body.pendingApprovalCount).toBe(1);
		await db
			.update(narratorToolCalls)
			.set({ status: "fail" })
			.where(eq(narratorToolCalls.status, "pending"));
		expect(hidden).toHaveLength(120);
		expect(TEAM_APPROVALS_LIMIT).toBe(50);
	});
});

test("past 500 hidden calls the scan stops: the badge counts what it saw, never 50+", async () => {
	for (let index = 0; index < 510; index++)
		await pendingCall(helperId, { command: `echo ${index}` });
	await db
		.update(narratorToolCalls)
		.set({ permissionSuggestions: [{ type: "plan_reflection", status: "running" }] })
		.where(eq(narratorToolCalls.narratorId, helperId));
	await pendingCall(workerId, { command: "bun test" });
	const approvals = (await call(MEMBER, teamPath("approvals"))).body;
	expect(approvals.approvals).toEqual([]);
	expect(approvals.more).toBe(false);
	expect(approvals.unscanned).toBe(true);
	expect((await call(MEMBER, teamPath("summary"))).body.pendingApprovalCount).toBe(0);
	await db
		.update(narratorToolCalls)
		.set({ status: "fail" })
		.where(eq(narratorToolCalls.status, "pending"));
});

describe("calls answered in their session", () => {
	test("questions, plans and rule requests are marked; questions read as text", async () => {
		const question = await pendingCall(
			workerId,
			{
				questions: [
					{ question: "Which branch first?", header: "Order", options: [{ label: "A" }] },
					{ question: "Ship today?", header: "When", options: [{ label: "Yes" }] },
				],
			},
			"AskUserQuestion",
		);
		const plan = await pendingCall(workerId, { plan: "1. Do it" }, "ExitPlanMode");
		const rule = await pendingCall(workerId, { reason: "allow bun" }, "RequestPermissionRule");
		const tool = await pendingCall(workerId, { command: "ls" });
		const approvals = (await call(MEMBER, teamPath("approvals"))).body.approvals as Array<{
			id: string;
			kind: string;
			preview: string;
			questions: string[];
		}>;
		const byId = new Map(approvals.map((row) => [row.id, row]));
		expect(byId.get(question)).toMatchObject({
			kind: "question",
			preview: "",
			questions: ["Which branch first?", "Ship today?"],
		});
		expect(byId.get(plan)?.kind).toBe("plan");
		expect(byId.get(rule)?.kind).toBe("rule");
		expect(byId.get(tool)).toMatchObject({ kind: "tool", preview: "ls", questions: [] });
	});

	test("question preview reads a cut-off prefix and clips", () => {
		expect(questionPreview(null)).toEqual([]);
		const cut = JSON.stringify({
			questions: [
				{ question: 'Use "main"?', header: "x" },
				{ question: "b".repeat(500), header: "y" },
				{ question: "c", header: "z" },
				{ question: "d", header: "w" },
			],
			extra: "e".repeat(5000),
		}).slice(0, 700);
		const shown = questionPreview(cut);
		expect(shown[0]).toBe('Use "main"?');
		expect(shown[1]?.length).toBe(200);
		expect(shown.length).toBeLessThanOrEqual(3);
	});
});
