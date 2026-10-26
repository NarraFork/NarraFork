/**
 * State-only writes (docs/BLOCK_STORAGE-DESIGN.md §5.4): reader-only fields of an envelope
 * (a translation, a card's status) change without a model-history bump, a COW or a sync,
 * and the block rows stay exactly what `content_json` splits into.
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { assembleContent, inAssembledOrder } from "@shared/narrator-blocks/storage";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
const { narratorService } = await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const { completeAssistantOutput } = await import("../narrator-output-recovery");
const { readEnvelopeBody } = await import("../narrator-body-writes");
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
	test("translation parts return persistent identity and envelope state revision without COW", async () => {
		seed("parts", "assistant", [
			null,
			"leftover",
			{
				type: "reasoning",
				id: "r1",
				text: "think more",
				translationGeneration: "g1",
				completed: false,
			},
		]);
		ref("n2", "parts");
		const original = envelope("parts");
		const block = sqlite
			.query<{ id: string; revision: number }, [string]>(
				"SELECT id, revision FROM narrator_blocks WHERE message_id = ? LIMIT 1",
			)
			.get("parts");
		if (!block) throw new Error("Missing persisted reasoning block");
		const payload = rows("parts")[0].payload;
		const otherRevision = holder("n2");
		const part = {
			id: "p1",
			generation: "g1",
			start: 0,
			end: 5,
			sourceText: "think",
			translatedText: "思考",
		};
		const input = {
			messageId: "parts",
			elementId: "r1",
			expected: { sourceText: "think", generation: "g1" },
			part,
		};
		const result = await narratorPersistence.patchReasoningTranslationPart(input);
		expect(result).toEqual({
			messageId: "parts",
			blockId: block.id,
			elementId: "r1",
			blockRevision: block.revision,
			stateRevision: original.state + 1,
			translationGeneration: "g1",
			part,
		});
		expect(envelope("parts").body).toBe(original.body);
		expect(holder("n2")).toBe(otherRevision);
		expect(rows("parts")[0].payload).toBe(payload);
		expect(sqlite.query("SELECT id FROM narrator_messages").all()).toHaveLength(1);
		expect(await narratorPersistence.patchReasoningTranslationPart(input)).toBeNull();
		expect(
			await narratorPersistence.patchReasoningTranslationPart({
				...input,
				part: { ...part, id: "overlap" },
			}),
		).toBeNull();
		expect(
			await narratorPersistence.patchReasoningTranslationPart({
				...input,
				expected: { sourceText: "rewritten", generation: "g1" },
			}),
		).toBeNull();
		expect(
			await narratorPersistence.patchReasoningTranslationPart({
				...input,
				expected: { sourceText: "think", generation: "g2" },
			}),
		).toBeNull();
		expectRowsCurrent("parts");
	});

	test.each([
		false,
		true,
	])("completion merges a translation committed during the COW ref read (shared=%s)", async (shared) => {
		seed("completion", "assistant", [
			{
				type: "reasoning",
				id: "r1",
				text: "thinking",
				translationGeneration: "g1",
				completed: false,
			},
			{ type: "text", id: "t1", text: "answer", completed: false },
		]);
		if (shared) ref("n2", "completion");
		const part = {
			id: "p1",
			generation: "g1",
			start: 0,
			end: 8,
			sourceText: "thinking",
			translatedText: "思考",
		};
		const refs = db.query.narratorMessageRefs;
		const read = refs.findFirst.bind(refs);
		let patched = false;
		const barrier = spyOn(refs, "findFirst").mockImplementation((options) => {
			const query = read(options);
			return new Proxy(query, {
				get(target, key, receiver) {
					if (key !== "then") return Reflect.get(target, key, receiver);
					const pending = target.then(async (row) => {
						if (!patched && query.toSQL().params.includes("completion")) {
							expect(
								(readEnvelopeBody(db, "completion") as Array<Record<string, unknown>>)[0]
									.translationParts,
							).toBeUndefined();
							const patch = await narratorPersistence.patchReasoningTranslationPart({
								messageId: "completion",
								elementId: "r1",
								expected: { sourceText: "thinking", generation: "g1" },
								part,
							});
							expect(patch).not.toBeNull();
							patched = true;
						}
						return row;
					});
					return pending.then.bind(pending);
				},
			});
		});
		let completedId: string;
		try {
			completedId = await completeAssistantOutput("n1", "completion");
		} finally {
			barrier.mockRestore();
		}
		expect(patched).toBe(true);
		const current = readEnvelopeBody(db, completedId) as Array<Record<string, unknown>>;
		expect(current[0]).toMatchObject({
			completed: true,
			translationGeneration: "g1",
			translationParts: [part],
		});
		expect(current[1].completed).toBe(true);
		if (shared) {
			expect(completedId).not.toBe("completion");
			expect(
				(readEnvelopeBody(db, "completion") as Array<Record<string, unknown>>)[0],
			).toMatchObject({ completed: false, translationParts: [part] });
		} else expect(completedId).toBe("completion");
	});

	test.each([
		"content_text",
		"origin",
		"origin+provider",
	] as const)("compat translation sums actual envelope text bytes before reading %s", async (field) => {
		seed("metadata-parts", "assistant", [
			{ type: "reasoning", id: "r1", text: "source", translationGeneration: "g1" },
		]);
		if (field === "origin+provider") {
			const half = "x".repeat(600 * 1024);
			sqlite.run(
				"UPDATE narrator_messages SET origin = ?, provider = ? WHERE id = 'metadata-parts'",
				[half, half],
			);
		} else {
			const large = "界".repeat(field === "content_text" ? 12 * 1024 * 1024 : 400 * 1024);
			sqlite.run(`UPDATE narrator_messages SET ${field} = ? WHERE id = 'metadata-parts'`, [large]);
		}
		sqlite.run("DELETE FROM narrator_block_sync_queue WHERE message_id = 'metadata-parts'");
		const input = {
			messageId: "metadata-parts",
			elementId: "r1",
			expected: { sourceText: "source", generation: "g1" },
			part: {
				id: "p1",
				generation: "g1",
				start: 0,
				end: 6,
				sourceText: "source",
				translatedText: "原文",
			},
		};
		const before = envelope("metadata-parts");
		const prepare = sqlite.prepare.bind(sqlite);
		let envelopeReads = 0;
		const guard = spyOn(sqlite, "prepare").mockImplementation(((...args) => {
			if (
				args[0].includes("content_text AS contentText") &&
				args[0].includes("sdk_message_uuid AS messageUuid")
			) {
				envelopeReads++;
				throw new Error("Unbounded envelope text was selected");
			}
			return prepare(...args);
		}) as typeof sqlite.prepare);
		try {
			expect(await narratorPersistence.patchReasoningTranslationPart(input)).toBeNull();
			expect(envelope("metadata-parts")).toEqual(before);
			sqlite.run(
				"UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1 WHERE id = 'metadata-parts'",
			);
			expect(await narratorPersistence.patchReasoningTranslationPart(input)).not.toBeNull();
		} finally {
			guard.mockRestore();
		}
		expect(envelopeReads).toBe(0);
	});

	test("translation input rejects huge identities before serialization and drops extra fields", async () => {
		seed("bounded-input", "assistant", [
			{ type: "reasoning", id: "r1", text: "source", translationGeneration: "g1" },
		]);
		const part = {
			id: "p1",
			generation: "g1",
			start: 0,
			end: 6,
			sourceText: "source",
			translatedText: "原文",
		};
		const input = {
			messageId: "bounded-input",
			elementId: "r1",
			expected: { sourceText: "source", generation: "g1" },
			part,
		};
		const huge = "x".repeat(32 * 1024 * 1024);
		const stringify = JSON.stringify;
		let serialized = 0;
		const guard = spyOn(JSON, "stringify").mockImplementation(
			(
				value: unknown,
				replacer?: ((key: string, value: unknown) => unknown) | (number | string)[] | null,
				space?: string | number,
			) => {
				serialized++;
				if (typeof replacer === "function") return stringify(value, replacer, space);
				return stringify(value, replacer, space);
			},
		);
		let rejected: unknown[];
		try {
			rejected = [
				await narratorPersistence.patchReasoningTranslationPart({
					...input,
					part: { ...part, id: huge },
				}),
				await narratorPersistence.patchReasoningTranslationPart({
					...input,
					part: { ...part, generation: huge },
				}),
				await narratorPersistence.patchReasoningTranslationPart({
					...input,
					expected: { ...input.expected, generation: huge },
				}),
			];
		} finally {
			guard.mockRestore();
		}
		expect(rejected).toEqual([null, null, null]);
		expect(serialized).toBe(0);
		let extraSerialized = false;
		const extra = {
			payload: huge,
			toJSON: () => {
				extraSerialized = true;
				throw new Error("Extra part data was serialized");
			},
		};
		const result = await narratorPersistence.patchReasoningTranslationPart({
			...input,
			part: { ...part, extra },
		} as Parameters<typeof narratorPersistence.patchReasoningTranslationPart>[0]);
		expect(result?.part).toEqual(part);
		expect(extraSerialized).toBe(false);
		expect(JSON.parse(rows("bounded-input")[0].state ?? "null").raw[0].translationParts).toEqual([
			part,
		]);
	});

	test("rows-only translation patches do not materialize large unrelated blocks", async () => {
		seed("large-parts", "assistant", [
			{ type: "reasoning", id: "r1", text: "source", translationGeneration: "g1" },
			{ type: "text", text: "x".repeat(blockSync.REASONING_TRANSLATION_WRITE_MAX_BYTES + 1) },
		]);
		const input = {
			messageId: "large-parts",
			elementId: "r1",
			expected: { sourceText: "source", generation: "g1" },
			part: {
				id: "p1",
				generation: "g1",
				start: 0,
				end: 6,
				sourceText: "source",
				translatedText: "原文",
			},
		};
		const before = envelope("large-parts");
		// A complete compatibility projection remains intact when outside the write budget.
		expect(await narratorPersistence.patchReasoningTranslationPart(input)).toBeNull();
		expect(envelope("large-parts")).toEqual(before);
		const unrelated = rows("large-parts")[1].payload;
		sqlite.run(
			"UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1 WHERE id = 'large-parts'",
		);
		const revision = envelope("large-parts");
		const parse = JSON.parse;
		let unrelatedReads = 0;
		const guard = spyOn(JSON, "parse").mockImplementation((text, reviver) => {
			if (text === unrelated) {
				unrelatedReads++;
				throw new Error("Unrelated large block was materialized");
			}
			return parse(text, reviver);
		});
		try {
			const result = await narratorPersistence.patchReasoningTranslationPart(input);
			expect(result?.stateRevision).toBe(revision.state + 1);
		} finally {
			guard.mockRestore();
		}
		expect(unrelatedReads).toBe(0);
		expect(envelope("large-parts").body).toBe(revision.body);
		expect(envelope("large-parts").contentJson).toBe("[]");
		expect(rows("large-parts")[1].payload).toBe(unrelated);
	});

	test("legacy envelopes without a persistent reasoning row do not manufacture patch identity", async () => {
		seed(
			"legacy-parts",
			"assistant",
			[{ type: "reasoning", id: "r1", text: "source", translationGeneration: "g1" }],
			{ format: 1 },
		);
		const before = envelope("legacy-parts");
		expect(
			await narratorPersistence.patchReasoningTranslationPart({
				messageId: "legacy-parts",
				elementId: "r1",
				expected: { sourceText: "source", generation: "g1" },
				part: {
					id: "p1",
					generation: "g1",
					start: 0,
					end: 6,
					sourceText: "source",
					translatedText: "原文",
				},
			}),
		).toBeNull();
		expect(envelope("legacy-parts")).toEqual(before);
		expect(rows("legacy-parts")).toEqual([]);
	});

	test("rows-only translations merge independent parts and preserve the real body", async () => {
		seed("rows-parts", "assistant", [
			{ type: "reasoning", id: "r1", text: "a😀b", translationGeneration: "g1" },
		]);
		sqlite.run(
			"UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1 WHERE id = 'rows-parts'",
		);
		const initial = envelope("rows-parts");
		const patch = (part: { id: string; start: number; end: number; sourceText: string }) =>
			narratorPersistence.patchReasoningTranslationPart({
				messageId: "rows-parts",
				elementId: "r1",
				expected: { sourceText: "a😀b", generation: "g1" },
				part: { ...part, generation: "g1", translatedText: "译" },
			});
		expect(await patch({ id: "bad", start: 1, end: 2, sourceText: "\ud83d" })).toBeNull();
		expect(await patch({ id: "tail", start: 3, end: 4, sourceText: "b" })).not.toBeNull();
		expect(await patch({ id: "head", start: 0, end: 1, sourceText: "a" })).not.toBeNull();
		expect(envelope("rows-parts").contentJson).toBe("[]");
		expect(envelope("rows-parts").body).toBe(initial.body);
		expect(envelope("rows-parts").state).toBe(initial.state + 2);
		const state = JSON.parse(rows("rows-parts")[0].state ?? "null");
		expect(state.raw[0].translationParts.map((part: { id: string }) => part.id)).toEqual([
			"head",
			"tail",
		]);
		const controller = new AbortController();
		controller.abort();
		await expect(
			narratorPersistence.patchReasoningTranslationPart({
				messageId: "rows-parts",
				elementId: "r1",
				expected: { sourceText: "a😀b", generation: "g1" },
				part: {
					id: "cancelled",
					generation: "g1",
					start: 1,
					end: 3,
					sourceText: "😀",
					translatedText: "译",
				},
				signal: controller.signal,
			}),
		).rejects.toThrow();
	});
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
