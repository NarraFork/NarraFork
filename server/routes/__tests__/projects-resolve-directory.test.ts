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
 *  - a project the caller cannot read is `no_access` with no id or name; a read-only one says
 *    `canWrite: false`; an archived one says so.
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
const { aclGrants, narrators, projects, users } = await import("../../db/schema");
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

function makeRepo(name: string): string {
	const dir = makeDir(name);
	git(dir, "init", "-q", "-b", "main");
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
			},
		});

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

	test("a project the caller cannot read is reported without its id or name", async () => {
		const result = await resolveDir(OUTSIDER, privateRepo, true);
		expect(result).toEqual({ status: 200, body: { status: "no_access" } });
		expect(JSON.stringify(result.body)).not.toContain(privateId);
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
