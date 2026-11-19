/**
 * X: who is changing what across a project's teams, and the exclusive paths lock
 * (docs/PROJECT_TEAMS-PLAN.md §二.5, §二.10).
 *
 *  - two teams changing the same file both see it (people through the route, each as far as
 *    they may read the other team; coordinators through a recorded event and a notice);
 *  - the second item touching the exclusive paths is refused readiness naming the holder; a
 *    person's force-release is recorded; finishing the holder releases the lock;
 *  - an item over the path budget compares by top-level directory (and is stored collapsed);
 *  - the background pass is bounded (50 items) and resumes after the last item it looked at;
 *  - the team status section is deterministic and bounded;
 *  - changed paths are read only through the hardened git of `team-git.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-team-overlap-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { db, sqlite } = await import("../../../db");
const { eq, sql } = await import("drizzle-orm");
const { narratorWorktreeResources, teamWorkEvents, teamWorkItems } = await import(
	"../../../db/schema"
);
const { AppError } = await import("../../../lib/errors");
const { setGitHardeningProbeForTests } = await import("../../../lib/git-exec-hardening");
const { generateId } = await import("../../../lib/id");
const { safeSpawn } = await import("../../../lib/spawn");
const shared = await import("@shared/project-teams");
const items = await import("../work-items");
const overlap = await import("../team-overlap");
const { readTeamStatus } = await import("../team-status");
const { projectTeamRoutes } = await import("../../../routes/project-teams");

const PROJECT = "x-project";
const MANAGER = "x-manager";
const USER_A = "x-user-a";
const USER_B = "x-user-b";
const OUTSIDER = "x-outsider";
const LEAD_A = "x-lead-a";
const LEAD_B = "x-lead-b";
const LEAD_C = "x-lead-c";
const NOW = "2026-11-18T00:00:00.000Z";

let temporary: string;
let source: string;
let clockNow = Date.UTC(2026, 10, 18, 12);
const notices: Array<{ teamId: string; text: string; wake: boolean }> = [];

afterAll(() => {
	setGitHardeningProbeForTests(null);
	overlap.setOverlapSeamsForTests({ clock: null, notify: null });
	overlap.setChangedPathsSourceForTests(null);
	items.setWorkItemPortsForTests(null);
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

async function git(args: string[], cwd = source) {
	const result = await safeSpawn({
		// CI runners have no git identity: every commit and merge in these fixtures needs one.
		cmd: ["git", "-C", cwd, "-c", "user.name=T", "-c", "user.email=t@e.test", ...args],
		timeout: 20_000,
		maxOutputBytes: 1024 * 1024,
	});
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}
async function commitFiles(cwd: string, files: Record<string, string>, message: string) {
	for (const [file, text] of Object.entries(files)) {
		await mkdir(join(cwd, file, ".."), { recursive: true });
		await writeFile(join(cwd, file), text);
	}
	await git(["add", "-A"], cwd);
	await git(["-c", "user.name=T", "-c", "user.email=t@e.test", "commit", "-qm", message], cwd);
}

const ports: import("../work-items").WorkItemWorktreePorts = {
	async createWorktree({ coordinatorId, requestId, branchName, baseRef }) {
		const path = join(source, ".worktrees", requestId);
		await git(["worktree", "add", "-q", "-b", branchName, "--", path, baseRef]);
		db.insert(narratorWorktreeResources)
			.values({
				id: generateId(),
				ownerNarratorId: coordinatorId,
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
};

function seedUsers() {
	for (const id of [MANAGER, USER_A, USER_B, OUTSIDER])
		sqlite.run(
			`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'x', 'user', ?)`,
			[id, id, NOW],
		);
}

function seedTeam(id: string, title: string, owner: string, visibility: string) {
	sqlite.run(
		`INSERT INTO narrators (id, type, title, traits, cwd, owner_user_id, visibility, write_audience,
			context_project_id, created_at, updated_at)
		VALUES (?, 'primary', ?, '["team"]', ?, ?, ?, 'owner', ?, ?, ?)`,
		[id, title, source, owner, visibility, PROJECT, NOW, NOW],
	);
	sqlite.run(
		`INSERT INTO project_teams (narrator_id, project_id, base_branch, created_by, created_at, updated_at)
		VALUES (?, ?, 'main', ?, ?, ?)`,
		[id, PROJECT, owner, NOW, NOW],
	);
}

function grantProject(userId: string) {
	sqlite.run(
		`INSERT INTO acl_grants (id, scope_type, scope_id, principal_type, principal_id, capability, created_at)
		VALUES (?, 'project', ?, 'user', ?, 'write', ?)`,
		[generateId(), PROJECT, userId, NOW],
	);
}

/**
 * Lead A: visibility `project` (any project member reads it, only USER_A writes it). Lead B and
 * Lead C: `private` (only their owners).
 */
function seedWorld() {
	seedUsers();
	sqlite.run(
		`INSERT INTO projects (id, name, git_path, owner_user_id, visibility, created_at, updated_at)
		VALUES (?, 'x', ?, ?, 'private', ?, ?)`,
		[PROJECT, source, MANAGER, NOW, NOW],
	);
	for (const user of [USER_A, USER_B, OUTSIDER]) grantProject(user);
	seedTeam(LEAD_A, "Lead A", USER_A, "project");
	seedTeam(LEAD_B, "Lead B", USER_B, "private");
	seedTeam(LEAD_C, "Lead C", USER_B, "private");
}

function setExclusivePaths(paths: string[] | null) {
	sqlite.run("UPDATE projects SET chapter_settings = ? WHERE id = ?", [
		paths ? JSON.stringify({ teams: { exclusivePaths: paths } }) : null,
		PROJECT,
	]);
}

function eventsOf(itemId: string) {
	return db
		.select({
			kind: teamWorkEvents.kind,
			actorKind: teamWorkEvents.actorKind,
			actorId: teamWorkEvents.actorId,
			detail: teamWorkEvents.detailJson,
		})
		.from(teamWorkEvents)
		.where(eq(teamWorkEvents.workItemId, itemId))
		.orderBy(sql`rowid`)
		.all();
}

function itemRow(id: string) {
	return db.select().from(teamWorkItems).where(eq(teamWorkItems.id, id)).get();
}

const create = (lead: string, title: string, userId: string) =>
	items.createWorkItem({
		coordinatorId: lead,
		title,
		actor: { kind: "agent", id: lead },
		principal: { userId, isAdmin: false },
		signal: new AbortController().signal,
	});

async function clearReview(lead: string, itemId: string) {
	await items.recordReview({
		coordinatorId: lead,
		itemId,
		verdict: "clear",
		findings: 0,
		reviewer: "reviewer",
		actor: { kind: "agent", id: lead },
	});
}

/** An item row without git, with stored changed paths (synthetic tests). */
function insertItem(lead: string, title: string, paths: string[] | null, extra = {}) {
	const id = generateId();
	db.insert(teamWorkItems)
		.values({
			id,
			teamId: lead,
			projectId: PROJECT,
			title,
			state: "in_progress",
			changedPathsJson: paths,
			changedPathsAtSha: paths ? "a".repeat(40) : null,
			createdAt: NOW,
			updatedAt: NOW,
			...extra,
		})
		.run();
	return id;
}

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		const status = error instanceof AppError ? error.statusCode : 500;
		return new Response(JSON.stringify({ error: error.message }), { status });
	});
	app.route("/projects", projectTeamRoutes);
	return app;
}

async function call(userId: string, path: string, body?: unknown) {
	const response = await appAs(userId).request(`http://localhost${path}`, {
		method: body === undefined ? "GET" : "POST",
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	return {
		status: response.status,
		body: (await response.json()) as import("@shared/project-teams").TeamOverlapResponse &
			Record<string, unknown>,
	};
}

beforeAll(() => {
	overlap.setOverlapSeamsForTests({
		clock: { now: () => clockNow, every: () => () => {} },
		notify: async (input) => {
			notices.push({ teamId: input.teamId, text: input.text, wake: input.wake });
		},
	});
});

beforeEach(async () => {
	temporary = await mkdtemp(join(tmpdir(), "nf-team-overlap-"));
	source = join(temporary, "repo");
	await mkdir(source);
	await git(["init", "-q", "-b", "main"]);
	await writeFile(join(source, ".gitignore"), ".worktrees/\n");
	await writeFile(join(source, "shared.ts"), "base\n");
	await git(["add", "."]);
	await git(["-c", "user.name=T", "-c", "user.email=t@e.test", "commit", "-qm", "initial"]);
	await mkdir(join(source, ".worktrees"));
	seedWorld();
	items.setWorkItemPortsForTests(ports);
	overlap.resetOverlapStateForTests();
	overlap.setChangedPathsSourceForTests(null);
	setGitHardeningProbeForTests(null);
	notices.length = 0;
	clockNow = Date.UTC(2026, 10, 18, 12);
});

afterEach(async () => {
	for (const table of [
		"team_work_events",
		"team_work_items",
		"project_teams",
		"narrator_worktree_resources",
		"acl_grants",
	])
		sqlite.run(`DELETE FROM ${table}`);
	sqlite.run("DELETE FROM narrators WHERE id LIKE 'x-%'");
	sqlite.run("DELETE FROM projects WHERE id = ?", [PROJECT]);
	sqlite.run("DELETE FROM users WHERE id LIKE 'x-%'");
	await rm(temporary, { recursive: true, force: true });
});

describe("two teams changing the same file", () => {
	test("both see it: people through the route, coordinators through an event and a notice", async () => {
		const a = await create(LEAD_A, "Rework the parser", USER_A);
		const b = await create(LEAD_B, "Parser speedup", USER_B);
		await commitFiles(
			items.worktreePathOf(a) ?? "",
			{ "shared.ts": "a\n", "a-only.ts": "a\n" },
			"a",
		);
		await commitFiles(
			items.worktreePathOf(b) ?? "",
			{ "shared.ts": "b\n", "b-only.ts": "b\n" },
			"b",
		);

		const pass = await overlap.runChangedPathsPass();
		expect(pass).toMatchObject({ looked: 2, updated: 2, failed: 0, wrapped: true, newPairs: 1 });
		expect(itemRow(a.id)?.changedPathsJson).toEqual(["a-only.ts", "shared.ts"]);
		expect(itemRow(a.id)?.changedPathsAtSha).toBe(
			await git(["rev-parse", "HEAD"], items.worktreePathOf(a) ?? ""),
		);
		// The background refresh never moves the coordinator's concurrency token.
		expect(itemRow(a.id)?.updatedAt).toBe(a.updatedAt);

		// Recorded once on each side, naming the other item and the shared path.
		const eventA = eventsOf(a.id).filter((event) => event.kind === "work.overlap");
		const eventB = eventsOf(b.id).filter((event) => event.kind === "work.overlap");
		expect(eventA).toEqual([
			{
				kind: "work.overlap",
				actorKind: "system",
				actorId: null,
				detail: { with: b.id, withTeam: LEAD_B, paths: ["shared.ts"] },
			},
		]);
		expect(eventB.map((event) => event.detail)).toEqual([
			{ with: a.id, withTeam: LEAD_A, paths: ["shared.ts"] },
		]);
		// Both coordinators are told. Lead B (private) is not named to Lead A's conversation;
		// Lead A (project-visible) is named to Lead B's.
		expect(notices.map((notice) => notice.teamId).sort()).toEqual([LEAD_A, LEAD_B]);
		const toA = notices.find((notice) => notice.teamId === LEAD_A)?.text ?? "";
		const toB = notices.find((notice) => notice.teamId === LEAD_B)?.text ?? "";
		expect(toA).toContain(`your work item "Rework the parser" and another team's work item`);
		expect(toA).not.toContain("Lead B");
		expect(toA).not.toContain("Parser speedup");
		expect(toB).toContain(
			`your work item "Parser speedup" and team "Lead A"'s work item "Rework the parser" both change: shared.ts`,
		);

		// USER_A: member of A; cannot read B → "another team" without details.
		const seenByA = await call(USER_A, `/projects/${PROJECT}/team-overlaps`);
		expect(seenByA.status).toBe(200);
		expect(seenByA.body.entries).toEqual([
			{
				path: "shared.ts",
				kind: "file",
				items: [
					{
						access: "member",
						teamId: LEAD_A,
						teamName: "Lead A",
						title: "Rework the parser",
						id: a.id,
						state: "queued",
						branch: a.branchName,
						exclusiveKey: null,
					},
					{ access: "hidden" },
				],
			},
		]);
		// USER_B: member of B; reads A (project-visible) → team name and title only.
		const seenByB = await call(USER_B, `/projects/${PROJECT}/team-overlaps`);
		expect(seenByB.body.entries[0]?.items).toEqual([
			expect.objectContaining({ access: "member", id: b.id, title: "Parser speedup" }),
			{ access: "reader", teamId: LEAD_A, teamName: "Lead A", title: "Rework the parser" },
		]);
		expect(seenByB.body).toMatchObject({
			activeItems: 2,
			activeItemsCapped: false,
			moreEntries: 0,
			stale: false,
		});
		// USER_A cannot see Lead B's item: it is not counted either.
		expect(seenByA.body.activeItems).toBe(1);

		// A second pass without new commits records nothing new and tells nobody again.
		clockNow += shared.TEAM_OVERLAP_NOTICE_INTERVAL_MS;
		const again = await overlap.runChangedPathsPass();
		expect(again).toMatchObject({ looked: 2, updated: 0, newPairs: 0 });
		expect(eventsOf(a.id).filter((event) => event.kind === "work.overlap")).toHaveLength(1);
		expect(notices).toHaveLength(2);

		// A finished item leaves the overlaps at once.
		items.cancelWorkItem({
			coordinatorId: LEAD_B,
			itemId: b.id,
			actor: { kind: "agent", id: LEAD_B },
		});
		expect((await call(USER_A, `/projects/${PROJECT}/team-overlaps`)).body.entries).toEqual([]);
	});

	test("a new overlap within the notice interval waits for the next notice", async () => {
		const a1 = insertItem(LEAD_A, "A one", ["x.ts"]);
		insertItem(LEAD_B, "B one", ["x.ts"]);
		expect(
			(await overlap.recordNewCrossTeamPairs(await overlap.ensureProjectOverlaps(PROJECT)))
				.recorded,
		).toBe(1);
		expect(await overlap.flushNotices()).toBe(2);
		insertItem(LEAD_C, "C one", ["x.ts"]);
		overlap.invalidateProjectOverlaps(PROJECT);
		// Two new pairs: A–C and B–C; Lead A and Lead B were told less than ten minutes ago.
		expect(
			(await overlap.recordNewCrossTeamPairs(await overlap.ensureProjectOverlaps(PROJECT)))
				.recorded,
		).toBe(2);
		expect(await overlap.flushNotices()).toBe(1);
		expect(notices.map((notice) => notice.teamId)).toEqual([LEAD_A, LEAD_B, LEAD_C]);
		clockNow += shared.TEAM_OVERLAP_NOTICE_INTERVAL_MS;
		expect(await overlap.flushNotices()).toBe(2);
		expect(notices.slice(3).map((notice) => notice.teamId)).toEqual([LEAD_A, LEAD_B]);
		expect(eventsOf(a1).filter((event) => event.kind === "work.overlap")).toHaveLength(2);
	});

	test("an overlap none of whose teams the reader can read is not listed", async () => {
		insertItem(LEAD_B, "B secret", ["secret.ts"]);
		insertItem(LEAD_C, "C secret", ["secret.ts"]);
		// A request never builds the index: the first one starts a build and says it is stale.
		const first = await call(USER_B, `/projects/${PROJECT}/team-overlaps`);
		expect(first.body).toMatchObject({ stale: true, computedAt: null, entries: [] });
		await overlap.ensureProjectOverlaps(PROJECT);
		const outsider = await call(OUTSIDER, `/projects/${PROJECT}/team-overlaps`);
		expect(outsider.status).toBe(200);
		expect(outsider.body.entries).toEqual([]);
		// The owner of both sees it.
		expect((await call(USER_B, `/projects/${PROJECT}/team-overlaps`)).body.entries).toHaveLength(1);
		// Not a project member: 404.
		sqlite.run("DELETE FROM acl_grants WHERE principal_id = ?", [OUTSIDER]);
		expect((await call(OUTSIDER, `/projects/${PROJECT}/team-overlaps`)).status).toBe(404);
	});
});

describe("exclusive paths", () => {
	test("the second item adding a migration is refused; force-release is recorded", async () => {
		setExclusivePaths(["drizzle/**", "drizzle-postgres/**", "server/db/schema.ts"]);
		const a = await create(LEAD_A, "Add a column", USER_A);
		const b = await create(LEAD_B, "Add a table", USER_B);
		const c = await create(LEAD_B, "Docs only", USER_B);
		await commitFiles(items.worktreePathOf(a) ?? "", { "drizzle/0260_x.sql": "--\n" }, "a");
		await commitFiles(items.worktreePathOf(b) ?? "", { "server/db/schema.ts": "//\n" }, "b");
		await commitFiles(items.worktreePathOf(c) ?? "", { "docs/x.md": "x\n" }, "c");
		for (const [lead, item] of [
			[LEAD_A, a],
			[LEAD_B, b],
			[LEAD_B, c],
		] as const)
			await clearReview(lead, item.id);

		const first = await items.markReady({
			coordinatorId: LEAD_A,
			itemId: a.id,
			actor: { kind: "agent", id: LEAD_A },
		});
		expect(first.item.state).toBe("ready");
		expect(first.item.exclusiveKey).toBe(shared.TEAM_EXCLUSIVE_LOCK_KEY);
		expect(first.item.changedPathsJson).toEqual(["drizzle/0260_x.sql"]);
		expect(eventsOf(a.id).map((event) => event.kind)).toContain("work.exclusive_taken");

		// An item not touching the exclusive paths is never held up.
		const docs = await items.markReady({
			coordinatorId: LEAD_B,
			itemId: c.id,
			actor: { kind: "agent", id: LEAD_B },
		});
		expect(docs.item.exclusiveKey).toBeNull();

		const refused = items.markReady({
			coordinatorId: LEAD_B,
			itemId: b.id,
			actor: { kind: "agent", id: LEAD_B },
		});
		await expect(refused).rejects.toMatchObject({ code: "TEAM_EXCLUSIVE_LOCK_HELD" });
		await expect(refused).rejects.toThrow(
			`the lock is held by team "Lead A"'s work item "Add a column" (ready)`,
		);
		expect(itemRow(b.id)?.state).toBe("in_review");
		expect(eventsOf(b.id).at(-1)).toMatchObject({
			kind: "work.exclusive_refused",
			detail: { holder: a.id, paths: ["server/db/schema.ts"] },
		});

		// The unique index is the guarantee: a second holder cannot be written at all.
		let conflict: unknown = null;
		try {
			db.update(teamWorkItems)
				.set({ exclusiveKey: shared.TEAM_EXCLUSIVE_LOCK_KEY })
				.where(eq(teamWorkItems.id, b.id))
				.run();
		} catch (error) {
			conflict = error;
		}
		expect(overlap.isExclusiveConflict(conflict)).toBe(true);

		// The route lists the lock; only a project manager may release it.
		const listed = await call(USER_B, `/projects/${PROJECT}/team-overlaps`);
		expect(listed.body.exclusivePaths).toEqual([
			"drizzle/**",
			"drizzle-postgres/**",
			"server/db/schema.ts",
		]);
		expect(listed.body.locks).toEqual([
			{
				key: shared.TEAM_EXCLUSIVE_LOCK_KEY,
				holder: { access: "reader", teamId: LEAD_A, teamName: "Lead A", title: "Add a column" },
				canRelease: false,
			},
		]);
		const denied = await call(USER_B, `/projects/${PROJECT}/team-locks/release`, {
			workItemId: a.id,
		});
		expect([403, 404]).toContain(denied.status);
		expect(itemRow(a.id)?.exclusiveKey).toBe(shared.TEAM_EXCLUSIVE_LOCK_KEY);

		const managerView = await call(MANAGER, `/projects/${PROJECT}/team-overlaps`);
		expect(managerView.body.locks[0]).toMatchObject({ canRelease: true, holderId: a.id });
		const released = await call(MANAGER, `/projects/${PROJECT}/team-locks/release`, {
			workItemId: a.id,
			reason: "B's migration goes first",
		});
		expect(released.status).toBe(200);
		expect(released.body as unknown).toEqual({
			released: true,
			key: shared.TEAM_EXCLUSIVE_LOCK_KEY,
		});
		expect(itemRow(a.id)?.exclusiveKey).toBeNull();
		expect(itemRow(a.id)?.state).toBe("ready");
		expect(eventsOf(a.id).at(-1)).toEqual({
			kind: "work.exclusive_released",
			actorKind: "person",
			actorId: MANAGER,
			detail: {
				key: shared.TEAM_EXCLUSIVE_LOCK_KEY,
				forced: true,
				reason: "B's migration goes first",
			},
		});

		// Now B takes it; cancelling B releases it again (recorded).
		const second = await items.markReady({
			coordinatorId: LEAD_B,
			itemId: b.id,
			actor: { kind: "agent", id: LEAD_B },
		});
		expect(second.item.exclusiveKey).toBe(shared.TEAM_EXCLUSIVE_LOCK_KEY);
		items.cancelWorkItem({
			coordinatorId: LEAD_B,
			itemId: b.id,
			actor: { kind: "agent", id: LEAD_B },
		});
		expect(itemRow(b.id)?.exclusiveKey).toBeNull();
		expect(
			eventsOf(b.id)
				.map((event) => event.kind)
				.slice(-2),
		).toEqual(["work.exclusive_released", "work.cancelled"]);
		expect(overlap.exclusiveHolder(PROJECT)).toBeNull();
	});

	test("Lead A's refusal does not name a private team", async () => {
		setExclusivePaths(["drizzle/**"]);
		const holder = insertItem(LEAD_B, "Private migration", ["drizzle/1.sql"], {
			exclusiveKey: shared.TEAM_EXCLUSIVE_LOCK_KEY,
			state: "ready",
		});
		const holderRow = overlap.exclusiveHolder(PROJECT);
		expect(holderRow?.id).toBe(holder);
		const text = await overlap.describeHolderFor(
			LEAD_A,
			holderRow as NonNullable<typeof holderRow>,
		);
		expect(text).toBe("a work item of another team (ready)");
		expect(
			await overlap.describeHolderFor(LEAD_B, holderRow as NonNullable<typeof holderRow>),
		).toContain(`your work item "Private migration"`);
	});

	test("globs match files and collapsed directories", () => {
		const globs = ["drizzle/**", "server/db/schema.ts"];
		expect(overlap.exclusiveHits(["drizzle/meta/_journal.json"], globs)).toHaveLength(1);
		expect(overlap.exclusiveHits(["server/db/schema.ts", "server/db/index.ts"], globs)).toEqual([
			"server/db/schema.ts",
		]);
		expect(overlap.exclusiveHits(["drizzle-postgres/0077.sql", "README.md"], globs)).toEqual([]);
		// A collapsed item errs toward the lock: `server/` may hold server/db/schema.ts.
		expect(overlap.exclusiveHits(["server/", "docs/"], globs)).toEqual(["server/"]);
		expect(overlap.exclusiveHits(["docs/"], ["**/*.sql"])).toEqual(["docs/"]);
		expect(overlap.exclusivePathsOf({ teams: { exclusivePaths: ["a/**", 3, ""] } })).toEqual([
			"a/**",
		]);
		expect(overlap.exclusivePathsOf(null)).toEqual([]);
	});

	test("the project setting is validated", async () => {
		const { projectChapterSettingsSchema } = await import("../../../lib/validators");
		const ok = (teams: unknown) => projectChapterSettingsSchema.safeParse({ teams }).success;
		expect(
			ok({ exclusivePaths: ["drizzle/**", "drizzle-postgres/**", "server/db/schema.ts"] }),
		).toBe(true);
		expect(ok({ exclusivePaths: ["/etc/**"] })).toBe(false);
		expect(ok({ exclusivePaths: ["../x"] })).toBe(false);
		expect(ok({ exclusivePaths: [""] })).toBe(false);
		expect(ok({ exclusivePaths: Array.from({ length: 51 }, (_, i) => `d${i}/**`) })).toBe(false);
		expect(ok({ other: true })).toBe(false);
	});
});

describe("comparing large changes by directory", () => {
	test("past 500 paths an item compares by top-level directory", async () => {
		const big = Array.from({ length: 600 }, (_, i) => `server/lib/f${i}.ts`);
		const entries = await overlap.computeOverlapEntries([
			{ id: "big", paths: big },
			{ id: "small", paths: ["server/routes/x.ts", "docs/a.md"] },
			{ id: "docs", paths: ["docs/a.md"] },
			{ id: "collapsed", paths: ["frontend/", "README.md"] },
			{ id: "readme", paths: ["README.md", "frontend/app.tsx"] },
		]);
		expect(entries).toEqual([
			{ path: "README.md", kind: "file", items: ["collapsed", "readme"] },
			{ path: "docs/a.md", kind: "file", items: ["docs", "small"] },
			{ path: "frontend/", kind: "dir", items: ["collapsed", "readme"] },
			{ path: "server/", kind: "dir", items: ["big", "small"] },
		]);
		// At 500 paths an item is still compared path by path.
		const exact = Array.from({ length: 500 }, (_, i) => `server/lib/f${i}.ts`);
		expect(
			await overlap.computeOverlapEntries([
				{ id: "exact", paths: exact },
				{ id: "small", paths: ["server/routes/x.ts"] },
			]),
		).toEqual([]);
	});

	test("past 2,000 changed paths only the top-level entries are stored", async () => {
		const a = await create(LEAD_A, "Mass rename", USER_A);
		const path = items.worktreePathOf(a) ?? "";
		const files: Record<string, string> = { "root.txt": "r\n" };
		for (let i = 0; i < shared.TEAM_CHANGED_PATHS_MAX + 1; i++) files[`many/f${i}.txt`] = `${i}\n`;
		await commitFiles(path, files, "many");
		const b = insertItem(LEAD_B, "Touch one", ["many/f7.txt"]);
		await overlap.runChangedPathsPass();
		expect(itemRow(a.id)?.changedPathsJson).toEqual(["many/", "root.txt"]);
		const entries = (await overlap.ensureProjectOverlaps(PROJECT)).entries;
		expect(entries).toEqual([{ path: "many/", kind: "dir", items: [a.id, b].sort() }]);
	});
});

describe("the background pass", () => {
	test("bounded to 50 items, resumes after the last one, skips unmoved heads", async () => {
		const calls = { opened: 0, head: 0, changed: 0 };
		overlap.setChangedPathsSourceForTests((worktree) => {
			calls.opened++;
			const head = worktree.endsWith("moved") ? "c".repeat(40) : "b".repeat(40);
			return {
				head: async () => {
					calls.head++;
					return head;
				},
				resolve: async () => "f".repeat(40),
				isAncestor: async () => false,
				changed: async () => {
					calls.changed++;
					return { head, mergeBase: "0".repeat(40), paths: ["common.ts"], collapsed: false };
				},
			};
		});
		const ids: string[] = [];
		for (let i = 0; i < 120; i++) {
			const resource = generateId();
			db.insert(narratorWorktreeResources)
				.values({
					id: resource,
					ownerNarratorId: LEAD_A,
					deviceId: "local",
					repositoryKey: "repository",
					worktreePath: join(temporary, `wt-${i}`),
					state: "ready",
					createRequestId: `req-${i}`,
				})
				.run();
			ids.push(
				insertItem(LEAD_A, `Item ${i}`, null, {
					worktreeResourceId: resource,
					createdAt: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString(),
				}),
			);
		}
		ids.sort();
		const first = await overlap.runChangedPathsPass();
		expect(first).toMatchObject({ looked: 50, updated: 50, wrapped: false });
		expect(overlap.overlapCursor()).toBe(ids[49] ?? null);
		const second = await overlap.runChangedPathsPass();
		expect(second).toMatchObject({ looked: 50, updated: 50, wrapped: false });
		expect(overlap.overlapCursor()).toBe(ids[99] ?? null);
		const third = await overlap.runChangedPathsPass();
		expect(third).toMatchObject({ looked: 20, updated: 20, wrapped: true });
		expect(overlap.overlapCursor()).toBeNull();
		// One git per item per pass.
		expect(calls).toEqual({ opened: 120, head: 120, changed: 120 });

		// Unmoved heads are looked at (one rev-parse) but not listed again.
		const fourth = await overlap.runChangedPathsPass();
		expect(fourth).toMatchObject({ looked: 50, updated: 0 });
		expect(calls.changed).toBe(120);

		// A worker's run ending puts its items first.
		const late = ids[110] as string;
		const worker = "x-worker";
		sqlite.run(
			`INSERT INTO narrators (id, type, title, parent_narrator_id, acl_root_narrator_id, created_at, updated_at)
			VALUES (?, 'subagent', 'w', ?, ?, ?, ?)`,
			[worker, LEAD_A, LEAD_A, NOW, NOW],
		);
		sqlite.run("UPDATE team_work_items SET worker_narrator_id = ? WHERE id = ?", [worker, late]);
		const resource = itemRow(late)?.worktreeResourceId as string;
		sqlite.run("UPDATE narrator_worktree_resources SET worktree_path = ? WHERE id = ?", [
			join(temporary, "wt-moved"),
			resource,
		]);
		overlap.refreshItemsOfWorker(worker);
		// A worker's run ending looks at its items only, not at 50 more of the sweep.
		const fifth = await overlap.runChangedPathsPass({ sweep: false });
		expect(fifth.looked).toBe(1);
		expect(overlap.overlapCursor()).toBe(ids[49] ?? null);
		expect(itemRow(late)?.changedPathsAtSha).toBe("c".repeat(40));
		// The overlap check looks at 100 of the 120 active items.
		const index = await overlap.ensureProjectOverlaps(PROJECT);
		expect(index.activeItems).toBe(shared.TEAM_OVERLAP_PROJECT_ITEMS);
		expect(index.capped).toBe(true);
		expect(index.entries).toEqual([{ path: "common.ts", kind: "file", items: expect.any(Array) }]);
		expect(index.entries[0]?.items).toHaveLength(shared.TEAM_OVERLAP_PROJECT_ITEMS);
	});

	test("git runs only through the hardened helper: an unhardened git reads nothing", async () => {
		const a = await create(LEAD_A, "Hardened", USER_A);
		await commitFiles(items.worktreePathOf(a) ?? "", { "h.ts": "h\n" }, "h");
		setGitHardeningProbeForTests(async () => false);
		const refused = await overlap.runChangedPathsPass();
		expect(refused).toMatchObject({ looked: 1, updated: 0, failed: 1 });
		expect(itemRow(a.id)?.changedPathsJson).toBeNull();
		setGitHardeningProbeForTests(null);
		expect(await overlap.runChangedPathsPass()).toMatchObject({ updated: 1 });
		expect(itemRow(a.id)?.changedPathsJson).toEqual(["h.ts"]);

		// The module spawns nothing itself: every git call is `team-git.ts`'s.
		const text = readFileSync(join(import.meta.dir, "..", "team-overlap.ts"), "utf8");
		for (const forbidden of ["safeSpawn", "Bun.spawn", "child_process", "gitService", "execRead"])
			expect(text).not.toContain(forbidden);
		expect(text).toContain("const git = teamGit(worktree);");
		expect(text).toContain("changed: (baseRef) => git.changedPaths(baseRef)");
		const gitText = readFileSync(join(import.meta.dir, "..", "team-git.ts"), "utf8");
		expect(gitText).toContain('["diff", "--name-only", "--no-renames", "-z", fork, head]');
	});
});

describe("team status section", () => {
	test("deterministic, bounded, and naming other teams only when allowed", async () => {
		const paths = Array.from({ length: 15 }, (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`);
		insertItem(LEAD_A, "A work", paths, {
			exclusiveKey: shared.TEAM_EXCLUSIVE_LOCK_KEY,
			state: "ready",
		});
		insertItem(LEAD_B, "B work", paths);
		const first = await readTeamStatus(LEAD_A, "en", { now: clockNow });
		overlap.invalidateProjectOverlaps(PROJECT);
		const second = await readTeamStatus(LEAD_A, "en", { now: clockNow });
		expect(first?.text).toBe(second?.text ?? "");
		const text = first?.text ?? "";
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(shared.TEAM_STATUS_MAX_BYTES);
		expect(text).toContain("Files your open work items share with other open work items: 15.");
		expect(text).toContain(`- src/file-00.ts: "A work"; another team's work item`);
		expect(text).not.toContain("B work");
		expect(text).toContain("- … and 5 more");
		expect(text).not.toContain("src/file-10.ts");
		expect(text).toContain(`Exclusive paths lock: held by your work item "A work"`);

		// Lead B reads Lead A (project-visible): named, in Chinese too.
		const zh = (await readTeamStatus(LEAD_B, "zh-CN", { now: clockNow }))?.text ?? "";
		expect(zh).toContain("同时改动的文件：15 处");
		expect(zh).toContain("team「Lead A」的「A work」");
		expect(zh).toContain("独占路径锁：由 team「Lead A」的工作项「A work」持有");

		// No overlap and no lock: no section at all.
		sqlite.run("DELETE FROM team_work_items");
		overlap.invalidateProjectOverlaps(PROJECT);
		const quiet = (await readTeamStatus(LEAD_A, "en", { now: clockNow }))?.text ?? "";
		expect(quiet).not.toContain("Files your open work items share");
		expect(quiet).not.toContain("Exclusive paths lock");
	});
});

describe("review round 1", () => {
	test("a landed item becomes merged: lock released, overlaps gone; squash merges are not noticed", async () => {
		setExclusivePaths(["drizzle/**"]);
		const landed = await create(LEAD_A, "Add a column", USER_A);
		const squashed = await create(LEAD_A, "Squash me", USER_A);
		const untouched = await create(LEAD_A, "Nothing yet", USER_A);
		const other = await create(LEAD_B, "Also the schema", USER_B);
		const landedPath = items.worktreePathOf(landed) ?? "";
		await commitFiles(landedPath, { "drizzle/0260.sql": "--\n", "shared.ts": "a\n" }, "a");
		await commitFiles(items.worktreePathOf(squashed) ?? "", { "squash.txt": "s\n" }, "s");
		await commitFiles(items.worktreePathOf(other) ?? "", { "shared.ts": "b\n" }, "b");
		await clearReview(LEAD_A, landed.id);
		await items.markReady({
			coordinatorId: LEAD_A,
			itemId: landed.id,
			actor: { kind: "agent", id: LEAD_A },
		});
		await overlap.runChangedPathsPass();
		expect(itemRow(landed.id)?.exclusiveKey).toBe(shared.TEAM_EXCLUSIVE_LOCK_KEY);
		expect((await call(USER_A, `/projects/${PROJECT}/team-overlaps`)).body.entries).toHaveLength(1);

		// The base takes the head (a merge that keeps it), and the squashed branch's content.
		const head = await git(["rev-parse", "HEAD"], landedPath);
		await git(["merge", "-q", "--ff-only", landed.branchName ?? ""]);
		await git(["merge", "-q", "--squash", squashed.branchName ?? ""]);
		await git(["-c", "user.name=T", "-c", "user.email=t@e.test", "commit", "-qm", "squash"]);
		const base = await git(["rev-parse", "main"]);

		// The landed item's head did not move: it is still noticed.
		const pass = await overlap.runChangedPathsPass();
		expect(pass.merged).toBe(1);
		const row = itemRow(landed.id);
		expect(row?.state).toBe("merged");
		expect(row?.exclusiveKey).toBeNull();
		expect(row?.changedPathsJson).toBeNull();
		expect(row?.updatedAt).not.toBe(landed.updatedAt);
		const kinds = eventsOf(landed.id).map((event) => event.kind);
		expect(kinds.slice(-2)).toEqual(["work.exclusive_released", "work.merged"]);
		expect(eventsOf(landed.id).at(-1)).toMatchObject({
			actorKind: "system",
			detail: { head, base, detectedBy: "ancestry" },
		});
		expect(overlap.exclusiveHolder(PROJECT)).toBeNull();
		clockNow += shared.TEAM_CHANGED_PATHS_INTERVAL_MS;
		await overlap.ensureProjectOverlaps(PROJECT);
		expect((await call(USER_A, `/projects/${PROJECT}/team-overlaps`)).body.entries).toEqual([]);
		// Documented limits: a squash merge never puts the head in the base; an item without
		// work is never "landed" although its head is the base's ancestor.
		expect(itemRow(squashed.id)?.state).toBe("queued");
		expect(itemRow(untouched.id)?.state).toBe("queued");
		expect(itemRow(other.id)?.state).toBe("queued");
	});

	test("the refusal names the limits of merge detection", async () => {
		setExclusivePaths(["drizzle/**"]);
		insertItem(LEAD_A, "Holder", ["drizzle/1.sql"], {
			exclusiveKey: shared.TEAM_EXCLUSIVE_LOCK_KEY,
			state: "ready",
		});
		const b = await create(LEAD_B, "Second", USER_B);
		await commitFiles(items.worktreePathOf(b) ?? "", { "drizzle/2.sql": "--\n" }, "b");
		await clearReview(LEAD_B, b.id);
		await expect(
			items.markReady({
				coordinatorId: LEAD_B,
				itemId: b.id,
				actor: { kind: "agent", id: LEAD_B },
			}),
		).rejects.toThrow(
			"a squash or rebase merge, or a base updated only on the remote, is not noticed",
		);
	});

	test("a coordinator a person stopped is told without being woken", async () => {
		sqlite.run("UPDATE narrators SET last_stop_reason = 'user_interrupt' WHERE id = ?", [LEAD_A]);
		sqlite.run("UPDATE narrators SET last_stop_reason = 'normal' WHERE id = ?", [LEAD_B]);
		insertItem(LEAD_A, "A one", ["x.ts"]);
		insertItem(LEAD_B, "B one", ["x.ts"]);
		await overlap.recordNewCrossTeamPairs(await overlap.ensureProjectOverlaps(PROJECT));
		await overlap.flushNotices();
		expect(notices.map(({ teamId, wake }) => ({ teamId, wake }))).toEqual([
			{ teamId: LEAD_A, wake: false },
			{ teamId: LEAD_B, wake: true },
		]);
	});

	test("pairing 100 items × 500 shared paths never blocks the event loop for long", async () => {
		const paths = Array.from({ length: 500 }, (_, j) => `src/d${j % 40}/f${j}.ts`);
		for (let i = 0; i < 100; i++) insertItem(i % 2 ? LEAD_A : LEAD_B, `Item ${i}`, paths);
		let last = performance.now();
		let longest = 0;
		let done = false;
		const tick = () => {
			const now = performance.now();
			longest = Math.max(longest, now - last);
			last = now;
			if (!done) setImmediate(tick);
		};
		setImmediate(tick);
		const index = await overlap.ensureProjectOverlaps(PROJECT);
		const first = await overlap.recordNewCrossTeamPairs(index);
		done = true;
		expect(index.entries).toHaveLength(500);
		// 2,500 cross-team pairs: 50 recorded, the rest on later passes.
		expect(first).toEqual({ recorded: overlap.NEW_PAIRS_PER_PASS, more: true });
		expect(longest).toBeLessThan(50);
	});

	test("pairs beyond the per-pass cap are recorded by the next pass", async () => {
		for (let i = 0; i < 8; i++) insertItem(LEAD_A, `A ${i}`, ["x.ts"]);
		for (let i = 0; i < 8; i++) insertItem(LEAD_B, `B ${i}`, ["x.ts"]);
		// 64 cross-team pairs.
		expect(
			await overlap.recordNewCrossTeamPairs(await overlap.ensureProjectOverlaps(PROJECT)),
		).toEqual({ recorded: 50, more: true });
		expect((await overlap.runChangedPathsPass()).newPairs).toBe(14);
		expect((await overlap.runChangedPathsPass()).newPairs).toBe(0);
	});

	test("a long path keeps the overlap event's `with`; the notice stays within its budget", async () => {
		const long = `${"deep/".repeat(600)}file.ts`;
		const a = insertItem(LEAD_A, "A long", [long]);
		for (let i = 0; i < 20; i++) insertItem(LEAD_B, `B ${i} ${"x".repeat(100)}`, [long]);
		await overlap.recordNewCrossTeamPairs(await overlap.ensureProjectOverlaps(PROJECT));
		const events = eventsOf(a).filter((event) => event.kind === "work.overlap");
		expect(events).toHaveLength(20);
		for (const event of events) {
			expect(typeof event.detail?.with).toBe("string");
			expect(String((event.detail?.paths as string[])[0]).length).toBeLessThanOrEqual(300);
		}
		await overlap.flushNotices();
		const toA = notices.find((notice) => notice.teamId === LEAD_A)?.text ?? "";
		expect(Buffer.byteLength(toA, "utf8")).toBeLessThanOrEqual(overlap.NOTICE_MAX_BYTES);
		expect(toA).toMatch(/… and \d+ more/);
	});

	test("an archived team leaves the overlaps and gives up its lock", async () => {
		insertItem(LEAD_A, "A one", ["x.ts"]);
		const held = insertItem(LEAD_B, "B one", ["x.ts"], {
			exclusiveKey: shared.TEAM_EXCLUSIVE_LOCK_KEY,
			state: "ready",
		});
		const before = await overlap.ensureProjectOverlaps(PROJECT);
		expect(before.entries).toHaveLength(1);
		sqlite.run("UPDATE narrators SET status = 'archived' WHERE id = ?", [LEAD_B]);
		sqlite.run("UPDATE project_teams SET status = 'archived' WHERE narrator_id = ?", [LEAD_B]);
		// The listener releases at once; the sweep is the backstop.
		expect(overlap.releaseLocksOfTeam(LEAD_B, "team_archived")).toBe(1);
		expect(itemRow(held)?.exclusiveKey).toBeNull();
		expect(eventsOf(held).at(-1)).toMatchObject({
			kind: "work.exclusive_released",
			actorKind: "system",
			detail: { key: shared.TEAM_EXCLUSIVE_LOCK_KEY, forced: false, reason: "team_archived" },
		});
		expect((await overlap.recordNewCrossTeamPairs(before)).recorded).toBe(0);
		clockNow += shared.TEAM_CHANGED_PATHS_INTERVAL_MS;
		expect((await overlap.ensureProjectOverlaps(PROJECT)).entries).toEqual([]);

		sqlite.run("UPDATE team_work_items SET exclusive_key = ? WHERE id = ?", [
			shared.TEAM_EXCLUSIVE_LOCK_KEY,
			held,
		]);
		await overlap.runChangedPathsPass();
		expect(itemRow(held)?.exclusiveKey).toBeNull();
	});

	test("the job's archive listener releases the lock", async () => {
		const { eventBus } = await import("../../../lib/event-bus");
		const held = insertItem(LEAD_B, "B one", ["x.ts"], {
			exclusiveKey: shared.TEAM_EXCLUSIVE_LOCK_KEY,
			state: "ready",
		});
		const stop = overlap.startTeamOverlapJob();
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			eventBus.emit({ type: "narrator:status_changed", narratorId: LEAD_B, status: "archived" });
			expect(itemRow(held)?.exclusiveKey).toBeNull();
		} finally {
			stop();
		}
	});

	test("a coordinator whose owner left the project is not told other teams' names", async () => {
		const holder = insertItem(LEAD_A, "Project-visible work", ["drizzle/1.sql"], {
			exclusiveKey: shared.TEAM_EXCLUSIVE_LOCK_KEY,
			state: "ready",
		});
		sqlite.run("UPDATE narrators SET owner_user_id = ? WHERE id = ?", [OUTSIDER, LEAD_C]);
		const row = overlap.exclusiveHolder(PROJECT) as NonNullable<
			ReturnType<typeof overlap.exclusiveHolder>
		>;
		expect(row.id).toBe(holder);
		expect(await overlap.describeHolderFor(LEAD_C, row)).toContain(`team "Lead A"`);
		sqlite.run("DELETE FROM acl_grants WHERE principal_id = ?", [OUTSIDER]);
		expect(await overlap.describeHolderFor(LEAD_C, row)).toBe(
			"a work item of another team (ready)",
		);
	});

	test("a forced release tells the holder's coordinator without waking it", async () => {
		const held = insertItem(LEAD_A, "Holder", ["drizzle/1.sql"], {
			exclusiveKey: shared.TEAM_EXCLUSIVE_LOCK_KEY,
			state: "ready",
		});
		const released = await overlap.forceReleaseExclusiveLock({
			projectId: PROJECT,
			workItemId: held,
			userId: MANAGER,
			reason: "unblock B",
		});
		expect(released).toEqual({ released: true, key: shared.TEAM_EXCLUSIVE_LOCK_KEY });
		expect(notices).toEqual([
			{
				teamId: LEAD_A,
				wake: false,
				text: expect.stringContaining(
					`released the exclusive paths lock your work item "Holder" held (unblock B)`,
				),
			},
		]);
	});

	test("directory and bare-name exclusive paths", async () => {
		for (const pattern of ["drizzle/", "drizzle", "./drizzle/"]) {
			expect(overlap.pathTouchesGlob("drizzle/0001.sql", pattern)).toBe(true);
			expect(overlap.pathTouchesGlob("drizzle/meta/_journal.json", pattern)).toBe(true);
			expect(overlap.pathTouchesGlob("drizzle-postgres/0001.sql", pattern)).toBe(false);
			expect(overlap.pathTouchesGlob("drizzle/", pattern)).toBe(true);
			expect(overlap.pathTouchesGlob("docs/", pattern)).toBe(false);
		}
		expect(overlap.pathTouchesGlob("server/db/schema.ts", "server/db/schema.ts")).toBe(true);
		expect(overlap.pathTouchesGlob("server/", "server/db/schema.ts")).toBe(true);
		expect(overlap.pathTouchesGlob("server/db/schema.ts.bak", "server/db/schema.ts")).toBe(false);
		expect(overlap.exclusivePathsOf({ teams: { exclusivePaths: ["drizzle/", "./x.ts"] } })).toEqual(
			["drizzle/**", "x.ts"],
		);
		const { projectChapterSettingsSchema } = await import("../../../lib/validators");
		const parsed = projectChapterSettingsSchema.parse({
			teams: { exclusivePaths: ["drizzle/", "drizzle-postgres/**", "server/db/schema.ts"] },
		});
		expect(parsed.teams?.exclusivePaths).toEqual([
			"drizzle/**",
			"drizzle-postgres/**",
			"server/db/schema.ts",
		]);
		expect(
			projectChapterSettingsSchema.safeParse({ teams: { exclusivePaths: ["/"] } }).success,
		).toBe(false);
	});

	test("a pass stops at its deadline and resumes where it stopped", async () => {
		const looked: string[] = [];
		overlap.setChangedPathsSourceForTests((worktree) => ({
			head: async () => {
				looked.push(worktree);
				clockNow += 25_000;
				return "b".repeat(40);
			},
			resolve: async () => "f".repeat(40),
			isAncestor: async () => false,
			changed: async () => ({
				head: "b".repeat(40),
				mergeBase: "0".repeat(40),
				paths: ["x.ts"],
				collapsed: false,
			}),
		}));
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) {
			const resource = generateId();
			db.insert(narratorWorktreeResources)
				.values({
					id: resource,
					ownerNarratorId: LEAD_A,
					deviceId: "local",
					repositoryKey: "repository",
					worktreePath: join(temporary, `wt-${i}`),
					state: "ready",
					createRequestId: `req-d-${i}`,
				})
				.run();
			ids.push(insertItem(LEAD_A, `Item ${i}`, null, { worktreeResourceId: resource }));
		}
		ids.sort();
		const first = await overlap.runChangedPathsPass();
		expect(first).toMatchObject({ looked: 3, deadline: true, wrapped: false });
		expect(overlap.overlapCursor()).toBe(ids[2] ?? null);
		const second = await overlap.runChangedPathsPass();
		expect(second).toMatchObject({ looked: 3, deadline: false, wrapped: true });
		expect(new Set(looked).size).toBe(6);

		// A git call that never answers: the pass gives up at the deadline instead of waiting.
		overlap.resetOverlapStateForTests();
		overlap.setChangedPathsSourceForTests(() => ({
			head: () => new Promise<string | null>(() => {}),
			resolve: async () => null,
			isAncestor: async () => false,
			changed: async () => null,
		}));
		overlap.setOverlapSeamsForTests({ deadlineMs: 100 });
		try {
			const hung = await overlap.runChangedPathsPass();
			expect(hung).toMatchObject({ looked: 1, failed: 1, deadline: true });
		} finally {
			overlap.setOverlapSeamsForTests({ deadlineMs: null });
		}
	});
});

describe("review round 2: merge detection without false positives", () => {
	const ready = async (lead: string, itemId: string) => {
		await clearReview(lead, itemId);
		return items.markReady({ coordinatorId: lead, itemId, actor: { kind: "agent", id: lead } });
	};

	test("reviewer probe: fast-forward, reset to base, detached checkout, mid-work landing stay open", async () => {
		const ff = await create(LEAD_A, "FF only", USER_A);
		const reset = await create(LEAD_A, "Reset", USER_A);
		const detached = await create(LEAD_A, "Detached", USER_A);
		const busy = await create(LEAD_A, "Busy", USER_A);
		await commitFiles(items.worktreePathOf(reset) ?? "", { "r.txt": "r\n" }, "r");
		await commitFiles(items.worktreePathOf(busy) ?? "", { "busy.txt": "b\n" }, "b");
		sqlite.run("UPDATE team_work_items SET exclusive_key = ? WHERE id = ?", [
			shared.TEAM_EXCLUSIVE_LOCK_KEY,
			busy.id,
		]);
		await overlap.runChangedPathsPass();
		// The base moves on.
		await commitFiles(source, { "base-moved.txt": "m\n" }, "base moves");
		await git(["merge", "-q", "--ff-only", "main"], items.worktreePathOf(ff) ?? "");
		await git(["reset", "-q", "--hard", "main"], items.worktreePathOf(reset) ?? "");
		await git(["checkout", "-q", "--detach", "main"], items.worktreePathOf(detached) ?? "");
		// busy: its in-progress head lands on the base while the worker continues.
		await git(["merge", "-q", "--no-ff", "-m", "land busy", busy.branchName ?? ""]);
		sqlite.run("UPDATE team_work_items SET state = 'in_progress' WHERE id = ?", [busy.id]);
		const pass = await overlap.runChangedPathsPass();
		expect(pass.merged).toBe(0);
		expect([ff, reset, detached, busy].map((it) => itemRow(it.id)?.state)).toEqual([
			"queued",
			"queued",
			"queued",
			"in_progress",
		]);
		expect(itemRow(busy.id)?.exclusiveKey).toBe(shared.TEAM_EXCLUSIVE_LOCK_KEY);
	});

	test("a ready item whose worktree was reset or detached later stays ready", async () => {
		const reset = await create(LEAD_A, "Reset after ready", USER_A);
		const detached = await create(LEAD_A, "Detached after ready", USER_A);
		for (const item of [reset, detached]) {
			await commitFiles(items.worktreePathOf(item) ?? "", { [`${item.id}.txt`]: "x\n" }, "x");
			await ready(LEAD_A, item.id);
		}
		await commitFiles(source, { "base-moved.txt": "m\n" }, "base moves");
		await git(["reset", "-q", "--hard", "main"], items.worktreePathOf(reset) ?? "");
		await git(["checkout", "-q", "--detach", "main"], items.worktreePathOf(detached) ?? "");
		expect((await overlap.runChangedPathsPass()).merged).toBe(0);
		expect(itemRow(reset.id)?.state).toBe("ready");
		expect(itemRow(detached.id)?.state).toBe("ready");
		// The reset branch no longer holds the ready head: flagged in the team status (the item
		// keeps that head until cancelled); a detached worktree leaves the branch as it was.
		const status = (await readTeamStatus(LEAD_A, "en", { now: clockNow }))?.text ?? "";
		expect(status).toContain(
			"Ready work items whose branch no longer contains the commit recorded when they were marked ready (reset or rewritten): Reset after ready.",
		);
		expect(itemRow(reset.id)?.headSha).not.toBe(await git(["rev-parse", "main"]));
	});

	test("a ready item with no changes at ready is never auto-merged", async () => {
		const empty = await create(LEAD_A, "No changes", USER_A);
		const marked = await ready(LEAD_A, empty.id);
		expect(marked.item.state).toBe("ready");
		// Its head is the base's own commit: an ancestor, but nothing landed.
		expect((await overlap.runChangedPathsPass()).merged).toBe(0);
		expect(itemRow(empty.id)?.state).toBe("ready");
	});

	test("a genuinely landed ready item is merged; a commit after ready keeps it ready", async () => {
		setExclusivePaths(["drizzle/**"]);
		const landed = await create(LEAD_A, "Landed", USER_A);
		const later = await create(LEAD_B, "More after ready", USER_B);
		await commitFiles(items.worktreePathOf(landed) ?? "", { "drizzle/1.sql": "--\n" }, "a");
		await commitFiles(items.worktreePathOf(later) ?? "", { "later.txt": "1\n" }, "b");
		const landedReady = await ready(LEAD_A, landed.id);
		expect(landedReady.item.exclusiveKey).toBe(shared.TEAM_EXCLUSIVE_LOCK_KEY);
		const laterReady = await ready(LEAD_B, later.id);
		// The ready facts are kept with the event, never derived again.
		expect(eventsOf(landed.id).at(-1)).toMatchObject({
			kind: "work.ready",
			detail: { head: landedReady.item.headSha, changedPathCount: 1 },
		});
		// Both ready heads land on the base; the second item's worker commits once more.
		await git(["merge", "-q", "--no-ff", "-m", "land", landed.branchName ?? ""]);
		await git(["merge", "-q", "--no-ff", "-m", "land 2", later.branchName ?? ""]);
		await commitFiles(items.worktreePathOf(later) ?? "", { "later.txt": "2\n" }, "after ready");
		const pass = await overlap.runChangedPathsPass();
		expect(pass.merged).toBe(1);
		expect(itemRow(landed.id)?.state).toBe("merged");
		expect(itemRow(landed.id)?.exclusiveKey).toBeNull();
		expect(eventsOf(landed.id).at(-1)).toMatchObject({
			kind: "work.merged",
			detail: { head: landedReady.item.headSha, detectedBy: "ancestry" },
		});
		expect(itemRow(later.id)?.state).toBe("ready");
		expect(laterReady.item.headSha).not.toBeNull();
	});

	test("not while the worker runs, and not when the item changed in between", async () => {
		const item = await create(LEAD_A, "Worker busy", USER_A);
		await commitFiles(items.worktreePathOf(item) ?? "", { "w.txt": "w\n" }, "w");
		sqlite.run(
			`INSERT INTO narrators (id, type, title, status, parent_narrator_id, acl_root_narrator_id, created_at, updated_at)
			VALUES ('x-runner', 'subagent', 'w', 'working', ?, ?, ?, ?)`,
			[LEAD_A, LEAD_A, NOW, NOW],
		);
		const marked = await ready(LEAD_A, item.id);
		sqlite.run("UPDATE team_work_items SET worker_narrator_id = 'x-runner' WHERE id = ?", [
			item.id,
		]);
		await git(["merge", "-q", "--no-ff", "-m", "land", item.branchName ?? ""]);
		expect((await overlap.runChangedPathsPass()).merged).toBe(0);
		expect(itemRow(item.id)?.state).toBe("ready");
		const row = itemRow(item.id) as NonNullable<ReturnType<typeof itemRow>>;
		expect(
			items.markMergedByAncestry({
				itemId: item.id,
				head: marked.item.headSha ?? "",
				base: "b".repeat(40),
				expectedHeadSha: row.headSha,
				expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
			}),
		).toBe(false);
		sqlite.run("UPDATE narrators SET status = 'idle' WHERE id = 'x-runner'");
		expect((await overlap.runChangedPathsPass()).merged).toBe(1);
	});

	test("a hung item is skipped past and backed off; the sweep progresses", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) {
			const resource = generateId();
			db.insert(narratorWorktreeResources)
				.values({
					id: resource,
					ownerNarratorId: LEAD_A,
					deviceId: "local",
					repositoryKey: "repository",
					worktreePath: join(temporary, `wt-h-${i}`),
					state: "ready",
					createRequestId: `req-h-${i}`,
				})
				.run();
			ids.push(insertItem(LEAD_A, `Item ${i}`, null, { worktreeResourceId: resource }));
		}
		ids.sort();
		const hungPath = items.worktreePathOf({
			worktreeResourceId: itemRow(ids[0] ?? "")?.worktreeResourceId ?? null,
		});
		const heads: string[] = [];
		overlap.setChangedPathsSourceForTests((worktree) => ({
			head: () => {
				heads.push(worktree);
				return worktree === hungPath
					? new Promise<string | null>(() => {})
					: Promise.resolve("b".repeat(40));
			},
			resolve: async () => "f".repeat(40),
			isAncestor: async () => false,
			changed: async () => ({
				head: "b".repeat(40),
				mergeBase: "0".repeat(40),
				paths: ["x.ts"],
				collapsed: false,
			}),
		}));
		overlap.setOverlapSeamsForTests({ deadlineMs: 100 });
		try {
			const first = await overlap.runChangedPathsPass();
			expect(first).toMatchObject({ looked: 1, failed: 1, deadline: true });
			// The cursor is past the hung item, so the next sweep goes on.
			expect(overlap.overlapCursor()).toBe(ids[0] ?? null);
			const second = await overlap.runChangedPathsPass();
			expect(second).toMatchObject({ looked: 3, updated: 3, wrapped: true });
			// Starting over, the hung item is backed off instead of hanging the pass again.
			const third = await overlap.runChangedPathsPass();
			expect(third).toMatchObject({ deadline: false, failed: 0 });
			expect(heads.filter((path) => path === hungPath)).toHaveLength(1);
		} finally {
			overlap.setOverlapSeamsForTests({ deadlineMs: null });
		}
	});

	test("a timer tick during a pending-only pass still gets a sweep", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const looked: string[] = [];
		overlap.setChangedPathsSourceForTests((worktree) => ({
			head: async () => {
				looked.push(worktree);
				if (worktree.endsWith("wt-p-0")) await gate;
				return "b".repeat(40);
			},
			resolve: async () => "f".repeat(40),
			isAncestor: async () => false,
			changed: async () => null,
		}));
		for (let i = 0; i < 3; i++) {
			const resource = generateId();
			db.insert(narratorWorktreeResources)
				.values({
					id: resource,
					ownerNarratorId: LEAD_A,
					deviceId: "local",
					repositoryKey: "repository",
					worktreePath: join(temporary, `wt-p-${i}`),
					state: "ready",
					createRequestId: `req-p-${i}`,
				})
				.run();
			insertItem(LEAD_A, `Item ${i}`, null, {
				worktreeResourceId: resource,
				workerNarratorId: i === 0 ? null : null,
			});
		}
		sqlite.run(
			`INSERT INTO narrators (id, type, title, parent_narrator_id, acl_root_narrator_id, created_at, updated_at)
			VALUES ('x-pending-worker', 'subagent', 'w', ?, ?, ?, ?)`,
			[LEAD_A, LEAD_A, NOW, NOW],
		);
		sqlite.run(
			`UPDATE team_work_items SET worker_narrator_id = 'x-pending-worker'
			WHERE worktree_resource_id = (SELECT id FROM narrator_worktree_resources WHERE worktree_path LIKE '%wt-p-0')`,
		);
		overlap.refreshItemsOfWorker("x-pending-worker");
		const tick = overlap.runChangedPathsPass();
		release();
		const shared1 = await tick;
		expect(shared1.looked).toBe(1);
		// The sweep the tick asked for runs right after.
		for (let i = 0; i < 50 && looked.length < 4; i++) await new Promise((r) => setTimeout(r, 10));
		expect(looked.length).toBe(4);
	});

	test("markReady refuses when the team was archived meanwhile", async () => {
		const item = await create(LEAD_A, "Archive race", USER_A);
		await commitFiles(items.worktreePathOf(item) ?? "", { "a.txt": "a\n" }, "a");
		await clearReview(LEAD_A, item.id);
		overlap.setChangedPathsSourceForTests(() => ({
			head: async () => null,
			resolve: async () => null,
			isAncestor: async () => false,
			changed: async () => {
				sqlite.run("UPDATE project_teams SET status = 'archived' WHERE narrator_id = ?", [LEAD_A]);
				return {
					head: "b".repeat(40),
					mergeBase: "0".repeat(40),
					paths: ["a.txt"],
					collapsed: false,
				};
			},
		}));
		await expect(
			items.markReady({
				coordinatorId: LEAD_A,
				itemId: item.id,
				actor: { kind: "agent", id: LEAD_A },
			}),
		).rejects.toMatchObject({ code: "TEAM_ARCHIVED" });
		expect(itemRow(item.id)?.state).toBe("in_review");
	});

	test("exclusive paths that match everything are refused", async () => {
		const { projectChapterSettingsSchema } = await import("../../../lib/validators");
		for (const broad of ["**", "**/", "*", "**/*", "*/**", "./**", "**/**", "*/"])
			expect(
				projectChapterSettingsSchema.safeParse({ teams: { exclusivePaths: [broad] } }).success,
			).toBe(false);
		expect(overlap.exclusivePathsOf({ teams: { exclusivePaths: ["*", "**/*", "a/**"] } })).toEqual([
			"a/**",
		]);
	});

	test("an item that merely started late ends the pass; the next pass starts with it", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const resource = generateId();
			db.insert(narratorWorktreeResources)
				.values({
					id: resource,
					ownerNarratorId: LEAD_A,
					deviceId: "local",
					repositoryKey: "repository",
					worktreePath: join(temporary, `wt-l-${i}`),
					state: "ready",
					createRequestId: `req-l-${i}`,
				})
				.run();
			ids.push(insertItem(LEAD_A, `Item ${i}`, null, { worktreeResourceId: resource }));
		}
		ids.sort();
		const pathOf = (id: string) =>
			items.worktreePathOf({ worktreeResourceId: itemRow(id)?.worktreeResourceId ?? null });
		const slow = pathOf(ids[0] ?? "");
		const hung = pathOf(ids[1] ?? "");
		let slowCalls = 0;
		const hungCalls: number[] = [];
		overlap.setChangedPathsSourceForTests((worktree) => ({
			head: () => {
				if (worktree === slow && slowCalls++ === 0) clockNow += 900;
				if (worktree === hung) {
					hungCalls.push(clockNow);
					return new Promise<string | null>(() => {});
				}
				return Promise.resolve("b".repeat(40));
			},
			resolve: async () => "f".repeat(40),
			isAncestor: async () => false,
			changed: async () => ({
				head: "b".repeat(40),
				mergeBase: "0".repeat(40),
				paths: ["x.ts"],
				collapsed: false,
			}),
		}));
		overlap.setOverlapSeamsForTests({ deadlineMs: 1000 });
		try {
			// The first item used 900 of 1,000 ms; the second starts with 100 ms left and times
			// out: not counted, not backed off, and the cursor stays before it.
			const first = await overlap.runChangedPathsPass();
			expect(first).toMatchObject({ looked: 1, failed: 0, deadline: true });
			expect(overlap.overlapCursor()).toBe(ids[0] ?? null);
			// The next pass starts with it and gives it the whole budget: now it is hung.
			const second = await overlap.runChangedPathsPass();
			expect(second).toMatchObject({ looked: 1, failed: 1, deadline: true });
			expect(overlap.overlapCursor()).toBe(ids[1] ?? null);
			expect(hungCalls).toHaveLength(2);
			// Backed off: the sweep goes on without it.
			const third = await overlap.runChangedPathsPass();
			expect(third).toMatchObject({ looked: 1, failed: 0, deadline: false, wrapped: true });
			const fourth = await overlap.runChangedPathsPass();
			expect(fourth).toMatchObject({ deadline: false });
			expect(hungCalls).toHaveLength(2);
		} finally {
			overlap.setOverlapSeamsForTests({ deadlineMs: null });
		}
	});
});
