/**
 * State-only writes (docs/BLOCK_STORAGE-DESIGN.md §5.4): reader-only fields of an envelope
 * (a translation, a card's status) change without a model-history bump, a COW or a sync,
 * and the block rows stay exactly what `content_json` splits into.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { assembleContent, inAssembledOrder } from "@shared/narrator-blocks/storage";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const blockSync = await import("../narrator-block-sync");
const { markRecoveryCardResolved } = await import("../narrator-subagent-recovery");
const { markCompactAsBlocking } = await import("../narrator-compact");
const { settings } = await import("../../lib/settings");

const NOW = "2026-10-01T00:00:00.000Z";

/** A stored envelope and its ref in `narratorId`, block-format unless `format` is 1. */
function seed(
	id: string,
	role: string,
	content: unknown[],
	options: { narratorId?: string; format?: 1 | 2; contentText?: string; createdAt?: string } = {},
) {
	const narratorId = options.narratorId ?? "n1";
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, body_format, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			narratorId,
			role,
			JSON.stringify(content),
			options.contentText ?? null,
			options.format ?? 2,
			options.createdAt ?? NOW,
		],
	);
	ref(narratorId, id);
	if ((options.format ?? 2) === 2) blockSync.syncEnvelopeNow(id);
}

function ref(narratorId: string, messageId: string) {
	sqlite.run(
		`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq)
		 VALUES (?, ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM narrator_message_refs WHERE narrator_id = ?))`,
		[`ref-${narratorId}-${messageId}`, narratorId, messageId, narratorId],
	);
}

function envelope(id: string) {
	return sqlite
		.prepare(
			`SELECT body_revision AS body, state_revision AS state, body_bytes AS bytes,
				content_json AS contentJson FROM narrator_messages WHERE id = ?`,
		)
		.get(id) as { body: number; state: number; bytes: number; contentJson: string };
}

const holder = (narratorId = "n1") =>
	(
		sqlite
			.prepare("SELECT model_history_revision AS r FROM narrators WHERE id = ?")
			.get(narratorId) as { r: number }
	).r;

const queued = () =>
	(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get() as { n: number }).n;

function rows(id: string) {
	return sqlite
		.prepare(
			"SELECT kind, phase, revision, payload, state, byte_size AS byteSize FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal",
		)
		.all(id) as Array<{
		kind: string;
		phase: string;
		revision: number;
		payload: string;
		state: string | null;
		byteSize: number;
	}>;
}

/** Rows equal to the content they split from, byte sizes included. */
function expectRowsCurrent(id: string) {
	const stored = rows(id);
	expect(
		assembleContent(
			stored.map((row) => ({
				payload: JSON.parse(row.payload),
				state: row.state ? JSON.parse(row.state) : null,
			})),
		),
	).toEqual(inAssembledOrder(JSON.parse(envelope(id).contentJson)));
	for (const row of stored)
		expect(row.byteSize).toBe(
			Buffer.byteLength(row.payload) + (row.state ? Buffer.byteLength(row.state) : 0),
		);
	expect(envelope(id).bytes).toBe(stored.reduce((sum, row) => sum + row.byteSize, 0));
}

/** Run `write` and report what moved. */
async function measure<T>(id: string, write: () => T | Promise<T>) {
	const before = { body: envelope(id).body, state: envelope(id).state, holder: holder() };
	const result = await write();
	return {
		result,
		bumped: holder() !== before.holder || envelope(id).body !== before.body,
		stateRevision: envelope(id).state - before.state,
		queued: queued(),
	};
}

beforeEach(() => {
	settings.narratorBlocks.compactJson = false;
	cleanDb(sqlite);
	for (const id of ["n1", "n2"])
		sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			id,
			id,
			NOW,
			NOW,
		]);
});
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

const reasoningStep = [
	{ type: "reasoning", id: "r1", text: "thinking", completed: true },
	{ type: "text", text: "answer" },
];

describe("patchState", () => {
	test("a translation changes state only: no bump, no sync, rows stay current", async () => {
		seed("s1", "assistant", reasoningStep);
		const revisions = rows("s1").map((row) => row.revision);
		const outcome = await measure("s1", () =>
			narratorPersistence.patchReasoningTranslation("s1", 0, "思考中", {
				id: "r1",
				text: "thinking",
			}),
		);
		expect(outcome).toEqual({ result: true, bumped: false, stateRevision: 1, queued: 0 });
		expect(JSON.parse(rows("s1")[0].state ?? "null")).toEqual({
			raw: [{ translatedText: "思考中" }],
		});
		expect(rows("s1").map((row) => row.revision)).toEqual(revisions);
		expectRowsCurrent("s1");
		// The same translation again writes nothing.
		expect(
			await narratorPersistence.patchReasoningTranslation("s1", 0, "思考中", {
				id: "r1",
				text: "thinking",
			}),
		).toBe(false);
	});

	test("a shared envelope is patched in place for every holder", async () => {
		seed("s1", "assistant", reasoningStep);
		ref("n2", "s1");
		const other = holder("n2");
		const outcome = await measure("s1", () =>
			narratorStore.patchState("s1", (content) => {
				(content[0] as Record<string, unknown>).translatedText = "t";
				return content;
			}),
		);
		expect(outcome.bumped).toBe(false);
		expect(holder("n2")).toBe(other);
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM narrator_messages").get() as { n: number },
		).toEqual({ n: 1 });
		expectRowsCurrent("s1");
	});

	test("a body field, or a state field that moves a derived column, is a body write", async () => {
		seed("s1", "assistant", reasoningStep);
		const body = await measure("s1", () =>
			narratorStore.patchState("s1", (content) => {
				(content[1] as Record<string, unknown>).text = "changed";
				return content;
			}),
		);
		expect(body).toMatchObject({ result: true, bumped: true, stateRevision: 0, queued: 0 });
		expectRowsCurrent("s1");

		// A compact's status is state, but it sets the marker's phase: the model sees it.
		seed("c1", "system", [{ type: "compact", status: "compacting", mode: "blocking" }], {
			contentText: "[Compacting]",
		});
		expect(rows("c1")[0].phase).toBe("open");
		const status = await measure("c1", () =>
			narratorStore.patchState("c1", (content) => {
				(content[0] as Record<string, unknown>).status = "failed";
				return content;
			}),
		);
		expect(status).toMatchObject({ bumped: true, stateRevision: 0 });
		expect(rows("c1")[0].phase).toBe("failed");
		expectRowsCurrent("c1");
	});

	test("a legacy envelope gets its content and no bump", async () => {
		seed("l1", "system", [{ type: "merge_summary", isLatest: true, summary: "s" }], {
			format: 1,
		});
		const outcome = await measure("l1", () =>
			narratorStore.patchState("l1", (content) => [
				{ ...(content[0] as Record<string, unknown>), isLatest: false },
			]),
		);
		expect(outcome).toEqual({ result: true, bumped: false, stateRevision: 1, queued: 0 });
		expect(JSON.parse(envelope("l1").contentJson)[0].isLatest).toBe(false);
		expect(rows("l1")).toEqual([]);
	});

	test("an envelope waiting on its sync is rebuilt by the sync, state included", async () => {
		seed("s1", "assistant", reasoningStep);
		sqlite.run("INSERT INTO narrator_block_sync_queue (message_id) VALUES ('s1')");
		narratorStore.patchState("s1", (content) => {
			(content[0] as Record<string, unknown>).translatedText = "t";
			return content;
		});
		expect(queued()).toBe(1);
		blockSync.flushChangedEnvelopes();
		expect(queued()).toBe(0);
		expectRowsCurrent("s1");
	});

	test("with block reads off, rows that no longer line up with the content are rebuilt", async () => {
		// With block reads on the rows are the body the patch starts from; off, it is the
		// column, and rows that differ from it are rebuilt from it.
		seed("s1", "assistant", reasoningStep);
		sqlite.run(
			`UPDATE narrator_blocks SET payload = '{"raw":[{"type":"reasoning","id":"r1","text":"stale","completed":true}]}' WHERE message_id = 's1' AND kind = 'reasoning'`,
		);
		settings.narratorBlocks.read = false;
		try {
			narratorStore.patchState("s1", (content) => {
				(content[0] as Record<string, unknown>).translatedText = "t";
				return content;
			});
		} finally {
			settings.narratorBlocks.read = true;
		}
		expectRowsCurrent("s1");
	});
});

describe("state writers", () => {
	test("a recovery card resolves as card state", async () => {
		seed(
			"rc",
			"disp",
			[{ type: "subagent_recovery", status: "pending", subagents: [{ id: "a1", alias: "a" }] }],
			{ contentText: "[Subagent recovery] 1 subagent(s) stopped with an error." },
		);
		expect(rows("rc")[0].state).not.toBeNull();
		const outcome = await measure("rc", () =>
			markRecoveryCardResolved({
				narratorId: "n1",
				messageId: "rc",
				mode: "notify",
				resumedAliases: ["a"],
			}),
		);
		await outcome.result;
		expect(outcome).toMatchObject({ bumped: false, stateRevision: 1 });
		expect(JSON.parse(envelope("rc").contentJson)[0]).toMatchObject({
			status: "resolved",
			mode: "notify",
			resumedCount: 1,
		});
		expectRowsCurrent("rc");
	});

	test("a running compact switched to blocking changes its mode only", async () => {
		seed(
			"c1",
			"system",
			[{ type: "compact", status: "compacting", mode: "background", trigger: "background" }],
			{ contentText: "[Compacting]" },
		);
		const outcome = await measure("c1", () => markCompactAsBlocking("n1"));
		await outcome.result;
		expect(outcome).toMatchObject({ bumped: false, stateRevision: 1 });
		expect(JSON.parse(envelope("c1").contentJson)[0].mode).toBe("blocking");
		expect(rows("c1")[0].phase).toBe("open");
		expectRowsCurrent("c1");
	});
});
