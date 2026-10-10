/**
 * Access boundary, route ordering and authorization handling for the Setup
 * Assistant endpoint.
 *
 * What must hold regardless of the service internals:
 *  - only admins may spawn a narrator that installs system software;
 *  - the literal `/setup-assistant` path must not be swallowed by `/:id`, which
 *    would turn the call into "fetch the narrator named setup-assistant";
 *  - an invalid authorization value is refused rather than silently downgraded,
 *    and an absent one means standard permissions — never full authority.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-setup-assistant-route-"));
process.env.NARRAFORK_HOME = testHome;
// Imported after NARRAFORK_HOME is redirected: no real user DB is opened.
const { db } = await import("../../db");
const { narratorMessages, narrators, users } = await import("../../db/schema");
const { eq } = await import("drizzle-orm");
const { generateId } = await import("../../lib/id");
const { dependencyService } = await import("../../services/dependency-service");
const session = await import("../../services/narrator-session");

// The route and narratorService.create remain real. Only host probing and the
// asynchronous Agent entry are replaced: never install software or start a provider.
const dependencyFixture: ReturnType<typeof dependencyService.checkAll> = {
	platform: "linux",
	packageManager: "apt",
	runtimeEnvironment: { android: false, proot: false, termux: false, containerSupport: true },
	allRequiredMet: false,
	dependencies: [
		{
			name: "git",
			required: true,
			installed: false,
			platformSupported: true,
			installCommands: { apt: "sudo apt-get install -y git" },
		},
	],
};
const checkAll = spyOn(dependencyService, "checkAll").mockReturnValue(dependencyFixture);
const sendMessage = spyOn(session, "sendMessage").mockImplementation(
	async (narratorId, prompt, _images, _locale, _replyInUserLanguage, _commandText, userId) => {
		const [message] = await db
			.insert(narratorMessages)
			.values({
				id: generateId(),
				narratorId,
				role: "user",
				contentJson: [{ type: "text", text: prompt }],
				createdBy: userId,
				createdAt: new Date().toISOString(),
			})
			.returning();
		return message;
	},
);
const network = spyOn(globalThis, "fetch").mockImplementation(
	Object.assign(
		async () => {
			throw new Error("Setup Assistant route tests must not access the network");
		},
		{
			preconnect: () => {
				throw new Error("Setup Assistant route tests must not preconnect to the network");
			},
		},
	),
);
const { narratorRoutes } = await import("../narrators");

beforeAll(async () => {
	const now = new Date().toISOString();
	for (const role of ["admin", "user"] as const) {
		await db.insert(users).values({
			id: `${role}-id`,
			username: `setup-assistant-${role}`,
			passwordHash: "test-only-no-login",
			role,
			createdAt: now,
		});
	}
});

beforeEach(() => {
	checkAll.mockClear();
	checkAll.mockReturnValue(structuredClone(dependencyFixture));
	sendMessage.mockClear();
});

afterAll(() => {
	checkAll.mockRestore();
	sendMessage.mockRestore();
	network.mockRestore();
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

function appForRole(role: "admin" | "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: `${role}-id`, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	});
	app.route("/narrators", narratorRoutes);
	return app;
}

function post(role: "admin" | "user", body?: unknown) {
	return appForRole(role).request("http://localhost/narrators/setup-assistant", {
		method: "POST",
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
}

async function assertCreatedNarrator(
	body: Record<string, unknown>,
	permissionMode: "default" | "bypassPermissions",
	dangerReflectionOverride: "inherit" | "strict",
) {
	const id = (body.narrator as { id: string }).id;
	const row = await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
	expect(row).toMatchObject({
		ownerUserId: "admin-id",
		visibility: "public",
		permissionMode,
		dangerReflectionOverride,
		status: "idle",
	});
	expect(row?.traits).toContain("setup");
	expect(sendMessage).toHaveBeenCalledTimes(1);
	expect(sendMessage.mock.calls[0][0]).toBe(id);
	expect(sendMessage.mock.calls[0][6]).toBe("admin-id");
	const message = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.narratorId, id),
	});
	expect(message?.createdBy).toBe("admin-id");
	expect(network).not.toHaveBeenCalled();
}

describe("setup assistant access boundary", () => {
	test("rejects a non-admin: installing system software is instance-wide", async () => {
		const response = await post("user", { authorization: "default" });
		expect(response.status).toBe(403);
		expect(checkAll).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	test("a non-admin cannot reach it by asking for full authority either", async () => {
		const response = await post("user", { authorization: "full" });
		expect(response.status).toBe(403);
		expect(checkAll).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});
});

describe("setup assistant route resolution and validation", () => {
	test("an admin request reaches the handler, not the /:id route", async () => {
		// /:id would 404 for a narrator literally named "setup-assistant". The handler
		// instead answers with the created/dependencies envelope — 201 when it spawned a
		// narrator, 200 with created:false when this machine has nothing to install.
		const response = await post("admin", { authorization: "default" });
		expect([200, 201]).toContain(response.status);
		const body = (await response.json()) as Record<string, unknown>;
		expect(typeof body.created).toBe("boolean");
		expect(body.dependencies).toBeDefined();
		expect(response.status).toBe(201);
		expect(body.created).toBe(true);
		expect(body.dependencies).toEqual(dependencyFixture);
		await assertCreatedNarrator(body, "default", "inherit");
	});

	test("an unknown authorization value is refused, not downgraded", async () => {
		const response = await post("admin", { authorization: "bypassEverything" });
		expect(response.status).toBe(400);
		expect(checkAll).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	test("a bodyless POST is accepted and never means full authority", async () => {
		const response = await post("admin");
		expect([200, 201]).toContain(response.status);
		const body = (await response.json()) as Record<string, unknown>;
		// created:false (nothing missing) carries no authorization; when it did create
		// one, the echoed authorization must be the standard level.
		if (body.created === true) expect(body.authorization).toBe("default");
		expect(response.status).toBe(201);
		expect(body.created).toBe(true);
		await assertCreatedNarrator(body, "default", "inherit");
	});

	test("installed dependencies return created:false without creating or starting a narrator", async () => {
		const installed = structuredClone(dependencyFixture);
		installed.allRequiredMet = true;
		installed.dependencies[0].installed = true;
		checkAll.mockReturnValue(installed);
		const before = await db.select({ id: narrators.id }).from(narrators);
		const response = await post("admin");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ created: false, dependencies: installed });
		expect(await db.select({ id: narrators.id }).from(narrators)).toEqual(before);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	test("only an explicit admin full request persists bypass permissions with strict reflection", async () => {
		const response = await post("admin", { authorization: "full" });
		expect(response.status).toBe(201);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.authorization).toBe("full");
		expect(body.created).toBe(true);
		await assertCreatedNarrator(body, "bypassPermissions", "strict");
	});
});
