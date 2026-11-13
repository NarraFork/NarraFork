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
 *  - a finding of the behavior fence is attached only with `confirmRule` (409 with its code
 *    otherwise, on both routes); every decision is 409 while an import works on the session;
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
import {
	importSpecSession,
	resetSpecImportRecords,
} from "../../services/outline/spec-import/importer";
import { attachSpecLossForSession } from "../../services/outline/spec-import/loss-attach";
import {
	resetSpecLossScanState,
	scanSpecSessionLossById,
	settleSpecLossPass,
} from "../../services/outline/spec-import/loss-scan";
import { readSpecLossScan } from "../../services/outline/spec-import/loss-store";
import { readSpecImportSession } from "../../services/outline/spec-import/read-port";
import { writeSpecFile } from "../../services/spec-vfs-service";
import { invalidateTaskBackend } from "../../services/task-source";
import { beginSpecImport } from "../../services/task-source/backend";
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
	// The saves of these cases count as made with the old editor.
	settings.outline.specLossCutoff = "2999-01-01T00:00:00.000Z";
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

	test("an imported session: the attached finding is dismissed and reopened through the route", async () => {
		const { id, owner } = await scanned({ scan: false });
		await writeSpecFile(id, "spec://tasks.json", JSON.stringify({ tasks: [{ text: "a" }] }), {
			actor: "agent",
			createdBy: "assistant",
		});
		expect(await importSpecSession(id, { trigger: "manual" })).toMatchObject({
			status: "imported",
		});
		await scanSpecSessionLossById(id);
		const session = await readSpecImportSession(id);
		if (!session) throw new Error("no session");
		expect(await attachSpecLossForSession(session)).toEqual({ attached: 1, left: 0 });
		const base = `/outline/narrators/${id}/spec-import/loss`;
		const page = await call<OutlineSpecLossPage>(owner, "user", "GET", `${base}?status=attached`);
		expect(page.body.counts).toEqual({ open: 0, attached: 1, dismissed: 0 });
		const finding = page.body.items[0];
		expect(finding?.blockId).toBeString();
		expect(finding?.spaceId).toBeString();
		// Attached already: a person's attach has nothing to do.
		const attach = await call<{ messageCode: string }>(
			owner,
			"user",
			"POST",
			`${base}/${finding?.id}`,
			{ action: "attach" },
		);
		expect(attach.status).toBe(409);
		expect(attach.body.messageCode).toBe("SPEC_LOSS_DECIDED");
		const dismissed = await call<OutlineSpecLossFinding>(
			owner,
			"user",
			"POST",
			`${base}/${finding?.id}`,
			{ action: "dismiss" },
		);
		expect(dismissed.body).toMatchObject({ status: "dismissed", blockId: null });
		const reopened = await call<OutlineSpecLossFinding>(
			owner,
			"user",
			"POST",
			`${base}/${finding?.id}`,
			{ action: "reopen" },
		);
		expect(reopened.body.status).toBe("attached");
		expect(reopened.body.blockId).toBeString();
	});

	test("a finding of the behavior fence: attach is 409 until the request carries the confirmation; 409 while an import runs", async () => {
		const { id, owner } = await makeSession();
		const userId = owner as string;
		await writeSpecFile(id, "spec://tasks.json", JSON.stringify({ tasks: [{ text: "a" }] }), {
			actor: "agent",
			createdBy: "assistant",
		});
		await writeSpecFile(id, "spec://behavior_fence", `Rules\n\n${TABLE}\n`, {
			actor: "user",
			createdBy: "user",
		});
		await writeSpecFile(id, "spec://behavior_fence", "Rules\n", {
			actor: "user",
			createdBy: "user",
		});
		expect(await importSpecSession(id, { trigger: "manual" })).toMatchObject({
			status: "imported",
		});
		await scanSpecSessionLossById(id);
		const session = await readSpecImportSession(id);
		if (!session) throw new Error("no session");
		// A pass attaches nothing of it.
		expect(await attachSpecLossForSession(session)).toEqual({ attached: 0, left: 0 });
		const base = `/outline/narrators/${id}/spec-import/loss`;
		const page = await call<OutlineSpecLossPage>(userId, "user", "GET", `${base}?status=open`);
		const finding = page.body.items[0];
		expect(finding).toMatchObject({
			path: "behavior_fence",
			attachNote: "rule_page",
			rulePage: true,
			attachable: true,
		});
		const post = (body: unknown) =>
			call<OutlineSpecLossFinding & { messageCode?: string }>(
				userId,
				"user",
				"POST",
				`${base}/${finding?.id}`,
				body,
			);
		const refused = await post({ action: "attach" });
		expect(refused.status).toBe(409);
		expect(refused.body.messageCode).toBe("SPEC_LOSS_RULE_CONFIRM");
		expect((await post({ action: "attach", confirmRule: false })).status).toBe(409);
		expect((await post({ action: "attach", confirmRule: "yes" })).status).toBe(400);
		// An import working on the session: not now, whatever is asked.
		const end = beginSpecImport(id);
		try {
			for (const body of [{ action: "attach", confirmRule: true }, { action: "dismiss" }]) {
				const busy = await post(body);
				expect(busy.status).toBe(409);
				expect(busy.body.messageCode).toBe("SPEC_IMPORT_IN_PROGRESS");
			}
		} finally {
			end();
		}
		const attached = await post({ action: "attach", confirmRule: true });
		expect(attached.status).toBe(200);
		expect(attached.body).toMatchObject({ status: "attached", rulePage: true });
		// The admin route asks for the confirmation as well.
		const admin = await makeAdmin();
		await post({ action: "dismiss" });
		await call(admin, "admin", "POST", `${ADMIN}/loss/${finding?.id}`, { action: "reopen" });
		const adminRefused = await call<{ messageCode: string }>(
			admin,
			"admin",
			"POST",
			`${ADMIN}/loss/${finding?.id}`,
			{ action: "attach" },
		);
		expect(adminRefused.status).toBe(409);
		expect(adminRefused.body.messageCode).toBe("SPEC_LOSS_RULE_CONFIRM");
		const adminAttached = await call<OutlineSpecLossFinding>(
			admin,
			"admin",
			"POST",
			`${ADMIN}/loss/${finding?.id}`,
			{ action: "attach", confirmRule: true },
		);
		expect(adminAttached.body).toMatchObject({ status: "attached" });
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
