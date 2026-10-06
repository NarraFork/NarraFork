/**
 * Project/user trait layer API.
 *
 * Covers the two things a route test can prove that a service test cannot: the
 * authorization boundary (who may edit whose layer) and that the enforced flag
 * survives a write/read round trip per trait key.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { projects, userPreferences } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { generateId } from "../../lib/id";
import { resetTraitLayerCaches } from "../../services/trait-layer-service";
import { traitLayerRoutes } from "../trait-layers";

const ADMIN = "user-admin-layers";
const MEMBER = "user-member-layers";

const createdProjects: string[] = [];
const createdPrefs: string[] = [];

/** Build an app that injects a fixed principal, mirroring the real auth context. */
function appAs(userId: string, role: "admin" | "user"): Hono {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.route("/api/trait-layers", traitLayerRoutes);
	app.onError(
		(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
	);
	return app;
}

async function makeProject(): Promise<string> {
	const now = new Date().toISOString();
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `Trait layer API ${id.slice(0, 6)}`,
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(id);
	return id;
}

beforeEach(() => {
	resetTraitLayerCaches();
});

afterEach(async () => {
	resetTraitLayerCaches();
	if (createdProjects.length > 0) {
		await db.delete(projects).where(inArray(projects.id, createdProjects.splice(0)));
	}
	if (createdPrefs.length > 0) {
		await db.delete(userPreferences).where(inArray(userPreferences.userId, createdPrefs.splice(0)));
	}
});

describe("authorization", () => {
	test("a non-admin may not edit project traits", async () => {
		const projectId = await makeProject();
		const response = await appAs(MEMBER, "user").request(
			`/api/trait-layers/project/${projectId}/disabled-tools`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tools: ["Bash"] }),
			},
		);
		expect(response.status).toBe(403);
	});

	test("an admin may edit project traits", async () => {
		const projectId = await makeProject();
		const response = await appAs(ADMIN, "admin").request(
			`/api/trait-layers/project/${projectId}/disabled-tools`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tools: ["Bash"] }),
			},
		);
		expect(response.status).toBe(200);
	});

	test("a user may edit their own user layer", async () => {
		createdPrefs.push(MEMBER);
		const response = await appAs(MEMBER, "user").request(
			`/api/trait-layers/user/${MEMBER}/disabled-tools`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tools: ["Bash"] }),
			},
		);
		expect(response.status).toBe(200);
	});

	test("a user may not edit someone else's user layer", async () => {
		const response = await appAs(MEMBER, "user").request(
			`/api/trait-layers/user/${ADMIN}/disabled-tools`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tools: ["Bash"] }),
			},
		);
		expect(response.status).toBe(403);
	});

	test("an unknown layer name is rejected", async () => {
		const response = await appAs(ADMIN, "admin").request(
			"/api/trait-layers/narrator/some-id/disabled-tools",
			{ method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" },
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
	});

	test("editing a project that does not exist is a 404, not a silent write", async () => {
		const response = await appAs(ADMIN, "admin").request(
			"/api/trait-layers/project/nonexistent-project/disabled-tools",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tools: ["Bash"] }),
			},
		);
		expect(response.status).toBe(404);
	});
});

describe("enforced flag round trip", () => {
	test("enforced is persisted and reported back per trait key", async () => {
		const projectId = await makeProject();
		const app = appAs(ADMIN, "admin");

		const put = await app.request(`/api/trait-layers/project/${projectId}/disabled-tools`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tools: ["Bash"], enforced: true }),
		});
		expect(put.status).toBe(200);
		const body = (await put.json()) as {
			enforced: { disabledTools: boolean; blockedSkills: boolean };
		};
		expect(body.enforced.disabledTools).toBe(true);
		// Enforcement is per key: setting tools must not mark skills enforced.
		expect(body.enforced.blockedSkills).toBe(false);

		const get = await app.request(`/api/trait-layers/project/${projectId}`);
		const read = (await get.json()) as { enforced: { disabledTools: boolean } };
		expect(read.enforced.disabledTools).toBe(true);
	});

	test("editing one trait key leaves another key's enforcement intact", async () => {
		const projectId = await makeProject();
		const app = appAs(ADMIN, "admin");

		await app.request(`/api/trait-layers/project/${projectId}/disabled-tools`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tools: ["Bash"], enforced: true }),
		});
		await app.request(`/api/trait-layers/project/${projectId}/blocked-skills`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ names: ["s1"], enforced: false }),
		});

		const get = await app.request(`/api/trait-layers/project/${projectId}`);
		const read = (await get.json()) as {
			enforced: { disabledTools: boolean; blockedSkills: boolean };
		};
		expect(read.enforced.disabledTools).toBe(true);
		expect(read.enforced.blockedSkills).toBe(false);
	});

	test("deleting a trait clears its enforcement", async () => {
		const projectId = await makeProject();
		const app = appAs(ADMIN, "admin");

		await app.request(`/api/trait-layers/project/${projectId}/disabled-tools`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tools: ["Bash"], enforced: true }),
		});
		await app.request(`/api/trait-layers/project/${projectId}/disabled-tools`, {
			method: "DELETE",
		});

		const get = await app.request(`/api/trait-layers/project/${projectId}`);
		const read = (await get.json()) as {
			enforced: { disabledTools: boolean };
			customTraits: { disabledTools: unknown };
		};
		expect(read.enforced.disabledTools).toBe(false);
		expect(read.customTraits.disabledTools).toBeNull();
	});
});

describe("device injection has no enforced flag", () => {
	test("injection is stored and read back as a preference", async () => {
		const projectId = await makeProject();
		const app = appAs(ADMIN, "admin");

		const put = await app.request(`/api/trait-layers/project/${projectId}/device-injection`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				version: 1,
				defaultMode: "none",
				devices: { "dev-1": "on" },
				// An enforced flag here must be ignored rather than honoured.
				enforced: true,
			}),
		});
		expect(put.status).toBe(200);
		const body = (await put.json()) as {
			enforced: { disabledTools: boolean };
			deviceInjection: { defaultMode: string; devices: Record<string, string> } | null;
		};
		expect(body.deviceInjection?.defaultMode).toBe("none");
		expect(body.deviceInjection?.devices).toEqual({ "dev-1": "on" });
		// Injection grants nothing, so it never participates in enforcement.
		expect(body.enforced.disabledTools).toBe(false);
	});

	test("injection can be cleared", async () => {
		const projectId = await makeProject();
		const app = appAs(ADMIN, "admin");
		await app.request(`/api/trait-layers/project/${projectId}/device-injection`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ version: 1, defaultMode: "none", devices: {} }),
		});
		await app.request(`/api/trait-layers/project/${projectId}/device-injection`, {
			method: "DELETE",
		});
		const get = await app.request(`/api/trait-layers/project/${projectId}`);
		const read = (await get.json()) as { deviceInjection: unknown };
		expect(read.deviceInjection).toBeNull();
	});
});

describe("user layer bootstrapping", () => {
	test("writing to a user with no preferences row creates one", async () => {
		const fresh = `user-fresh-${generateId().slice(0, 8)}`;
		createdPrefs.push(fresh);
		const response = await appAs(fresh, "user").request(
			`/api/trait-layers/user/${fresh}/blocked-skills`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ names: ["s1"] }),
			},
		);
		expect(response.status).toBe(200);

		const row = await db.query.userPreferences.findFirst({
			where: (prefs, { eq }) => eq(prefs.userId, fresh),
			columns: { traits: true },
		});
		expect(Array.isArray(row?.traits)).toBe(true);
		expect((row?.traits as string[]).length).toBeGreaterThan(0);
	});
});

describe("invalid JSON body handling", () => {
	test("sending non-JSON body to a PUT endpoint returns 400, not silent acceptance", async () => {
		const projectId = await makeProject();
		const app = appAs(ADMIN, "admin");

		const response = await app.request(`/api/trait-layers/project/${projectId}/disabled-tools`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: "this is not valid json {{{",
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toContain("Invalid JSON");
	});
});
