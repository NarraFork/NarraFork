import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import { DbReadError } from "../../lib/db-worker/errors";
import * as pool from "../../lib/db-worker/pool";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const session = await import("../narrator-session");
const { narratorService } = await import("../narrator-service");

const now = "2026-11-24T00:00:00.000Z";

function seedNarrator(
	id: string,
	fields: { status?: string; substatus?: string; pendingModelRestore?: string } = {},
) {
	sqlite
		.query(
			"INSERT INTO narrators (id, status, substatus, model, pending_model_restore, created_at, updated_at) VALUES (?, ?, ?, 'temp:model', ?, ?, ?)",
		)
		.run(
			id,
			fields.status ?? "idle",
			fields.substatus ?? "[]",
			fields.pendingModelRestore ?? null,
			now,
			now,
		);
}

function seedToolCalls(narratorId: string, status: string, count: number) {
	sqlite
		.query(
			"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, ?, 'assistant', '[]', ?)",
		)
		.run(`m-${narratorId}`, narratorId, now);
	const insert = sqlite.query(
		"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at) VALUES (?, ?, ?, ?, 'Bash', ?, ?)",
	);
	for (let i = 0; i < count; i++) {
		const id = `${status}-${String(i).padStart(4, "0")}`;
		insert.run(id, narratorId, `m-${narratorId}`, `use-${id}`, status, now);
	}
}

function toolStatuses(): Record<string, number> {
	const rows = sqlite
		.query("SELECT status, count(*) AS total FROM narrator_tool_calls GROUP BY status")
		.all() as Array<{ status: string; total: number }>;
	return Object.fromEntries(rows.map((row) => [row.status, row.total]));
}

/** Let the `nth` Worker read finish, then change the database before the caller writes. */
function afterRead(change: () => void, nth = 1) {
	const run = pool.runReadTask;
	let reads = 0;
	spyOn(pool, "runReadTask").mockImplementation((async (path, params, options) => {
		const result = await run(path, params, options);
		if (++reads === nth) change();
		return result;
	}) as typeof pool.runReadTask);
}

beforeEach(() => cleanDb(sqlite));
afterEach(() => mock.restore());
afterAll(async () => {
	mock.module("../../db", () => realDbModule);
	await fixture.close();
});

describe("session metadata reads are Worker-required", () => {
	for (const code of ["DB_READ_FAILED", "DB_READ_TASK_TIMEOUT", "DB_READ_UNAVAILABLE"]) {
		test(`${code} propagates without reading on the main connection`, async () => {
			seedNarrator("n1", { pendingModelRestore: "original:model" });
			const error = new DbReadError(code, "injected session fault");
			spyOn(pool, "runReadTask").mockRejectedValue(error);
			const main = spyOn(sqlite, "prepare");
			await expect(session.readSessionDeliverTo("n1")).rejects.toBe(error);
			await expect(session.restorePendingModelOverrides()).rejects.toBe(error);
			await expect(session.reconcileRunningStatus("n1")).rejects.toBe(error);
			expect(main).not.toHaveBeenCalled();
			mock.restore();
			// Nothing was restored on the strength of an unknown read.
			expect(
				sqlite.query("SELECT model, pending_model_restore AS pending FROM narrators").get(),
			).toEqual({ model: "temp:model", pending: "original:model" });
		});
	}
});

describe("interrupt finalization keeps a recorded error", () => {
	test("an idle error is left untouched, an active session becomes interrupted", async () => {
		seedNarrator("errored", { substatus: '["error"]' });
		seedNarrator("working", { status: "working" });
		for (const id of ["errored", "working"])
			await narratorService.updateStatus(id, "idle", {
				substatus: ["interrupted"],
				unlessArchived: true,
				keepIdleError: true,
			});
		const rows = sqlite
			.query("SELECT id, status, substatus FROM narrators ORDER BY id")
			.all() as Array<{ id: string; status: string; substatus: string }>;
		expect(rows[0]).toEqual({ id: "errored", status: "idle", substatus: '["error"]' });
		expect(rows[1]).toMatchObject({ id: "working", status: "idle" });
		const tags = JSON.parse(rows[1].substatus) as string[];
		expect(tags).toContain("interrupted");
		expect(tags).not.toContain("error");
	});

	test("a transition after the observation conflicts instead of being overwritten", async () => {
		seedNarrator("racing", { status: "working" });
		afterRead(() => sqlite.run("UPDATE narrators SET status = 'idle', substatus = '[\"error\"]'"));
		await expect(
			narratorService.updateStatus("racing", "idle", {
				substatus: ["interrupted"],
				unlessArchived: true,
				keepIdleError: true,
			}),
		).rejects.toMatchObject({ code: "RUNTIME_READ_CONFLICT", statusCode: 409 });
		expect(sqlite.query("SELECT substatus FROM narrators").get()).toEqual({
			substatus: '["error"]',
		});
	});
});

describe("startup recovery", () => {
	test("stale tool calls are failed page by page, protected calls survive", async () => {
		seedNarrator("n1");
		seedToolCalls("n1", "pending", 130);
		sqlite
			.query(
				"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at) VALUES ('running-a', 'n1', 'm-n1', 'use-running-a', 'Bash', 'running', ?), ('init-a', 'n1', 'm-n1', 'use-init-a', 'Bash', 'initializing', ?), ('kept', 'n1', 'm-n1', 'use-kept', 'Bash', 'running', ?)",
			)
			.run(now, now, now);
		await session.recoverStaleToolCallsOnStartup({ toolCallIds: new Set(["kept"]) }, now);
		expect(toolStatuses()).toEqual({ fail: 132, running: 1 });
		expect(
			sqlite
				.query("SELECT permission_decided_by AS decidedBy FROM narrator_tool_calls WHERE id = ?")
				.get("pending-0129"),
		).toEqual({ decidedBy: "server_restart" });
	});

	test("a tool call that moved on after the page read is not rewritten", async () => {
		seedNarrator("n1");
		seedToolCalls("n1", "running", 2);
		// Statuses are scanned pending → running → initializing: the second read is the
		// running page, and the change lands between it and the per-row write.
		afterRead(
			() =>
				sqlite.run(
					"UPDATE narrator_tool_calls SET execution_attempt = execution_attempt + 1 WHERE id = 'running-0000'",
				),
			2,
		);
		await session.recoverStaleToolCallsOnStartup({}, now);
		expect(sqlite.query("SELECT id, status FROM narrator_tool_calls ORDER BY id").all()).toEqual([
			{ id: "running-0000", status: "running" },
			{ id: "running-0001", status: "fail" },
		]);
	});

	test("model restore applies only the override that was observed", async () => {
		seedNarrator("same", { pendingModelRestore: "original:model" });
		seedNarrator("replaced", { pendingModelRestore: "original:model" });
		afterRead(() =>
			sqlite.run(
				"UPDATE narrators SET pending_model_restore = 'newer:model' WHERE id = 'replaced'",
			),
		);
		await session.restorePendingModelOverrides();
		expect(
			sqlite
				.query("SELECT id, model, pending_model_restore AS pending FROM narrators ORDER BY id")
				.all(),
		).toEqual([
			{ id: "replaced", model: "temp:model", pending: "newer:model" },
			{ id: "same", model: "original:model", pending: null },
		]);
	});
});
