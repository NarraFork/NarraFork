import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { db, sqlite } from "../../db";
import { narrators, projects, users } from "../../db/schema";
import { narratorService } from "../../services/narrator-service";
import { narratorRoutes } from "../narrators";

const NOW = "2026-10-01T00:00:00.000Z";
beforeAll(async () => {
	await db
		.insert(users)
		.values({ id: "list-owner", username: "list-owner", passwordHash: "x", createdAt: NOW });
	await db.insert(projects).values({
		id: "list-project",
		name: "List",
		gitPath: "/unused-list-path",
		ownerUserId: "list-owner",
		createdAt: NOW,
		updatedAt: NOW,
	});
	await db.insert(narrators).values(
		[null, "list-project"].map((contextProjectId, i) => ({
			id: `list-${i}`,
			contextProjectId,
			ownerUserId: "list-owner",
			handle: i === 0 ? "list-named" : null,
			handleFolded: i === 0 ? "list-named" : null,
			traits: i === 0 ? ["standalone", "named"] : ["standalone"],
			runtimeRegistrationJson: {
				version: 1 as const,
				run: {
					logicalRunId: "private-run",
					principal: { userId: "private-execution-principal" },
				},
			},
			createdAt: NOW,
			updatedAt: NOW,
		})),
	);
});
test("list queries exclude the registration at SQL projection, not only response serialization", () => {
	const routes = readFileSync(join(import.meta.dir, "../narrators.ts"), "utf-8");
	const service = readFileSync(
		join(import.meta.dir, "../../services/narrator-service.ts"),
		"utf-8",
	);
	for (const site of [
		routes.slice(routes.indexOf("const [list, countResult]"), routes.indexOf("const totalCount")),
		service.slice(service.indexOf("async listNamed()"), service.indexOf("async setHandle(")),
	]) {
		expect(site).toMatch(/columns:\s*\{\s*runtimeRegistrationJson:\s*false\s*\}/);
	}
});
test("named list searches by handle instead of scanning every narrator", () => {
	const service = readFileSync(
		join(import.meta.dir, "../../services/narrator-service.ts"),
		"utf-8",
	);
	const namedList = service.slice(
		service.indexOf("async listNamed()"),
		service.indexOf("async setHandle("),
	);
	expect(namedList).toContain('gt(narrators.handle, "")');
	const plan = sqlite
		.prepare(
			`EXPLAIN QUERY PLAN SELECT "id" FROM "narrators" "narrators"
			WHERE ("narrators"."type" = ? AND "narrators"."handle" > ?)
			ORDER BY "narrators"."last_message_at" DESC, "narrators"."created_at" DESC`,
		)
		.all("primary", "") as Array<{ detail: string }>;
	expect(plan.some((row) => /SEARCH narrators USING (COVERING )?INDEX/.test(row.detail))).toBe(
		true,
	);
	expect(plan.some((row) => row.detail === "SCAN narrators")).toBe(false);
});
test("all, project and named lists never return live runtime registration", async () => {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: "list-owner", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.route("/narrators", narratorRoutes);
	for (const suffix of ["", "?projectId=list-project", "/named"]) {
		const response = await app.request(`http://localhost/narrators${suffix}`);
		expect(response.status).toBe(200);
		const body = await response.json();
		const items = Array.isArray(body) ? body : body.items;
		expect(items.length).toBeGreaterThan(0);
		for (const item of items) expect(item).not.toHaveProperty("runtimeRegistrationJson");
		expect(JSON.stringify(body)).not.toContain("private-execution-principal");
	}
	const named = await narratorService.listNamed();
	expect(named.length).toBeGreaterThan(0);
	for (const item of named) expect(item).not.toHaveProperty("runtimeRegistrationJson");
});
