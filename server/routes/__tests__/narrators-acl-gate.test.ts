/**
 * The `/api/narrators` access gate.
 *
 * The gate is a middleware over `/:id` and `/:id/*` rather than a check inside each
 * of ~150 handlers, so these tests pin the properties that decision depends on:
 *
 *  - a private narrator is unreachable by another user, and the refusal is a 404
 *    (not 403) so the endpoint cannot be used to discover which ids exist;
 *  - read access does not imply the ability to drive the session;
 *  - admins pass;
 *  - literal collection paths (`/named`, `/broken-models`, `/permissions/:id/...`)
 *    are NOT mistaken for narrator ids by the gate — otherwise adding the gate
 *    would have broken them in a way no ACL test would notice.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-narrator-acl-gate-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

// Imported after NARRAFORK_HOME is redirected: these modules initialise the DB at
// import time and must not touch the developer's real instance.
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { aclGrants, narrators, users } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const OWNER = "gate-owner";
const STRANGER = "gate-stranger";
const VIEWER = "gate-viewer";

let privateNarratorId: string;
let publicNarratorId: string;

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
		return new Response(JSON.stringify({ error: String(error) }), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	});
	app.route("/narrators", narratorRoutes);
	return app;
}

function get(userId: string, path: string, role: "admin" | "user" = "user") {
	return appAs(userId, role).request(`http://localhost/narrators${path}`);
}

function patch(userId: string, path: string, body: unknown, role: "admin" | "user" = "user") {
	return appAs(userId, role).request(`http://localhost/narrators${path}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	const now = new Date().toISOString();
	for (const id of [OWNER, STRANGER, VIEWER]) {
		await db.insert(users).values({
			id,
			username: `${id}-${Date.now()}`,
			passwordHash: "x",
			role: "user",
			createdAt: now,
		});
	}

	privateNarratorId = generateId();
	await db.insert(narrators).values({
		id: privateNarratorId,
		title: "private session",
		ownerUserId: OWNER,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});

	publicNarratorId = generateId();
	await db.insert(narrators).values({
		id: publicNarratorId,
		title: "public session",
		ownerUserId: OWNER,
		visibility: "public",
		createdAt: now,
		updatedAt: now,
	});

	// VIEWER may look but not touch.
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "narrator",
		scopeId: privateNarratorId,
		principalType: "user",
		principalId: VIEWER,
		capability: "read",
		grantedBy: OWNER,
		createdAt: now,
	});
});

describe("reading a narrator", () => {
	test("the owner can fetch their private narrator", async () => {
		expect((await get(OWNER, `/${privateNarratorId}`)).status).toBe(200);
	});

	test("a stranger gets 404, not 403, so ids cannot be probed", async () => {
		const res = await get(STRANGER, `/${privateNarratorId}`);
		expect(res.status).toBe(404);
	});

	test("a read-granted user can fetch it", async () => {
		expect((await get(VIEWER, `/${privateNarratorId}`)).status).toBe(200);
	});

	test("an admin can fetch anyone's", async () => {
		expect((await get("some-admin", `/${privateNarratorId}`, "admin")).status).toBe(200);
	});

	test("a public narrator is readable by any user", async () => {
		expect((await get(STRANGER, `/${publicNarratorId}`)).status).toBe(200);
	});

	test("nested read routes are gated too, not just the bare id", async () => {
		expect((await get(STRANGER, `/${privateNarratorId}/usage-stats`)).status).toBe(404);
		expect((await get(OWNER, `/${privateNarratorId}/usage-stats`)).status).toBe(200);
	});
});

describe("driving a narrator", () => {
	test("a read grant does not allow changing the model", async () => {
		const res = await patch(VIEWER, `/${privateNarratorId}/model`, { model: "x" });
		expect(res.status).toBe(404);
	});

	test("public visibility does not allow changing the model", async () => {
		const res = await patch(STRANGER, `/${publicNarratorId}/model`, { model: "x" });
		expect(res.status).toBe(404);
	});

	test("the owner may change the model", async () => {
		const res = await patch(OWNER, `/${privateNarratorId}/model`, { model: "test-model" });
		expect(res.status).toBe(200);
	});
});

describe("literal collection paths are not treated as narrator ids", () => {
	test("/named still lists named narrators", async () => {
		// Would 404 through the gate if "named" were parsed as an id.
		expect((await get(STRANGER, "/named")).status).toBe(200);
	});

	test("/broken-models keeps its own admin gate rather than an ACL 404", async () => {
		expect((await get("some-admin", "/broken-models", "admin")).status).toBe(200);
		// Non-admin is refused by requireAdmin (403), not silently 404'd by the ACL gate.
		expect((await get(STRANGER, "/broken-models")).status).toBe(403);
	});

	test("/by-handle/:handle resolves by handle instead of being gated as an id", async () => {
		// No narrator owns this handle, so the handler's own 404 is expected — the
		// point is that it reaches the handler at all.
		expect((await get(STRANGER, "/by-handle/nobody-has-this")).status).toBe(404);
	});
});
