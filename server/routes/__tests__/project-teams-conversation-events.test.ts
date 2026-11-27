/**
 * Team mode of the coordinator conversation reads its dividers through the ordinary events read
 * (`/projects/:projectId/teams/:teamId/events`) with `kinds` and `since`:
 *
 *  - same access as the activity: members and onlookers read, strangers get 404;
 *  - only the fixed divider kinds are accepted (anything else is 400), `since` is a lower bound
 *    on the time, and pages still run newest first by a keyset cursor;
 *  - each detail is cut to the few keys a divider reads (never a return reason or findings), and a
 *    long review keeps its verdict through its bounded head;
 *  - without the new parameters the read is unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";
import { initTeamRepo } from "../../services/teams/__tests__/team-repo.fixture";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-team-convo-events-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectTeamRoutes } = await import("../project-teams");
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { eq } = await import("drizzle-orm");
const { aclGrants, narrators, projects, teamWorkEvents, teamWorkItems, users } = await import(
	"../../db/schema"
);
const { generateId } = await import("../../lib/id");
const { narratorService } = await import("../../services/narrator-service");
const { pendingPermissions } = await import("../../services/narrator-session-state");

const OWNER = "convo-owner";
const MEMBER = "convo-member";
const READER = "convo-reader";
const OUTSIDER = "convo-outsider";

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

beforeAll(async () => {
	initTeamRepo(repo);
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

function event(
	kind: string,
	detailJson: Record<string, unknown> | null,
	createdAt: string,
	workItemId: string | null,
) {
	return {
		id: generateId(),
		teamId,
		workItemId,
		kind,
		actorKind: "agent" as const,
		actorId: teamId,
		detailJson,
		createdAt,
	};
}

let itemId: string;
const times: string[] = [];

describe("conversation events", () => {
	beforeAll(async () => {
		itemId = await item("Fix the CSV export", "ready");
		for (let i = 0; i < 6; i++) times.push(tick());
		await db
			.insert(teamWorkEvents)
			.values([
				event("work.created", { branch: "team/csv" }, times[0] as string, itemId),
				event(
					"work.review",
					{ round: 1, verdict: "blocker", findings: 2, summary: "s".repeat(500) },
					times[1] as string,
					itemId,
				),
				event(
					"work.returned",
					{ reason: "Use the team timezone", round: 2 },
					times[2] as string,
					itemId,
				),
				event(
					"work.review",
					{ round: 3, verdict: "clear", findings: 0, summary: "x".repeat(4000) },
					times[3] as string,
					itemId,
				),
				event(
					"work.pr_opened",
					{ pr: 42, url: "https://github.com/o/r/pull/42" },
					times[4] as string,
					itemId,
				),
				event(
					"work.merged",
					{ detectedBy: "pull_request", pr: 42, head: "abc" },
					times[5] as string,
					itemId,
				),
			]);
	});

	const kinds = "work.review,work.returned,work.merged,work.pr_opened,work.merge_failed";

	test("members and onlookers read the dividers; strangers get 404", async () => {
		for (const user of [OWNER, MEMBER, READER])
			expect((await call(user, teamPath(`events?kinds=${kinds}`))).status).toBe(200);
		expect((await call(OUTSIDER, teamPath(`events?kinds=${kinds}`))).status).toBe(404);
		expect(
			(await call(OUTSIDER, `/projects/${projectId}/teams/not-a-team/events?kinds=${kinds}`))
				.status,
		).toBe(404);
	});

	test("only divider kinds, newest first, details cut to what a divider reads", async () => {
		const body = (await call(READER, teamPath(`events?kinds=${kinds}`))).body;
		expect(body.events.map((e: { kind: string }) => e.kind)).toEqual([
			"work.merged",
			"work.pr_opened",
			"work.review",
			"work.returned",
			"work.review",
		]);
		const [merged, opened, clear, returned, blocker] = body.events;
		expect(merged.detail).toEqual({ detectedBy: "pull_request", pr: 42 });
		expect(opened.detail).toEqual({ pr: 42 });
		// A long review: its verdict survives through the bounded head, never the findings.
		expect(clear.detail).toMatchObject({ verdict: "clear", round: 3 });
		expect(clear.detail.summary).toBeUndefined();
		expect(returned.detail).toEqual({ round: 2 });
		expect(JSON.stringify(body)).not.toContain("Use the team timezone");
		expect(blocker.detail).toEqual({ verdict: "blocker", round: 1 });
		expect(merged.workItemTitle).toBe("Fix the CSV export");
	});

	test("since is an inclusive lower bound and the cursor still pages", async () => {
		const since = encodeURIComponent(times[3] as string);
		const first = (await call(MEMBER, teamPath(`events?kinds=${kinds}&since=${since}&limit=2`)))
			.body;
		expect(first.events.map((e: { kind: string }) => e.kind)).toEqual([
			"work.merged",
			"work.pr_opened",
		]);
		expect(first.nextCursor).toBeString();
		const second = (
			await call(
				MEMBER,
				teamPath(`events?kinds=${kinds}&since=${since}&limit=2&cursor=${first.nextCursor}`),
			)
		).body;
		expect(second.events.map((e: { kind: string }) => e.kind)).toEqual(["work.review"]);
		expect(second.nextCursor).toBeNull();
	});

	test("other kinds and bad times are refused", async () => {
		expect((await call(OWNER, teamPath("events?kinds=team.brief"))).status).toBe(400);
		expect((await call(OWNER, teamPath("events?kinds=work.review,work.created"))).status).toBe(400);
		expect((await call(OWNER, teamPath("events?kinds="))).status).toBe(400);
		expect((await call(OWNER, teamPath(`events?kinds=${kinds}&since=yesterday`))).status).toBe(400);
	});

	test("without the new parameters the read is unchanged", async () => {
		const body = (await call(READER, teamPath("events?limit=50"))).body;
		const kindsSeen = body.events.map((e: { kind: string }) => e.kind);
		expect(kindsSeen).toContain("work.created");
		expect(kindsSeen).toContain("team.created");
		const returned = body.events.find((e: { kind: string }) => e.kind === "work.returned");
		expect(returned.detail.reason).toBe("Use the team timezone");
		const longReview = body.events.find(
			(e: { kind: string; detail: { round?: number } | null }) =>
				e.kind === "work.review" && e.detail === null,
		);
		expect(longReview.detailOmitted).toBe(true);
	});
});
