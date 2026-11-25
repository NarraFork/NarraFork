import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import { readRecallConversation, readRecallMessage } from "../../lib/db-worker/recall-reader";
import {
	captureWorkerRejection,
	captureWorkerRejectionThrower,
	getNarratorWorkerTestDb,
} from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));
const { narratorService } = await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const { ensureRefsCoverSeq } = await import("../narrator-refs-backfill");
const now = "2026-06-01T00:00:00.000Z";

function narrator(id: string, parent: string | null = null, cursor: number | null = null) {
	sqlite.run(
		`INSERT INTO narrators (id, traits, created_at, updated_at, refs_inherited_from, refs_backfill_cursor)
		VALUES (?, '["standalone"]', ?, ?, ?, ?)`,
		[id, now, now, parent, cursor],
	);
}

function message(id: string, seq: number, compact = false, narratorId = "parent") {
	const blocks = compact
		? [{ type: "compact", status: "compacted", summary: "summary" }]
		: [{ type: "text", text: `original ${id}` }];
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		[id, narratorId, compact ? "system" : "user", JSON.stringify(blocks), `original ${id}`, now],
	);
	sqlite.run(
		`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact)
		VALUES (?, ?, ?, ?, ?)`,
		[`ref-${id}`, narratorId, id, seq, compact ? 1 : 0],
	);
}

async function forkWithCutoff20() {
	narrator("parent");
	for (let seq = 0; seq < 20; seq++) message(`m${seq}`, seq);
	message("compact20", 20, true);
	message("tail21", 21);
	const child = await narratorService.forkNarrator("parent", null, { inheritMode: "full" });
	// Loading just the old compact leaves ordinary m19 unmaterialized below cutoff 20.
	await ensureRefsCoverSeq(child.id, 20);
	expect(
		sqlite.query("SELECT refs_backfill_cursor FROM narrators WHERE id=?").get(child.id),
	).toEqual({ refs_backfill_cursor: 20 });
	expect(
		sqlite
			.query("SELECT 1 FROM narrator_message_refs WHERE narrator_id=? AND message_id='m19'")
			.get(child.id),
	).toBeNull();
	return child;
}

function recall(narratorId: string, messageId = "m19") {
	return readRecallMessage(sqlite, { narratorId, messageId, offset: 0, maxChars: 1000 });
}
function conversation(narratorId: string) {
	return readRecallConversation(sqlite, { narratorId, messageId: null, limit: 50 }).rows;
}
function parentRefs() {
	return sqlite
		.query(
			"SELECT message_id, seq FROM narrator_message_refs WHERE narrator_id='parent' ORDER BY seq, message_id",
		)
		.all();
}

beforeEach(() => cleanDb(sqlite));
afterAll(async () => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
	await fixture.close();
});

test("parent clear before 5 preserves a lazy fork's strict-cutoff message, text and order", async () => {
	const child = await forkWithCutoff20();
	const before = recall(child.id);
	expect(before).toMatchObject({ seq: 19, text: "original m19" });
	const rows = conversation(child.id);
	const marker = await narratorPersistence.clearContextBefore("parent", "m5");
	message("after-fork", 23);
	expect(recall(child.id)).toEqual(before);
	expect(conversation(child.id)).toEqual(rows);
	expect(recall(child.id, marker.id)).toBeNull();
	expect(recall(child.id, "after-fork")).toBeNull();
});

for (const target of ["parent", "child"] as const) {
	test(`clearing ${target} protects still-lazy nested forks, including an inherited target`, async () => {
		const child = await forkWithCutoff20();
		message("child-compact22", 22, true, child.id);
		message("child-tail23", 23, false, child.id);
		const grandchild = await narratorService.forkNarrator(child.id, null, { inheritMode: "full" });
		const before = recall(grandchild.id);
		const rows = conversation(grandchild.id);
		expect(before).toMatchObject({ seq: 19, text: "original m19" });
		expect(
			sqlite
				.query("SELECT 1 FROM narrator_message_refs WHERE narrator_id=? AND message_id='m5'")
				.get(child.id),
		).toBeNull();
		const sourceBefore = parentRefs();
		const marker = await narratorPersistence.clearContextBefore(
			target === "parent" ? "parent" : child.id,
			"m5",
		);
		expect(recall(grandchild.id)).toEqual(before);
		expect(conversation(grandchild.id)).toEqual(rows);
		expect(recall(grandchild.id, marker.id)).toBeNull();
		if (target === "child") {
			expect(parentRefs()).toEqual(sourceBefore);
			expect(recall("parent", marker.id)).toBeNull();
			expect(recall(child.id, "m5")).toMatchObject({ seq: 6, text: "original m5" });
		} else {
			expect(recall(child.id, marker.id)).toBeNull();
		}
		message("parent-later", 30);
		message("child-later", 30, false, child.id);
		expect(recall(grandchild.id, "parent-later")).toBeNull();
		expect(recall(grandchild.id, "child-later")).toBeNull();
	});
}

for (const mutation of ["new child", "bad boundary", "moved target"] as const) {
	test(`transaction rechecks ${mutation} before shifting or inserting a marker`, async () => {
		narrator("parent");
		for (let seq = 0; seq < 20; seq++) message(`m${seq}`, seq);
		const transaction = db.transaction.bind(db);
		const intercepted = spyOn(db, "transaction").mockImplementationOnce((callback, config) => {
			if (mutation === "new child") narrator("concurrent-child", "parent", 20);
			else if (mutation === "bad boundary") {
				narrator("ancestor");
				sqlite.run(
					"UPDATE narrators SET refs_inherited_from='ancestor', refs_backfill_cursor=20 WHERE id='parent'",
				);
			} else
				sqlite.run(
					"UPDATE narrator_message_refs SET seq=4 WHERE narrator_id='parent' AND message_id='m5'",
				);
			return transaction(callback, config);
		});
		try {
			expect(
				await captureWorkerRejection(narratorPersistence.clearContextBefore("parent", "m5")),
			).toMatchObject({
				code: "HISTORY_LAZY_DEPENDENCY_CHANGED",
			});
			expect(parentRefs()).toEqual(
				Array.from({ length: 20 }, (_, seq) => ({
					message_id: `m${seq}`,
					seq: mutation === "moved target" && seq === 5 ? 4 : seq,
				})).sort((a, b) => a.seq - b.seq || a.message_id.localeCompare(b.message_id)),
			);
			expect(
				sqlite
					.query("SELECT id FROM narrator_messages WHERE content_text='[Context cleared]'")
					.all(),
			).toEqual([]);
			if (mutation === "new child")
				expect(recall("concurrent-child")).toMatchObject({ text: "original m19", seq: 19 });
		} finally {
			intercepted.mockRestore();
		}
	});
}

test("an insert fault rolls back the parent seq shift and marker without losing prepared child history", async () => {
	const child = await forkWithCutoff20();
	const before = recall(child.id);
	const refs = parentRefs();
	sqlite.run(`CREATE TEMP TRIGGER fail_clear_marker BEFORE INSERT ON narrator_message_refs
		WHEN NEW.narrator_id='parent' AND NEW.is_compact=1
		BEGIN SELECT RAISE(ABORT, 'injected marker fault'); END`);
	try {
		expect(
			await captureWorkerRejectionThrower(narratorPersistence.clearContextBefore("parent", "m5")),
		).toThrow("injected marker fault");
		expect(parentRefs()).toEqual(refs);
		expect(recall(child.id)).toEqual(before);
		expect(
			sqlite.query("SELECT id FROM narrator_messages WHERE content_text='[Context cleared]'").all(),
		).toEqual([]);
	} finally {
		sqlite.run("DROP TRIGGER fail_clear_marker");
	}
});

test("child preparation failure cannot start a parent seq shift", async () => {
	const child = await forkWithCutoff20();
	const before = recall(child.id);
	const refs = parentRefs();
	sqlite.run(`CREATE TEMP TRIGGER fail_lazy_prepare BEFORE INSERT ON narrator_message_refs
		WHEN NEW.narrator_id!='parent' AND NEW.message_id='m19'
		BEGIN SELECT RAISE(ABORT, 'injected preparation fault'); END`);
	try {
		expect(
			await captureWorkerRejection(narratorPersistence.clearContextBefore("parent", "m5")),
		).toMatchObject({ cause: { message: "injected preparation fault" } });
		expect(parentRefs()).toEqual(refs);
		expect(recall(child.id)).toEqual(before);
		expect(
			sqlite.query("SELECT id FROM narrator_messages WHERE content_text='[Context cleared]'").all(),
		).toEqual([]);
	} finally {
		sqlite.run("DROP TRIGGER fail_lazy_prepare");
	}
});

test("a target outside the fork cutoff remains unavailable and cannot clear parent history", async () => {
	const child = await forkWithCutoff20();
	message("parent-only", 30);
	const refs = parentRefs();
	expect(
		await captureWorkerRejection(narratorPersistence.clearContextBefore(child.id, "parent-only")),
	).toMatchObject({ code: "NOT_FOUND" });
	expect(parentRefs()).toEqual(refs);
	expect(recall(child.id, "parent-only")).toBeNull();
});
