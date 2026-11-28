import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../../../server/lib/errors";
import { createProviderSettingsRoutes } from "../../../server/routes/provider-settings";
import type { ProviderSettingsService } from "../../../server/services/provider-settings-service";
import { providerSettingsContributionSchema } from "../../../shared/provider-settings";
import type { ProviderSettingsConfigView } from "../../../shared/provider-settings-values";

function fixture(role: "admin" | "user") {
	let initialized = 0,
		writes = 0;
	const actions: string[] = [];
	const declaration = providerSettingsContributionSchema.parse({
		id: "prefs",
		schemaVersion: 1,
		title: "Preferences",
		targetKinds: ["custom-api"],
		configSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				label: { type: "string" },
				account: { type: "string", "x-narrafork-host-only": true },
				token: { type: "string", writeOnly: true },
			},
		},
	});
	const config: ProviderSettingsConfigView = {
		schemaVersion: 1,
		schemaFingerprint: "a".repeat(64),
		revision: 1,
		bindingRevision: "b".repeat(64),
		status: "ready",
		values: { label: "public", account: "private-user" },
		secrets: { token: { isSet: true } },
	};
	const service: Pick<
		ProviderSettingsService,
		"list" | "save" | "remove" | "action" | "rebind" | "retained"
	> = {
		list: async () => [
			{
				pluginId: "com.example.settings",
				contributionId: "prefs",
				declaration,
				target: {
					kind: "custom-api",
					id: "provider-1",
					name: "Provider",
					disabled: false,
					available: true,
				},
				config,
			},
		],
		retained: async () => ({
			items: [{ targetId: "previous-target", revision: 1, updatedAt: "2026-11-28T00:00:00Z" }],
			nextCursor: null,
		}),
		rebind: async () => {
			writes++;
			return config;
		},
		save: async () => {
			writes++;
			return config;
		},
		remove: async () => {
			writes++;
		},
		action: async (_p, _c, _k, _id, user) => {
			actions.push(user);
			return { text: "fixture result" };
		},
	};
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", {
			sub: "fixture-user",
			role,
			sid: "fixture-authenticated-session",
			username: "fixture",
		} as never);
		await next();
	});
	app.onError((error, c) =>
		c.json(
			{ code: error instanceof AppError ? error.code : "ERROR" },
			error instanceof AppError ? (error.statusCode as 400 | 403 | 409) : 500,
		),
	);
	app.route(
		"/settings",
		createProviderSettingsRoutes(service, async () => {
			initialized++;
		}),
	);
	return {
		app,
		actions,
		get initialized() {
			return initialized;
		},
		get writes() {
			return writes;
		},
	};
}
const query = "?kind=custom-api&id=provider-1",
	path = "/settings/com.example.settings/prefs";
describe("provider settings HTTP boundary", () => {
	test("ordinary readers see public values without private schema or secret presence", async () => {
		const f = fixture("user"),
			response = await f.app.request(`/settings${query}`);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain("public");
		expect(text).not.toContain("private-user");
		expect(text).not.toContain("isSet");
		expect(text).not.toContain("declaration");
		expect(f.writes).toBe(0);
	});
	test("writes and actions require a first-party administrator", async () => {
		const f = fixture("user");
		for (const [method, suffix] of [
			["PUT", ""],
			["DELETE", ""],
			["POST", "/action"],
		]) {
			expect(
				(
					await f.app.request(path + suffix + query, {
						method,
						headers: { "content-type": "application/json" },
						body: '{"expectedRevision":1}',
					})
				).status,
			).toBe(403);
		}
		expect(f.writes).toBe(0);
		expect(f.actions).toEqual([]);
		expect(f.initialized).toBe(0);
	});
	test("admin action uses authenticated user and validated saved target", async () => {
		const f = fixture("admin");
		expect((await f.app.request(`${path}/action${query}`, { method: "POST" })).status).toBe(200);
		expect(f.actions).toEqual(["fixture-user"]);
		const bad = await f.app.request(`${path}/action?kind=custom-api&id=provider-1&owner=other`, {
			method: "POST",
		});
		expect(bad.status).toBe(400);
		expect(f.actions).toHaveLength(1);
	});
	test("invalid revisions and oversized JSON never reach storage", async () => {
		const f = fixture("admin");
		expect(
			(
				await f.app.request(path + query, {
					method: "DELETE",
					headers: { "content-type": "application/json" },
					body: '{"expectedRevision":-1}',
				})
			).status,
		).toBe(400);
		expect(
			(
				await f.app.request(path + query, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ value: "x".repeat(50 * 1024) }),
				})
			).status,
		).toBe(413);
		expect(f.writes).toBe(0);
	});
});

test("retained target summaries and cross-target confirmation stay administrator-only", async () => {
	const user = fixture("user"),
		admin = fixture("admin");
	expect((await user.app.request(`${path}/retained${query}`)).status).toBe(403);
	const result = await admin.app.request(`${path}/retained${query}`);
	expect(result.status).toBe(200);
	expect(await result.json()).toMatchObject({
		items: [{ targetId: "previous-target", revision: 1 }],
		nextCursor: null,
	});
	expect((await admin.app.request(`${path}/retained${query}&cursor=bad`)).status).toBe(400);
	const input = {
		expectedRevision: 0,
		schemaFingerprint: "a".repeat(64),
		expectedBindingRevision: "b".repeat(64),
		source: { targetId: "previous-target", expectedRevision: 1 },
	};
	const request = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	};
	expect((await user.app.request(`${path}/rebind${query}`, request)).status).toBe(403);
	expect((await admin.app.request(`${path}/rebind${query}`, request)).status).toBe(200);
	expect(admin.writes).toBe(1);
});
