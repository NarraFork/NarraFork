/**
 * Project-level route gates.
 *
 * The instrumentation is spread across many routers (projects, narrators, git,
 * skills), so these tests pin the behaviour at the boundary rather than per-file:
 *
 *  - a private project is invisible to non-members, and refusal is 404 (not 403) so
 *    ids cannot be probed;
 *  - the list endpoint filters instead of erroring, and filtering happens in SQL;
 *  - read does not imply write: a read member cannot start sessions in it or commit;
 *  - write does not imply manage: a write member cannot delete the project or edit
 *    its settings;
 *  - project sessions inherit the project verdict, including through the git surface,
 *    whose endpoints are the ones that touch the filesystem;
 *  - public projects are readable by everyone but still not writable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-project-acl-gate-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { projectRoutes, requireSqliteProjectMutation } = await import("../projects");
const { narratorRoutes } = await import("../narrators");
const { narratorGitRoutes } = await import("../git");
const { db } = await import("../../db");
const { aclGrants, narrators, projects, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const { executionPolicyEngine } = await import("../../services/execution-policy/engine");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const OWNER = "proj-gate-owner";
const READER = "proj-gate-reader";
const WRITER = "proj-gate-writer";
const OUTSIDER = "proj-gate-outsider";

let privateProject: string;
let publicProject: string;
let sessionInPrivate: string;

function appAs(userId: string, role: "admin" | "user" = "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
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
	app.route("/projects", projectRoutes);
	app.route("/narrators", narratorRoutes);
	app.route("/narrators", narratorGitRoutes);
	return app;
}

function request(
	userId: string,
	path: string,
	init: { method?: string; body?: unknown; role?: "admin" | "user" } = {},
) {
	const { method = "GET", body, role = "user" } = init;
	return appAs(userId, role).request(`http://localhost${path}`, {
		method,
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
}

async function grantProject(projectId: string, userId: string, capability: string) {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: userId,
		capability: capability as "read",
		createdAt: new Date().toISOString(),
	});
}

beforeAll(async () => {
	const now = new Date().toISOString();
	for (const id of [OWNER, READER, WRITER, OUTSIDER]) {
		await db.insert(users).values({
			id,
			username: `${id}-${Date.now()}`,
			passwordHash: "x",
			role: "user",
			createdAt: now,
		});
	}

	privateProject = generateId();
	publicProject = generateId();
	await db.insert(projects).values([
		{
			id: privateProject,
			name: "private project",
			gitPath: join(testHome, "private-repo"),
			ownerUserId: OWNER,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: publicProject,
			name: "public project",
			gitPath: join(testHome, "public-repo"),
			ownerUserId: OWNER,
			visibility: "public",
			createdAt: now,
			updatedAt: now,
		},
	]);

	sessionInPrivate = generateId();
	await db.insert(narrators).values({
		id: sessionInPrivate,
		title: "project session",
		ownerUserId: OWNER,
		contextProjectId: privateProject,
		cwd: join(testHome, "private-repo"),
		traits: ["standalone"],
		visibility: "project",
		writeAudience: "project",
		createdAt: now,
		updatedAt: now,
	});

	await grantProject(privateProject, READER, "read");
	await grantProject(privateProject, WRITER, "write");
});

describe("reading a project", () => {
	test("the owner can open their private project", async () => {
		expect((await request(OWNER, `/projects/${privateProject}`)).status).toBe(200);
	});

	test("an outsider gets 404, not 403", async () => {
		expect((await request(OUTSIDER, `/projects/${privateProject}`)).status).toBe(404);
	});

	test("a read member can open it", async () => {
		expect((await request(READER, `/projects/${privateProject}`)).status).toBe(200);
	});

	test("an admin can open anyone's", async () => {
		expect(
			(await request("gate-admin", `/projects/${privateProject}`, { role: "admin" })).status,
		).toBe(200);
	});

	test("a public project is readable by anyone signed in", async () => {
		expect((await request(OUTSIDER, `/projects/${publicProject}`)).status).toBe(200);
	});
});

describe("the project list", () => {
	test("omits projects the caller cannot read instead of failing", async () => {
		const res = await request(OUTSIDER, "/projects");
		expect(res.status).toBe(200);
		const ids = ((await res.json()) as Array<{ id: string }>).map((p) => p.id);
		expect(ids).not.toContain(privateProject);
		// The public one is still there, so this is filtering rather than blanket denial.
		expect(ids).toContain(publicProject);
	});

	test("includes a project the caller was granted", async () => {
		const res = await request(READER, "/projects");
		const ids = ((await res.json()) as Array<{ id: string }>).map((p) => p.id);
		expect(ids).toContain(privateProject);
	});
});

describe("write is not read", () => {
	test("a read member cannot start a session in the project", async () => {
		const res = await request(READER, "/narrators", {
			method: "POST",
			body: { contextProjectId: privateProject, title: "nope" },
		});
		expect(res.status).toBe(404);
	});

	test("a public project does not accept sessions from outsiders", async () => {
		// Publishing a project shares a view of it, not commit rights.
		const res = await request(OUTSIDER, "/narrators", {
			method: "POST",
			body: { contextProjectId: publicProject, title: "nope" },
		});
		expect(res.status).toBe(404);
	});
});

describe("manage is not write", () => {
	test("a write member cannot change project settings", async () => {
		const res = await request(WRITER, `/projects/${privateProject}`, {
			method: "PATCH",
			body: { description: "hijacked" },
		});
		expect(res.status).toBe(404);
	});

	test("a write member cannot delete the project", async () => {
		const res = await request(WRITER, `/projects/${privateProject}`, { method: "DELETE" });
		expect(res.status).toBe(404);
	});

	test("the owner can change settings", async () => {
		const res = await request(OWNER, `/projects/${privateProject}`, {
			method: "PATCH",
			body: { description: "owner edit" },
		});
		expect(res.status).toBe(200);
	});
});

describe("project sessions inherit the project", () => {
	test("removing a project rule refreshes an existing session's cached policy", async () => {
		const pattern = "test-project-policy-cache";
		const updateRule = (commandBlacklist: { pattern: string }[]) =>
			request(OWNER, `/projects/${privateProject}`, {
				method: "PATCH",
				body: { chapterSettings: { commandBlacklist } },
			});
		const cachedPatterns = async () =>
			(await executionPolicyEngine.compile(sessionInPrivate, null)).commandBlacklist.map(
				(rule) => rule.pattern,
			);
		try {
			expect((await updateRule([{ pattern }])).status).toBe(200);
			expect(await cachedPatterns()).toContain(pattern);
			expect((await updateRule([])).status).toBe(200);
			expect(await cachedPatterns()).not.toContain(pattern);
		} finally {
			executionPolicyEngine.clear();
		}
	});

	test("an outsider cannot read a session of a private project", async () => {
		expect((await request(OUTSIDER, `/narrators/${sessionInPrivate}`)).status).toBe(404);
	});

	test("a read member can", async () => {
		expect((await request(READER, `/narrators/${sessionInPrivate}`)).status).toBe(200);
	});

	test("a read member cannot delete it", async () => {
		expect(
			(await request(READER, `/narrators/${sessionInPrivate}`, { method: "DELETE" })).status,
		).toBe(404);
	});

	test("project session listing requires project read", async () => {
		expect((await request(OUTSIDER, `/narrators?projectId=${privateProject}`)).status).toBe(404);
		expect((await request(READER, `/narrators?projectId=${privateProject}`)).status).toBe(200);
	});
});

describe("PostgreSQL mutation admission", () => {
	test("project mutations fail closed before any host-side work", () => {
		for (const operation of [
			"Project creation",
			"Project updates",
			"Project deletion",
			"Project membership changes",
			"Project ownership transfers",
		]) {
			expect(() => requireSqliteProjectMutation(operation, "postgres")).toThrowError(
				new AppError(
					`${operation} is not yet supported on the PostgreSQL backend`,
					503,
					"POSTGRES_UNSUPPORTED",
				),
			);
		}
		expect(() => requireSqliteProjectMutation("Project creation", "sqlite")).not.toThrow();
	});
});

describe("the git surface inherits too", () => {
	test("an outsider cannot read git status of a private project's session", async () => {
		// The git endpoints reach the filesystem, so this gate matters more than most.
		const res = await request(OUTSIDER, `/narrators/${sessionInPrivate}/git/status`);
		expect(res.status).toBe(404);
	});

	test("a read member cannot stage files", async () => {
		const res = await request(READER, `/narrators/${sessionInPrivate}/git/stage`, {
			method: "POST",
			body: { files: ["a.txt"] },
		});
		expect(res.status).toBe(404);
	});
});
