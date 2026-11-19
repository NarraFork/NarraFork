import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, projects, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { getNarraforkHome } from "../../lib/narrafork-home";
import { setOutboundFetchOverrideForTest } from "../../lib/net/outbound-fetch";
import { skillRoutes } from "../skills";

const owner = generateId();
const reader = generateId();
const outsider = generateId();
const admin = generateId();
const projectId = generateId();
const url = "https://github.com/example/skills/tree/main";
const sha = "a".repeat(40);
let projectPath: string;
let networkCalls = 0;
const globalPaths: string[] = [];

function appAs(userId?: string) {
	const app = new Hono();
	if (userId) {
		app.use("*", async (c, next) => {
			const user = { sub: userId, role: "user" as const, iat: 0, exp: Number.MAX_SAFE_INTEGER };
			c.set("auth", { type: "session", user });
			c.set("user", user);
			await next();
		});
	}
	app.onError(
		(error) =>
			new Response(JSON.stringify({ error: error.message }), {
				status: error instanceof AppError ? error.statusCode : 500,
				headers: { "content-type": "application/json" },
			}),
	);
	app.route("/skills", skillRoutes);
	return app;
}

function request(path: string, userId?: string, body: unknown = { url }) {
	return appAs(userId).request(`http://localhost/skills${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function networkFixture(name: string) {
	networkCalls = 0;
	const raw = `---\nname: ${name}\ndescription: Route test\n---\n\nbody\n`;
	setOutboundFetchOverrideForTest(async (input) => {
		networkCalls++;
		if (String(input).includes("/git/trees/"))
			return Response.json({
				sha,
				truncated: false,
				tree: [
					{ path: "SKILL.md", type: "blob", mode: "100644", sha, size: Buffer.byteLength(raw) },
				],
			});
		return new Response(raw);
	});
	return raw;
}

beforeAll(async () => {
	projectPath = await mkdtemp(join(getNarraforkHome(), "import-routes-"));
	const now = new Date().toISOString();
	for (const id of [owner, reader, outsider, admin]) {
		await db.insert(users).values({
			id,
			username: `import-${id}`,
			passwordHash: "unused",
			role: id === admin ? "admin" : "user",
			createdAt: now,
		});
	}
	await db.insert(projects).values({
		id: projectId,
		name: "skill import",
		gitPath: projectPath,
		ownerUserId: owner,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: reader,
		capability: "read",
		createdAt: now,
	});
});

afterEach(() => setOutboundFetchOverrideForTest(null));

afterAll(async () => {
	await db.delete(aclGrants).where(eq(aclGrants.scopeId, projectId));
	await db.delete(projects).where(eq(projects.id, projectId));
	for (const id of [owner, reader, outsider, admin]) await db.delete(users).where(eq(users.id, id));
	for (const path of [projectPath, ...globalPaths])
		await rm(path, { recursive: true, force: true });
});

describe("skill import routes", () => {
	test("authentication and write authorization fail before outbound requests", async () => {
		networkFixture("unauthorized");
		expect((await request("/global/import")).status).toBe(401);
		expect((await request("/global/import", outsider)).status).toBe(403);
		expect((await request("/global/test/update-from-url", outsider)).status).toBe(403);
		expect((await request(`/import?projectId=${projectId}`)).status).toBe(401);
		expect((await request(`/import?projectId=${projectId}`, outsider)).status).toBe(404);
		expect((await request(`/import?projectId=${projectId}`, reader)).status).toBe(404);
		expect(networkCalls).toBe(0);
	});

	test("validates the body and project before outbound requests", async () => {
		networkFixture("bad-body");
		for (const body of [{}, { url: 7 }, { url: " " }, { url: "x".repeat(2049) }]) {
			expect((await request(`/import?projectId=${projectId}`, owner, body)).status).toBe(400);
		}
		expect((await request("/import", owner)).status).toBe(400);
		expect((await request("/global/import", admin, { url: "x".repeat(9000) })).status).toBe(413);
		const invalid = await appAs(admin).request("http://localhost/skills/global/import", {
			method: "POST",
			body: "{",
			headers: { "content-type": "application/json" },
		});
		expect(invalid.status).toBe(400);
		expect(networkCalls).toBe(0);
	});

	test("bounds streamed bytes even with a misleading Content-Length", async () => {
		networkFixture("oversized-stream");
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(8_193));
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = await appAs(admin).request("http://localhost/skills/global/import", {
			method: "POST",
			body,
			headers: { "content-length": "2", "content-type": "application/json" },
		});
		expect(response.status).toBe(413);
		expect(cancelled).toBe(true);
		expect(networkCalls).toBe(0);
	});

	test("times out and cancels a stalled request body before starting GitHub access", async () => {
		networkFixture("stalled-body");
		let cancelled = false;
		let shortened = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const original = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			...args: Parameters<typeof setTimeout>
		) => {
			const [fn, ms, ...rest] = args;
			if (ms === 5_000) shortened = true;
			return original(fn, ms === 5_000 ? 10 : ms, ...rest);
		}) as typeof setTimeout);
		try {
			const response = await appAs(admin).request("http://localhost/skills/global/import", {
				method: "POST",
				body,
				headers: { "content-type": "application/json" },
			});
			expect(response.status).toBe(408);
			expect(shortened).toBe(true);
			expect(cancelled).toBe(true);
			expect(networkCalls).toBe(0);
		} finally {
			timer.mockRestore();
		}
	});

	test("project owner can import and list the skill; duplicates are not overwritten", async () => {
		const raw = networkFixture("route-project-skill");
		const response = await request(`/import?projectId=${projectId}`, owner, { url: ` ${url} ` });
		expect(response.status).toBe(201);
		const skill = (await response.json()) as { name: string; location: string };
		expect(skill.name).toBe("route-project-skill");
		expect(await readFile(skill.location, "utf8")).toBe(raw);
		const list = await appAs(owner).request(`http://localhost/skills?projectId=${projectId}`);
		expect(
			((await list.json()) as Array<{ name: string }>).some((s) => s.name === skill.name),
		).toBe(true);
		expect((await request(`/import?projectId=${projectId}`, owner)).status).toBe(400);
		expect(await readFile(skill.location, "utf8")).toBe(raw);
	});

	test("global import requires an administrator and does not download for other users", async () => {
		const name = `route-global-${generateId()
			.replace(/[^a-z0-9]/gi, "")
			.toLowerCase()}`;
		networkFixture(name);
		globalPaths.push(join(getNarraforkHome(), "skills", name));
		expect((await request("/global/import", outsider)).status).toBe(403);
		expect(networkCalls).toBe(0);
		const response = await request("/global/import", admin);
		expect(response.status).toBe(201);
		expect(((await response.json()) as { name: string }).name).toBe(name);
		expect(networkCalls).toBeGreaterThan(0);
	});
});

describe("update skill from URL routes", () => {
	test("requires authentication and project write access before outbound requests", async () => {
		networkFixture("blocked-update");
		expect((await request("/global/test/update-from-url")).status).toBe(401);
		expect((await request(`/test/update-from-url?projectId=${projectId}`, reader)).status).toBe(
			404,
		);
		expect((await request(`/test/update-from-url?projectId=${projectId}`, outsider)).status).toBe(
			404,
		);
		expect((await request("/test/update-from-url", owner)).status).toBe(400);
		expect(networkCalls).toBe(0);
	});

	test("requires an explicit URL and bounds the body", async () => {
		networkFixture("invalid-url-update");
		for (const body of [{}, { url: " " }, { url: 7 }]) {
			expect(
				(await request(`/test/update-from-url?projectId=${projectId}`, owner, body)).status,
			).toBe(400);
		}
		expect(
			(await request("/global/test/update-from-url", admin, { url: "x".repeat(9000) })).status,
		).toBe(413);
		expect(networkCalls).toBe(0);
	});

	test("updates a project skill and exposes whether URL updates are supported", async () => {
		const name = "project-url-update";
		networkFixture(name);
		expect((await request(`/import?projectId=${projectId}`, owner)).status).toBe(201);
		const list = await appAs(owner).request(`http://localhost/skills?projectId=${projectId}`);
		const skill = ((await list.json()) as Array<{ name: string; canUpdateFromUrl: boolean }>).find(
			(s) => s.name === name,
		);
		expect(skill?.canUpdateFromUrl).toBe(true);
		const response = await request(`/${name}/update-from-url?projectId=${projectId}`, owner);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { name: string }).name).toBe(name);
	});

	test("global URL updates require an administrator", async () => {
		const name = `global-url-${generateId()
			.replace(/[^a-z0-9]/gi, "")
			.toLowerCase()}`;
		globalPaths.push(join(getNarraforkHome(), "skills", name));
		networkFixture(name);
		expect((await request("/global/import", admin)).status).toBe(201);
		networkFixture(name);
		expect((await request(`/global/${name}/update-from-url`, outsider)).status).toBe(403);
		expect(networkCalls).toBe(0);
		const response = await request(`/global/${name}/update-from-url`, admin);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { name: string }).name).toBe(name);
	});
});
