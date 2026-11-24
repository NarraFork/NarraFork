import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb } from "../../../tests/setup";
import { DbReadError } from "../../lib/db-worker/errors";
import * as pool from "../../lib/db-worker/pool";
import { delegationRegistration } from "../../lib/validators/runtime-registration";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { narratorService, prepareNarratorCreation, createPreparedNarratorInTransaction } =
	await import("../narrator-service");
const { narratorRoutes } = await import("../../routes/narrators");
const { getNarratorPanelState } = await import("../narrator-panel-state");
const { shouldAutoAllowSendWithinScope } = await import("../narrator-permission");
const { narratorSurfaceReadOptions } = await import("../narrator-surface-reads");
const { ignoreAsyncQuestion } = await import("../narrator-question-service");
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "owner", role: "admin", iat: 0, exp: 9999999999 });
	await next();
});
app.onError((error) => {
	const failure = error as Error & { code?: string; statusCode?: number };
	return new Response(JSON.stringify({ code: failure.code }), {
		status: failure.statusCode ?? 503,
	});
});
app.route("/", narratorRoutes);
const now = "2026-10-12T00:00:00.000Z";
beforeEach(() => {
	cleanDb(sqlite);
	sqlite
		.query(
			"INSERT INTO narrators (id, owner_user_id, created_at, updated_at) VALUES ('n1', NULL, ?, ?)",
		)
		.run(now, now);
});
afterEach(() => mock.restore());
afterAll(async () => {
	mock.module("../../db", () => realDbModule);
	await fixture.close();
});

const cases = [
	{
		segment: "whitelist-dirs",
		table: "narrator_whitelist_dirs",
		field: "path",
		before: "/before",
		after: "/after",
	},
	{
		segment: "blacklist-dirs",
		table: "narrator_blacklist_dirs",
		field: "path",
		before: "/before",
		after: "/after",
	},
	{
		segment: "cmd-whitelist",
		table: "narrator_whitelist_cmds",
		field: "pattern",
		before: "echo before",
		after: "echo after",
	},
	{
		segment: "cmd-blacklist",
		table: "narrator_blacklist_cmds",
		field: "pattern",
		before: "echo before",
		after: "echo after",
	},
] as const;
function seedRule(item: (typeof cases)[number]) {
	sqlite
		.query(
			`INSERT INTO ${item.table} (id, narrator_id, ${item.field}, enabled, created_at, updated_at) VALUES ('rule', 'n1', ?, 1, ?, ?)`,
		)
		.run(item.before, now, now);
}
function patchRule(item: (typeof cases)[number]) {
	return app.request(`/${item.segment}/rule`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ [item.field]: item.after }),
	});
}

describe("narrator rule observation fences", () => {
	for (const item of cases) {
		test(`${item.segment}: a field-only PATCH cannot undo a concurrent disable`, async () => {
			seedRule(item);
			const observed = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const run = pool.runReadTask;
			let intercepted = false;
			spyOn(pool, "runReadTask").mockImplementation((async (path, params, options) => {
				const result = await run(path, params, options);
				if (
					!intercepted &&
					(params.kind === "selectRows" || params.kind === "selectValues") &&
					params.sql.includes(item.table) &&
					params.sql.includes('"enabled"')
				) {
					intercepted = true;
					observed.resolve();
					await release.promise;
				}
				return result;
			}) as typeof pool.runReadTask);
			const pending = Promise.resolve(patchRule(item));
			try {
				await Promise.race([
					observed.promise,
					pending.then(() => {
						if (!intercepted)
							throw new Error("PATCH completed without the Worker observation gate");
					}),
				]);
				sqlite.query(`UPDATE ${item.table} SET enabled = 0 WHERE id = 'rule'`).run();
				release.resolve();
				const response = await pending;
				expect(response.status).toBe(409);
				expect(await response.json()).toEqual({ code: "RUNTIME_READ_CONFLICT" });
				expect(
					sqlite
						.query(`SELECT enabled, ${item.field} AS value FROM ${item.table} WHERE id = 'rule'`)
						.get(),
				).toEqual({ enabled: 0, value: item.before });
			} finally {
				release.resolve();
				await pending;
			}
		});
	}
	test("a field-only PATCH succeeds normally, and an absent rule remains 404", async () => {
		seedRule(cases[0]);
		const response = await patchRule(cases[0]);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ path: "/after", enabled: true });
		sqlite.query("DELETE FROM narrator_whitelist_dirs").run();
		expect((await patchRule(cases[0])).status).toBe(404);
	});
});

describe("question observation fences", () => {
	test("ignore propagates caller cancellation and rejects ownership drift before writing", async () => {
		sqlite
			.query("INSERT INTO narrators (id, created_at, updated_at) VALUES ('n2', ?, ?)")
			.run(now, now);
		sqlite
			.query(
				"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES ('qm', 'n1', 'assistant', '[]', ?)",
			)
			.run(now);
		sqlite
			.query(
				"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at) VALUES ('qt', 'n1', 'qm', 'qu', 'AskUserQuestion', 'completed', ?)",
			)
			.run(now);
		sqlite
			.query(
				"INSERT INTO narrator_questions (id, narrator_id, tool_call_id, tool_use_id, questions_json, created_at) VALUES ('question', 'n1', 'qt', 'qu', '[]', ?)",
			)
			.run(now);
		const controller = new AbortController();
		controller.abort();
		await expect(ignoreAsyncQuestion("question", { signal: controller.signal })).rejects.toThrow();
		const observed = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const run = pool.runReadTask;
		let intercepted = false;
		spyOn(pool, "runReadTask").mockImplementation((async (path, params, options) => {
			const result = await run(path, params, options);
			if (
				!intercepted &&
				(params.kind === "selectRows" || params.kind === "selectValues") &&
				params.sql.includes('"narrator_questions"')
			) {
				intercepted = true;
				observed.resolve();
				await release.promise;
			}
			return result;
		}) as typeof pool.runReadTask);
		const pending = ignoreAsyncQuestion("question", { narratorId: "n1" });
		const settled = pending.then(
			() => null,
			(error: unknown) => error,
		);
		try {
			await Promise.race([
				observed.promise,
				pending.then(() => {
					throw new Error("Missing question observation");
				}),
			]);
			sqlite.query("UPDATE narrator_questions SET narrator_id = 'n2' WHERE id = 'question'").run();
			release.resolve();
			expect(await settled).toMatchObject({ code: "RUNTIME_READ_CONFLICT", statusCode: 409 });
			expect(
				sqlite.query("SELECT status FROM narrator_questions WHERE id = 'question'").get(),
			).toEqual({ status: "open" });
		} finally {
			release.resolve();
			await settled;
		}
	});
});

describe("narrator metadata observation fences", () => {
	for (const conflict of [true, false]) {
		test(`custom trait edits ${conflict ? "reject a concurrent trait edit" : "tolerate title changes"}`, async () => {
			const observed = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const read = narratorService.getById.bind(narratorService);
			let intercepted = false;
			spyOn(narratorService, "getById").mockImplementation(async (...args) => {
				const result = await read(...args);
				if (!intercepted) {
					intercepted = true;
					observed.resolve();
					await release.promise;
				}
				return result;
			});
			const pending = Promise.resolve(
				app.request("/n1/custom-traits/disabled-tools", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ tools: ["Bash"] }),
				}),
			);
			try {
				await Promise.race([
					observed.promise,
					pending.then(() => {
						if (!intercepted) throw new Error("No trait observation");
					}),
				]);
				if (conflict)
					sqlite.run(`UPDATE narrators SET traits = '["standalone","plan"]' WHERE id = 'n1'`);
				else
					sqlite.run(
						"UPDATE narrators SET title = 'new title', updated_at = '2099-01-01T00:00:00Z' WHERE id = 'n1'",
					);
				release.resolve();
				const response = await pending;
				expect(response.status).toBe(conflict ? 409 : 200);
				if (conflict) {
					expect(await response.json()).toEqual({ code: "RUNTIME_READ_CONFLICT" });
					expect(sqlite.query("SELECT traits FROM narrators WHERE id = 'n1'").get()).toEqual({
						traits: '["standalone","plan"]',
					});
				} else
					expect(sqlite.query("SELECT title FROM narrators WHERE id = 'n1'").get()).toEqual({
						title: "new title",
					});
			} finally {
				release.resolve();
				await pending;
			}
		});
	}
	for (const conflict of [true, false]) {
		test(`handle edits ${conflict ? "reject a concurrent trait edit" : "tolerate title and timestamp edits"}`, async () => {
			const observed = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const run = pool.runReadTask;
			let intercepted = false;
			spyOn(pool, "runReadTask").mockImplementation((async (path, params, options) => {
				const result = await run(path, params, options);
				if (
					!intercepted &&
					(params.kind === "selectRows" || params.kind === "selectValues") &&
					params.sql.includes('"narrators"')
				) {
					intercepted = true;
					observed.resolve();
					await release.promise;
				}
				return result;
			}) as typeof pool.runReadTask);
			const pending = narratorService.setHandle("n1", null);
			const settled = pending.then(
				(value) => ({ value }),
				(error) => ({ error }),
			);
			try {
				await Promise.race([
					observed.promise,
					settled.then(() => {
						if (!intercepted) throw new Error("No narrator observation");
					}),
				]);
				if (conflict)
					sqlite.run(`UPDATE narrators SET traits = '["standalone","plan"]' WHERE id = 'n1'`);
				else
					sqlite.run(
						"UPDATE narrators SET title = 'new title', updated_at = '2099-01-01T00:00:00Z' WHERE id = 'n1'",
					);
				release.resolve();
				const result = await settled;
				if (conflict)
					expect(result).toMatchObject({
						error: { code: "RUNTIME_READ_CONFLICT", statusCode: 409 },
					});
				else {
					expect(result).toHaveProperty("value");
					expect(sqlite.query("SELECT title FROM narrators WHERE id = 'n1'").get()).toEqual({
						title: "new title",
					});
				}
			} finally {
				release.resolve();
				await settled;
			}
		});
	}
	test("prepared creation rechecks its observed project path in the insert transaction", async () => {
		sqlite.run(
			"INSERT INTO projects (id, name, git_path, created_at, updated_at) VALUES ('p1', 'Project', ?, ?, ?)",
			[process.cwd(), now, now],
		);
		const first = await prepareNarratorCreation({
			contextProjectId: "p1",
			cwd: process.cwd(),
			startInPlanMode: false,
		});
		const created = db.transaction((tx) => createPreparedNarratorInTransaction(tx, first));
		expect(created.contextProjectId).toBe("p1");
		const second = await prepareNarratorCreation({
			contextProjectId: "p1",
			cwd: process.cwd(),
			startInPlanMode: false,
		});
		sqlite.run("UPDATE projects SET git_path = '/changed-project' WHERE id = 'p1'");
		expect(() => db.transaction((tx) => createPreparedNarratorInTransaction(tx, second))).toThrow(
			"Runtime state changed while reading",
		);
		expect(sqlite.query("SELECT count(*) AS total FROM narrators").get()).toEqual({ total: 2 });
	});
	test("prepared named creation cannot overwrite a concurrently reserved handle", async () => {
		const prepared = await prepareNarratorCreation({
			makeNamed: true,
			handle: "reserved",
			startInPlanMode: false,
		});
		sqlite.run(
			"UPDATE narrators SET handle = 'reserved', handle_fold = 'reserved' WHERE id = 'n1'",
		);
		expect(() => db.transaction((tx) => createPreparedNarratorInTransaction(tx, prepared))).toThrow(
			"Runtime state changed while reading",
		);
		expect(sqlite.query("SELECT count(*) AS total FROM narrators").get()).toEqual({ total: 1 });
	});
});

describe("required narrator surface reads", () => {
	for (const code of [
		"DB_READ_FAILED",
		"DB_READ_TASK_TIMEOUT",
		"DB_READ_ABORTED",
		"DB_READ_UNAVAILABLE",
	]) {
		test(`${code} propagates without executing the read on the main connection`, async () => {
			const caller = await narratorService.getById("n1");
			const error = new DbReadError(code, "injected surface fault");
			spyOn(pool, "runReadTask").mockRejectedValue(error);
			const main = spyOn(sqlite, "prepare");
			await expect(getNarratorPanelState("n1", "viewer")).rejects.toBe(error);
			await expect(shouldAutoAllowSendWithinScope("n1", caller, { id: "target" })).rejects.toBe(
				error,
			);
			expect(main).not.toHaveBeenCalled();
		});
	}
	test("an empty panel is a successful Worker result", async () => {
		expect(await getNarratorPanelState("n1", "viewer")).toMatchObject({
			permissions: [],
			buffer: [],
			draft: { hasDraft: false },
			hasMore: { permissions: false, buffer: false },
		});
	});
	test("disabling Workers fails closed even after a successful panel read", async () => {
		await getNarratorPanelState("n1", "viewer");
		const previous = process.env.NARRAFORK_DB_WORKER;
		const main = spyOn(sqlite, "prepare");
		try {
			process.env.NARRAFORK_DB_WORKER = "off";
			await expect(getNarratorPanelState("n1", "viewer")).rejects.toMatchObject({
				code: "DB_READ_UNAVAILABLE",
			});
			expect(main).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = previous;
		}
	});
	test("caller cancellation and expired budgets dispatch nothing", async () => {
		const caller = await narratorService.getById("n1");
		const dispatch = spyOn(pool, "runReadTask");
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			getNarratorPanelState("n1", "viewer", {}, { signal: controller.signal }),
		).rejects.toThrow("cancelled");
		await expect(
			shouldAutoAllowSendWithinScope("n1", caller, { id: "target" }, { signal: controller.signal }),
		).rejects.toThrow("cancelled");
		await expect(
			getNarratorPanelState("n1", "viewer", {}, { deadlineAt: Date.now() - 1 }),
		).rejects.toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		expect(dispatch).not.toHaveBeenCalled();
	});
	test("Send target resolution batches selectors and propagates its caller budget", async () => {
		const caller = await narratorService.getById("n1");
		const ids = Array.from({ length: 20 }, (_, index) => `child-${index}`);
		for (const id of ids)
			sqlite.run(
				"INSERT INTO narrators (id, type, variant, parent_narrator_id, runtime_registration_json, created_at, updated_at) VALUES (?, 'subagent', 'subagent:general', 'n1', ?, ?, ?)",
				[id, JSON.stringify(delegationRegistration("n1", "general")), now, now],
			);
		const dispatch = spyOn(pool, "runReadTask");
		const signal = new AbortController().signal;
		const deadlineAt = Date.now() + 20_000;
		expect(
			await shouldAutoAllowSendWithinScope(
				"n1",
				caller,
				{ ids },
				{ signal, deadlineAt, timeoutMs: 20_000 },
			),
		).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(2);
		for (const [, , options] of dispatch.mock.calls)
			expect(options).toMatchObject({ signal, deadlineAt });
		dispatch.mockClear();
		expect(await shouldAutoAllowSendWithinScope("n1", caller, { ids: [] })).toBe(false);
		await expect(
			shouldAutoAllowSendWithinScope("n1", caller, {
				ids: Array.from({ length: 101 }, (_, index) => `missing-${index}`),
			}),
		).rejects.toMatchObject({ code: "DB_READ_BUDGET" });
		expect(dispatch).not.toHaveBeenCalled();
	});
	test("only caller budgets cross the read boundary and oversized timeouts are capped", () => {
		const signal = new AbortController().signal;
		const deadlineAt = Date.now() + 100_000;
		const result = narratorSurfaceReadOptions(
			Object.assign({ signal, deadlineAt, timeoutMs: 90_000 }, { unrelated: "private" }),
		);
		expect(result).toEqual({
			signal,
			deadlineAt,
			timeoutMs: 30_000,
			executionPolicy: "worker-required",
		});
	});
});
