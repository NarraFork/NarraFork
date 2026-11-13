/**
 * `/api/admin/outline/spec-import` (outline P2 PR 12b2): the Dynamic Spec import's admin page,
 * re-import and move back, and how the Spec panel's routes treat a moved-back session.
 *
 * What must hold:
 *  - administrators only (the live role): anyone else gets 403 and nothing happens;
 *  - the list reads one state a page at a time, with the counts and the mode; bad input is 400;
 *  - re-import answers 202 at once and the session is moved; move back answers what it did, a
 *    second move back is 409 with its code;
 *  - for a moved-back session the owner's banner offers no import (and the owner's POST starts
 *    none); an administrator's does;
 *  - with the outline off the routes are a plain 404.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type {
	OutlineSpecImportAdminPage,
	OutlineSpecImportStatus,
} from "@shared/outline-spec-import";
import { Hono } from "hono";
import { db } from "../../db";
import { users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { stopEditTextWorker } from "../../services/outline/edit-text-runner";
import {
	backendOf,
	makeSession,
	writeTasks,
} from "../../services/outline/spec-import/__tests__/fixtures";
import { resetSpecImportRecords } from "../../services/outline/spec-import/importer";
import { settleSpecImportRequests } from "../../services/outline/spec-import/triggers";
import { invalidateTaskBackend } from "../../services/task-source";
import { outlineSpecImportAdminRoutes } from "../admin-outline-spec-import";
import { outlineRoutes } from "../outline";

async function makeAdmin(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `adm${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "admin",
		createdAt: "2026-11-12T00:00:00.000Z",
	});
	return id;
}

function appAs(userId: string, role: "admin" | "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(
				JSON.stringify({ error: error.message, code: error.code, messageCode: error.messageCode }),
				{ status: error.statusCode, headers: { "content-type": "application/json" } },
			);
		}
		return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
	});
	app.route("/admin/outline/spec-import", outlineSpecImportAdminRoutes);
	app.route("/outline", outlineRoutes);
	return app;
}

async function call<T>(
	userId: string,
	role: "admin" | "user",
	method: "GET" | "POST",
	path: string,
): Promise<{ status: number; body: T }> {
	const response = await appAs(userId, role).request(`http://localhost${path}`, { method });
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// A plain 404 has a text body.
	}
	return { status: response.status, body: body as T };
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

describe("the admin routes", () => {
	test("re-import, list and move back, administrators only", async () => {
		const admin = await makeAdmin();
		const { id, owner } = await makeSession();
		await writeTasks(id, [{ text: "a" }]);
		const base = "/admin/outline/spec-import";

		// Someone else: refused, nothing started.
		expect((await call(owner as string, "user", "GET", `${base}?state=attention`)).status).toBe(
			403,
		);
		expect((await call(owner as string, "user", "POST", `${base}/${id}/reimport`)).status).toBe(
			403,
		);
		expect((await call(owner as string, "user", "POST", `${base}/${id}/revert`)).status).toBe(403);
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("spec");

		const started = await call<OutlineSpecImportStatus>(
			admin,
			"admin",
			"POST",
			`${base}/${id}/reimport`,
		);
		expect(started.status).toBe(202);
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("outline");

		const page = await call<OutlineSpecImportAdminPage>(
			admin,
			"admin",
			"GET",
			`${base}?state=imported&limit=50`,
		);
		expect(page.status).toBe(200);
		expect(page.body.mode).toBe("auto");
		expect(page.body.countCap).toBe(1000);
		expect(page.body.counts.imported).toBeGreaterThanOrEqual(1);
		expect(page.body.items.find((item) => item.narratorId === id)).toMatchObject({
			state: "imported",
			canRevert: true,
		});
		expect((await call(admin, "admin", "GET", `${base}?state=nonsense`)).status).toBe(400);
		expect((await call(admin, "admin", "GET", `${base}?limit=500`)).status).toBe(400);

		const reverted = await call(admin, "admin", "POST", `${base}/${id}/revert`);
		expect(reverted.status).toBe(200);
		expect(reverted.body).toMatchObject({ reverted: true, marked: true });
		expect(await backendOf(id)).toBe("spec");
		const again = await call<{ code: string; messageCode: string }>(
			admin,
			"admin",
			"POST",
			`${base}/${id}/revert`,
		);
		expect(again.status).toBe(409);
		expect(again.body.messageCode).toBe("SPEC_IMPORT_NOT_REVERTIBLE");

		// The owner's banner: no import for a moved-back session; an administrator's has one.
		const ownerView = await call<OutlineSpecImportStatus>(
			owner as string,
			"user",
			"GET",
			`/outline/narrators/${id}/spec-import`,
		);
		expect(ownerView.body).toMatchObject({ state: "reverted", importable: true, canImport: false });
		const pressed = await call<OutlineSpecImportStatus>(
			owner as string,
			"user",
			"POST",
			`/outline/narrators/${id}/spec-import`,
		);
		expect(pressed.body.state).toBe("reverted");
		await settleSpecImportRequests();
		expect(await backendOf(id)).toBe("spec");
		const adminView = await call<OutlineSpecImportStatus>(
			admin,
			"admin",
			"GET",
			`/outline/narrators/${id}/spec-import`,
		);
		expect(adminView.body.canImport).toBe(true);
	});

	test("with the outline off the routes are a plain 404", async () => {
		const admin = await makeAdmin();
		settings.outline.enabled = false;
		const response = await call(admin, "admin", "GET", "/admin/outline/spec-import");
		expect(response.status).toBe(404);
	});
});
