/**
 * The redesigned team page's work item APIs (R) through `/projects/:projectId/teams/:teamId/…`,
 * against real git worktrees:
 *
 *  - `work-stats`: lines added / removed and files per item, for members and onlookers; a
 *    stranger gets 404; more than 50 ids are refused; a merged item keeps the size its
 *    `work.ready` recorded;
 *  - `work/:itemId`: the drawer (base, commits ahead, changed files, review rounds, timeline,
 *    whether the caller may return it); `work/:itemId/diff` reads one changed file, capped, and
 *    nothing the branch did not change;
 *  - `work/:itemId/return`: members only; a reason is required; only in review / ready; the item
 *    goes back to in progress as a blocker round by that person and the coordinator gets the
 *    reason to relay;
 *  - the board names what a running worker did last, and the summary says whether anyone spoke
 *    to the coordinator yet.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";
import { initTeamRepo } from "../../services/teams/__tests__/team-repo.fixture";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-team-work-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectTeamRoutes } = await import("../project-teams");
const { db } = await import("../../db");
const { eq } = await import("drizzle-orm");
const {
	aclGrants,
	narratorMessages,
	narrators,
	narratorToolCalls,
	narratorWorktreeResources,
	projects,
	teamWorkEvents,
	teamWorkItems,
	users,
} = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { narratorService } = await import("../../services/narrator-service");
const work = await import("../../services/teams/work-items");
const { resetWorkStatCacheForTests } = await import("../../services/teams/team-work-view");
const { TEAM_WORK_DIFF_MAX_BYTES } = await import("@shared/project-teams");

const OWNER = "work-owner";
const MEMBER = "work-member";
const READER = "work-reader";
const OUTSIDER = "work-outsider";

const repo = join(testHome, "repo");
let projectId: string;
let teamId: string;
let workerId: string;
const notes: { teamId: string; text: string; userId: string | null }[] = [];

afterAll(() => {
	work.setWorkItemPortsForTests(null);
	work.setReturnDeliveryForTests(null);
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync(
		"git",
		["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8", timeout: 30_000 },
	);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function commitIn(cwd: string, files: Record<string, string>, message: string) {
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(dirname(join(cwd, file)), { recursive: true });
		writeFileSync(join(cwd, file), text);
	}
	git(cwd, "add", "-A");
	git(cwd, "commit", "-q", "--no-verify", "-m", message);
}

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

const teamPath = (suffix: string) => `/projects/${projectId}/teams/${teamId}/${suffix}`;
const agent = { kind: "agent" as const, id: "" };

async function newItem(title: string) {
	return work.createWorkItem({
		coordinatorId: teamId,
		title,
		actor: { ...agent, id: teamId },
		principal: { userId: OWNER, isAdmin: false },
		signal: new AbortController().signal,
	});
}

async function readyItem(title: string, files: Record<string, string>) {
	const item = await newItem(title);
	const path = work.worktreePathOf(item) ?? "";
	commitIn(path, files, title);
	const actor = { kind: "agent" as const, id: teamId };
	await work.recordReview({
		coordinatorId: teamId,
		itemId: item.id,
		verdict: "clear",
		findings: 0,
		reviewer: null,
		actor,
	});
	await work.markReady({ coordinatorId: teamId, itemId: item.id, actor });
	return { item: work.requireWorkItem(teamId, item.id), path };
}

beforeAll(async () => {
	initTeamRepo(repo);
	writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-q", "--no-verify", "-m", "ignore worktrees");
	const now = new Date().toISOString();
	for (const id of [OWNER, MEMBER, READER, OUTSIDER])
		await db
			.insert(users)
			.values({ id, username: `${id}-name`, passwordHash: "x", role: "user", createdAt: now });
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "work project",
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
		body: { name: "Work team" },
	});
	expect(created.status).toBe(201);
	teamId = created.body.id;
	const worker = await narratorService.create({ title: "worker", cwd: repo });
	workerId = worker.id;
	await db
		.update(narrators)
		.set({ type: "subagent", aclRootNarratorId: teamId, parentNarratorId: teamId })
		.where(eq(narrators.id, workerId));
	work.setWorkItemPortsForTests({
		async createWorktree({ requestId, branchName, baseRef }) {
			const path = join(repo, ".worktrees", requestId);
			git(repo, "worktree", "add", "-q", "-b", branchName, "--", path, baseRef);
			db.insert(narratorWorktreeResources)
				.values({
					id: generateId(),
					ownerNarratorId: teamId,
					deviceId: "local",
					repositoryKey: "repository",
					worktreePath: path,
					state: "ready",
					createRequestId: requestId,
				})
				.run();
			return { path };
		},
		planRemoval: async () => {
			throw new Error("not used");
		},
		removeWorktree: async () => {
			throw new Error("not used");
		},
		principalOf: async (userId) => ({ userId, isAdmin: false }),
	});
	work.setReturnDeliveryForTests(async (note) => {
		notes.push(note);
		return true;
	});
});

describe("work-stats", () => {
	test("sizes per item for members and onlookers; strangers 404; at most 50 ids", async () => {
		resetWorkStatCacheForTests();
		const live = await newItem("Live item");
		commitIn(
			work.worktreePathOf(live) ?? "",
			{ "src/a.ts": "one\ntwo\nthree\n", "bin/blob.bin": "\u0000\u0001binary" },
			"live work",
		);
		const queued = await newItem("No commits yet");
		const ids = [live.id, queued.id, "not-an-item"].join(",");
		for (const user of [OWNER, MEMBER, READER]) {
			const response = await call(user, teamPath(`work-stats?ids=${ids}`));
			expect(response.status).toBe(200);
			expect(response.body.stats[live.id]).toEqual({
				added: 3,
				removed: 0,
				files: 2,
				binaryFiles: 1,
				truncated: false,
			});
			expect(response.body.stats[queued.id]).toEqual({
				added: 0,
				removed: 0,
				files: 0,
				binaryFiles: 0,
				truncated: false,
			});
			// Another team's or a missing item is left out.
			expect("not-an-item" in response.body.stats).toBe(false);
		}
		expect((await call(OUTSIDER, teamPath(`work-stats?ids=${live.id}`))).status).toBe(404);
		const tooMany = Array.from({ length: 51 }, (_, index) => `id${index}`).join(",");
		expect((await call(OWNER, teamPath(`work-stats?ids=${tooMany}`))).status).toBe(400);
		expect((await call(OWNER, teamPath("work-stats?ids="))).body).toEqual({ stats: {} });
	});

	test("a merged item keeps the size and files its ready recorded", async () => {
		resetWorkStatCacheForTests();
		const { item } = await readyItem("Lands", { "docs/landed.md": "a\nb\n" });
		const ready = db
			.select({ detail: teamWorkEvents.detailJson })
			.from(teamWorkEvents)
			.where(eq(teamWorkEvents.workItemId, item.id))
			.all()
			.map((row) => row.detail)
			.find((detail) => detail && "diffStat" in detail);
		expect(ready?.diffStat).toEqual({
			added: 2,
			removed: 0,
			files: 1,
			binaryFiles: 0,
			truncated: false,
		});
		git(repo, "merge", "-q", "--no-ff", "-m", "land", item.branchName ?? "");
		expect(
			work.markMergedByAncestry({
				itemId: item.id,
				head: item.headSha ?? "",
				base: "main",
				expectedHeadSha: item.headSha,
				expectedUpdatedAt: item.updatedAt,
			}),
		).toBe(true);
		const stats = await call(READER, teamPath(`work-stats?ids=${item.id}`));
		expect(stats.body.stats[item.id]).toMatchObject({ added: 2, removed: 0, files: 1 });
		const detail = await call(READER, teamPath(`work/${item.id}`));
		expect(detail.body.item.state).toBe("merged");
		expect(detail.body.files).toEqual([{ path: "docs/landed.md", added: 2, removed: 0 }]);
		expect(detail.body.canReturn).toBe(false);
	});
});

describe("the drawer", () => {
	test("base, commits ahead, files, reviews, timeline; diff of a changed file only", async () => {
		resetWorkStatCacheForTests();
		const { item, path } = await readyItem("Drawer item", {
			"src/export.ts": "export const tz = 'UTC';\n",
		});
		commitIn(path, { "src/export.ts": "export const tz = user.timezone;\n" }, "second");
		const detail = await call(READER, teamPath(`work/${item.id}`));
		expect(detail.status).toBe(200);
		expect(detail.body.base).toBe("main");
		expect(detail.body.aheadBy).toBe(2);
		expect(detail.body.item).toMatchObject({ id: item.id, state: "ready", title: "Drawer item" });
		expect(detail.body.stat).toMatchObject({ added: 1, removed: 0, files: 1 });
		expect(detail.body.files).toEqual([{ path: "src/export.ts", added: 1, removed: 0 }]);
		expect(detail.body.diffAvailable).toBe(true);
		expect(detail.body.reviews).toHaveLength(1);
		expect(detail.body.reviews[0]).toMatchObject({ round: 1, verdict: "clear", by: "agent" });
		expect(detail.body.events.map((event: { kind: string }) => event.kind)).toEqual([
			"work.created",
			"work.review",
			"work.ready",
		]);
		// Readers may look; only members may return.
		expect(detail.body.canReturn).toBe(false);
		expect((await call(MEMBER, teamPath(`work/${item.id}`))).body.canReturn).toBe(true);
		expect((await call(OUTSIDER, teamPath(`work/${item.id}`))).status).toBe(404);
		expect((await call(OWNER, teamPath("work/not-an-item"))).status).toBe(404);

		const diff = await call(READER, teamPath(`work/${item.id}/diff?path=src/export.ts`));
		expect(diff.status).toBe(200);
		expect(diff.body.truncated).toBe(false);
		expect(diff.body.text).toContain("+export const tz = user.timezone;");
		// Nothing the branch did not change, and nothing outside the repository.
		expect((await call(READER, teamPath(`work/${item.id}/diff?path=README.md`))).status).toBe(
			404,
		);
		expect(
			(await call(READER, teamPath(`work/${item.id}/diff?path=../../etc/passwd`))).status,
		).toBe(404);
		expect((await call(READER, teamPath(`work/${item.id}/diff`))).status).toBe(400);
	});

	test("a large file's diff is cut at the cap", async () => {
		resetWorkStatCacheForTests();
		const item = await newItem("Big file");
		const line = `${"x".repeat(99)}\n`;
		commitIn(
			work.worktreePathOf(item) ?? "",
			{ "big.txt": line.repeat(Math.ceil((TEAM_WORK_DIFF_MAX_BYTES * 2) / line.length)) },
			"big",
		);
		const diff = await call(OWNER, teamPath(`work/${item.id}/diff?path=big.txt`));
		expect(diff.status).toBe(200);
		expect(diff.body.truncated).toBe(true);
		expect(Buffer.byteLength(diff.body.text)).toBeLessThanOrEqual(TEAM_WORK_DIFF_MAX_BYTES);
	});
});

describe("return with a reason", () => {
	test("members only; a reason; review or ready only; blocker round and a note", async () => {
		resetWorkStatCacheForTests();
		const { item } = await readyItem("Return me", { "src/r.ts": "r\n" });
		const path = teamPath(`work/${item.id}/return`);
		expect((await call(READER, path, { method: "POST", body: { reason: "no" } })).status).toBe(
			403,
		);
		expect((await call(OUTSIDER, path, { method: "POST", body: { reason: "no" } })).status).toBe(
			404,
		);
		expect((await call(MEMBER, path, { method: "POST", body: { reason: "   " } })).status).toBe(
			400,
		);
		expect(
			(await call(MEMBER, path, { method: "POST", body: { reason: "x", extra: 1 } })).status,
		).toBe(400);
		notes.length = 0;
		const returned = await call(MEMBER, path, {
			method: "POST",
			body: { reason: "Read the team's default time zone; move the CHANGELOG line." },
		});
		expect(returned.status).toBe(200);
		expect(returned.body.delivered).toBe(true);
		expect(returned.body.item).toMatchObject({
			id: item.id,
			state: "in_progress",
			reviewRounds: 2,
			lastReview: "blocker",
		});
		const event = db
			.select()
			.from(teamWorkEvents)
			.where(eq(teamWorkEvents.workItemId, item.id))
			.all()
			.find((row) => row.kind === "work.returned");
		expect(event).toMatchObject({ actorKind: "person", actorId: MEMBER });
		expect(event?.detailJson).toMatchObject({
			round: 2,
			verdict: "blocker",
			from: "ready",
			to: "in_progress",
			reason: "Read the team's default time zone; move the CHANGELOG line.",
		});
		expect(notes).toHaveLength(1);
		expect(notes[0]?.teamId).toBe(teamId);
		expect(notes[0]?.userId).toBe(MEMBER);
		expect(notes[0]?.text).toContain("Read the team's default time zone");
		expect(notes[0]?.text).toContain(`${MEMBER}-name`);
		// The drawer lists the return as a round by that person, with the reason.
		const detail = await call(OWNER, teamPath(`work/${item.id}`));
		expect(detail.body.reviews.at(-1)).toMatchObject({
			round: 2,
			verdict: "blocker",
			by: "person",
			actorName: `${MEMBER}-name`,
			reason: "Read the team's default time zone; move the CHANGELOG line.",
		});
		// In progress now: nothing to return; ready needs a clear review again.
		const again = await call(MEMBER, path, { method: "POST", body: { reason: "again" } });
		expect(again.status).toBe(409);
		expect(again.body.code).toBe("TEAM_WORK_ITEM_NOT_RETURNABLE");
		await expect(
			work.markReady({ coordinatorId: teamId, itemId: item.id, actor: { kind: "agent", id: teamId } }),
		).rejects.toMatchObject({ code: "TEAM_WORK_ITEM_NOT_REVIEWED" });
	});

	test("a failed note still returns the item", async () => {
		const { item } = await readyItem("Note fails", { "src/n.ts": "n\n" });
		work.setReturnDeliveryForTests(async () => {
			throw new Error("coordinator unreachable");
		});
		try {
			const returned = await call(OWNER, teamPath(`work/${item.id}/return`), {
				method: "POST",
				body: { reason: "fix it" },
			});
			expect(returned.status).toBe(200);
			expect(returned.body.delivered).toBe(false);
			expect(returned.body.item.state).toBe("in_progress");
		} finally {
			work.setReturnDeliveryForTests(async (note) => {
				notes.push(note);
				return true;
			});
		}
	});
});

describe("board and summary", () => {
	test("a running worker's newest tool call; the coordinator's message count", async () => {
		const item = await newItem("Running");
		work.attachWorker(teamId, item.id, workerId, { kind: "agent", id: teamId });
		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, workerId));
		const messageId = generateId();
		const at = new Date(Date.now() + 120_000).toISOString();
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId: workerId,
			role: "assistant",
			contentJson: [],
			createdAt: at,
		});
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId: workerId,
			messageId,
			toolUseId: `use-${messageId}`,
			toolName: "Bash",
			status: "running",
			inputJson: { command: "pnpm test api/auth", description: "run the tests" },
			createdAt: at,
		});
		const board = await call(READER, teamPath("board?column=in_progress"));
		const card = board.body.items.find((entry: { id: string }) => entry.id === item.id);
		expect(card.activity).toMatchObject({ toolName: "Bash", preview: "pnpm test api/auth" });
		await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, workerId));
		const idle = await call(READER, teamPath("board?column=in_progress"));
		expect(idle.body.items.find((entry: { id: string }) => entry.id === item.id).activity).toBe(
			null,
		);
		const summary = await call(READER, teamPath("summary"));
		expect(summary.body.coordinatorMessageCount).toBe(0);
		expect(summary.body.coordinatorStopReason).toBeNull();
		expect(
			db.select().from(teamWorkItems).where(eq(teamWorkItems.id, item.id)).get()?.state,
		).toBe("in_progress");
	});
});
