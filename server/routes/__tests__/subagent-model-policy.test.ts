import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REASONING_EFFORT_VALUES } from "@shared/reasoning-effort";
import { MAX_SUBAGENT_FIXED_EFFORTS_PER_POOL } from "@shared/subagent-model-policy";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { narrators, projects, userPreferences } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { generateId } from "../../lib/id";
import { getDefaults, narraforkDir, saveSettings, settings } from "../../lib/settings";
import type { NarraForkSettings } from "../../lib/settings/types";
import { resetTraitLayerCaches } from "../../services/trait-layer-service";
import { narratorRoutes } from "../narrators";
import { settingsRoutes } from "../settings";
import { traitLayerRoutes } from "../trait-layers";

// HOME, settings and DB are isolated by tests/preload.ts before these imports.
const ADMIN = "subagent-policy-test-admin";
const createdNarrators: string[] = [];
const createdProjects: string[] = [];
const createdPrefs: string[] = [];
let original: NarraForkSettings;

function appAs(role: "admin" | "user" = "admin") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: ADMIN, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError(
		(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500),
	);
	app.route("/settings", settingsRoutes);
	app.route("/narrators", narratorRoutes);
	app.route("/trait-layers", traitLayerRoutes);
	return app;
}

function write(app: Hono, path: string, body: unknown, method = "PATCH") {
	return app.request(path, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function readDisk() {
	return readFileSync(resolve(narraforkDir, "settings.json"), "utf8");
}

beforeEach(() => {
	original = structuredClone(settings);
	resetTraitLayerCaches();
});

afterEach(async () => {
	saveSettings(original);
	resetTraitLayerCaches();
	if (createdNarrators.length) {
		await db.delete(narrators).where(inArray(narrators.id, createdNarrators.splice(0)));
	}
	if (createdProjects.length) {
		await db.delete(projects).where(inArray(projects.id, createdProjects.splice(0)));
	}
	if (createdPrefs.length) {
		await db.delete(userPreferences).where(inArray(userPreferences.userId, createdPrefs.splice(0)));
	}
});

describe("settings fixed reasoning efforts", () => {
	test("defaults to an empty optional map", () => {
		expect(getDefaults().agent.subagentModelReasoningEfforts).toEqual({});
	});

	test("PATCH omits to preserve, replaces the entire map, and clears with {}", async () => {
		const app = appAs();
		const initial = { explore: { "p:a": "high" }, review: { "p:a": "none" } } as const;
		expect(
			(await write(app, "/settings", { agent: { subagentModelReasoningEfforts: initial } })).status,
		).toBe(200);
		expect((await write(app, "/settings", { agent: { maxTurns: 123 } })).status).toBe(200);
		expect(settings.agent.subagentModelReasoningEfforts).toEqual(initial);
		const read = await app.request("/settings");
		expect((await read.json()).agent.subagentModelReasoningEfforts).toEqual(initial);

		const replacement = { general: { "p:b": "medium" } };
		for (const value of [replacement, {}]) {
			const response = await write(app, "/settings", {
				agent: { subagentModelReasoningEfforts: value },
			});
			expect(response.status).toBe(200);
			expect(settings.agent.subagentModelReasoningEfforts).toEqual(value);
			expect(JSON.parse(readDisk()).agent.subagentModelReasoningEfforts).toEqual(value);
		}
	});

	test("rejects invalid maps without changing memory or disk", async () => {
		saveSettings(settings);
		const before = structuredClone(settings);
		const disk = readDisk();
		const tooMany = Object.fromEntries(
			Array.from({ length: MAX_SUBAGENT_FIXED_EFFORTS_PER_POOL + 1 }, (_, i) => [`m${i}`, "high"]),
		);
		for (const value of [
			{ explore: { model: "auto" } },
			{ search: { model: "" } },
			{ unknown: {} },
			{ plan: { ["x".repeat(201)]: "high" } },
			{ review: tooMany },
			null,
			[],
		]) {
			const response = await write(appAs(), "/settings", {
				agent: { subagentModelReasoningEfforts: value },
			});
			expect(response.status).toBe(400);
			expect(settings).toEqual(before);
			expect(readDisk()).toBe(disk);
		}
	});

	test("non-admins cannot configure fixed efforts", async () => {
		const response = await write(appAs("user"), "/settings", {
			agent: { subagentModelReasoningEfforts: { explore: { model: "high" } } },
		});
		expect(response.status).toBe(403);
	});

	test("prefix migration rejects conflicting tiers atomically then merges identical tiers", async () => {
		const provider = {
			id: "subagent-prefix-test",
			name: "Test",
			prefix: "old",
			protocol: "responses-compatible" as const,
			apiKey: "test-key",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "model",
		};
		saveSettings({
			...settings,
			customApiProviders: [provider],
			agent: {
				...settings.agent,
				defaultModel: "old:model",
				subagentAllowedModels: { explore: ["old:model"], plan: [], general: [] },
				subagentModelReasoningEfforts: { explore: { "old:model": "high", "new:model": "low" } },
			},
		});
		const before = structuredClone(settings);
		const disk = readDisk();
		const patch = { customApiProviders: [{ ...provider, prefix: "new" }] };
		expect((await write(appAs(), "/settings", patch)).status).toBe(400);
		expect(settings).toEqual(before);
		expect(readDisk()).toBe(disk);

		const response = await write(appAs(), "/settings", {
			...patch,
			agent: {
				subagentModelReasoningEfforts: { explore: { "old:model": "high", "new:model": "high" } },
			},
		});
		expect(response.status).toBe(200);
		expect(settings.agent.subagentModelReasoningEfforts).toEqual({
			explore: { "new:model": "high" },
		});
		expect(settings.agent.subagentAllowedModels.explore).toEqual(["new:model"]);
		expect(JSON.parse(readDisk()).agent.subagentModelReasoningEfforts).toEqual({
			explore: { "new:model": "high" },
		});
	});
});

async function targetPaths() {
	const now = new Date().toISOString();
	const narratorId = generateId();
	await db
		.insert(narrators)
		.values({ id: narratorId, title: "Fixed effort", createdAt: now, updatedAt: now });
	createdNarrators.push(narratorId);
	const projectId = generateId();
	await db
		.insert(projects)
		.values({ id: projectId, name: "Fixed effort", createdAt: now, updatedAt: now });
	createdProjects.push(projectId);
	createdPrefs.push(ADMIN);
	return [
		{
			write: `/narrators/${narratorId}/custom-traits/subagent-model-restriction`,
			read: `/narrators/${narratorId}/custom-traits`,
			nested: false,
		},
		{
			write: `/trait-layers/project/${projectId}/subagent-model-restriction`,
			read: `/trait-layers/project/${projectId}`,
			nested: true,
		},
		{
			write: `/trait-layers/user/${ADMIN}/subagent-model-restriction`,
			read: `/trait-layers/user/${ADMIN}`,
			nested: true,
		},
	];
}

describe("narrator, project and user trait fixed effort writes", () => {
	test("round trips tiers, hidden/custom pools and empty pools; clearing removes only metadata", async () => {
		const app = appAs();
		const paths = await targetPaths();
		for (const target of paths) {
			const pools = {
				explore: [" legacy ", { model: " object ", purpose: " purpose " }],
				search: [{ model: "search", reasoningEffort: "none" }],
				review: [],
				custom: REASONING_EFFORT_VALUES.map((reasoningEffort) => ({
					model: reasoningEffort,
					purpose: "task",
					reasoningEffort,
				})),
			};
			expect((await write(app, target.write, { pools }, "PUT")).status).toBe(200);
			const response = await app.request(target.read);
			const body = await response.json();
			const traits = target.nested ? body.customTraits : body;
			const normalized = {
				...pools,
				explore: [{ model: "legacy" }, { model: "object", purpose: "purpose" }],
			};
			expect(traits.subagentModelRestriction.pools).toEqual(normalized);
			const cleared = {
				...normalized,
				search: [{ model: "search" }],
				custom: [{ model: "none", purpose: "task" }, ...pools.custom.slice(1)],
			};
			expect((await write(app, target.write, { pools: cleared }, "PUT")).status).toBe(200);
			const read = await (await app.request(target.read)).json();
			expect((target.nested ? read.customTraits : read).subagentModelRestriction.pools).toEqual(
				cleared,
			);
		}
	});

	test("returns 400 for illegal tiers and preserves the preceding trait", async () => {
		const app = appAs();
		for (const target of await targetPaths()) {
			expect(
				(await write(app, target.write, { pools: { general: ["model"] } }, "PUT")).status,
			).toBe(200);
			const before = await (await app.request(target.read)).json();
			for (const reasoningEffort of ["auto", "inherit", "", "HIGH", null, 1, {}]) {
				const response = await write(
					app,
					target.write,
					{
						pools: { general: [{ model: "model", reasoningEffort }] },
					},
					"PUT",
				);
				expect(response.status).toBe(400);
				expect(await (await app.request(target.read)).json()).toEqual(before);
			}
		}
	});
});
