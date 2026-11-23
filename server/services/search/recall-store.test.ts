import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { narrators } from "../../db/schema";
import * as pool from "../../lib/db-worker/pool";
import {
	captureWorkerRejection,
	getNarratorWorkerTestDb,
} from "../__tests__/narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const realDb = { ...(await import("../../db")) };
const sqliteDb = {
	...realDb,
	db: fixture.db,
	sqlite: fixture.sqlite,
	activeDatabaseBackend: "sqlite",
};
mock.module("../../db", () => sqliteDb);
const { recallConversation, recallToolCallDetail } = await import("./recall-store");
afterEach(() => {
	mock.restore();
	mock.module("../../db", () => sqliteDb);
});
afterAll(async () => {
	await fixture.close();
	mock.module("../../db", () => realDb);
});

test("recall store reads committed SQLite rows and misses without owning-thread SQL", async () => {
	await fixture.db.insert(narrators).values({
		id: "recall-store",
		title: "Recall store",
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
	});
	const prepare = spyOn(fixture.sqlite, "prepare");
	const query = spyOn(fixture.sqlite, "query");
	expect(
		(await recallConversation({ narratorId: "recall-store", messageId: null, limit: 5 })).narrator
			?.title,
	).toBe("Recall store");
	expect(await recallConversation({ narratorId: "missing", messageId: null, limit: 5 })).toEqual({
		narrator: null,
		messageMissing: false,
		rows: [],
		tools: [],
	});
	expect(await recallToolCallDetail({ toolCallId: "missing", narratorId: null })).toBeNull();
	expect(prepare).not.toHaveBeenCalled();
	expect(query).not.toHaveBeenCalled();
});

for (const fault of ["spawn", "crash", "timeout", "disabled", "cancelled", "deadline"] as const) {
	test(`recall store propagates ${fault} without inline retry`, async () => {
		const previous = process.env.NARRAFORK_DB_WORKER;
		if (fault === "disabled") process.env.NARRAFORK_DB_WORKER = "off";
		const error =
			fault === "spawn"
				? new pool.WorkersUnavailableError("spawn failed")
				: fault === "timeout"
					? new pool.DbReadTaskTimeoutError("timed out")
					: new Error("worker crashed");
		if (["spawn", "crash", "timeout"].includes(fault))
			spyOn(pool, "runReadTask").mockRejectedValue(error);
		const prepare = spyOn(fixture.sqlite, "prepare"),
			query = spyOn(fixture.sqlite, "query");
		const options = {
			signal: fault === "cancelled" ? AbortSignal.abort() : undefined,
			deadlineAt: fault === "deadline" ? Date.now() - 1 : Date.now() + 30_000,
		};
		try {
			for (const work of [
				() => recallToolCallDetail({ toolCallId: "missing", narratorId: null }, undefined, options),
				() =>
					recallConversation(
						{ narratorId: "recall-store", messageId: null, limit: 5 },
						undefined,
						options,
					),
			])
				expect(await captureWorkerRejection(work())).toBeInstanceOf(Error);
			expect(prepare).not.toHaveBeenCalled();
			expect(query).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = previous;
		}
	});
}

test("PostgreSQL misses and source-budget failures do not touch SQLite", async () => {
	let oversized = false;
	const unsafe = mock(async () => (oversized ? [{ bytes: 41 * 1024 * 1024 }] : []));
	mock.module("../../db", () => ({
		...sqliteDb,
		activeDatabaseBackend: "postgres",
		postgresRuntime: { closed: false, executor: { unsafe } },
	}));
	const prepare = spyOn(fixture.sqlite, "prepare");
	expect(await recallToolCallDetail({ toolCallId: "missing", narratorId: null })).toBeNull();
	expect(
		(await recallConversation({ narratorId: "missing", messageId: null, limit: 5 })).narrator,
	).toBeNull();
	oversized = true;
	expect(
		await captureWorkerRejection(recallToolCallDetail({ toolCallId: "large", narratorId: null })),
	).toMatchObject({ code: "DB_READ_BUDGET" });
	expect(prepare).not.toHaveBeenCalled();
});
