/**
 * `GET/POST /api/outline/narrators/:narratorId/spec-import` (outline P2 PR 12b): the Spec panel's
 * import banner.
 *
 * What must hold:
 *  - the owner of a Dynamic Spec session reads that it is importable and may start the import;
 *    the POST answers 202 at once and the session is an outline session once the import settled;
 *  - someone who cannot read the session gets the same 404 as for an unknown one, and nothing
 *    is started; a reader without write access reads the state (`canImport` false) and is
 *    refused the POST (403);
 *  - a second POST while the session is an outline session starts nothing;
 *  - with `outline.enabled` off the routes are a plain 404.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import type { OutlineSpecImportStatus } from "@shared/outline-spec-import";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { settings } from "../../lib/settings";
import { stopEditTextWorker } from "../../services/outline/edit-text-runner";
import {
	backendOf,
	commitCount,
	makeSession,
	makeUser,
	taskPage,
	writeTasks,
} from "../../services/outline/spec-import/__tests__/fixtures";
import { resetSpecImportRecords } from "../../services/outline/spec-import/importer";
import { settleSpecImportRequests } from "../../services/outline/spec-import/triggers";
import { invalidateTaskBackend } from "../../services/task-source";
import { outlineRoutes } from "../outline";

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
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
	app.route("/outline", outlineRoutes);
	return app;
}

async function call(userId: string, method: "GET" | "POST", narratorId: string) {
	const response = await appAs(userId).request(
		`http://localhost/outline/narrators/${narratorId}/spec-import`,
		{ method },
	);
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// A plain 404 has a text body.
	}
	return { status: response.status, body: body as OutlineSpecImportStatus };
}

beforeEach(() => {
	settings.outline.enabled = true;
	settings.outline.specImport = "auto";
	invalidateTaskBackend();
	resetSpecImportRecords();
});
afterAll(async () => {
	await settleSpecImportRequests();
	stopEditTextWorker();
});

test("the owner reads the state, starts the import and the session is moved", async () => {
	const { id, owner } = await makeSession();
	await writeTasks(id, [{ text: "a" }, { text: "b", status: "doing" }]);
	const before = await call(owner as string, "GET", id);
	expect(before.status).toBe(200);
	expect(before.body).toMatchObject({
		mode: "auto",
		importable: true,
		canImport: true,
		state: "idle",
	});
	const started = await call(owner as string, "POST", id);
	expect(started.status).toBe(202);
	expect(["running", "imported"]).toContain(started.body.state);
	await settleSpecImportRequests();
	expect(await backendOf(id)).toBe("outline");
	expect((await taskPage(id)).map((t) => t.text)).toEqual(["a", "b"]);
	const after = await call(owner as string, "GET", id);
	expect(after.body).toMatchObject({ importable: false, state: "imported" });
	// Asked again: nothing is started, nothing written.
	const commits = await commitCount(id);
	expect((await call(owner as string, "POST", id)).body.importable).toBe(false);
	await settleSpecImportRequests();
	expect(await commitCount(id)).toBe(commits);
});

test("who cannot read the session gets a 404 and starts nothing; a reader without write access is refused", async () => {
	const { id } = await makeSession();
	await writeTasks(id, [{ text: "private" }]);
	const stranger = await makeUser();
	expect((await call(stranger, "GET", id)).status).toBe(404);
	expect((await call(stranger, "POST", id)).status).toBe(404);
	expect((await call(stranger, "GET", "no-such-narrator")).status).toBe(404);
	// Readable by everyone, writable by its owner only.
	await db
		.update(narrators)
		.set({ visibility: "public", writeAudience: "owner" })
		.where(eq(narrators.id, id));
	const read = await call(stranger, "GET", id);
	expect(read.status).toBe(200);
	expect(read.body).toMatchObject({ importable: true, canImport: false });
	expect((await call(stranger, "POST", id)).status).toBe(403);
	await settleSpecImportRequests();
	expect(await backendOf(id)).toBe("spec");
	expect(await commitCount(id)).toBe(0);
});

test("with the outline off the routes are a plain 404", async () => {
	const { id, owner } = await makeSession();
	settings.outline.enabled = false;
	expect((await call(owner as string, "GET", id)).status).toBe(404);
	expect((await call(owner as string, "POST", id)).status).toBe(404);
	expect(await backendOf(id)).toBe("spec");
});
