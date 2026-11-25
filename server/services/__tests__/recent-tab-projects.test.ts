/**
 * Project tabs' hover-card state (`recent-tab-projects.ts`) through the runtime patches: the
 * project's directory, the sessions running or waiting there that the reader can read, and the
 * readable active teams. Real database and real ACL, so a private session or team of someone
 * else is never counted, and a project the reader cannot enter reports nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-project-tabs-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { db } = await import("../../db");
const { narratorProjectLinks, narrators, projects, projectTeams, users } = await import(
	"../../db/schema"
);
const { eq } = await import("drizzle-orm");
const { generateId } = await import("../../lib/id");
const { getRuntimePatches, upsertRecentTab } = await import("../recent-tabs-service");
const { PROJECT_TAB_ROW_CAP } = await import("../recent-tab-projects");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

async function makeUser(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `u-${generateId(6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: now(),
	});
	return id;
}

async function makeProject(owner: string, visibility: "private" | "public"): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `p-${generateId(6)}`,
		gitPath: join(testHome, `repo-${id}`),
		ownerUserId: owner,
		visibility,
		createdAt: now(),
		updatedAt: now(),
	});
	return id;
}

async function makeSession(
	projectId: string,
	owner: string,
	options: {
		status: "idle" | "working" | "waiting" | "archived";
		visibility?: "private" | "public";
		type?: "primary" | "subagent";
		parent?: string;
		team?: boolean;
	},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title: `s-${id.slice(0, 6)}`,
		status: options.status,
		type: options.type ?? "primary",
		...(options.type === "subagent"
			? {
					variant: "subagent:general",
					parentNarratorId: options.parent,
					aclRootNarratorId: options.parent,
				}
			: {}),
		ownerUserId: owner,
		visibility: options.visibility ?? "private",
		contextProjectId: projectId,
		traits: options.team ? ["team"] : [],
		createdAt: now(),
		updatedAt: now(),
	});
	await db.insert(narratorProjectLinks).values({
		narratorId: id,
		projectId,
		role: "primary",
		source: "explicit",
		updatedAt: now(),
	});
	if (options.team)
		await db.insert(projectTeams).values({
			narratorId: id,
			projectId,
			baseBranch: "main",
			createdAt: now(),
			updatedAt: now(),
		});
	return id;
}

async function patchOf(userId: string, projectId: string) {
	await upsertRecentTab(userId, { type: "project", id: projectId, title: "p", lastVisitedAt: 1 });
	const { patches } = await getRuntimePatches(userId, [`project:${projectId}`]);
	return patches.find((patch) => patch.key === `project:${projectId}`)?.patch;
}

let owner: string;
let reader: string;
let projectId: string;
let privateProjectId: string;

beforeAll(async () => {
	owner = await makeUser();
	reader = await makeUser();
	projectId = await makeProject(owner, "public");
	privateProjectId = await makeProject(owner, "private");

	// The owner's own sessions: two running (one waiting), one idle, one subagent running.
	const running = await makeSession(projectId, owner, { status: "working" });
	await makeSession(projectId, owner, { status: "waiting", visibility: "public" });
	await makeSession(projectId, owner, { status: "idle" });
	await makeSession(projectId, owner, { status: "working", type: "subagent", parent: running });
	// The reader's private running session: the owner cannot read it.
	await makeSession(projectId, reader, { status: "working" });
	// Teams: the owner's private active team, and an archived one.
	await makeSession(projectId, owner, { status: "idle", team: true });
	await makeSession(projectId, owner, { status: "archived", team: true });
	await makeSession(privateProjectId, owner, { status: "working" });
});

describe("project tab runtime state", () => {
	test("the owner sees the path and the sessions and teams they can read", async () => {
		const patch = await patchOf(owner, projectId);
		expect(patch).toMatchObject({
			projectPath: join(testHome, `repo-${projectId}`),
			// Running + waiting primaries the owner can read; not the subagent, not the idle one,
			// not the reader's private session.
			activeSessionCount: 2,
			waitingSessionCount: 1,
			// The archived team does not count.
			teamCount: 1,
			projectCountsCapped: false,
		});
	});

	test("another reader counts only what they can read", async () => {
		const patch = await patchOf(reader, projectId);
		expect(patch).toMatchObject({
			// The owner's public waiting session and the reader's own running one.
			activeSessionCount: 2,
			waitingSessionCount: 1,
			// The owner's team is private.
			teamCount: 0,
		});
	});

	test("a project the reader can no longer enter reports nothing", async () => {
		const ownerPatch = await patchOf(owner, privateProjectId);
		expect(ownerPatch?.activeSessionCount).toBe(1);
		// The reader pinned it while it was public; then it became private.
		await db
			.update(projects)
			.set({ visibility: "public" })
			.where(eq(projects.id, privateProjectId));
		expect((await patchOf(reader, privateProjectId))?.activeSessionCount).toBe(0);
		await db
			.update(projects)
			.set({ visibility: "private" })
			.where(eq(projects.id, privateProjectId));
		const { patches } = await getRuntimePatches(reader, [`project:${privateProjectId}`]);
		expect(patches).toEqual([]);
	});

	test("the row cap is a bound, not a scan of the project's history", () => {
		expect(PROJECT_TAB_ROW_CAP).toBeLessThanOrEqual(500);
	});
});
