import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SourcingCatalog } from "@shared/sourcing/presets";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { users } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { createToken } from "../../lib/auth";
import { generateId } from "../../lib/id";
import { getSourcingCatalog } from "../../lib/sourcing/presets";
import { requireSessionAuth } from "../../middleware/auth";
import { sourcingRoutes } from "../sourcing";

// Mounted the way server/app.ts mounts it: behind the session gate.
const app = new Hono();
app.use("/api/*", requireSessionAuth);
app.route("/api/sourcing", sourcingRoutes);
app.onError((err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: String(err) }, 500));

const userId = generateId();

beforeAll(async () => {
	await db.insert(users).values({
		id: userId,
		username: `sourcing-route-${userId}`,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: new Date().toISOString(),
	});
});

afterAll(async () => {
	await db.delete(users).where(eq(users.id, userId));
});

describe("GET /api/sourcing/templates", () => {
	test("rejects a request without a session", async () => {
		const res = await app.request("/api/sourcing/templates");
		expect(res.status).toBe(401);
	});

	test("returns templates and presets to any signed-in user", async () => {
		const res = await app.request("/api/sourcing/templates", {
			headers: { Authorization: `Bearer ${await createToken(userId)}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as SourcingCatalog;
		expect(body).toEqual(JSON.parse(JSON.stringify(getSourcingCatalog())));
		expect(Object.keys(body).sort()).toEqual(["presets", "templates"]);
		expect(body.templates.find((template) => template.id === "kimi-code")).toEqual({
			id: "kimi-code",
			kind: "known",
			regions: {
				china: {
					"anthropic-messages": "https://api.kimi.com/coding/v1",
					"completions-compatible": "https://api.kimi.com/coding/v1",
					"openai-responses": "https://api.kimi.com/coding/v1",
				},
				international: {
					"anthropic-messages": "https://api.kimi.ai/coding/v1",
					"completions-compatible": "https://api.kimi.ai/coding/v1",
					"openai-responses": "https://api.kimi.ai/coding/v1",
				},
			},
			defaults: { userAgentMode: "narrafork" },
		});
		expect(body.templates.find((template) => template.id === "openai-compatible")).toEqual({
			id: "openai-compatible",
			kind: "api",
		});
		const mimo = body.presets.find((preset) => preset.id === "mimo");
		expect(mimo).toMatchObject({ nameKey: "providerNames.mimo", popular: 6 });
		expect(
			mimo?.connections?.filter((connection) => connection.cluster).map((c) => c.cluster),
		).toEqual(["sgp", "ams"]);
	});
});
