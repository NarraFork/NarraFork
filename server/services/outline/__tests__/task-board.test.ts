/**
 * The task board (outline P2 PR 5) on SQLite: the store scenarios (also run on PostgreSQL), and the
 * board's routes with their gates (`/api/outline/narrators/:id/tasks`, `/projects/:id/tasks`,
 * `/spaces/:id/tasks/finished`, `PATCH /tasks/:blockId`).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own people,
 * projects and sessions. `outline.enabled` is switched on before each case.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { db } from "../../../db";
import { aclGrants, narrators, projects, users } from "../../../db/schema";
import { AppError } from "../../../lib/errors";
import { generateId } from "../../../lib/id";
import { settings } from "../../../lib/settings";
import { outlineRoutes } from "../../../routes/outline";
import { invalidateTaskBackend } from "../../task-source";
import { addPersonTask } from "../person-tasks";
import { outlineStore } from "../store";
import { readProjectTaskBoard } from "../task-board";
import { type BoardScenarioContext, OUTLINE_TASK_BOARD_SCENARIOS } from "./task-board-scenarios";

const NOW = "2026-11-03T00:00:00.000Z";

beforeEach(() => {
	settings.outline.enabled = true;
	invalidateTaskBackend();
});

const ctx: BoardScenarioContext = {
	async user(options = {}) {
		const id = generateId();
		const username = `board${id.replace(/[^A-Za-z0-9]/g, "")}${options.suffix ?? ""}`;
		await db.insert(users).values({
			id,
			username,
			passwordHash: "x",
			role: options.admin ? "admin" : "user",
			createdAt: NOW,
		});
		return { id, username };
	},
	async project({ owner, visibility }) {
		const id = generateId();
		await db.insert(projects).values({
			id,
			name: `board-${id}`,
			ownerUserId: owner,
			visibility: visibility ?? "private",
			createdAt: NOW,
			updatedAt: NOW,
		});
		return id;
	},
	async session({ owner, projectId, visibility, archived, writeAudience }) {
		const id = generateId();
		await db.insert(narrators).values({
			id,
			title: `board session ${id}`,
			ownerUserId: owner,
			visibility: visibility ?? "private",
			writeAudience: writeAudience ?? "owner",
			contextProjectId: projectId ?? null,
			taskBackend: "outline",
			status: archived ? "archived" : "idle",
			createdAt: NOW,
			updatedAt: NOW,
		});
		return id;
	},
	async grant(projectId, userId, capability) {
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: userId,
			capability,
			createdAt: NOW,
		});
	},
	async grantSession(narratorId, userId, capability) {
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: narratorId,
			principalType: "user",
			principalId: userId,
			capability,
			createdAt: NOW,
		});
	},
};

describe("task board scenarios (SQLite)", () => {
	for (const scenario of OUTLINE_TASK_BOARD_SCENARIOS) {
		test(scenario.name, async () => {
			await scenario.run(ctx);
		});
	}
});

describe("a project board page's cost", () => {
	test("its reads do not grow with the sessions on the page (one batched read each)", async () => {
		const owner = await ctx.user();
		const projectId = await ctx.project({ owner: owner.id });
		const principal = { userId: owner.id, isAdmin: false };
		const addSessions = async (n: number) => {
			for (let i = 0; i < n; i++) {
				const narratorId = await ctx.session({ owner: owner.id, projectId, visibility: "project" });
				for (const text of ["one", "two", "three"])
					await addPersonTask({ narratorId, userId: owner.id, text, lock: i % 2 === 0 });
			}
		};
		const storeCalls = async () => {
			const calls: string[] = [];
			const restores: Array<() => void> = [];
			for (const key of Object.keys(outlineStore) as Array<keyof typeof outlineStore>) {
				const original = outlineStore[key];
				if (typeof original !== "function") continue;
				const wrapped = (...args: unknown[]) => {
					calls.push(String(key));
					return (original as (...a: unknown[]) => unknown).apply(outlineStore, args);
				};
				(outlineStore as unknown as Record<string, unknown>)[key] = wrapped;
				restores.push(() => {
					(outlineStore as unknown as Record<string, unknown>)[key] = original;
				});
			}
			try {
				const board = await readProjectTaskBoard(principal, projectId);
				return { calls: calls.length, sections: board.sections.length };
			} finally {
				for (const restore of restores) restore();
			}
		};
		await addSessions(2);
		const few = await storeCalls();
		await addSessions(6);
		const many = await storeCalls();
		expect(many.sections).toBe(few.sections + 6);
		expect(many.calls).toBe(few.calls);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

function app(userId: string) {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.onError((error) => {
		const status = error instanceof AppError ? error.statusCode : 500;
		return new Response(JSON.stringify({ error: error.message }), { status });
	});
	instance.route("/outline", outlineRoutes);
	return instance;
}

function call(userId: string, method: string, path: string, body?: unknown) {
	return app(userId).request(`http://localhost/outline${path}`, {
		method,
		...(body === undefined
			? {}
			: { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
	});
}

describe("the board's routes", () => {
	test("a session's board: readers see it, others get 404; only writers may add", async () => {
		const owner = await ctx.user();
		const reader = await ctx.user();
		const stranger = await ctx.user();
		const project = await ctx.project({ owner: owner.id });
		await ctx.grant(project, reader.id, "read");
		const session = await ctx.session({
			owner: owner.id,
			projectId: project,
			visibility: "project",
		});

		const mine = await call(owner.id, "GET", `/narrators/${session}/tasks`);
		expect(mine.status).toBe(200);
		expect(((await mine.json()) as { canAdd: boolean }).canAdd).toBe(true);
		const theirs = await call(reader.id, "GET", `/narrators/${session}/tasks`);
		expect(((await theirs.json()) as { canAdd: boolean }).canAdd).toBe(false);
		expect((await call(stranger.id, "GET", `/narrators/${session}/tasks`)).status).toBe(404);

		const added = await call(owner.id, "POST", `/narrators/${session}/tasks`, { text: "Ship it" });
		expect(added.status).toBe(201);
		expect(await added.json()).toMatchObject({ added: true, locked: true, started: false });
		const again = await call(owner.id, "POST", `/narrators/${session}/tasks`, { text: "Ship it" });
		expect(again.status).toBe(200);
		expect(await again.json()).toMatchObject({ added: false });
		expect(
			(await call(reader.id, "POST", `/narrators/${session}/tasks`, { text: "Mine" })).status,
		).toBe(403);
		expect(
			(await call(owner.id, "POST", `/narrators/${session}/tasks`, { text: "  " })).status,
		).toBe(400);
	});

	test("adding needs the session's tasks in the outline", async () => {
		const owner = await ctx.user();
		const id = generateId();
		await db.insert(narrators).values({
			id,
			ownerUserId: owner.id,
			taskBackend: "spec",
			createdAt: NOW,
			updatedAt: NOW,
		});
		expect((await call(owner.id, "POST", `/narrators/${id}/tasks`, { text: "x" })).status).toBe(
			400,
		);
		expect(
			(
				(await (await call(owner.id, "GET", `/narrators/${id}/tasks`)).json()) as {
					canAdd: boolean;
				}
			).canAdd,
		).toBe(false);
	});

	test("changing a task: 404 unreadable, 403 reader, 409 stale, else the change", async () => {
		const owner = await ctx.user();
		const reader = await ctx.user();
		const stranger = await ctx.user();
		const project = await ctx.project({ owner: owner.id });
		await ctx.grant(project, reader.id, "read");
		const session = await ctx.session({
			owner: owner.id,
			projectId: project,
			visibility: "project",
		});
		const task = await addPersonTask({
			narratorId: session,
			userId: owner.id,
			text: "Do it",
			lock: false,
		});
		const version = (await outlineStore.getBlock(task.blockId))?.versionSeq as number;
		const patch = (who: string, body: unknown) =>
			call(who, "PATCH", `/tasks/${task.blockId}`, body);
		expect((await patch(stranger.id, { baseVersionSeq: version, status: "done" })).status).toBe(
			404,
		);
		expect((await patch(reader.id, { baseVersionSeq: version, status: "done" })).status).toBe(403);
		expect((await patch(owner.id, { baseVersionSeq: version })).status).toBe(400);
		const done = await patch(owner.id, { baseVersionSeq: version, status: "done" });
		expect(done.status).toBe(200);
		const after = ((await done.json()) as { versionSeq: number }).versionSeq;
		expect(after).toBeGreaterThan(version);
		expect((await patch(owner.id, { baseVersionSeq: version, status: "todo" })).status).toBe(409);
		const reopened = await patch(owner.id, { baseVersionSeq: after, status: "todo" });
		expect(await reopened.json()).toMatchObject({ started: false });
		expect((await outlineStore.getBlock(task.blockId))?.taskJson?.status).toBe("todo");
	});

	test("a project's board: 404 to someone who cannot read the project; the finished list pages", async () => {
		const owner = await ctx.user();
		const stranger = await ctx.user();
		const project = await ctx.project({ owner: owner.id });
		const session = await ctx.session({
			owner: owner.id,
			projectId: project,
			visibility: "project",
		});
		const task = await addPersonTask({
			narratorId: session,
			userId: owner.id,
			text: "Do it",
			lock: false,
		});
		expect((await call(stranger.id, "GET", `/projects/${project}/tasks`)).status).toBe(404);
		const board = await call(owner.id, "GET", `/projects/${project}/tasks`);
		expect(board.status).toBe(200);
		const body = (await board.json()) as { sections: Array<{ open: Array<{ title: string }> }> };
		expect(body.sections.flatMap((s) => s.open.map((t) => t.title))).toEqual(["Do it"]);
		expect((await call(owner.id, "GET", `/projects/${project}/tasks?cursor=%%%`)).status).toBe(400);
		const finished = await call(owner.id, "GET", `/spaces/${task.spaceId}/tasks/finished`);
		expect(await finished.json()).toEqual({ tasks: [], nextCursor: null });
		expect((await call(stranger.id, "GET", `/spaces/${task.spaceId}/tasks/finished`)).status).toBe(
			404,
		);
	});

	test("with the outline off, the board's routes are not there", async () => {
		const owner = await ctx.user();
		const session = await ctx.session({ owner: owner.id });
		settings.outline.enabled = false;
		expect((await call(owner.id, "GET", `/narrators/${session}/tasks`)).status).toBe(404);
	});
});
