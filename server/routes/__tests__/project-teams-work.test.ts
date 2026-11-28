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
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
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
const { capReviewSummaries, resetWorkStatCacheForTests } = await import(
	"../../services/teams/team-work-view"
);
const board = await import("../../services/teams/team-board");
const {
	TEAM_EVENT_DETAIL_PREVIEW_CHARS,
	TEAM_REVIEW_SUMMARIES_TOTAL_CHARS,
	TEAM_WORK_DIFF_MAX_BYTES,
} = await import("@shared/project-teams");

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

/** Only a started item is reviewed: give it a worker of its own, as an Agent call attaches. */
async function startItem(item: { id: string }, title: string) {
	const worker = await narratorService.create({ title: `${title} worker`, cwd: repo });
	await db
		.update(narrators)
		.set({ type: "subagent", aclRootNarratorId: teamId, parentNarratorId: teamId })
		.where(eq(narrators.id, worker.id));
	work.attachWorker(teamId, item.id, worker.id, { kind: "agent", id: teamId });
}

async function readyItem(title: string, files: Record<string, string>) {
	const item = await newItem(title);
	const path = work.worktreePathOf(item) ?? "";
	commitIn(path, files, title);
	const actor = { kind: "agent" as const, id: teamId };
	await startItem(item, title);
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
			"work.started",
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
		expect((await call(READER, teamPath(`work/${item.id}/diff?path=README.md`))).status).toBe(404);
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
		expect((await call(READER, path, { method: "POST", body: { reason: "no" } })).status).toBe(403);
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
			work.markReady({
				coordinatorId: teamId,
				itemId: item.id,
				actor: { kind: "agent", id: teamId },
			}),
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
		expect(db.select().from(teamWorkItems).where(eq(teamWorkItems.id, item.id)).get()?.state).toBe(
			"in_progress",
		);
	});
});

describe("dependencies (D)", () => {
	test("the board carries each card's dependencies; the drawer lists the dependents", async () => {
		const first = await newItem("Dependency first");
		const second = await work.createWorkItem({
			coordinatorId: teamId,
			title: "Dependency second",
			dependsOn: [first.id],
			actor: { ...agent, id: teamId },
			principal: { userId: OWNER, isAdmin: false },
			signal: new AbortController().signal,
		});
		const board = await call(READER, teamPath("board?column=queued"));
		const card = board.body.items.find((entry: { id: string }) => entry.id === second.id);
		expect(card.dependsOn).toEqual([{ id: first.id, title: "Dependency first", state: "queued" }]);
		expect(
			board.body.items.find((entry: { id: string }) => entry.id === first.id).dependsOn,
		).toEqual([]);
		const detail = await call(READER, teamPath(`work/${first.id}`));
		expect(detail.body.dependents).toEqual([
			{ id: second.id, title: "Dependency second", state: "queued" },
		]);
		expect(detail.body.dependentsMore).toBe(false);
		const events = await call(READER, teamPath("events"));
		expect(events.body.events.map((event: { kind: string }) => event.kind)).toContain(
			"work.dependencies_changed",
		);
	});
});

describe("review fixes", () => {
	test("an in-place question carries each option's whole title; more than six: no form", async () => {
		const { questionForm } = await import("../../services/teams/team-board");
		const long = `Use the team's default time zone, ${"x".repeat(120)}`;
		const form = questionForm(
			JSON.stringify({
				questions: [
					{ question: "Which?", header: "Zone", options: [{ label: long }, { label: "UTC" }] },
				],
			}),
		);
		expect(form?.options).toEqual([long, "UTC"]);
		const seven = Array.from({ length: 7 }, (_, index) => ({ label: `o${index}` }));
		expect(
			questionForm(
				JSON.stringify({ questions: [{ question: "Which?", header: "H", options: seven }] }),
			),
		).toBeNull();
	});

	test("a long return reason full of quotes and newlines stays readable everywhere", async () => {
		resetWorkStatCacheForTests();
		const { item } = await readyItem("Quoted reason", { "src/q.ts": "q\n" });
		const reason = `"\n`.repeat(999).trim().padEnd(2000, '"');
		const returned = await call(MEMBER, teamPath(`work/${item.id}/return`), {
			method: "POST",
			body: { reason },
		});
		expect(returned.status).toBe(200);
		const detail = await call(READER, teamPath(`work/${item.id}`));
		expect(detail.body.reviews.at(-1)).toMatchObject({ by: "person", round: 2, reason });
		const returnedEvent = detail.body.events.find(
			(event: { kind: string }) => event.kind === "work.returned",
		);
		expect(returnedEvent).toMatchObject({ detailOmitted: false, detail: { reason } });
		const activity = await call(READER, teamPath("events"));
		const listed = activity.body.events.find(
			(event: { kind: string; workItemId: string }) =>
				event.kind === "work.returned" && event.workItemId === item.id,
		);
		expect(listed).toMatchObject({ detailOmitted: false, detail: { reason } });
	});

	test("a diff path is literal: *.txt is that file only; files past the first 300 still open", async () => {
		resetWorkStatCacheForTests();
		const item = await newItem("Many files");
		const files: Record<string, string> = { "*.txt": "star\n", "a.txt": "plain\n" };
		for (let index = 0; index < 305; index++)
			files[`many/f-${String(index).padStart(3, "0")}.txt`] = `${index}\n`;
		commitIn(work.worktreePathOf(item) ?? "", files, "many");
		const detail = await call(OWNER, teamPath(`work/${item.id}`));
		expect(detail.body.files).toHaveLength(300);
		expect(detail.body.filesMore).toBe(true);
		expect(detail.body.stat).toMatchObject({ files: 307 });
		const star = await call(
			OWNER,
			teamPath(`work/${item.id}/diff?path=${encodeURIComponent("*.txt")}`),
		);
		expect(star.status).toBe(200);
		expect(star.body.text).toContain("+star");
		expect(star.body.text).not.toContain("+plain");
		const late = await call(OWNER, teamPath("work/" + item.id + "/diff?path=many/f-304.txt"));
		expect(late.status).toBe(200);
		expect(late.body.text).toContain("+304");
		expect((await call(OWNER, teamPath(`work/${item.id}/diff?path=many/*.txt`))).status).toBe(404);
	});

	test("the summary carries running workers' latest activity and held worktrees", async () => {
		const item = await newItem("Live activity");
		const live = await narratorService.create({ title: "live worker", cwd: repo });
		await db
			.update(narrators)
			.set({
				type: "subagent",
				aclRootNarratorId: teamId,
				parentNarratorId: teamId,
				status: "working",
			})
			.where(eq(narrators.id, live.id));
		work.attachWorker(teamId, item.id, live.id, { kind: "agent", id: teamId });
		const messageId = generateId();
		const at = new Date(Date.now() + 240_000).toISOString();
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId: live.id,
			role: "assistant",
			contentJson: [],
			createdAt: at,
		});
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId: live.id,
			messageId,
			toolUseId: `use-${messageId}`,
			toolName: "AskUserQuestion",
			status: "pending",
			inputJson: { questions: [{ question: "Ship today?", header: "When", options: [] }] },
			createdAt: at,
		});
		const summary = await call(READER, teamPath("summary"));
		const agent = summary.body.runningAgents.find((entry: { id: string }) => entry.id === live.id);
		expect(agent.activity).toMatchObject({ toolName: "AskUserQuestion", preview: "Ship today?" });
		await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, live.id));
		// A cancelled item keeps its worktree until cleanup: counted.
		const before = summary.body.heldWorktreeCount;
		work.cancelWorkItem({
			coordinatorId: teamId,
			itemId: item.id,
			actor: { kind: "agent", id: teamId },
		});
		expect((await call(READER, teamPath("summary"))).body.heldWorktreeCount).toBe(before + 1);
	});
});

describe("review fixes (PR review)", () => {
	test("an unresolved base branch is refused and the old base stays", async () => {
		const path = `/projects/${projectId}/teams/${teamId}`;
		const refused = await call(MEMBER, path, { method: "PATCH", body: { baseBranch: "mian" } });
		expect(refused.status).toBe(409);
		expect(refused.body.code).toBe("TEAM_BASE_BRANCH_UNRESOLVED");
		expect((await call(OWNER, path)).body.baseBranch).toBe("main");
		// A base that resolves is saved; then back to main.
		git(repo, "branch", "-f", "release", "main");
		const saved = await call(MEMBER, path, { method: "PATCH", body: { baseBranch: "release" } });
		expect(saved.status).toBe(200);
		expect(saved.body.baseBranch).toBe("release");
		// Changing only the brief runs no branch check.
		expect(
			(await call(MEMBER, path, { method: "PATCH", body: { brief: "Be kind." } })).status,
		).toBe(200);
		expect(
			(await call(MEMBER, path, { method: "PATCH", body: { baseBranch: "main" } })).body.baseBranch,
		).toBe("main");
	});

	test("a diff opens from the repository root when the coordinator works in a subdirectory", async () => {
		resetWorkStatCacheForTests();
		const { item } = await readyItem("Root readme", { "README.md": "more\n" });
		git(repo, "merge", "-q", "--no-ff", "-m", "land readme", item.branchName ?? "");
		expect(
			work.markMergedByAncestry({
				itemId: item.id,
				head: item.headSha ?? "",
				base: "main",
				expectedHeadSha: item.headSha,
				expectedUpdatedAt: item.updatedAt,
			}),
		).toBe(true);
		// Merged: read in the repository through the coordinator's working directory.
		mkdirSync(join(repo, "frontend"), { recursive: true });
		writeFileSync(join(repo, "frontend", "README.md"), "a different file\n");
		const before = db
			.select({ cwd: narrators.cwd })
			.from(narrators)
			.where(eq(narrators.id, teamId))
			.get();
		await db
			.update(narrators)
			.set({ cwd: join(repo, "frontend") })
			.where(eq(narrators.id, teamId));
		try {
			const detail = await call(READER, teamPath(`work/${item.id}`));
			expect(detail.body.files).toEqual([{ path: "README.md", added: 1, removed: 1 }]);
			const diff = await call(READER, teamPath(`work/${item.id}/diff?path=README.md`));
			expect(diff.status).toBe(200);
			expect(diff.body.text).toContain("+more");
		} finally {
			await db
				.update(narrators)
				.set({ cwd: before?.cwd ?? repo })
				.where(eq(narrators.id, teamId));
		}
	});

	test("a question's prompt and option explanations come from the normalized shape", async () => {
		const { questionForm, questionPreview } = await import("../../services/teams/team-board");
		const input = JSON.stringify({
			questions: [
				{
					header: "Rounding",
					description: "Which rule rounds a 0.005 remainder?",
					options: [
						{ header: "Half up", description: "0.5 rounds away from zero" },
						{ header: "Banker's" },
					],
				},
			],
		});
		expect(questionPreview(input)).toEqual(["Which rule rounds a 0.005 remainder?"]);
		expect(questionForm(input)).toEqual({
			header: "Rounding",
			description: "Which rule rounds a 0.005 remainder?",
			options: ["Half up", "Banker's"],
			optionDescriptions: ["0.5 rounds away from zero", null],
			multiSelect: false,
		});
		// The legacy shape still reads: the body in `question`.
		expect(
			questionPreview(
				JSON.stringify({ questions: [{ question: "Ship today?", header: "When", options: [] }] }),
			),
		).toEqual(["Ship today?"]);
	});
});

describe("review findings in the drawer", () => {
	test("each round's findings, long ones too, as far as the drawer is readable", async () => {
		resetWorkStatCacheForTests();
		const item = await newItem("Findings item");
		commitIn(work.worktreePathOf(item) ?? "", { "src/f.ts": "f\n" }, "findings work");
		await startItem(item, "Findings");
		const actor = { kind: "agent" as const, id: teamId };
		const short = "缺少跨日边界用例：UTC 16:00 之后下的订单，在东八区应算到第二天。";
		await work.recordReview({
			coordinatorId: teamId,
			itemId: item.id,
			verdict: "blocker",
			findings: 1,
			summary: `  ${short}\n`,
			reviewer: null,
			actor,
		});
		// Quotes and newlines escape past the event preview: read on its own, still whole.
		const long = `"\u0001`.repeat(500);
		await work.recordReview({
			coordinatorId: teamId,
			itemId: item.id,
			verdict: "clear",
			findings: 0,
			summary: long,
			reviewer: null,
			actor,
		});
		await work.recordReview({
			coordinatorId: teamId,
			itemId: item.id,
			verdict: "clear",
			findings: 0,
			summary: "   ",
			reviewer: null,
			actor,
		});
		for (const user of [OWNER, MEMBER, READER]) {
			const detail = await call(user, teamPath(`work/${item.id}`));
			expect(detail.status).toBe(200);
			expect(
				detail.body.reviews.map((round: { summary: string | null; verdict: string }) => [
					round.verdict,
					round.summary,
				]),
			).toEqual([
				["blocker", short],
				["clear", long],
				["clear", null],
			]);
			expect(
				detail.body.reviews.some((round: { summaryClipped?: boolean }) => round.summaryClipped),
			).toBe(false);
			// The timeline does not repeat the text the rounds carry.
			const reviews = detail.body.events.filter(
				(event: { kind: string }) => event.kind === "work.review",
			);
			expect(reviews).toHaveLength(3);
			for (const event of reviews) {
				expect(event.detailOmitted).toBe(false);
				expect("summary" in event.detail).toBe(false);
			}
			expect(reviews[1].detail).toMatchObject({ round: 2, verdict: "clear", findings: 0 });
		}
		// Findings are only as visible as the events: a stranger reads nothing.
		expect((await call(OUTSIDER, teamPath(`work/${item.id}`))).status).toBe(404);
		expect((await call(OUTSIDER, teamPath("events"))).status).toBe(404);
		// A blank summary is not stored; a too-long one is refused.
		const stored = db
			.select({ kind: teamWorkEvents.kind, detail: teamWorkEvents.detailJson })
			.from(teamWorkEvents)
			.where(eq(teamWorkEvents.workItemId, item.id))
			.all()
			.filter((row) => row.kind === "work.review");
		expect(JSON.stringify(stored[1]?.detail).length).toBeGreaterThan(
			TEAM_EVENT_DETAIL_PREVIEW_CHARS,
		);
		expect(stored.map((row) => row.detail && "summary" in row.detail)).toEqual([true, true, false]);
		await expect(
			work.recordReview({
				coordinatorId: teamId,
				itemId: item.id,
				verdict: "clear",
				findings: 0,
				summary: "x".repeat(1001),
				reviewer: null,
				actor,
			}),
		).rejects.toThrow("summary must be at most 1000 characters");
	});

	test("long findings are read row by row, newest first, only until the drawer has enough", async () => {
		resetWorkStatCacheForTests();
		const item = await newItem("Many findings item");
		commitIn(work.worktreePathOf(item) ?? "", { "src/many.ts": "m\n" }, "many findings work");
		await startItem(item, "Findings");
		const actor = { kind: "agent" as const, id: teamId };
		// Each findings text is the longest allowed and escapes past the event preview.
		const findings = (round: number) => `${round}`.padEnd(2, "-") + "\u0001".repeat(998);
		const rounds = 15;
		for (let round = 1; round <= rounds; round++)
			await work.recordReview({
				coordinatorId: teamId,
				itemId: item.id,
				verdict: round % 2 ? "blocker" : "clear",
				findings: round,
				summary: findings(round),
				reviewer: null,
				actor,
			});
		const reads = spyOn(board, "readReviewDetailText");
		try {
			for (const user of [OWNER, READER]) {
				reads.mockClear();
				const detail = await call(user, teamPath(`work/${item.id}`));
				expect(detail.status).toBe(200);
				// 6000 characters of findings is six rounds: the older nine are never read.
				const kept = TEAM_REVIEW_SUMMARIES_TOTAL_CHARS / 1000;
				expect(reads).toHaveBeenCalledTimes(kept);
				const reviews = detail.body.reviews as {
					round: number;
					verdict: string;
					findings: number | null;
					summary: string | null;
					summaryClipped?: boolean;
				}[];
				expect(reviews).toHaveLength(rounds);
				reviews.forEach((review, index) => {
					const round = index + 1;
					// Every round keeps its verdict and count, read or not.
					expect([review.round, review.verdict, review.findings]).toEqual([
						round,
						round % 2 ? "blocker" : "clear",
						round,
					]);
					if (round > rounds - kept) {
						expect(review.summary).toBe(findings(round));
						expect(review.summaryClipped ?? false).toBe(false);
					} else {
						expect(review.summary).toBeNull();
						expect(review.summaryClipped).toBe(true);
					}
				});
				const timeline = detail.body.events.filter(
					(event: { kind: string }) => event.kind === "work.review",
				);
				for (const event of timeline) expect(event.detailOmitted).toBe(false);
			}
		} finally {
			reads.mockRestore();
		}
		expect((await call(OUTSIDER, teamPath(`work/${item.id}`))).status).toBe(404);
	});

	test("a long review's head gives its round, verdict and count", () => {
		expect(
			board.reviewHeadDetail('{"round":3,"verdict":"clear","findings":0,"summary":"\\u0001'),
		).toEqual({ round: 3, verdict: "clear", findings: 0 });
		expect(board.reviewHeadDetail('{"round":2,"verdict":"blocker","findings":4}')).toEqual({
			round: 2,
			verdict: "blocker",
			findings: 4,
		});
		for (const head of [null, undefined, "", '{"verdict":"clear"}', '{"round":1,"verdict":"maybe"'])
			expect(board.reviewHeadDetail(head)).toBeNull();
	});

	test("the findings one drawer sends are capped in all, newest rounds first", () => {
		const round = (eventId: string, summary: string | null) => ({
			eventId,
			round: 1,
			actorId: null,
			verdict: "blocker" as const,
			findings: 1,
			by: "agent" as const,
			actorName: null,
			reason: null,
			summary,
			at: "2026-01-01T00:00:00.000Z",
		});
		const capped = capReviewSummaries(
			[
				round("a", "a".repeat(400)),
				round("b", "b".repeat(400)),
				round("c", null),
				round("d", "d".repeat(700)),
			],
			1000,
		);
		expect(capped.map((entry) => entry.summary?.length ?? null)).toEqual([null, 300, null, 700]);
		expect(capped.map((entry) => entry.summaryClipped ?? false)).toEqual([
			true,
			true,
			false,
			false,
		]);
		expect(capped[1]?.summary?.endsWith("…")).toBe(true);
	});
});

describe("merge (M)", () => {
	test("members only (as 退回); 202 with the phase; the drawer and the board read it back", async () => {
		const { settleMergeJobs } = await import("../../services/teams/team-merge");
		const merged: string[] = [];
		work.setMergeNoteDeliveryForTests(async ({ text }) => {
			merged.push(text);
			return true;
		});
		try {
			// The member's own NarraFork git identity commits the merge.
			const { userGitIdentities } = await import("../../db/schema");
			await db.insert(userGitIdentities).values({
				id: generateId(),
				userId: MEMBER,
				name: "Member Person",
				email: "member@example.com",
				isDefault: true,
				createdAt: new Date().toISOString(),
			});
			const { item } = await readyItem("Merge me", { "merge/me.txt": "merge\n" });
			const path = teamPath(`work/${item.id}/merge`);
			expect((await call(READER, path, { method: "POST" })).status).toBe(403);
			expect((await call(OUTSIDER, path, { method: "POST" })).status).toBe(404);
			const accepted = await call(MEMBER, path, { method: "POST" });
			expect(accepted.status).toBe(202);
			expect(accepted.body).toEqual({ itemId: item.id, job: "merge", phase: "queued" });
			await settleMergeJobs();
			// main is checked out in the project's directory: the merge is prepared, not applied.
			const before = git(repo, "rev-parse", "main");
			const drawer = await call(MEMBER, teamPath(`work/${item.id}`));
			expect(drawer.status).toBe(200);
			expect(drawer.body.merge).toMatchObject({
				mode: "local",
				phase: null,
				outcome: "prepared",
				canMerge: true,
				disabledReason: null,
				detail: { kind: "prepared", baseSha: before },
				fastForward: {
					available: true,
					command: {
						sh: expect.stringContaining("merge --ff-only --no-autostash --no-overwrite-ignore"),
						powershell: expect.stringContaining("-ceq 'refs/heads/main'"),
						preferred: "sh",
					},
				},
			});
			const onlooker = await call(READER, teamPath(`work/${item.id}`));
			expect(onlooker.body.merge).toMatchObject({ outcome: "prepared", canMerge: false });
			const column = await call(MEMBER, teamPath("board?column=review"));
			const card = column.body.items.find((entry: { id: string }) => entry.id === item.id);
			expect(card.merge).toMatchObject({ mode: "local", outcome: "prepared", canMerge: true });

			// 「在该目录中快进」: the same access; then the item is merged.
			const forward = teamPath(`work/${item.id}/merge/fast-forward`);
			expect((await call(READER, forward, { method: "POST" })).status).toBe(403);
			const fastForward = await call(MEMBER, forward, { method: "POST" });
			expect(fastForward.status).toBe(202);
			expect(fastForward.body).toEqual({ itemId: item.id, job: "fast_forward", phase: "queued" });
			await settleMergeJobs();
			expect(work.requireWorkItem(teamId, item.id).state).toBe("merged");
			expect(git(repo, "rev-parse", "main")).not.toBe(before);
			expect(git(repo, "log", "-1", "--format=%an <%ae>|%P", "main")).toBe(
				`Member Person <member@example.com>|${before} ${item.headSha}`,
			);
			expect(git(repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
			expect(merged).toHaveLength(1);
			// No longer ready: refused.
			const again = await call(MEMBER, path, { method: "POST" });
			expect(again.status).toBe(409);
			expect(again.body.code).toBe("TEAM_WORK_ITEM_NOT_READY");
		} finally {
			work.setMergeNoteDeliveryForTests(null);
		}
	});

	test("a read-only project member with coordinator write can neither merge nor fast-forward", async () => {
		const { item } = await readyItem("Reader merges", { "merge/reader.txt": "reader\n" });
		const grantId = generateId();
		await db.insert(aclGrants).values({
			id: grantId,
			scopeType: "narrator",
			scopeId: teamId,
			principalType: "user",
			principalId: READER,
			capability: "write",
			createdAt: new Date().toISOString(),
		});
		try {
			// The coordinator grant makes them a member: they may return the item, as before.
			const drawer = await call(READER, teamPath(`work/${item.id}`));
			expect(drawer.body.canReturn).toBe(true);
			// The drawer does not offer them the merge either.
			expect(drawer.body.merge).toMatchObject({ canMerge: false });
			for (const suffix of ["merge", "merge/fast-forward", "pr/merge", "pr/refresh"]) {
				const response = await call(READER, teamPath(`work/${item.id}/${suffix}`), {
					method: "POST",
				});
				expect({ suffix, status: response.status }).toEqual({ suffix, status: 403 });
			}
			expect(work.requireWorkItem(teamId, item.id).state).toBe("ready");
		} finally {
			await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
		}
	});

	test("a fast-forward without a prepared merge is refused", async () => {
		const { item } = await readyItem("Nothing prepared", { "merge/none.txt": "none\n" });
		const response = await call(MEMBER, teamPath(`work/${item.id}/merge/fast-forward`), {
			method: "POST",
		});
		expect(response.status).toBe(409);
		expect(response.body.code).toBe("TEAM_MERGE_NOT_PREPARED");
	});
});

describe("pull requests (G)", () => {
	async function onGitHub(
		gh:
			| { ok: true; methods: ("merge" | "squash" | "rebase")[] }
			| {
					ok: false;
					reason: "gh_logged_out";
			  },
	) {
		const hosting = await import("../../services/teams/team-hosting");
		hosting.setHostingSourceForTests(async () => "git@github.com:acme/app.git");
		hosting.setGhProbeForTests(async () => gh);
		await hosting.hostingOf(repo);
		return () => {
			hosting.setHostingSourceForTests(null);
			hosting.setGhProbeForTests(null);
		};
	}

	test("members only (as the merge); a stranger gets 404; no pull request yet is refused with its reason", async () => {
		const { settleMergeJobs } = await import("../../services/teams/team-merge");
		const { item } = await readyItem("PR access", { "pr/access.txt": "pr\n" });
		const restore = await onGitHub({ ok: true, methods: ["squash", "merge"] });
		try {
			// Nothing confirmed yet: a member who may not manage the project waits for a manager.
			const unconfirmed = await call(MEMBER, teamPath(`work/${item.id}`));
			expect(unconfirmed.body.merge).toMatchObject({
				mode: "github",
				canMerge: false,
				disabledReason: "github_unconfirmed",
				github: { target: "github.com/acme/app", pinned: null, canConfirm: false },
			});
			expect((await call(OWNER, teamPath(`work/${item.id}`))).body.merge.github).toMatchObject({
				canConfirm: true,
			});
			const refused = await call(MEMBER, teamPath(`work/${item.id}/merge`), { method: "POST" });
			expect(refused.body.code).toBe("TEAM_PR_TARGET_UNCONFIRMED");
			// Only a project manager confirms it.
			const pinPath = `/projects/${projectId}/team-github`;
			const body = { target: "github.com/acme/app" };
			expect((await call(MEMBER, pinPath, { method: "PUT", body })).status).toBe(403);
			expect((await call(OUTSIDER, pinPath, { method: "PUT", body })).status).toBe(404);
			expect(
				(await call(OWNER, pinPath, { method: "PUT", body: { target: "acme/app" } })).status,
			).toBe(400);
			const pinned = await call(OWNER, pinPath, { method: "PUT", body });
			expect(pinned.status).toBe(200);
			expect(pinned.body).toMatchObject({
				pinned: { host: "github.com", owner: "acme", repo: "app", confirmedBy: OWNER },
				detected: "github.com/acme/app",
			});
			// Reading it needs project read only.
			expect((await call(MEMBER, pinPath)).body.pinned.repo).toBe("app");
			for (const suffix of ["pr/merge", "pr/refresh"]) {
				const path = teamPath(`work/${item.id}/${suffix}`);
				expect((await call(READER, path, { method: "POST" })).status).toBe(403);
				expect((await call(OUTSIDER, path, { method: "POST" })).status).toBe(404);
			}
			const refresh = await call(MEMBER, teamPath(`work/${item.id}/pr/refresh`), {
				method: "POST",
			});
			expect(refresh.status).toBe(409);
			expect(refresh.body.code).toBe("TEAM_PR_NONE");
			const mergePath = teamPath(`work/${item.id}/pr/merge`);
			expect(
				(await call(MEMBER, mergePath, { method: "POST", body: { method: "octopus" } })).status,
			).toBe(400);
			const rebase = await call(MEMBER, mergePath, { method: "POST", body: { method: "rebase" } });
			expect(rebase.status).toBe(409);
			expect(rebase.body.code).toBe("TEAM_PR_METHOD_NOT_ALLOWED");
			const accepted = await call(MEMBER, mergePath, { method: "POST" });
			expect(accepted.status).toBe(202);
			expect(accepted.body).toEqual({ itemId: item.id, job: "pr_merge", phase: "queued" });
			await settleMergeJobs();
			const drawer = await call(MEMBER, teamPath(`work/${item.id}`));
			expect(drawer.body.merge).toMatchObject({
				mode: "github",
				canMerge: true,
				disabledReason: null,
				pr: null,
				detail: { kind: "failed", code: "TEAM_PR_NONE" },
			});
			expect(work.requireWorkItem(teamId, item.id).state).toBe("ready");
			expect((await call(OWNER, pinPath, { method: "DELETE" })).body.pinned).toBeNull();
		} finally {
			restore();
		}
	});

	test("the project PATCH never writes the confirmed repository, and keeps it", async () => {
		const { projectRoutes } = await import("../projects");
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("user", { sub: OWNER, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
			await next();
		});
		app.route("/projects", projectRoutes);
		const { pinnedGithubTarget, setPinnedGithubTarget } = await import(
			"../../services/teams/team-github-pin"
		);
		setPinnedGithubTarget(projectId, { host: "github.com", owner: "acme", repo: "app" }, OWNER);
		try {
			const response = await app.request(`http://localhost/projects/${projectId}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					chapterSettings: {
						teams: {
							workStart: "local",
							github: { host: "github.com", owner: "attacker", repo: "app" },
						},
					},
				}),
			});
			expect(response.status).toBe(200);
			expect(pinnedGithubTarget(projectId)).toMatchObject({ owner: "acme", repo: "app" });
		} finally {
			setPinnedGithubTarget(projectId, null, null);
		}
	});

	test("GitHub with gh logged out: the merge is refused with the reason, never merged locally", async () => {
		const { item } = await readyItem("PR logged out", { "pr/out.txt": "out\n" });
		const before = git(repo, "rev-parse", "main");
		const restore = await onGitHub({ ok: false, reason: "gh_logged_out" });
		try {
			const refused = await call(MEMBER, teamPath(`work/${item.id}/merge`), { method: "POST" });
			expect(refused.status).toBe(409);
			expect(refused.body.code).toBe("TEAM_PR_GH_LOGGED_OUT");
			const drawer = await call(MEMBER, teamPath(`work/${item.id}`));
			expect(drawer.body.merge).toMatchObject({
				mode: "github",
				canMerge: false,
				disabledReason: "gh_logged_out",
			});
			expect(git(repo, "rev-parse", "main")).toBe(before);
		} finally {
			restore();
		}
	});
});
