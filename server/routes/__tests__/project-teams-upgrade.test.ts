/**
 * Turning an existing session into a team coordinator, and disbanding a team while keeping its
 * session (`teams/team-conversion.ts`), through `/projects/:projectId/teams`:
 *
 *  - an upgrade keeps the session's id, messages and audiences, and writes the team row, the
 *    `team` trait, a `team.created` event (`fromSession`) and the pinned project in one go;
 *  - every refusal has its own code, checked before anything is written, and a failed team insert
 *    leaves the trait as it was; a concurrent traits writer cannot drop the trait;
 *  - subagents already spawned belong to the team at once, and the IM memo follows both ways;
 *  - a disband is refused while work is live or the coordinator busy, deletes the row with its
 *    work items and events, removes the trait and keeps the conversation; each change tells the
 *    session once; upgrade → disband → upgrade works.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-team-upgrade-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectTeamRoutes } = await import("../project-teams");
const { db } = await import("../../db");
const { and, eq } = await import("drizzle-orm");
const {
	aclGrants,
	narratorMessageRefs,
	narrators,
	projects,
	projectTeams,
	teamWorkEvents,
	teamWorkItems,
	users,
} = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { narratorTraitsLock } = await import("../../lib/async-mutex");
const { appendRuntimePolicyTrait } = await import("../../lib/runtime-policy-trait");
const { safeSpawn } = await import("../../lib/spawn");
const { narratorService } = await import("../../services/narrator-service");
const { teamIdOfNarrator } = await import("../../services/teams/team-membership");
const { isTeamSessionCached, forgetTeamSessions } = await import(
	"../../services/teams/team-session-memo"
);
const {
	teamConversionNoteId,
	teamConversionTestHooks,
	upgradeSessionToTeam,
	TEAM_DISBAND_NOTE_SOURCE,
	TEAM_UPGRADE_NOTE_SOURCE,
} = await import("../../services/teams/team-conversion");
const { narratorPersistence } = await import("../../services/narrator-persistence");
const { narratorStore } = await import("../../services/narrator-store");
const { listAllRecentTabs, upsertRecentTab } = await import("../../services/recent-tabs-service");
const {
	hasTrailingInjectionRow,
	resolveContinuationTail,
	resolveRetryTarget,
	rewindHistoryForRetry,
} = await import("../../services/narrator-session");
const { TEAM_STATUS_SOURCE, writeTeamStatusAtPass } = await import(
	"../../services/teams/team-status"
);

const OWNER = "upgrade-owner";
const MEMBER = "upgrade-member";
const OUTSIDER = "upgrade-outsider";

const repo = join(testHome, "repo");
const plainDir = join(testHome, "not-git");
let projectId: string;
let otherProjectId: string;

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
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(
				JSON.stringify({ error: error.message, code: error.code, details: error.details }),
				{ status: error.statusCode, headers: { "content-type": "application/json" } },
			);
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/projects", projectTeamRoutes);
	return app;
}

async function call(
	userId: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await appAs(userId).request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const upgrade = (userId: string, body: Record<string, unknown>, project = projectId) =>
	call(userId, `/projects/${project}/teams`, body);
const disband = (userId: string, teamId: string) =>
	call(userId, `/projects/${projectId}/teams/${teamId}/disband`);

async function git(...args: string[]) {
	const result = await safeSpawn({
		cmd: ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
		cwd: repo,
		timeout: 10_000,
		maxOutputBytes: 64 * 1024,
	});
	if (result.exitCode) throw new Error(result.stderr);
}

async function session(
	title: string | undefined,
	extra: Parameters<typeof narratorService.create>[0] = {},
): Promise<string> {
	const created = await narratorService.create({
		title,
		cwd: repo,
		contextProjectId: projectId,
		ownerUserId: OWNER,
		visibility: "project",
		writeAudience: "project",
		...extra,
	});
	await narratorService.persistDisplayMessage(created.id, `hello from ${title ?? "untitled"}`);
	return created.id;
}

async function row(id: string) {
	const found = await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
	if (!found) throw new Error(`missing narrator ${id}`);
	return found;
}

async function refCount(id: string) {
	return (
		await db
			.select({ id: narratorMessageRefs.messageId })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, id))
	).length;
}

async function notes(id: string, source: string) {
	const rows = await narratorService.getModelHistorySinceLastCompact(id);
	return rows.filter(
		(message) =>
			Array.isArray(message.contentJson) &&
			(message.contentJson as Array<{ type?: string; source?: string }>).some(
				(block) => block.type === "system_injection" && block.source === source,
			),
	);
}

beforeAll(async () => {
	mkdirSync(repo, { recursive: true });
	mkdirSync(plainDir, { recursive: true });
	await git("init", "-q", "-b", "trunk");
	await git("commit", "-q", "--allow-empty", "-m", "initial");
	const now = new Date().toISOString();
	for (const id of [OWNER, MEMBER, OUTSIDER]) {
		await db.insert(users).values({
			id,
			username: `${id}-${Date.now()}`,
			passwordHash: "x",
			role: "user",
			createdAt: now,
		});
	}
	projectId = generateId();
	otherProjectId = generateId();
	for (const [id, gitPath] of [
		[projectId, repo],
		[otherProjectId, join(testHome, "elsewhere")],
	] as const) {
		await db.insert(projects).values({
			id,
			name: `project ${id}`,
			gitPath,
			defaultBranch: "trunk",
			ownerUserId: OWNER,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: id,
			principalType: "user",
			principalId: MEMBER,
			capability: "write",
			createdAt: now,
		});
	}
});

describe("turning a session into a team", () => {
	test("keeps the session and writes the row, the trait, the event and the pinned project", async () => {
		const id = await session("Feature work", { contextProjectId: null });
		const before = await row(id);
		const refsBefore = await refCount(id);
		expect(isTeamSessionCached(id)).toBe(false);

		const response = await upgrade(OWNER, { fromNarratorId: id, brief: "Keep it small." });
		expect(response.status).toBe(201);
		expect(response.body).toMatchObject({
			id,
			projectId,
			name: "Feature work",
			baseBranch: "trunk",
			status: "active",
			access: "write",
			brief: "Keep it small.",
			createdBy: OWNER,
		});

		const after = await row(id);
		expect(after.traits).toContain("team");
		expect(after.title).toBe("Feature work");
		expect(after.contextProjectId).toBe(projectId);
		expect(after.visibility).toBe(before.visibility);
		expect(after.writeAudience).toBe(before.writeAudience);
		expect(after.ownerUserId).toBe(OWNER);
		expect(after.cwd).toBe(before.cwd);
		// The conversation is kept; the note is the only row added.
		expect(await refCount(id)).toBe(refsBefore + 1);
		const team = await db.query.projectTeams.findFirst({ where: eq(projectTeams.narratorId, id) });
		expect(team?.projectId).toBe(projectId);
		const events = await db.query.teamWorkEvents.findMany({
			where: eq(teamWorkEvents.teamId, id),
		});
		expect(events.map((event) => [event.kind, event.actorId, event.detailJson])).toEqual([
			["team.created", OWNER, { baseBranch: "trunk", fromSession: true }],
		]);
		// The memo cached "not a team" and was told.
		expect(isTeamSessionCached(id)).toBe(true);

		// The note: written once, under its deterministic id, naming the real directory.
		const written = await notes(id, TEAM_UPGRADE_NOTE_SOURCE);
		expect(written.map((note) => note.id)).toEqual([
			teamConversionNoteId(id, "upgrade", team?.createdAt ?? ""),
		]);
		const text = JSON.stringify(written[0]?.contentJson);
		expect(text).toContain("Feature work");
		expect(text).toContain(repo);
		expect(text).toContain("main checkout");
	});

	test("a new name renames the session; the default is the title", async () => {
		const id = await session("Old title");
		const response = await upgrade(OWNER, { fromNarratorId: id, name: "  Renamed team  " });
		expect(response.status).toBe(201);
		expect(response.body.name).toBe("Renamed team");
		expect((await row(id)).title).toBe("Renamed team");
	});

	test("a linked worktree of the project is allowed, and the note names it", async () => {
		const worktree = join(testHome, "linked-worktree");
		await git("worktree", "add", "-q", "-b", "feature/linked", worktree);
		const id = await session("In a worktree", { cwd: worktree });
		const response = await upgrade(OWNER, { fromNarratorId: id });
		expect(response.status).toBe(201);
		const text = JSON.stringify((await notes(id, TEAM_UPGRADE_NOTE_SOURCE))[0]?.contentJson);
		expect(text).toContain(worktree);
		expect(text).toContain("other than its main checkout");
	});

	test("a session pinned here but working in another repository is refused", async () => {
		const elsewhere = join(testHome, "other-repo");
		mkdirSync(elsewhere, { recursive: true });
		await git("init", "-q", elsewhere);
		const id = await session("Elsewhere", { cwd: elsewhere });
		const response = await upgrade(OWNER, { fromNarratorId: id });
		expect(response.status).toBe(409);
		expect(response.body.code).toBe("TEAM_SESSION_OTHER_PROJECT");
		expect(parseTraitsOf(await row(id))).not.toContain("team");
	});

	test("subagents already spawned join the team at once", async () => {
		const id = await session("With helpers");
		const subagentId = generateId();
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: subagentId,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: id,
			aclRootNarratorId: id,
			cwd: repo,
			createdAt: now,
			updatedAt: now,
		});
		expect(isTeamSessionCached(subagentId)).toBe(false);
		expect((await upgrade(OWNER, { fromNarratorId: id })).status).toBe(201);
		expect(teamIdOfNarrator(subagentId)).toBe(id);
		expect(isTeamSessionCached(subagentId)).toBe(true);
	});

	test("the body is strict: audiences are refused", async () => {
		const id = await session("Strict");
		for (const body of [
			{ fromNarratorId: id, visibility: "public" },
			{ fromNarratorId: id, writeAudience: "public" },
			{ fromNarratorId: id, name: "" },
			{ fromNarratorId: id, extra: 1 },
			{ fromNarratorId: "" },
		]) {
			expect((await upgrade(OWNER, body)).status).toBe(400);
		}
		expect(parseTraitsOf(await row(id))).not.toContain("team");
	});

	test("each refusal has its own code and writes nothing", async () => {
		const expectRefused = async (
			id: string,
			status: number,
			code: string | null,
			userId = OWNER,
			project = projectId,
		) => {
			const response = await upgrade(userId, { fromNarratorId: id }, project);
			expect(response.status).toBe(status);
			if (code) expect(response.body.code).toBe(code);
			expect(parseTraitsOf(await row(id))).not.toContain("team");
			expect(
				await db.query.projectTeams.findFirst({ where: eq(projectTeams.narratorId, id) }),
			).toBeUndefined();
			return response;
		};
		const plain = await session("Plain");
		await expectRefused(plain, 404, null, OUTSIDER);
		// A writer of the session who is not its owner.
		await expectRefused(plain, 403, null, MEMBER);
		await expectRefused(plain, 409, "TEAM_SESSION_OTHER_PROJECT", OWNER, otherProjectId);

		const bot = await session("Bot", { kind: "bot" });
		const botRefusal = await expectRefused(bot, 409, "TEAM_SESSION_KIND_UNSUPPORTED");
		expect(botRefusal.body.details).toEqual({ reason: "bot" });
		for (const trait of ["scheduled", "ask-in-passing", "modeltrace", "knowledge-steward"] as const)
			await expectRefused(
				await session(`Kind ${trait}`, { extraTraits: [trait] }),
				409,
				"TEAM_SESSION_KIND_UNSUPPORTED",
			);
		const setup = await session("Setup", { kind: "setup" });
		await expectRefused(setup, 409, "TEAM_SESSION_KIND_UNSUPPORTED");

		const subagentId = generateId();
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: subagentId,
			type: "subagent",
			variant: "subagent:general",
			aclRootNarratorId: plain,
			parentNarratorId: plain,
			cwd: repo,
			contextProjectId: projectId,
			ownerUserId: OWNER,
			createdAt: now,
			updatedAt: now,
		});
		await expectRefused(subagentId, 409, "TEAM_SESSION_KIND_UNSUPPORTED");

		const ceiling = await session("No delegation");
		await db
			.update(narrators)
			.set({ traits: appendRuntimePolicyTrait([], { version: 1, deny: ["spawnAgent"] }) })
			.where(eq(narrators.id, ceiling));
		const ceilingRefusal = await expectRefused(ceiling, 409, "TEAM_SESSION_KIND_UNSUPPORTED");
		expect(ceilingRefusal.body.details).toEqual({ reason: "cannot-start-subagents" });

		const archived = await session("Archived");
		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, archived));
		await expectRefused(archived, 409, "TEAM_SESSION_ARCHIVED");

		for (const status of ["working", "waiting"] as const) {
			const busy = await session(`Busy ${status}`);
			await db.update(narrators).set({ status }).where(eq(narrators.id, busy));
			await expectRefused(busy, 409, "NARRATOR_EXECUTION_BUSY");
		}

		const notGit = await session("Not git", { cwd: plainDir });
		await expectRefused(notGit, 409, "TEAM_WORKSPACE_UNAVAILABLE");

		const untitled = await session(undefined);
		await db.update(narrators).set({ title: null }).where(eq(narrators.id, untitled));
		await expectRefused(untitled, 400, "TEAM_NAME_INVALID");
		const long = await session("x".repeat(150));
		await expectRefused(long, 400, "TEAM_NAME_INVALID");
		// A name given in the body makes the long title usable.
		expect((await upgrade(OWNER, { fromNarratorId: long, name: "Short" })).status).toBe(201);

		const already = await session("Already");
		expect((await upgrade(OWNER, { fromNarratorId: already })).status).toBe(201);
		const again = await upgrade(OWNER, { fromNarratorId: already });
		expect(again.status).toBe(409);
		expect(again.body.code).toBe("TEAM_ALREADY");
	});

	test("a team row that cannot be written leaves the trait as it was", async () => {
		const id = await session("Atomic upgrade");
		// Over the 4 KB column check: the route refuses it, so go to the service directly.
		await expect(
			upgradeSessionToTeam(
				{ projectId, fromNarratorId: id, brief: "x".repeat(5000) },
				{ userId: OWNER, isAdmin: false },
			),
		).rejects.toThrow();
		const after = await row(id);
		expect(parseTraitsOf(after)).not.toContain("team");
		expect(after.contextProjectId).toBe(projectId);
		expect(await notes(id, TEAM_UPGRADE_NOTE_SOURCE)).toHaveLength(0);
	});

	test("a concurrent traits writer under the lock keeps the team trait", async () => {
		const id = await session("Concurrent");
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// Another traits writer (plan mode, blocked skills) reads, waits, then writes back.
		const writer = narratorTraitsLock.acquire(id, async () => {
			const current = parseTraitsOf(await row(id));
			await held;
			await db
				.update(narrators)
				.set({ traits: [...current, "plan"] })
				.where(eq(narrators.id, id));
		});
		const upgrading = upgrade(OWNER, { fromNarratorId: id });
		await Bun.sleep(20);
		release();
		await writer;
		expect((await upgrading).status).toBe(201);
		const traits = parseTraitsOf(await row(id));
		expect(traits).toContain("plan");
		expect(traits).toContain("team");
	});
});

describe("the project's git checks (the same as creating a team)", () => {
	async function expectNothingWritten(id: string) {
		expect(parseTraitsOf(await row(id))).not.toContain("team");
		expect(
			await db.query.projectTeams.findFirst({ where: eq(projectTeams.narratorId, id) }),
		).toBeUndefined();
		expect(
			await db.query.teamWorkEvents.findMany({ where: eq(teamWorkEvents.teamId, id) }),
		).toEqual([]);
		expect(await notes(id, TEAM_UPGRADE_NOTE_SOURCE)).toHaveLength(0);
	}

	async function setProject(patch: Partial<typeof projects.$inferInsert>) {
		await db.update(projects).set(patch).where(eq(projects.id, projectId));
	}

	test("a project whose directory is not a git work tree: TEAM_PROJECT_NOT_GIT", async () => {
		const dir = join(testHome, "plain-project");
		mkdirSync(dir, { recursive: true });
		const plainProjectId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: plainProjectId,
			name: "plain folder",
			gitPath: dir,
			defaultBranch: "main",
			ownerUserId: OWNER,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		});
		const id = await session("Plain folder", { cwd: dir, contextProjectId: plainProjectId });
		const response = await upgrade(OWNER, { fromNarratorId: id }, plainProjectId);
		expect(response.status).toBe(409);
		expect(response.body.code).toBe("TEAM_PROJECT_NOT_GIT");
		await expectNothingWritten(id);
	});

	test("a base branch that names no commit: TEAM_BASE_BRANCH_UNRESOLVED", async () => {
		const given = await session("Missing given base");
		const response = await upgrade(OWNER, { fromNarratorId: given, baseBranch: "no-such-branch" });
		expect(response.status).toBe(409);
		expect(response.body.code).toBe("TEAM_BASE_BRANCH_UNRESOLVED");
		await expectNothingWritten(given);

		// Without a base in the body, the project's default is checked.
		const byDefault = await session("Missing default base");
		await setProject({ defaultBranch: "missing-default" });
		try {
			const refused = await upgrade(OWNER, { fromNarratorId: byDefault });
			expect(refused.status).toBe(409);
			expect(refused.body.code).toBe("TEAM_BASE_BRANCH_UNRESOLVED");
		} finally {
			await setProject({ defaultBranch: "trunk" });
		}
		await expectNothingWritten(byDefault);
		// A base that resolves is accepted.
		expect((await upgrade(OWNER, { fromNarratorId: byDefault, baseBranch: "trunk" })).status).toBe(
			201,
		);
	});

	test("a project changed after the checks is refused inside the transaction", async () => {
		const principal = { userId: OWNER, isAdmin: false };
		for (const patch of [{ defaultBranch: "feature/linked" }, { gitPath: plainDir }]) {
			const id = await session(`Changed ${Object.keys(patch)[0]}`);
			// The project row is read before the first await; change it right after.
			const upgrading = upgradeSessionToTeam({ projectId, fromNarratorId: id }, principal);
			db.update(projects).set(patch).where(eq(projects.id, projectId)).run();
			try {
				await expect(upgrading).rejects.toMatchObject({ code: "TEAM_PROJECT_CHANGED" });
			} finally {
				await setProject({ defaultBranch: "trunk", gitPath: repo });
			}
			await expectNothingWritten(id);
		}
	});
});

describe("disbanding a team and keeping its session", () => {
	async function workItem(teamId: string, state: string) {
		const now = new Date().toISOString();
		const id = generateId();
		await db.insert(teamWorkItems).values({
			id,
			teamId,
			projectId,
			title: `item ${state}`,
			state: state as typeof teamWorkItems.$inferInsert.state,
			branchName: `team/item-${id.slice(0, 8)}`,
			createdAt: now,
			updatedAt: now,
		});
		return id;
	}

	test("refused while work is live, while busy, for a non-owner and for an archived team", async () => {
		const id = await session("Disband refusals");
		expect((await upgrade(OWNER, { fromNarratorId: id })).status).toBe(201);

		const live = await workItem(id, "in_progress");
		const refused = await disband(OWNER, id);
		expect(refused.status).toBe(409);
		expect(refused.body.code).toBe("TEAM_HAS_LIVE_WORK");
		await db.delete(teamWorkItems).where(eq(teamWorkItems.id, live));

		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, id));
		const busy = await disband(OWNER, id);
		expect(busy.status).toBe(409);
		expect(busy.body.code).toBe("NARRATOR_EXECUTION_BUSY");
		await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, id));

		// A member who may write to the session but does not own it.
		expect((await disband(MEMBER, id)).status).toBe(403);
		expect((await disband(OUTSIDER, id)).status).toBe(404);

		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, id));
		const archived = await disband(OWNER, id);
		expect(archived.status).toBe(409);
		expect(archived.body.code).toBe("TEAM_ARCHIVED");
		await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, id));

		expect(parseTraitsOf(await row(id))).toContain("team");
		expect(
			await db.query.projectTeams.findFirst({ where: eq(projectTeams.narratorId, id) }),
		).toBeDefined();
	});

	test("removes the row with its items and events and the trait, and keeps the conversation", async () => {
		const id = await session("Disband me");
		expect((await upgrade(OWNER, { fromNarratorId: id })).status).toBe(201);
		const team = await db.query.projectTeams.findFirst({ where: eq(projectTeams.narratorId, id) });
		const finished = await workItem(id, "merged");
		expect(isTeamSessionCached(id)).toBe(true);
		const before = await row(id);
		const refsBefore = await refCount(id);

		const response = await disband(OWNER, id);
		expect(response.status).toBe(200);
		expect(response.body).toEqual({ narratorId: id });

		expect(
			await db.query.projectTeams.findFirst({ where: eq(projectTeams.narratorId, id) }),
		).toBeUndefined();
		expect(
			await db.query.teamWorkItems.findFirst({ where: eq(teamWorkItems.id, finished) }),
		).toBeUndefined();
		expect(
			await db.query.teamWorkEvents.findMany({ where: eq(teamWorkEvents.teamId, id) }),
		).toEqual([]);
		const after = await row(id);
		expect(parseTraitsOf(after)).not.toContain("team");
		expect(after.title).toBe(before.title);
		expect(after.visibility).toBe(before.visibility);
		expect(after.writeAudience).toBe(before.writeAudience);
		expect(after.status).toBe("idle");
		// The conversation is kept; the disband note is the only row added.
		expect(await refCount(id)).toBe(refsBefore + 1);
		const disbandNotes = await notes(id, "team_disband");
		expect(disbandNotes.map((note) => note.id)).toEqual([
			teamConversionNoteId(id, "disband", team?.createdAt ?? ""),
		]);
		expect(JSON.stringify(disbandNotes[0]?.contentJson)).toContain("no longer a team coordinator");
		// The memo flipped back.
		expect(isTeamSessionCached(id)).toBe(false);
		expect(teamIdOfNarrator(id)).toBeNull();
		// Now an ordinary session: it can be deleted, which a coordinator with a row restricts.
		expect((await disband(OWNER, id)).status).toBe(404);
	});

	test("a pinned team tab disappears with the team; the session's own tab stays", async () => {
		const id = await session("Pinned then disbanded");
		expect((await upgrade(OWNER, { fromNarratorId: id })).status).toBe(201);
		await upsertRecentTab(
			OWNER,
			{ type: "team", id, title: "client title", lastVisitedAt: Date.now() },
			{ pin: true },
		);
		await upsertRecentTab(OWNER, { type: "narrator", id, title: "x", lastVisitedAt: Date.now() });
		const keys = async () => (await listAllRecentTabs(OWNER)).map((tab) => `${tab.type}:${tab.id}`);
		expect(await keys()).toContain(`team:${id}`);

		expect((await disband(OWNER, id)).status).toBe(200);
		expect(await keys()).not.toContain(`team:${id}`);
		expect(await keys()).toContain(`narrator:${id}`);
	});

	test("upgrade → disband → upgrade again", async () => {
		const id = await session("Round trip");
		forgetTeamSessions();
		const pass = () =>
			writeTeamStatusAtPass({ narratorId: id, locale: "en", compactSeq: null, runStart: true });
		// An ordinary session's pass writes no team status.
		expect(await pass()).toBe(false);
		expect((await upgrade(OWNER, { fromNarratorId: id, brief: "Round-trip rules." })).status).toBe(
			201,
		);
		// The upgraded coordinator's next pass writes its first team status, brief included.
		expect(await pass()).toBe(true);
		const status = await notes(id, TEAM_STATUS_SOURCE);
		expect(status).toHaveLength(1);
		expect(JSON.stringify(status[0]?.contentJson)).toContain("Round-trip rules.");
		expect((await disband(OWNER, id)).status).toBe(200);
		expect(await pass()).toBe(false);
		// The team row's creation time names the note: the second upgrade is told again.
		await Bun.sleep(5);
		const second = await upgrade(OWNER, { fromNarratorId: id, name: "Round trip 2" });
		expect(second.status).toBe(201);
		expect(parseTraitsOf(await row(id)).filter((trait) => trait === "team")).toHaveLength(1);
		expect(await notes(id, TEAM_UPGRADE_NOTE_SOURCE)).toHaveLength(2);
		expect(await notes(id, "team_disband")).toHaveLength(1);
		const events = await db.query.teamWorkEvents.findMany({
			where: and(eq(teamWorkEvents.teamId, id), eq(teamWorkEvents.kind, "team.created")),
		});
		expect(events).toHaveLength(1);
		expect(isTeamSessionCached(id)).toBe(true);
	});
});

function parseTraitsOf(narrator: { traits: unknown }): string[] {
	return Array.isArray(narrator.traits) ? (narrator.traits as string[]) : [];
}

describe("the reader's labels", () => {
	test("the notes are headed in both locales", async () => {
		const { readFileSync } = await import("node:fs");
		const root = join(import.meta.dir, "../../..");
		const adapter = readFileSync(join(root, "shared/pretext-layout/segment-adapter.ts"), "utf8");
		expect(adapter).toContain('team_upgrade: "sidecarSourceTeamUpgrade",');
		expect(adapter).toContain('team_disband: "sidecarSourceTeamDisband",');
		const labels = readFileSync(
			join(root, "frontend/components/narrator/vlist/useVListLabels.ts"),
			"utf8",
		);
		expect(labels).toContain('sidecarSourceTeamUpgrade: t("sidecar.sources.team_upgrade"),');
		expect(labels).toContain('sidecarSourceTeamDisband: t("sidecar.sources.team_disband"),');
		for (const [locale, upgradeText, disbandText] of [
			["en", "Became a team coordinator", "Team disbanded"],
			["zh-CN", "已升级为团队协调者", "团队已解散"],
		]) {
			const json = JSON.parse(
				readFileSync(join(root, `frontend/locales/${locale}/narrator.json`), "utf8"),
			);
			expect(json.sidecar.sources.team_upgrade).toBe(upgradeText);
			expect(json.sidecar.sources.team_disband).toBe(disbandText);
		}
	});
});

describe("review fixes: repository identity, ownership, Retry and Continue around the notes", () => {
	test("a session in a submodule of the project is refused; a linked worktree is not", async () => {
		const library = join(testHome, "library-src");
		mkdirSync(library, { recursive: true });
		const inLibrary = async (...args: string[]) => {
			const result = await safeSpawn({
				cmd: ["git", "-c", "user.name=F", "-c", "user.email=f@example.invalid", ...args],
				cwd: library,
				timeout: 10_000,
				maxOutputBytes: 64 * 1024,
			});
			if (result.exitCode) throw new Error(result.stderr);
		};
		await inLibrary("init", "-q", "-b", "trunk");
		await inLibrary("commit", "-q", "--allow-empty", "-m", "library");
		await git(
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			library,
			"vendor/library",
		);
		await git("commit", "-q", "-m", "add library submodule");

		const id = await session("In a submodule", { cwd: join(repo, "vendor/library") });
		const response = await upgrade(OWNER, { fromNarratorId: id });
		expect(response.status).toBe(409);
		expect(response.body.code).toBe("TEAM_WORKSPACE_UNAVAILABLE");
		expect(response.body.details).toEqual({ reason: "other-repository" });
		expect(parseTraitsOf(await row(id))).not.toContain("team");
		expect(
			await db.query.projectTeams.findFirst({ where: eq(projectTeams.narratorId, id) }),
		).toBeUndefined();
		expect(await notes(id, TEAM_UPGRADE_NOTE_SOURCE)).toHaveLength(0);

		// A linked worktree of the project's own repository shares its identity.
		const worktree = join(testHome, "linked-worktree-2");
		await git("worktree", "add", "-q", "-b", "feature/linked-2", worktree);
		const linked = await session("Linked again", { cwd: worktree });
		expect((await upgrade(OWNER, { fromNarratorId: linked })).status).toBe(201);
	});

	test("ownership handed over after the first check: upgrade and disband are refused", async () => {
		const handOver = async (narratorId: string) =>
			db.update(narrators).set({ ownerUserId: MEMBER }).where(eq(narrators.id, narratorId));

		const id = await session("Handed over before upgrade");
		teamConversionTestHooks.beforeTransaction = async (kind, narratorId) => {
			if (kind === "upgrade" && narratorId === id) await handOver(id);
		};
		try {
			const refused = await upgrade(OWNER, { fromNarratorId: id });
			expect(refused.status).toBe(403);
		} finally {
			teamConversionTestHooks.beforeTransaction = undefined;
		}
		expect(parseTraitsOf(await row(id))).not.toContain("team");
		expect(
			await db.query.projectTeams.findFirst({ where: eq(projectTeams.narratorId, id) }),
		).toBeUndefined();
		expect(await notes(id, TEAM_UPGRADE_NOTE_SOURCE)).toHaveLength(0);

		const team = await session("Handed over before disband");
		expect((await upgrade(OWNER, { fromNarratorId: team })).status).toBe(201);
		teamConversionTestHooks.beforeTransaction = async (kind, narratorId) => {
			if (kind === "disband" && narratorId === team) await handOver(team);
		};
		try {
			expect((await disband(OWNER, team)).status).toBe(403);
		} finally {
			teamConversionTestHooks.beforeTransaction = undefined;
		}
		expect(parseTraitsOf(await row(team))).toContain("team");
		expect(
			await db.query.projectTeams.findFirst({ where: eq(projectTeams.narratorId, team) }),
		).toBeDefined();
		expect(await notes(team, TEAM_DISBAND_NOTE_SOURCE)).toHaveLength(0);
		// The new owner may.
		expect((await disband(MEMBER, team)).status).toBe(200);
	});

	/** The rebaseline notice `requestToolDeclarationRebaseline` writes on a `replace_tools` epoch. */
	async function rebaselineNotice(narratorId: string) {
		return narratorStore.appendToolChange(
			narratorId,
			{
				type: "tool_loaded",
				toolName: "Team",
				toolNames: ["Team"],
				text: "Tool loaded: Team",
				rebaseline: true,
			},
			"system",
		);
	}

	async function refIds(narratorId: string) {
		return (
			await db
				.select({ id: narratorMessageRefs.messageId })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, narratorId))
		).map((ref) => ref.id);
	}

	test("Retry after an upgrade re-runs the person's message and keeps the note and notice", async () => {
		const id = await session("Retry across an upgrade");
		const asked = await narratorPersistence.persistUserMessage(id, "Refactor the payments module");
		// The failed run's leftovers, which Retry discards.
		const leftover = await narratorPersistence.persistDisplayMessage(id, "The provider failed");
		expect((await upgrade(OWNER, { fromNarratorId: id })).status).toBe(201);
		const notice = await rebaselineNotice(id);
		const [note] = await notes(id, TEAM_UPGRADE_NOTE_SOURCE);
		if (!note) throw new Error("no upgrade note");

		const { lastMsg, prompt } = await rewindHistoryForRetry(id);
		expect(lastMsg.id).toBe(asked.id);
		expect(prompt).toBe("Refactor the payments module");
		const kept = await refIds(id);
		expect(kept).toContain(note.id);
		expect(kept).toContain(notice.id);
		expect(kept).not.toContain(leftover.id);
	});

	test("after Retry the provider input carries the person's prompt once, and the notice", async () => {
		const { settings } = await import("../../lib/settings");
		const { buildRuntimeHistory } = await import("../../services/agent-runtime/history");
		const previousProviders = settings.anthropicProviders;
		settings.anthropicProviders = [
			{
				id: "upgrade-retry",
				name: "Upgrade retry test",
				prefix: "upgrade-retry",
				apiKey: "isolated-test-no-network",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "claude-sonnet-4",
				officialApi: false,
			},
		] as typeof settings.anthropicProviders;
		try {
			const id = await session("Provider input after Retry");
			const prompt = "Summarize the open invoices for the payments team";
			await narratorPersistence.persistUserMessage(id, prompt);
			expect((await upgrade(OWNER, { fromNarratorId: id })).status).toBe(201);
			await rebaselineNotice(id);
			const rewound = await rewindHistoryForRetry(id);
			expect(rewound.prompt).toBe(prompt);

			// What the retried run assembles: the retry passes the prompt as current input.
			const prepared = await buildRuntimeHistory({
				narratorId: id,
				model: "claude-sonnet-4",
				provider: "upgrade-retry",
				currentInput: rewound.prompt,
			});
			// The persisted message carries it; nothing travels again as separate input.
			expect(prepared.currentText).toBe("");
			expect(prepared.currentInputText).toContain(prompt);
			const text = JSON.stringify(prepared.history);
			expect(text.split(prompt).length - 1).toBe(1);
			// The notice and the note stay in what the model reads.
			expect(text).toContain("Tool loaded: Team");
			// The upgrade note names the team (the session's title).
			expect(text).toContain("Provider input after Retry");
		} finally {
			settings.anthropicProviders = previousProviders;
		}
	});

	test("Retry after a disband keeps the disband note", async () => {
		const id = await session("Retry across a disband");
		expect((await upgrade(OWNER, { fromNarratorId: id })).status).toBe(201);
		const asked = await narratorPersistence.persistUserMessage(id, "Ship the release");
		const leftover = await narratorPersistence.persistDisplayMessage(id, "The provider failed");
		expect((await disband(OWNER, id)).status).toBe(200);
		const [note] = await notes(id, TEAM_DISBAND_NOTE_SOURCE);
		if (!note) throw new Error("no disband note");

		const { lastMsg } = await rewindHistoryForRetry(id);
		expect(lastMsg.id).toBe(asked.id);
		const kept = await refIds(id);
		expect(kept).toContain(note.id);
		expect(kept).not.toContain(leftover.id);
	});

	test("Continue looks past the notes and the notice; a genuine injection is still input", async () => {
		const note = (source: string) => ({
			role: "sys",
			contentJson: [{ type: "system_injection", source, modelText: "note" }],
		});
		const notice = {
			role: "user",
			contentJson: [
				{ type: "tool_loaded", toolName: "Team", toolNames: ["Team"], rebaseline: true },
			],
		};
		const reply = { id: "a1", role: "assistant", contentJson: [{ type: "text", text: "Half" }] };
		for (const source of ["team_upgrade", "team_disband"]) {
			const history = [reply, note(source), notice];
			expect(hasTrailingInjectionRow(history)).toBe(false);
			expect(resolveContinuationTail(history).tail).toBe(reply);
		}
		expect(hasTrailingInjectionRow([reply, note("bg_agent")])).toBe(true);
		expect(hasTrailingInjectionRow([reply, note("team_upgrade"), note("bg_agent")])).toBe(true);

		// The retry target skips the notice to the person's message.
		const person = { id: "u1", role: "user", contentJson: [{ type: "text", text: "Go" }] };
		const target = resolveRetryTarget([person, { id: "r1", ...notice }]);
		expect(target.target?.id).toBe("u1");

		// On real history: an upgraded session's tail is its last reply, not the note.
		const id = await session("Continue across an upgrade");
		await narratorPersistence.persistUserMessage(id, "Explain the module");
		await narratorPersistence.persistAssistantMessage(id, {
			uuid: generateId(),
			session_id: "continue",
			message: { content: [{ type: "text", text: "It has three parts" }] },
		});
		expect((await upgrade(OWNER, { fromNarratorId: id })).status).toBe(201);
		await rebaselineNotice(id);
		const history = await narratorService.getModelHistorySinceLastCompact(id);
		expect(hasTrailingInjectionRow(history)).toBe(false);
		expect(resolveContinuationTail(history).tail?.role).toBe("assistant");
	});
});
