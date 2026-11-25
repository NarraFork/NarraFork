import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { narrators, users } from "../db/schema";
import { buildAppErrorResponse } from "../lib/app-error-response";
import { settings } from "../lib/settings";
import {
	clearNarratorRuntimeModel,
	recordNarratorRuntimeModel,
} from "../services/narrator-session-state";
import { modelCatalogRoutes } from "./model-catalog";
import { settingsRoutes } from "./settings";

const owner = `runtime-owner-${crypto.randomUUID()}`;
const narratorId = `runtime-${crypto.randomUUID()}`;
const now = new Date().toISOString();
db.insert(users)
	.values({ id: owner, username: owner, passwordHash: "unused", createdAt: now })
	.run();
db.insert(narrators)
	.values({
		id: narratorId,
		ownerUserId: owner,
		model: "auto:claude-sonnet-4-5",
		visibility: "private",
		writeAudience: "owner",
		createdAt: now,
		updatedAt: now,
	})
	.run();
afterAll(() => {
	clearNarratorRuntimeModel(narratorId);
	db.delete(narrators).where(eq(narrators.id, narratorId)).run();
	db.delete(users).where(eq(users.id, owner)).run();
});
function app(userId: string, role: "user" | "admin" = "user") {
	const router = new Hono();
	router.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: 0 });
		await next();
	});
	router.onError(
		(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "Internal error" }, 500),
	);
	router.route("/api/settings", settingsRoutes);
	router.route("/api/model-catalog", modelCatalogRoutes);
	return router;
}

test("runtime route bound to narrator always reauthorizes even with an explicit model", async () => {
	recordNarratorRuntimeModel(
		narratorId,
		"auto:claude-sonnet-4-5",
		"actual-B",
		"claude-sonnet-4-5",
		"actual-B:claude-sonnet-4-5",
	);
	const query = `/api/model-catalog/runtime?narratorId=${encodeURIComponent(narratorId)}&model=auto%3Aclaude-sonnet-4-5`;
	expect((await app("not-owner").request(query)).status).toBe(404);
	const response = await app(owner).request(query);
	expect(response.status).toBe(200);
	const body = await response.text();
	expect(new TextEncoder().encode(body).byteLength).toBeLessThan(4 * 1024);
	expect(JSON.parse(body).concreteValue).toBe("actual-B:claude-sonnet-4-5");
	const draft = await app(owner).request(
		"/api/model-catalog/runtime?model=auto%3Aclaude-sonnet-4-5",
	);
	expect((await draft.json()).state).toBe("not-observed");
});

test("runtime settings HTTP stays small with huge prompts/providers; metadata endpoint does not guess auto", async () => {
	settings.agent.defaultSystemPrompt = "private-system-prompt".repeat(100_000);
	settings.agent.customModels = Array.from({ length: 10_000 }, (_, id) => ({
		value: `test:${id}`,
		label: "unused",
	}));
	settings.agent.summaryModel = "auto:claude-sonnet-4-5";
	const response = await app(owner).request("/api/settings/runtime");
	expect(response.status).toBe(200);
	const body = await response.text();
	expect(new TextEncoder().encode(body).byteLength).toBeLessThan(4 * 1024);
	expect(body).not.toContain("private-system-prompt");
	expect(body).not.toContain("customModels");
	expect(JSON.parse(body).summaryModelAvailable).toBeNull();
	const denied = await app(owner).request("/api/settings?view=runtime", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ agent: { behaviorFenceInterval: 5 } }),
	});
	expect(denied.status).toBe(403);
	db.update(users).set({ role: "admin" }).where(eq(users.id, owner)).run();
	const patched = await app(owner, "admin").request("/api/settings?view=runtime", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ agent: { behaviorFenceInterval: 5 } }),
	});
	expect(patched.status).toBe(200);
	const patchedText = await patched.text();
	expect(new TextEncoder().encode(patchedText).byteLength).toBeLessThan(8 * 1024);
	expect(patchedText).not.toContain("private-system-prompt");
});
