/**
 * The Spec panel's fence tab in a session whose tasks live in the outline (outline P2, PR 4): the
 * file list and the file say the fence is not editable in the panel and where the behavior page
 * is; a save is refused before anything is written. Spec sessions are unchanged.
 *
 * The real `specRoutes` behind a stub that sets the acting user (the session's owner).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { db } from "../../db";
import { narrators, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { ensureSessionSpace } from "../../services/outline/spaces";
import { readSpecFile } from "../../services/spec-vfs-service";
import { seedBehaviorPage } from "../../services/task-source/__tests__/outline-task-source-scenarios";
import { specRoutes } from "../spec";

const NOW = "2026-11-02T00:00:00.000Z";
let actor = "";

const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: actor, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER } as never);
	await next();
});
app.onError((error, c) => {
	if (error instanceof AppError) {
		return c.json(
			{ error: error.message, code: error.code, messageCode: error.messageCode },
			error.statusCode as ContentfulStatusCode,
		);
	}
	return c.json({ error: String(error) }, 500);
});
app.route("/", specRoutes);

beforeEach(() => {
	settings.outline.enabled = true;
});

async function session(backend: "spec" | "outline"): Promise<string> {
	actor = generateId();
	await db.insert(users).values({
		id: actor,
		username: `spec-${actor}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		status: "idle",
		cwd: "/tmp",
		taskBackend: backend,
		ownerUserId: actor,
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

const fenceUri = encodeURIComponent("spec://behavior_fence");
const save = (id: string) =>
	app.request(`/${id}/spec/file`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			uri: "spec://behavior_fence",
			content: "Never force-push.",
			notifyAgent: false,
		}),
	});

describe("the Spec panel's fence tab", () => {
	test("an outline session: read-only, with where the behavior page is; a save is refused", async () => {
		const id = await session("outline");
		const before = await (await app.request(`/${id}/spec/files`)).json();
		const fence = before.files.find((f: { path: string }) => f.path === "behavior_fence");
		expect(fence).toMatchObject({ uiEditable: false, readonly: true });
		expect(before.outlineBehavior).toEqual({ spaceId: null, pageId: null });

		const pageId = await seedBehaviorPage(id, "Never force-push.");
		const space = await ensureSessionSpace(id);
		const after = await (await app.request(`/${id}/spec/files`)).json();
		expect(after.outlineBehavior).toEqual({ spaceId: space.id, pageId });
		const file = await (await app.request(`/${id}/spec/file?uri=${fenceUri}`)).json();
		expect(file).toMatchObject({ path: "behavior_fence", uiEditable: false });

		const refused = await save(id);
		expect(refused.status).toBe(409);
		expect((await refused.json()).messageCode).toBe("SPEC_IN_OUTLINE_SESSION");
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toBe("");
	});

	test("a spec session: editable as before, no outline field, the save lands", async () => {
		const id = await session("spec");
		const listed = await (await app.request(`/${id}/spec/files`)).json();
		expect(listed.files.find((f: { path: string }) => f.path === "behavior_fence")).toMatchObject({
			uiEditable: true,
		});
		expect(listed).not.toHaveProperty("outlineBehavior");
		const saved = await save(id);
		expect(saved.status).toBe(200);
		expect((await readSpecFile(id, "spec://behavior_fence")).content).toBe("Never force-push.");
	});
});
