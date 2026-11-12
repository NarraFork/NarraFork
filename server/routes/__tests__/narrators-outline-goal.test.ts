/**
 * Editing a queued message into `/goal`: a session whose tasks live in the outline runs it (outline
 * P2 PR 5: a person-created, locked task), as a spec session does. An outline subagent has no tasks
 * of its own, so the edit is refused for it, as sending one is: the consumer would otherwise reach
 * a `/goal` it cannot run.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-outline-goal-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

// Imported after NARRAFORK_HOME is redirected so the DB never touches a real instance.
const { narratorRoutes } = await import("../narrators");
const { db } = await import("../../db");
const { narrators, users } = await import("../../db/schema");
const { settings } = await import("../../lib/settings");
const { enqueueBufferedMessage, getBufferedMessagesAsync } = await import(
	"../../services/narrator-buffer"
);

const OWNER = "outline-goal-owner";
const OUTLINE = "outline-goal-outline";
const SPEC = "outline-goal-spec";
const SUBAGENT = "outline-goal-subagent";

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

beforeAll(async () => {
	const now = new Date().toISOString();
	await db.insert(users).values({
		id: OWNER,
		username: `${OWNER}-${Date.now()}`,
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});
	const base = { ownerUserId: OWNER, visibility: "private", status: "working" } as const;
	await db.insert(narrators).values([
		{ id: OUTLINE, ...base, taskBackend: "outline", createdAt: now, updatedAt: now },
		{ id: SPEC, ...base, taskBackend: "spec", createdAt: now, updatedAt: now },
		{
			id: SUBAGENT,
			...base,
			type: "subagent",
			parentNarratorId: OUTLINE,
			aclRootNarratorId: OUTLINE,
			taskBackend: "outline",
			createdAt: now,
			updatedAt: now,
		},
	]);
});

beforeEach(() => {
	settings.outline.enabled = true;
});

function app() {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: OWNER, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.onError((error) => {
		const status = error instanceof AppError ? error.statusCode : 500;
		return new Response(
			JSON.stringify({
				error: error.message,
				messageCode: error instanceof AppError ? error.messageCode : undefined,
			}),
			{ status },
		);
	});
	instance.route("/narrators", narratorRoutes);
	return instance;
}

function edit(narratorId: string, messageId: string, text: string) {
	return app().request(`http://localhost/narrators/${narratorId}/buffer/${messageId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
}

const texts = async (narratorId: string) =>
	(await getBufferedMessagesAsync(narratorId)).map((message) => message.text);

test("an outline session's queued message can be edited into /goal (outline P2 PR 5)", async () => {
	const queued = await enqueueBufferedMessage(OUTLINE, "fix the build");
	expect((await edit(OUTLINE, queued.id, "/goal ship the release")).status).toBe(200);
	expect(await texts(OUTLINE)).toEqual(["/goal ship the release"]);
});

test("an outline subagent's queued message cannot be edited into /goal", async () => {
	const queued = await enqueueBufferedMessage(SUBAGENT, "fix the build");
	const response = await edit(SUBAGENT, queued.id, "/goal ship the release");
	expect(response.status).toBe(409);
	expect(((await response.json()) as { messageCode?: string }).messageCode).toBe(
		"GOAL_IN_OUTLINE_SESSION",
	);
	expect(await texts(SUBAGENT)).toEqual(["fix the build"]);
	// Any other wording is an ordinary edit.
	expect((await edit(SUBAGENT, queued.id, "fix the build, then the docs")).status).toBe(200);
	expect(await texts(SUBAGENT)).toEqual(["fix the build, then the docs"]);
});

test("a spec session's edit into /goal goes through as before", async () => {
	const queued = await enqueueBufferedMessage(SPEC, "fix the build");
	expect((await edit(SPEC, queued.id, "/goal ship the release")).status).toBe(200);
	expect(await texts(SPEC)).toEqual(["/goal ship the release"]);
});
