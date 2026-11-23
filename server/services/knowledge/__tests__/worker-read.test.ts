import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { knowledgeCollections, knowledgeEntries } from "../../../db/schema";
import { readDomainTask } from "../../../db/worker-read";
import { readKnowledgeEntryDetail } from "../../../lib/db-worker/knowledge-entry-reader";
import * as pool from "../../../lib/db-worker/pool";
import { generateId } from "../../../lib/id";
import {
	captureWorkerRejection,
	getNarratorWorkerTestDb,
} from "../../__tests__/narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const realDb = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({ ...realDb, db: fixture.db, sqlite: fixture.sqlite }));
const { sqliteKnowledgeReadStore: store } = await import("../sqlite-read-store");
afterAll(async () => {
	await fixture.close();
	mock.module("../../../db", () => realDb);
	mock.restore();
});

test("entry detail preserves legal large metadata and UTF-8 chunk boundaries in a Worker", async () => {
	const collectionId = generateId(),
		entryId = generateId(),
		now = new Date().toISOString();
	fixture.db
		.insert(knowledgeCollections)
		.values({
			id: collectionId,
			name: collectionId,
			slug: collectionId,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const currentContent = `${"x".repeat(128 * 1024 - 1)}😀中文`;
	const metadata = { note: "m".repeat(5 * 1024 * 1024) };
	fixture.db
		.insert(knowledgeEntries)
		.values({
			id: entryId,
			collectionId,
			title: "entry",
			slug: entryId,
			currentContent,
			metadataJson: metadata,
			tagsJson: ["tag"],
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const forbidden = () => {
		throw new Error("Owning connection must not execute a SELECT");
	};
	const prepare = spyOn(fixture.sqlite, "prepare").mockImplementation(forbidden);
	const query = spyOn(fixture.sqlite, "query").mockImplementation(forbidden);
	try {
		const row = await readDomainTask(
			fixture.sqlite,
			"knowledgeEntryDetail",
			{ entryId },
			{ executionPolicy: "worker-required" },
		);
		expect(row?.currentContent).toBe(currentContent);
		expect(JSON.parse(row?.metadataJson ?? "null")).toEqual(metadata);
		expect(JSON.parse(row?.tagsJson ?? "null")).toEqual(["tag"]);
		const entry = await store.getEntryById(entryId);
		expect(entry?.currentContent).toBe(currentContent);
		expect(entry?.metadataJson).toEqual(metadata);
		expect(entry?.tagsJson).toEqual(["tag"]);
		expect(prepare).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
		query.mockRestore();
	}
});

test("cancelled entry reads reject rather than returning a missing entry", async () => {
	expect(
		await captureWorkerRejection(
			readDomainTask(
				fixture.sqlite,
				"knowledgeEntryDetail",
				{ entryId: "missing" },
				{ executionPolicy: "worker-required", signal: AbortSignal.abort() },
			),
		),
	).toMatchObject({ code: "DB_READ_ABORTED" });
});

test("missing entry and collection are null without executing on the owning connection", async () => {
	const prepare = spyOn(fixture.sqlite, "prepare");
	try {
		expect(await store.getEntryById("missing")).toBeNull();
		expect(await store.getCollectionAclById("missing")).toBeNull();
		expect(prepare).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
	}
});

for (const fault of ["spawn", "crash", "timeout", "disabled", "cancelled", "deadline"] as const) {
	test(`${fault} propagates through first-row, paged and entry reads without main-thread SQL`, async () => {
		const old = process.env.NARRAFORK_DB_WORKER;
		if (fault === "disabled") process.env.NARRAFORK_DB_WORKER = "off";
		const options = {
			signal: fault === "cancelled" ? AbortSignal.abort() : undefined,
			deadlineAt: fault === "deadline" ? Date.now() - 1 : Date.now() + 30_000,
		};
		const error =
			fault === "spawn"
				? new pool.WorkersUnavailableError("spawn failed")
				: fault === "timeout"
					? new pool.DbReadTaskTimeoutError("timeout")
					: new Error("worker crashed");
		const run = ["spawn", "crash", "timeout"].includes(fault)
			? spyOn(pool, "runReadTask").mockRejectedValue(error)
			: null;
		const prepare = spyOn(fixture.sqlite, "prepare");
		const query = spyOn(fixture.sqlite, "query");
		try {
			for (const work of [
				() => store.getCollectionAclById("missing", options),
				() => store.getEntryById("missing", options),
				() => store.listKeywordInjectionCandidates({ limit: 101 }, options),
			])
				expect(await captureWorkerRejection(work())).toBeInstanceOf(Error);
			expect(prepare).not.toHaveBeenCalled();
			expect(query).not.toHaveBeenCalled();
		} finally {
			prepare.mockRestore();
			query.mockRestore();
			run?.mockRestore();
			if (old === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = old;
		}
	});
}

test("entry detail finalizes its statement when native reading fails", () => {
	const statement = fixture.sqlite.prepare("SELECT 1");
	const finalized = spyOn(statement, "finalize");
	spyOn(statement, "get").mockImplementation(() => {
		throw new Error("read failed");
	});
	const prepare = spyOn(fixture.sqlite, "prepare").mockReturnValue(statement);
	try {
		expect(() => readKnowledgeEntryDetail(fixture.sqlite, { entryId: "missing" })).toThrow(
			"read failed",
		);
		expect(finalized).toHaveBeenCalledTimes(1);
	} finally {
		prepare.mockRestore();
		mock.restore();
	}
});
