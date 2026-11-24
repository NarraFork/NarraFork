import { beforeAll, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { db, sqlite } from "../../db";
import { narrators, projects, users } from "../../db/schema";
import * as pool from "../../lib/db-worker/pool";
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
			isAskInPassing: i === 1,
			parentNarratorId: i === 1 ? "list-0" : null,
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
test("named list searches by handle instead of scanning every narrator", () => {
	const service = readFileSync(
		join(import.meta.dir, "../../services/narrator-service.ts"),
		"utf-8",
	);
	const namedList = service.slice(
		service.indexOf("async listNamed("),
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
test("flat, grouped and named lists omit runtime registration from SQL and responses", async () => {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: "list-owner", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.route("/narrators", narratorRoutes);
	const prepare = spyOn(sqlite, "prepare");
	const dispatch = spyOn(pool, "runReadTask");
	function expectSafeProjection() {
		const queries = [
			...prepare.mock.calls.map(([statement]) => statement),
			...dispatch.mock.calls.flatMap(([, task]) => (task.kind === "selectRows" ? [task.sql] : [])),
		].filter((statement) => /\b(?:from|join) "narrators"/i.test(statement));
		expect(queries.length).toBeGreaterThan(0);
		for (const query of queries) {
			expect(query).not.toContain("runtime_registration_json");
			expect(query).not.toMatch(/^select (?:\*|"[^"]+"\.\*)/i);
		}
		prepare.mockClear();
		dispatch.mockClear();
	}
	try {
		for (const suffix of ["", "?projectId=list-project", "?groupAskInPassing=true", "/named"]) {
			const response = await app.request(`http://localhost/narrators${suffix}`);
			expect(response.status).toBe(200);
			const body = await response.json();
			const items = Array.isArray(body) ? body : body.items;
			expect(items.length).toBeGreaterThan(0);
			for (const item of items) expect(item).not.toHaveProperty("runtimeRegistrationJson");
			if (suffix.includes("groupAskInPassing")) {
				const children = items.find(
					(item: { id: string }) => item.id === "list-0",
				)?.askInPassingSessions;
				expect(children).toEqual([expect.objectContaining({ id: "list-1" })]);
				expect(children[0]).not.toHaveProperty("runtimeRegistrationJson");
			}
			expect(JSON.stringify(body)).not.toContain("private-execution-principal");
			expectSafeProjection();
		}
		const named = await narratorService.listNamed();
		expect(named.length).toBeGreaterThan(0);
		for (const item of named) expect(item).not.toHaveProperty("runtimeRegistrationJson");
		expectSafeProjection();
	} finally {
		prepare.mockRestore();
		dispatch.mockRestore();
	}
});
