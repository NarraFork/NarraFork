import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { narrators, userPreferences, users } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import type { BooleanOverride } from "../../lib/boolean-override";
import { legacyFastModeMirror } from "../../lib/fast-mode";
import { generateId } from "../../lib/id";
import { narratorService } from "../../services/narrator-service";
import { narratorRoutes } from "../narrators";
import { userPreferencesRoutes } from "../user-preferences";

// tests/preload.ts isolates this file-backed DB and its worker reads from the running instance.
const narratorIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
	for (const id of narratorIds.splice(0).reverse()) {
		await db.delete(narrators).where(eq(narrators.id, id));
	}
	if (userIds.length) {
		await db.delete(userPreferences).where(inArray(userPreferences.userId, userIds));
		await db.delete(users).where(inArray(users.id, userIds.splice(0)));
	}
});

function appAs(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500),
	);
	app.route("/narrators", narratorRoutes);
	app.route("/user-preferences", userPreferencesRoutes);
	return app;
}
async function user(defaultFastMode: boolean) {
	const id = generateId();
	const now = new Date().toISOString();
	userIds.push(id);
	await db.insert(users).values({
		id,
		username: `fast-mode-${id}`,
		passwordHash: "unused",
		role: "user",
		createdAt: now,
	});
	await db.insert(userPreferences).values({
		id: generateId(),
		userId: id,
		fastModeDefault: defaultFastMode,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}
async function narrator(
	ownerUserId: string,
	override: BooleanOverride = "inherit",
	rootId?: string,
) {
	const id = generateId();
	narratorIds.push(id);
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		type: rootId ? "subagent" : "primary",
		variant: rootId ? "subagent:general" : "primary",
		subagentType: rootId ? "general" : null,
		ownerUserId,
		parentNarratorId: rootId ?? null,
		aclRootNarratorId: rootId ?? null,
		visibility: "public",
		writeAudience: "owner",
		fastModeOverride: override,
		fastMode: legacyFastModeMirror(override),
		cwd: process.env.HOME,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}
async function patch(app: Hono, id: string, body: unknown) {
	return app.request(`/narrators/${id}/fast-mode`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}
async function detail(app: Hono, id: string) {
	const response = await app.request(`/narrators/${id}`);
	expect(response.status).toBe(200);
	return response.json();
}

describe("narrator fast-mode HTTP resolution", () => {
	test("details retain raw mirrors while primary and child use the execution owner's default", async () => {
		const owner = await user(true);
		const viewer = await user(false);
		const root = await narrator(owner);
		const child = await narrator(owner, "inherit", root);
		const app = appAs(viewer);
		expect(await detail(app, root)).toMatchObject({
			fastMode: false,
			fastModeOverride: "inherit",
			effectiveFastMode: true,
			fastModeSource: "user-default",
			fastModeSourceNarratorId: null,
		});
		expect(await detail(app, child)).toMatchObject({
			fastMode: false,
			fastModeOverride: "inherit",
			effectiveFastMode: true,
			fastModeSource: "primary",
			fastModeSourceNarratorId: root,
		});
	});

	for (const rootOverride of ["inherit", "on", "off"] as const) {
		for (const childOverride of ["inherit", "on", "off"] as const) {
			test(`PATCH resolves primary=${rootOverride}, subagent=${childOverride} independently`, async () => {
				const owner = await user(true);
				const root = await narrator(owner);
				const child = await narrator(owner, "inherit", root);
				const sibling = await narrator(owner, "off", root);
				const app = appAs(owner);
				const rootResponse = await patch(app, root, { fastModeOverride: rootOverride });
				expect(rootResponse.status).toBe(200);
				const rootEnabled = rootOverride !== "off";
				expect(await rootResponse.json()).toMatchObject({
					fastMode: rootEnabled,
					effectiveFastMode: rootEnabled,
					fastModeOverride: rootOverride,
					fastModeSource: rootOverride === "inherit" ? "user-default" : "override",
					fastModeSourceNarratorId: null,
				});
				const response = await patch(app, child, { fastModeOverride: childOverride });
				expect(response.status).toBe(200);
				const effective = childOverride === "inherit" ? rootEnabled : childOverride === "on";
				expect(await response.json()).toMatchObject({
					ok: true,
					fastModeOverride: childOverride,
					fastMode: effective,
					effectiveFastMode: effective,
					fastModeSource: childOverride === "inherit" ? "primary" : "override",
					fastModeSourceNarratorId: childOverride === "inherit" ? root : null,
				});
				expect(await detail(app, child)).toMatchObject({
					fastMode: legacyFastModeMirror(childOverride),
					effectiveFastMode: effective,
				});
				expect((await narratorService.getById(root)).fastModeOverride).toBe(rootOverride);
				expect((await narratorService.getById(sibling)).fastModeOverride).toBe("off");
			});
		}
	}

	test("legacy booleans pin both narrator types; explicit tri-state input takes precedence", async () => {
		const owner = await user(false);
		const root = await narrator(owner, "on");
		const child = await narrator(owner, "inherit", root);
		const app = appAs(owner);
		for (const id of [root, child]) {
			for (const fastMode of [false, true]) {
				const response = await patch(app, id, { fastMode });
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({
					fastMode,
					effectiveFastMode: fastMode,
					fastModeOverride: fastMode ? "on" : "off",
					fastModeSource: "override",
				});
			}
		}
		const response = await patch(app, child, { fastMode: false, fastModeOverride: "inherit" });
		expect(await response.json()).toMatchObject({
			fastModeOverride: "inherit",
			fastMode: true,
			fastModeSource: "primary",
		});
	});

	test("read access cannot mutate either type; a different authorized writer does not supply defaults", async () => {
		const owner = await user(true);
		const viewer = await user(false);
		const root = await narrator(owner);
		const child = await narrator(owner, "inherit", root);
		const app = appAs(viewer);
		for (const id of [root, child]) {
			expect((await patch(app, id, { fastModeOverride: "off" })).status).toBe(404);
			expect((await narratorService.getById(id)).fastModeOverride).toBe("inherit");
		}
		await db.update(narrators).set({ writeAudience: "public" }).where(eq(narrators.id, root));
		for (const id of [root, child]) {
			const response = await patch(app, id, { fastModeOverride: "inherit" });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ effectiveFastMode: true, fastMode: true });
		}
	});

	test("invalid values leave stored choices unchanged", async () => {
		const owner = await user(true);
		const root = await narrator(owner, "on");
		for (const body of [null, [], {}, { fastMode: "true" }, { fastModeOverride: "invalid" }]) {
			expect((await patch(appAs(owner), root, body)).status).toBe(400);
			expect((await narratorService.getById(root)).fastModeOverride).toBe("on");
		}
	});

	test("warm existing detail reads follow committed defaults and preserve explicit child choices", async () => {
		const owner = await user(true);
		const root = await narrator(owner);
		const following = await narrator(owner, "inherit", root);
		const pinnedOn = await narrator(owner, "on", root);
		const pinnedOff = await narrator(owner, "off", root);
		const app = appAs(owner);
		for (const id of [root, following, pinnedOn]) {
			expect((await detail(app, id)).effectiveFastMode).toBe(true);
		}
		const preference = await app.request("/user-preferences", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ fastModeDefault: false }),
		});
		expect(preference.status).toBe(200);
		for (const id of [root, following, pinnedOff]) {
			expect((await detail(app, id)).effectiveFastMode).toBe(false);
		}
		expect((await detail(app, pinnedOn)).effectiveFastMode).toBe(true);
		for (const [id, override] of [
			[following, "inherit"],
			[pinnedOn, "on"],
			[pinnedOff, "off"],
		] as const) {
			expect((await narratorService.getById(id)).fastModeOverride).toBe(override);
		}
	});
});
