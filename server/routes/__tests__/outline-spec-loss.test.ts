/**
 * The routes of the swallowed-content scan (outline P2 PR 12c): the admin page's
 * (`/api/admin/outline/spec-import/loss…`) and a session's
 * (`/api/outline/narrators/:id/spec-import/loss…`).
 *
 * What must hold:
 *  - the admin routes are administrators' only (403 otherwise, nothing happens); they list every
 *    session's findings with the scan's state, read one, decide one, and start a pass (202,
 *    answered before anything is scanned);
 *  - a session's routes: a reader lists and reads the session's findings and may not decide
 *    (403); a writer decides; someone who cannot read the session gets 404; a finding of another
 *    session is 404 under this one;
 *  - lists never carry the lost text; bad input is 400; a second decision is 409 with its code;
 *  - with the outline off the routes are a plain 404.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type {
	OutlineSpecLossDetail,
	OutlineSpecLossFinding,
	OutlineSpecLossPage,
	OutlineSpecLossScanStatus,
} from "@shared/outline-spec-import";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { narrators, outlineSpecLossScans, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { stopEditTextWorker } from "../../services/outline/edit-text-runner";
import { makeSession, makeUser } from "../../services/outline/spec-import/__tests__/fixtures";
import { resetSpecImportRecords } from "../../services/outline/spec-import/importer";
import {
	resetSpecLossScanState,
	scanSpecSessionLossById,
	settleSpecLossPass,
} from "../../services/outline/spec-import/loss-scan";
import { readSpecLossScan } from "../../services/outline/spec-import/loss-store";
import { writeSpecFile } from "../../services/spec-vfs-service";
import { invalidateTaskBackend } from "../../services/task-source";
import { outlineSpecImportAdminRoutes } from "../admin-outline-spec-import";
import { outlineRoutes } from "../outline";

const TABLE = "| name | value |\n| --- | --- |\n| alpha | 1 |";
const ADMIN = "/admin/outline/spec-import";

async function makeAdmin(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `adm${id.replace(/[^A-Za-z0-9]/g, "")}`,
		passwordHash: "x",
		role: "admin",
		createdAt: "2026-11-13T00:00:00.000Z",
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
	body?: unknown,
): Promise<{ status: number; body: T }> {
	const response = await appAs(userId, role).request(`http://localhost${path}`, {
		method,
		...(body === undefined
			? {}
			: { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
	});
	const text = await response.text();
	let parsed: unknown = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// A plain 404 has a text body.
	}
	return { status: response.status, body: parsed as T };
}

/** A session whose owner's save dropped a table, scanned. */
async function scanned(options: { scan?: boolean } = {}): Promise<{ id: string; owner: string }> {
	const { id, owner } = await makeSession();
	await writeSpecFile(id, "spec://design.md", `intro\n\n${TABLE}\n`, {
		actor: "agent",
		createdBy: "assistant",
	});
	await writeSpecFile(id, "spec://design.md", "intro\n", { actor: "user", createdBy: "user" });
	if (options.scan !== false) await scanSpecSessionLossById(id);
	return { id, owner: owner as string };
}

beforeEach(async () => {
	settings.outline.enabled = true;
	settings.outline.specImport = "manual";
	invalidateTaskBackend();
	resetSpecImportRecords();
	resetSpecLossScanState();
	await db.delete(outlineSpecLossScans);
});
afterAll(async () => {
	await settleSpecLossPass();
	stopEditTextWorker();
});

describe("the admin routes", () => {
	test("administrators only: list, read, decide", async () => {
		const admin = await makeAdmin();
		const { id, owner } = await scanned();
		for (const [method, path, body] of [
			["GET", `${ADMIN}/loss`, undefined],
			["POST", `${ADMIN}/loss-scan`, undefined],
		] as const)
			expect((await call(owner, "user", method, path, body)).status).toBe(403);

		const page = await call<OutlineSpecLossPage>(admin, "admin", "GET", `${ADMIN}/loss?limit=50`);
		expect(page.status).toBe(200);
		expect(page.body.canAct).toBe(true);
		expect(page.body.scan).toMatchObject({ running: false });
		expect(page.body.countCap).toBe(1000);
		const finding = page.body.items.find((item) => item.narratorId === id);
		expect(finding).toMatchObject({ path: "design.md", status: "open", kinds: { table: 1 } });
		expect(JSON.stringify(page.body)).not.toContain("alpha");
		const findingId = finding?.id as string;

		expect((await call(owner, "user", "GET", `${ADMIN}/loss/${findingId}`)).status).toBe(403);
		expect(
			(await call(owner, "user", "POST", `${ADMIN}/loss/${findingId}`, { action: "dismiss" }))
				.status,
		).toBe(403);

		const detail = await call<OutlineSpecLossDetail>(
			admin,
			"admin",
			"GET",
			`${ADMIN}/loss/${findingId}`,
		);
		expect(detail.body.parts).toEqual([{ kind: "table", text: TABLE }]);
		expect((await call(admin, "admin", "GET", `${ADMIN}/loss/nosuchfinding`)).status).toBe(404);

		expect((await call(admin, "admin", "GET", `${ADMIN}/loss?status=nonsense`)).status).toBe(400);
		expect((await call(admin, "admin", "GET", `${ADMIN}/loss?limit=500`)).status).toBe(400);
		expect(
			(await call(admin, "admin", "POST", `${ADMIN}/loss/${findingId}`, { action: "fix" })).status,
		).toBe(400);

		// Still in Dynamic Spec: nothing to attach to.
		const attach = await call<{ messageCode: string }>(
			admin,
			"admin",
			"POST",
			`${ADMIN}/loss/${findingId}`,
			{ action: "attach" },
		);
		expect(attach.status).toBe(409);
		expect(attach.body.messageCode).toBe("SPEC_LOSS_NOT_IMPORTED");

		const dismissed = await call<OutlineSpecLossFinding>(
			admin,
			"admin",
			"POST",
			`${ADMIN}/loss/${findingId}`,
			{ action: "dismiss" },
		);
		expect(dismissed.status).toBe(200);
		expect(dismissed.body.status).toBe("dismissed");
		const again = await call<{ messageCode: string }>(
			admin,
			"admin",
			"POST",
			`${ADMIN}/loss/${findingId}`,
			{ action: "dismiss" },
		);
		expect(again.status).toBe(409);
		expect(again.body.messageCode).toBe("SPEC_LOSS_DECIDED");
		const listed = await call<OutlineSpecLossPage>(
			admin,
			"admin",
			"GET",
			`${ADMIN}/loss?status=dismissed&limit=50`,
		);
		expect(listed.body.items.some((item) => item.id === findingId)).toBe(true);
	});

	test("scan now: 202 at once, the pass runs afterwards", async () => {
		const admin = await makeAdmin();
		const { id } = await scanned({ scan: false });
		const started = await call<OutlineSpecLossScanStatus>(
			admin,
			"admin",
			"POST",
			`${ADMIN}/loss-scan`,
		);
		expect(started.status).toBe(202);
		expect(started.body.running).toBe(true);
		expect(await readSpecLossScan(id)).toBeNull();
		await settleSpecLossPass();
		expect(await readSpecLossScan(id)).toMatchObject({ findings: 1 });

		settings.outline.specImport = "off";
		const off = await call<{ messageCode: string }>(admin, "admin", "POST", `${ADMIN}/loss-scan`);
		expect(off.status).toBe(409);
		expect(off.body.messageCode).toBe("SPEC_IMPORT_OFF");
	});

	test("with the outline off the routes are a plain 404", async () => {
		const admin = await makeAdmin();
		settings.outline.enabled = false;
		expect((await call(admin, "admin", "GET", `${ADMIN}/loss`)).status).toBe(404);
		expect((await call(admin, "admin", "POST", `${ADMIN}/loss-scan`)).status).toBe(404);
	});
});

describe("a session's routes", () => {
	test("the owner lists, reads and decides; a stranger sees nothing", async () => {
		const { id, owner } = await scanned();
		const base = `/outline/narrators/${id}/spec-import/loss`;
		const page = await call<OutlineSpecLossPage>(owner, "user", "GET", base);
		expect(page.status).toBe(200);
		expect(page.body).toMatchObject({ canAct: true, counts: { open: 1 } });
		expect(page.body.scan).toBeUndefined();
		expect(JSON.stringify(page.body)).not.toContain("alpha");
		const findingId = page.body.items[0]?.id as string;

		const stranger = await makeUser();
		expect((await call(stranger, "user", "GET", base)).status).toBe(404);
		expect((await call(stranger, "user", "GET", `${base}/${findingId}`)).status).toBe(404);
		expect(
			(await call(stranger, "user", "POST", `${base}/${findingId}`, { action: "dismiss" })).status,
		).toBe(404);

		// Another session's finding is not this session's.
		const other = await scanned();
		const otherBase = `/outline/narrators/${other.id}/spec-import/loss`;
		expect((await call(other.owner, "user", "GET", `${otherBase}/${findingId}`)).status).toBe(404);
		expect(
			(await call(other.owner, "user", "POST", `${otherBase}/${findingId}`, { action: "dismiss" }))
				.status,
		).toBe(404);

		const detail = await call<OutlineSpecLossDetail>(owner, "user", "GET", `${base}/${findingId}`);
		expect(detail.body.parts[0]?.text).toBe(TABLE);
		expect((await call(owner, "user", "POST", `${base}/${findingId}`, {})).status).toBe(400);
		const dismissed = await call<OutlineSpecLossFinding>(
			owner,
			"user",
			"POST",
			`${base}/${findingId}`,
			{ action: "dismiss" },
		);
		expect(dismissed.body.status).toBe("dismissed");
		const reopened = await call<OutlineSpecLossFinding>(
			owner,
			"user",
			"POST",
			`${base}/${findingId}`,
			{ action: "reopen" },
		);
		expect(reopened.body.status).toBe("open");
	});

	test("a reader who may not write reads the findings and decides nothing", async () => {
		const { id } = await scanned();
		// Public to read: anyone signed in reads it, only its owner writes.
		await db.update(narrators).set({ visibility: "public" }).where(eq(narrators.id, id));
		const reader = await makeUser();
		const base = `/outline/narrators/${id}/spec-import/loss`;
		const page = await call<OutlineSpecLossPage>(reader, "user", "GET", base);
		expect(page.status).toBe(200);
		expect(page.body.canAct).toBe(false);
		const findingId = page.body.items[0]?.id as string;
		expect((await call(reader, "user", "GET", `${base}/${findingId}`)).status).toBe(200);
		expect(
			(await call(reader, "user", "POST", `${base}/${findingId}`, { action: "dismiss" })).status,
		).toBe(403);
		const after = await call<OutlineSpecLossPage>(reader, "user", "GET", base);
		expect(after.body.counts.open).toBe(1);
	});
});
