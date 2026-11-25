import { beforeAll, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { db, sqlite } from "../../db";
import { narrators, users } from "../../db/schema";
import * as pool from "../../lib/db-worker/pool";
import { generateId } from "../../lib/id";
import { narratorService } from "../../services/narrator-service";
import { narratorRoutes } from "../narrators";

const id = generateId();
const userId = generateId();
const handle = `route${generateId(6).toLowerCase()}`;
const now = new Date().toISOString();
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
	await next();
});
app.route("/narrators", narratorRoutes);

beforeAll(async () => {
	await db
		.insert(users)
		.values({ id: userId, username: userId, passwordHash: "x", createdAt: now });
	await db.insert(narrators).values({
		id,
		handle,
		handleFold: handle,
		traits: ["named"],
		title: "title".repeat(1000),
		ownerUserId: userId,
		createdAt: now,
		updatedAt: now,
		runtimeRegistrationJson: { version: 1, run: { logicalRunId: "never-read-registration" } },
	});
});

test("suggestions route bypasses full listing and draft/enrichment reads", async () => {
	const full = spyOn(narratorService, "listNamed").mockImplementation(() => {
		throw new Error("full named list forbidden");
	});
	const read = spyOn(pool, "runReadTask");
	try {
		const response = await app.request(`/narrators/named?view=suggestions&q=${handle}`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.items).toEqual([{ id, handle, title: "title".repeat(32), status: "idle" }]);
		expect(body.nextCursor).toBeNull();
		expect(full).not.toHaveBeenCalled();
		const queries = read.mock.calls.flatMap(([, task]) =>
			task.kind === "selectRows" ? [task.sql] : [],
		);
		expect(queries).toHaveLength(1);
		expect(queries[0]).not.toContain("runtime_registration_json");
		expect(queries[0]).not.toContain("draft");
		expect(queries[0]).not.toMatch(/select\s+\*/i);
		expect(queries[0]).toContain("substr(");
		expect(queries[0]).toContain("limit ?");
		const task = read.mock.calls.find(([, candidate]) => candidate.kind === "selectRows")?.[1];
		if (task?.kind !== "selectRows") throw new Error("Missing suggestions SQL");
		const plan = sqlite
			.prepare<{ detail: string }, typeof task.params>(`EXPLAIN QUERY PLAN ${task.sql}`)
			.all(...task.params);
		expect(plan.some((row) => row.detail.includes("idx_narrators_handle_fold"))).toBe(true);
		expect(plan.some((row) => row.detail === "SCAN narrators")).toBe(false);
	} finally {
		full.mockRestore();
		read.mockRestore();
	}
});
