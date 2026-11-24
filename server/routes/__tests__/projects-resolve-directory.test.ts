/**
 * `POST /projects/resolve-directory`: the new-session dialog's "start as a team" asks which
 * project a directory belongs to before any session exists.
 *
 *  - signed-in callers only (the same gate as starting a session in a directory);
 *  - a git repository without a project: `create: false` only reports it, `create: true`
 *    makes the project (owned by the caller), and the team route then works on it;
 *  - a subdirectory resolves to its repository's project;
 *  - a non-git directory never gets a project, with or without `create`;
 *  - a missing path is `not_directory`;
 *  - a project the caller cannot read is answered byte for byte like a non-git directory, so
 *    the lookup cannot locate private projects; a read-only one says `canWrite: false`; an
 *    archived one says so;
 *  - a project on a folder that is not a git checkout says `gitWorkTree: false`, and the team
 *    route refuses it (`TEAM_PROJECT_NOT_GIT`) without writing anything;
 *  - a project made for a repository takes the repository's checked-out branch as its default
 *    (`master` when that is all there is), and the team route refuses a base branch that names
 *    no commit (`TEAM_BASE_BRANCH_UNRESOLVED`) without writing anything.
 *
 * Run: bun test --isolate server/routes/__tests__/projects-resolve-directory.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-resolve-directory-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectRoutes } = await import("../projects");
const { projectTeamRoutes } = await import("../project-teams");
const { db } = await import("../../db");
const { eq } = await import("drizzle-orm");
const { aclGrants, narrators, projects, projectTeams, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { resetProjectIndexStateForTests } = await import("../../services/project-index");

const OWNER = "resolve-owner";
const READER = "resolve-reader";
const OUTSIDER = "resolve-outsider";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nf-resolve-directory-")));

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function makeDir(...parts: string[]): string {
	const dir = join(root, ...parts);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeRepo(name: string, branch = "main"): string {
	const dir = makeDir(name);
	git(dir, "init", "-q", "-b", branch);
	writeFileSync(join(dir, "README.md"), "x");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

function appAs(userId: string | null) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (userId) c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
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

async function post(userId: string | null, path: string, body: unknown) {
	const response = await appAs(userId).request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The response exactly as sent, for comparing answers byte for byte. */
async function rawResolve(userId: string, cwd: string, create?: boolean) {
	const response = await appAs(userId).request("http://localhost/projects/resolve-directory", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(create === undefined ? { cwd } : { cwd, create }),
	});
	return {
		status: response.status,
		contentType: response.headers.get("content-type"),
		bytes: new Uint8Array(await response.arrayBuffer()),
	};
}

async function teamRowCount() {
	const teams = (await db.select({ id: projectTeams.narratorId }).from(projectTeams)).length;
	const sessions = (await db.select({ id: narrators.id }).from(narrators)).length;
	return { teams, sessions };
}

const resolveDir = (userId: string | null, cwd: string, create?: boolean) =>
	post(userId, "/projects/resolve-directory", create === undefined ? { cwd } : { cwd, create });

async function projectsAt(gitPath: string) {
	return await db.select().from(projects).where(eq(projects.gitPath, gitPath));
}

async function projectCount() {
	return (await db.select({ id: projects.id }).from(projects)).length;
}

beforeAll(async () => {
	const now = new Date().toISOString();
	for (const id of [OWNER, READER, OUTSIDER]) {
		await db.insert(users).values({
			id,
			username: `${id}-${Date.now()}`,
			passwordHash: "x",
			role: "user",
			createdAt: now,
		});
	}
});

beforeEach(() => resetProjectIndexStateForTests());

describe("who may ask", () => {
	test("a request without a signed-in user is refused", async () => {
		const repo = makeRepo("anonymous");
		const before = await projectCount();
		const result = await resolveDir(null, repo, true);
		expect(result.status).toBe(401);
		expect(await projectCount()).toBe(before);
	});

	test("the body is validated", async () => {
		expect((await post(OWNER, "/projects/resolve-directory", {})).status).toBe(400);
		expect((await post(OWNER, "/projects/resolve-directory", { cwd: " " })).status).toBe(400);
		expect((await post(OWNER, "/projects/resolve-directory", { cwd: root, extra: 1 })).status).toBe(
			400,
		);
	});
});

describe("git repositories", () => {
	test("looking does not create; creating makes the caller's project and the team route takes it", async () => {
		const repo = makeRepo("fresh");
		const looked = await resolveDir(OWNER, repo);
		expect(looked).toEqual({ status: 200, body: { status: "repository", root: repo } });
		expect(await projectsAt(repo)).toHaveLength(0);

		const created = await resolveDir(OWNER, repo, true);
		expect(created.status).toBe(200);
		const rows = await projectsAt(repo);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ownerUserId).toBe(OWNER);
		expect(created.body).toEqual({
			status: "project",
			project: {
				id: rows[0]?.id,
				name: "fresh",
				gitPath: repo,
				archived: false,
				canWrite: true,
				gitWorkTree: true,
			},
		});
		expect(rows[0]?.defaultBranch).toBe("main");

		// Asking again finds the same project, without creating another.
		const again = await resolveDir(OWNER, repo, true);
		expect((again.body.project as { id: string }).id).toBe(rows[0]?.id as string);
		expect(await projectsAt(repo)).toHaveLength(1);

		// The client's next step: the existing team route, P1.
		const projectId = rows[0]?.id as string;
		const team = await post(OWNER, `/projects/${projectId}/teams`, {
			name: "Fresh team",
			baseBranch: "main",
			brief: "Start here.",
		});
		expect(team.status).toBe(201);
		const coordinator = await db.query.narrators.findFirst({
			where: eq(narrators.id, team.body.id as string),
		});
		expect(coordinator?.cwd).toBe(repo);
		expect(coordinator?.contextProjectId).toBe(projectId);
		expect(coordinator?.traits).toContain("team");
	});

	test("a subdirectory resolves to its repository's project", async () => {
		const repo = makeRepo("nested");
		const sub = makeDir("nested", "packages", "app");
		const created = await resolveDir(OWNER, sub, true);
		expect(created.body.status).toBe("project");
		expect((created.body.project as { gitPath: string }).gitPath).toBe(repo);
		expect(await projectsAt(sub)).toHaveLength(0);
	});
});

describe("directories that cannot have a team", () => {
	test("a non-git directory never gets a project", async () => {
		const plain = makeDir("plain", "folder");
		const before = await projectCount();
		expect(await resolveDir(OWNER, plain)).toEqual({ status: 200, body: { status: "not_git" } });
		expect(await resolveDir(OWNER, plain, true)).toEqual({
			status: 200,
			body: { status: "not_git" },
		});
		expect(await projectCount()).toBe(before);
	});

	test("a path that is not an existing directory", async () => {
		const before = await projectCount();
		expect(await resolveDir(OWNER, join(root, "does-not-exist"), true)).toEqual({
			status: 200,
			body: { status: "not_directory" },
		});
		const file = join(makeDir("files"), "a.txt");
		writeFileSync(file, "x");
		expect((await resolveDir(OWNER, file, true)).body).toEqual({ status: "not_directory" });
		expect(await projectCount()).toBe(before);
	});
});

describe("someone else's project", () => {
	let privateRepo: string;
	let privateId: string;

	beforeAll(async () => {
		privateRepo = makeRepo("private");
		const created = await resolveDir(OWNER, privateRepo, true);
		privateId = (created.body.project as { id: string }).id;
		await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, privateId));
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: privateId,
			principalType: "user",
			principalId: READER,
			capability: "read",
			createdAt: new Date().toISOString(),
		});
	});

	test("a project the caller cannot read is answered exactly like a non-git directory", async () => {
		const plain = makeDir("plain-for-comparison");
		for (const create of [undefined, false, true]) {
			const hidden = await rawResolve(OUTSIDER, privateRepo, create);
			const notGit = await rawResolve(OUTSIDER, plain, create);
			expect(hidden.status).toBe(200);
			expect(hidden.status).toBe(notGit.status);
			expect(hidden.contentType).toBe(notGit.contentType);
			expect(hidden.bytes).toEqual(notGit.bytes);
			expect(new TextDecoder().decode(hidden.bytes)).toBe('{"status":"not_git"}');
		}
		expect(await projectsAt(privateRepo)).toHaveLength(1);
	});

	test("a reader sees the project but cannot write to it", async () => {
		const result = await resolveDir(READER, privateRepo);
		expect(result.body).toMatchObject({
			status: "project",
			project: { id: privateId, canWrite: false },
		});
	});

	test("an archived project says so", async () => {
		await db.update(projects).set({ status: "archived" }).where(eq(projects.id, privateId));
		try {
			const result = await resolveDir(OWNER, privateRepo);
			expect(result.body).toMatchObject({
				status: "project",
				project: { id: privateId, archived: true, canWrite: true },
			});
		} finally {
			await db.update(projects).set({ status: "active" }).where(eq(projects.id, privateId));
		}
	});
});

describe("what a team needs from the project's repository", () => {
	test("a project on a folder that is not a git checkout: reported, and the team route refuses", async () => {
		const folder = makeDir("associated", "folder");
		const projectId = generateId();
		const now = new Date().toISOString();
		// What `POST /projects` with an existing folder makes: no git required.
		await db.insert(projects).values({
			id: projectId,
			name: "Associated folder",
			gitPath: folder,
			ownerUserId: OWNER,
			visibility: "public",
			rootKey: folder,
			createdAt: now,
			updatedAt: now,
		});
		const looked = await resolveDir(OWNER, folder);
		expect(looked.body).toMatchObject({
			status: "project",
			project: { id: projectId, canWrite: true, gitWorkTree: false },
		});

		const before = await teamRowCount();
		const team = await post(OWNER, `/projects/${projectId}/teams`, { name: "No git" });
		expect(team.status).toBe(409);
		expect(team.body.code).toBe("TEAM_PROJECT_NOT_GIT");
		expect(await teamRowCount()).toEqual(before);
	});

	test("a repository with only master: the project defaults to master and a blank base takes it", async () => {
		const repo = makeRepo("only-master", "master");
		const created = await resolveDir(OWNER, repo, true);
		const projectId = (created.body.project as { id: string }).id;
		const [row] = await projectsAt(repo);
		expect(row?.defaultBranch).toBe("master");

		const team = await post(OWNER, `/projects/${projectId}/teams`, { name: "Master crew" });
		expect(team.status).toBe(201);
		expect(team.body.baseBranch).toBe("master");
		const stored = await db.query.projectTeams.findFirst({
			where: eq(projectTeams.narratorId, team.body.id as string),
		});
		expect(stored?.baseBranch).toBe("master");
	});

	test("a base branch that names no commit is refused and nothing is written", async () => {
		const repo = makeRepo("unresolved-base", "master");
		const created = await resolveDir(OWNER, repo, true);
		const projectId = (created.body.project as { id: string }).id;

		const before = await teamRowCount();
		const given = await post(OWNER, `/projects/${projectId}/teams`, {
			name: "Ghost base",
			baseBranch: "main",
		});
		expect(given.status).toBe(409);
		expect(given.body.code).toBe("TEAM_BASE_BRANCH_UNRESOLVED");
		expect(given.body.error).toContain('"main"');
		expect(await teamRowCount()).toEqual(before);

		// A project default that names no commit (set by hand, or a branch deleted since) too.
		await db.update(projects).set({ defaultBranch: "gone" }).where(eq(projects.id, projectId));
		const defaulted = await post(OWNER, `/projects/${projectId}/teams`, { name: "Ghost default" });
		expect(defaulted.status).toBe(409);
		expect(defaulted.body.code).toBe("TEAM_BASE_BRANCH_UNRESOLVED");
		expect(defaulted.body.error).toContain('"gone"');
		expect(await teamRowCount()).toEqual(before);
	});
});
