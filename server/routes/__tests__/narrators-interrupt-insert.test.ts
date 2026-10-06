/**
 * The interrupt-and-insert path must expose a settled boundary. The frontend
 * sends the replacement message only after this boundary so the interrupted-task
 * guard is ordered before the new user message.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-interrupt-insert-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const sessionModule = { ...(await import("../../services/narrator-session")) };
let settled = true;
let interruptResult = true;
mock.module("../../services/narrator-session", () => ({
	...sessionModule,
	interruptNarrator: () => interruptResult,
	interruptAndWaitForIdle: async () => settled,
}));

const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { narrators, users } = await import("../../db/schema");
const { eq } = await import("drizzle-orm");

const OWNER = "interrupt-insert-owner";
const NARRATOR_ID = "interrupt-insert-primary";

function app() {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: OWNER, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	instance.route("/narrators", narratorRoutes);
	return instance;
}

beforeAll(async () => {
	const now = new Date().toISOString();
	await db.insert(users).values({
		id: OWNER,
		username: `${OWNER}-${Date.now()}`,
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});
	await db.insert(narrators).values({
		id: NARRATOR_ID,
		title: "interrupt insert primary",
		ownerUserId: OWNER,
		visibility: "private",
		status: "working",
		variant: "primary",
		createdAt: now,
		updatedAt: now,
	});
});

beforeEach(async () => {
	settled = true;
	interruptResult = true;
	await db
		.update(narrators)
		.set({ status: "working", variant: "primary", substatus: "[]" })
		.where(eq(narrators.id, NARRATOR_ID));
});

afterAll(() => {
	mock.module("../../services/narrator-session", () => sessionModule);
	mock.restore();
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

describe("interrupt-and-insert HTTP boundary", () => {
	test("waitForIdle returns settled true for the replacement-send boundary", async () => {
		const response = await app().request(
			`http://localhost/narrators/${NARRATOR_ID}/interrupt?waitForIdle=1`,
			{ method: "POST" },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ interrupted: true, settled: true });
	});

	test("waitForIdle treats an already-idle narrator as settled", async () => {
		interruptResult = false;
		await db.update(narrators).set({ status: "idle" }).where(eq(narrators.id, NARRATOR_ID));

		const response = await app().request(
			`http://localhost/narrators/${NARRATOR_ID}/interrupt?waitForIdle=1`,
			{ method: "POST" },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ interrupted: false, settled: true });
	});

	test("waitForIdle fails closed when the old loop has not settled", async () => {
		settled = false;
		const response = await app().request(
			`http://localhost/narrators/${NARRATOR_ID}/interrupt?waitForIdle=1`,
			{ method: "POST" },
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ interrupted: true, settled: false });
	});

	test("default interrupt remains the immediate compatibility contract", async () => {
		const response = await app().request(`http://localhost/narrators/${NARRATOR_ID}/interrupt`, {
			method: "POST",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ interrupted: true });
	});
});
