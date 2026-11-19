import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	MAX_REASONING_TRANSLATION_SOURCE_BYTES,
	MAX_REASONING_TRANSLATION_STREAMING_SOURCE_BYTES,
	type ReasoningTranslationPart,
	type ReasoningTranslationVisibilityTarget,
} from "@shared/reasoning-translation";
import { cleanDb } from "../../../tests/setup";
import {
	REASONING_TRANSLATION_LIMITS,
	ReasoningTranslationScheduler,
} from "../reasoning-translation-scheduler";
import {
	ReasoningTranslationVisibility,
	type TranslationViewer,
} from "../reasoning-translation-visibility";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
mock.module("../../db", () => ({
	db,
	sqlite,
	activeDatabaseBackend: "sqlite",
	postgresRuntime: null,
}));
const prompt = { ...(await import("../../lib/prompt-i18n")) };
mock.module("../../lib/prompt-i18n", () => ({
	...prompt,
	getUserLanguage: async (id: string) => (id === "english" ? "en" : "zh-CN"),
}));
const { reasoningTranslationActivities: activity } = await import(
	"../reasoning-translation-activity"
);
const blockSync = await import("../narrator-block-sync");
const store = await import("../reasoning-translation-store");
const NOW = "2026-10-28T00:00:00.000Z";
const signal = () => new AbortController().signal;
const viewer = (narratorId = "author", userId = "chinese"): TranslationViewer => ({
	narratorId,
	userId,
	isCurrent: () => true,
	authorize: async () => true,
});

/** Storage/CAS fixtures keep queue timing in the dedicated scheduler suite. */
function createVisibility(
	dependencies: ConstructorParameters<typeof ReasoningTranslationVisibility>[0],
) {
	return new ReasoningTranslationVisibility(
		dependencies,
		new ReasoningTranslationScheduler({ ...REASONING_TRANSLATION_LIMITS, coalesceMs: 0 }),
	);
}

function ref(narratorId: string, messageId = "message") {
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, ?, ?, 1)",
		[`${narratorId}-${messageId}`, narratorId, messageId],
	);
}
function seed(elements: unknown[], format: 1 | 2 = 2): ReasoningTranslationVisibilityTarget {
	sqlite.run(
		"INSERT INTO narrator_messages (id, narrator_id, role, content_json, body_format, created_at) VALUES ('message', 'author', 'assistant', ?, ?, ?)",
		[JSON.stringify(elements), format, NOW],
	);
	ref("author");
	if (format === 2) blockSync.syncEnvelopeNow("message");
	const block = sqlite
		.query<{ id: string; revision: number }, []>(
			"SELECT id, revision FROM narrator_blocks WHERE message_id = 'message' AND kind = 'reasoning' LIMIT 1",
		)
		.get();
	const reasoningIndex = elements.findIndex((entry) =>
		["reasoning", "thinking"].includes((entry as { type?: string })?.type ?? ""),
	);
	const elementId = (elements[reasoningIndex] as { id?: string }).id;
	return {
		ownerNarratorId: "author",
		messageId: "message",
		blockId: block?.id ?? `message:${reasoningIndex}`,
		...(elementId
			? { elementId }
			: { legacyIndex: reasoningIndex, legacyVersion: block?.revision ?? 0 }),
	};
}
function part(
	source: NonNullable<Awaited<ReturnType<typeof store.loadVisibleTranslationSource>>>,
): ReasoningTranslationPart {
	return {
		id: "part",
		generation: source.generation,
		start: 0,
		end: 1,
		sourceText: source.text.slice(0, 1),
		translatedText: "译",
	};
}
function revisions() {
	return sqlite
		.query<{ body: number; state: number }, []>(
			"SELECT body_revision AS body, state_revision AS state FROM narrator_messages WHERE id = 'message'",
		)
		.get();
}

beforeEach(() => {
	activity.finish("author", true);
	cleanDb(sqlite);
	for (const id of ["author", "fork", "unrelated"])
		sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			id,
			id,
			NOW,
			NOW,
		]);
});
afterAll(async () => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../lib/prompt-i18n", () => prompt);
	await fixture.close();
});

describe("bounded visible translation source and state CAS", () => {
	test("real active store ranges upgrade an observed response into prefix and terminal batches", async () => {
		const target = seed([
			{
				type: "reasoning",
				id: "r",
				text: "A\n\nB\n\nC",
				completed: false,
				translationGeneration: "g",
				translationLocale: "zh-CN",
				translationParts: [],
			},
		]);
		activity.start("author", "r", 1, 0, { id: "A", index: 0 });
		activity.checkpoint("author", target, 1, 7, false);
		const firstLoaded = Promise.withResolvers<void>();
		const prefixesPublished = Promise.withResolvers<void>();
		const terminalPublished = Promise.withResolvers<void>();
		const singles: string[] = [];
		const batches: string[][] = [];
		let loads = 0,
			published = 0;
		const registry = createVisibility({
			enabled: () => true,
			completedRanges: (identity) => activity.completedRanges(identity),
			permits: (source, start, end) => activity.allows(source.target, start, end),
			load: async (...args) => {
				const source = await store.loadVisibleTranslationSource(...args);
				if (++loads === 1) firstLoaded.resolve();
				return source;
			},
			translate: async (_source, _viewer, task) => {
				singles.push(task.sourceText);
				return "单项";
			},
			translateBatch: async (source, _viewer, tasks) => {
				expect(source.allowedRanges).toBeArray();
				expect(source.runAnchor).toEqual(target);
				batches.push(tasks.map((task) => task.sourceText));
				return JSON.stringify({
					parts: tasks.map((task) => ({ id: task.id, translatedText: "译" })),
				});
			},
			apply: store.applyVisibleTranslationPart,
			publish: () => {
				if (++published === 2) prefixesPublished.resolve();
				if (published === 3) terminalPublished.resolve();
			},
		});
		try {
			registry.replace(
				{},
				"body",
				viewer(),
				[target],
				[{ groupId: "real-run", anchor: target, targetIndexes: [0] }],
			);
			await firstLoaded.promise;
			for (let index = 0; index < 100; index++) await Promise.resolve();
			expect(singles).toHaveLength(0);
			expect(batches).toHaveLength(0);
			activity.seal("author", "r", 1, 0, 1, { id: "A", index: 0 });
			activity.start("author", "r", 2, 7, { id: "B", index: 1 });
			activity.seal("author", "r", 1, 3, 4, { id: "B", index: 1 });
			activity.start("author", "r", 3, 7, { id: "C", index: 2 });
			registry.complete(target);
			registry.notify("message");
			await prefixesPublished.promise;
			expect(singles).toHaveLength(0);
			expect(batches).toEqual([["A", "B"]]);
			expect(activity.allows(target, 6, 7)).toBe(false);
			activity.finish("author");
			registry.complete(target);
			registry.notify("message");
			await terminalPublished.promise;
			expect(singles).toHaveLength(0);
			expect(batches).toEqual([["A", "B"], ["\n\nC"]]);
			const restored = await store.loadVisibleTranslationSource(target, viewer(), signal());
			expect(restored?.parts?.map(({ start, end }) => [start, end])).toEqual([
				[0, 1],
				[3, 4],
				[4, 7],
			]);
		} finally {
			await registry.stop();
		}
	});

	for (const firstResult of ["prefix", "tail"] as const) {
		test(`a slow prefix and terminal tail persist independently (${firstResult} writes first)`, async () => {
			const target = seed([
				{
					type: "reasoning",
					id: "r",
					text: "A\n\nB\n\nC",
					completed: false,
					translationGeneration: "g",
					translationLocale: "zh-CN",
					translationParts: [
						{
							id: "accepted-A",
							generation: "g",
							start: 0,
							end: 1,
							sourceText: "A",
							translatedText: "甲",
						},
					],
				},
			]);
			activity.start("author", "r", 1, 0, { id: "A", index: 0 });
			activity.checkpoint("author", target, 1, 7, false);
			activity.seal("author", "r", 1, 0, 1, { id: "A", index: 0 });
			activity.start("author", "r", 2, 7, { id: "B", index: 1 });
			activity.seal("author", "r", 1, 3, 4, { id: "B", index: 1 });
			activity.start("author", "r", 3, 7, { id: "C", index: 2 });
			const requests: Array<{
				task: { start: number; end: number; sourceText: string };
				signal: AbortSignal;
				resolve: (text: string) => void;
			}> = [];
			const prefixStarted = Promise.withResolvers<void>();
			const tailStarted = Promise.withResolvers<void>();
			const firstPublished = Promise.withResolvers<void>();
			const bothPublished = Promise.withResolvers<void>();
			let published = 0;
			const registry = createVisibility({
				enabled: () => true,
				completedRanges: (identity) => activity.completedRanges(identity),
				permits: (source, start, end) => activity.allows(source.target, start, end),
				load: store.loadVisibleTranslationSource,
				translate: async (_source, _viewer, task, signal) =>
					new Promise<string>((resolve) => {
						requests.push({ task, signal, resolve });
						if (requests.length === 1) prefixStarted.resolve();
						if (requests.length === 2) tailStarted.resolve();
					}),
				apply: store.applyVisibleTranslationPart,
				publish: () => {
					published++;
					if (published === 1) firstPublished.resolve();
					if (published === 2) bothPublished.resolve();
				},
			});
			try {
				registry.replace({}, "body", viewer(), [target]);
				await prefixStarted.promise;
				expect(requests[0].task.sourceText).toBe("B");
				activity.finish("author");
				registry.complete(target);
				registry.notify("message");
				await tailStarted.promise;
				expect(requests.map(({ task }) => task.sourceText)).toEqual(["B", "\n\nC"]);
				expect(requests.map(({ task }) => [task.start, task.end])).toEqual([
					[3, 4],
					[4, 7],
				]);
				const order = firstResult === "prefix" ? [0, 1] : [1, 0];
				requests[order[0]].resolve(order[0] === 0 ? "乙" : "丙");
				await firstPublished.promise;
				requests[order[1]].resolve(order[1] === 0 ? "乙" : "丙");
				await bothPublished.promise;
				const restored = await store.loadVisibleTranslationSource(target, viewer(), signal());
				expect(
					restored?.parts?.map(({ start, end, sourceText }) => [start, end, sourceText]),
				).toEqual([
					[0, 1, "A"],
					[3, 4, "B"],
					[4, 7, "\n\nC"],
				]);
				expect(published).toBe(2);
			} finally {
				for (const request of requests) request.resolve("译");
				await registry.stop();
			}
		});
	}

	test("full checkpoint proof requires the exact durable revision, UTF-16 text and completion", async () => {
		const text = "A😀B";
		const target = seed([{ type: "reasoning", id: "r", revision: 3, text, completed: true }]);
		const proof = {
			blockRevision: 3,
			start: 0,
			end: text.length,
			sourceText: text,
			completed: true,
		};
		expect(await store.resolveReasoningTranslationTarget("author", "message", "r", proof)).toEqual(
			target,
		);
		for (const invalid of [
			{ ...proof, blockRevision: 2 },
			{ ...proof, end: 3, sourceText: "A😀" },
			{ ...proof, sourceText: "B😀A" },
			{ ...proof, start: 1, end: 3, sourceText: "😀" },
		])
			expect(
				await store.resolveReasoningTranslationTarget("author", "message", "r", invalid),
			).toBeNull();
		expect(
			await store.resolveReasoningTranslationTarget("author", "message", "missing", proof),
		).toBeNull();
	});

	test.each([
		false,
		undefined,
		1,
		"true",
	])("durable completed=%s cannot prove an explicit item completion", async (completed) => {
		const target = seed([
			{
				type: "reasoning",
				id: "r",
				revision: 1,
				text: "ABC",
				...(completed !== undefined ? { completed } : {}),
			},
		]);
		const proof = { blockRevision: 1, start: 0, end: 3, sourceText: "ABC", completed: true };
		expect(
			await store.resolveReasoningTranslationTarget("author", "message", "r", proof),
		).toBeNull();
		expect(
			await store.resolveReasoningTranslationTarget("author", "message", "r", {
				...proof,
				completed: false,
			}),
		).toEqual(target);
	});

	test("a completed active item accepts a translated result without retiring the display owner", async () => {
		const text = "A😀B";
		const target = seed([
			{
				type: "reasoning",
				id: "r",
				revision: 2,
				text,
				completed: true,
				translationGeneration: "g",
				translationLocale: "zh-CN",
				translationParts: [],
			},
		]);
		activity.start("author", "r", 1, 0);
		const proof = await store.resolveReasoningTranslationTarget("author", "message", "r", {
			blockRevision: 2,
			start: 0,
			end: text.length,
			sourceText: text,
			completed: true,
		});
		if (!proof) throw new Error("Missing durable completion proof");
		expect(activity.checkpoint("author", proof, 2, text.length, true)).toBe(true);
		const before = activity.get("author");
		const source = await store.loadVisibleTranslationSource(target, viewer(), signal());
		if (!source) throw new Error("Missing completed active source");
		expect(source.allowedRanges).toEqual([{ start: 0, end: text.length }]);
		expect(
			await store.applyVisibleTranslationPart(
				source,
				viewer(),
				{
					id: "full",
					generation: source.generation,
					start: 0,
					end: text.length,
					sourceText: text,
					translatedText: "完整译文。\n\n第二段。",
				},
				signal(),
			),
		).not.toBeNull();
		expect(activity.get("author")).toEqual(before);
		expect(before).toMatchObject({ elementId: "r", displayTailStart: 0 });
	});

	test("summary seal source matching uses UTF-16 after and within astral characters", async () => {
		const target = seed([
			{ type: "reasoning", id: "r", revision: 3, text: "😀A😀BC", completed: false },
		]);
		expect(
			await store.resolveReasoningTranslationTarget("author", "message", "r", {
				blockRevision: 3,
				start: 2,
				end: 5,
				sourceText: "A😀",
			}),
		).toEqual(target);
		expect(
			await store.resolveReasoningTranslationTarget("author", "message", "r", {
				blockRevision: 2,
				start: 2,
				end: 5,
				sourceText: "A😀",
			}),
		).toBeNull();
		expect(
			await store.resolveReasoningTranslationTarget("author", "message", "r", {
				blockRevision: 3,
				start: 2,
				end: 5,
				sourceText: "wrong",
			}),
		).toBeNull();
	});

	test("active source exposes only sealed prefixes and rejects late tail writes", async () => {
		const target = seed([{ type: "reasoning", id: "r", text: "ABC", completed: false }]);
		activity.start("author", "r", 1);
		activity.checkpoint("author", target, 1, 3, false);
		let source = await store.loadVisibleTranslationSource(target, viewer(), signal());
		expect(source?.allowedRanges).toEqual([]);
		activity.seal("author", "r", 1, 0, 1, { id: "A", index: 0 });
		activity.start("author", "r", 2, 3, { id: "B", index: 1 });
		source = await store.loadVisibleTranslationSource(target, viewer(), signal());
		if (!source) throw new Error("Missing sealed source");
		expect(source.allowedRanges).toEqual([{ start: 0, end: 1 }]);
		const tail = { ...part(source), start: 1, end: 3, sourceText: "BC" };
		expect(await store.applyVisibleTranslationPart(source, viewer(), tail, signal())).toBeNull();
		expect(
			await store.applyVisibleTranslationPart(source, viewer(), part(source), signal()),
		).not.toBeNull();
		expect(
			(await store.loadVisibleTranslationSource(target, viewer(), signal()))?.parts,
		).toHaveLength(1);
	});

	test("a reopened tail retains a valid previously completed prefix result", async () => {
		const target = seed([{ type: "reasoning", id: "r", text: "AB", completed: false }]);
		const source = await store.loadVisibleTranslationSource(target, viewer(), signal());
		if (!source) throw new Error("Missing historical source");
		activity.start("author", "r", 1);
		activity.checkpoint("author", target, 1, 1, true);
		activity.finish("author");
		activity.start("author", "r", 2, 1);
		expect(
			await store.applyVisibleTranslationPart(
				source,
				viewer(),
				{ ...part(source), start: 1, end: 2, sourceText: "B" },
				signal(),
			),
		).toBeNull();
		expect(
			await store.applyVisibleTranslationPart(source, viewer(), part(source), signal()),
		).not.toBeNull();
	});

	test("a referenced historical source initializes generation and language as state only", async () => {
		const target = seed([{ type: "reasoning", id: "r", text: "ABC" }]);
		const before = revisions();
		if (!before) throw new Error("Missing stored envelope");
		const source = await store.loadVisibleTranslationSource(target, viewer(), signal());
		expect(source).not.toBeNull();
		if (!source) throw new Error("Missing source");
		expect(source.locale).toBe("zh-CN");
		expect(source.generation).toBeTruthy();
		expect(revisions()).toEqual({ body: before.body, state: before.state + 1 });
		expect(
			await store.applyVisibleTranslationPart(source, viewer(), part(source), signal()),
		).not.toBeNull();
		expect(revisions()?.body).toBe(before?.body);
		expect(
			await store.applyVisibleTranslationPart(source, viewer(), part(source), signal()),
		).toBeNull();
		const reopened = await store.loadVisibleTranslationSource(
			target,
			viewer("author", "english"),
			signal(),
		);
		expect(reopened?.locale).toBe("zh-CN");
		expect(reopened?.parts).toHaveLength(1);
	});

	test("a fork's actual shared ref authorizes history without access to its original author", async () => {
		const target = seed([
			{
				type: "reasoning",
				id: "r",
				text: "ABC",
				translationGeneration: "g",
				translationLocale: "zh-CN",
			},
		]);
		ref("fork");
		expect(await store.canReferenceVisibleTranslationTarget(target, "fork", signal())).toBe(true);
		const source = await store.loadVisibleTranslationSource(target, viewer("fork"), signal());
		expect(source).not.toBeNull();
		if (!source) throw new Error("Missing shared source");
		expect(
			await store.applyVisibleTranslationPart(source, viewer("fork"), part(source), signal()),
		).not.toBeNull();
		expect(await store.canReferenceVisibleTranslationTarget(target, "unrelated", signal())).toBe(
			false,
		);
		expect(
			await store.loadVisibleTranslationSource(target, viewer("unrelated"), signal()),
		).toBeNull();
		expect(
			await store.loadVisibleTranslationSource(
				{ ...target, ownerNarratorId: "unrelated" },
				viewer("fork"),
				signal(),
			),
		).toBeNull();
		expect(
			await store.loadVisibleTranslationSource(
				{ ...target, blockId: "wrong" },
				viewer("fork"),
				signal(),
			),
		).toBeNull();
		expect(
			await store.loadVisibleTranslationSource(
				{ ...target, elementId: "wrong" },
				viewer("fork"),
				signal(),
			),
		).toBeNull();
	});

	test("an aggregate child is authorized only through its real visible Agent origin and author ref", async () => {
		sqlite.run(
			"INSERT INTO narrators (id, type, variant, parent_narrator_id, origin_tool_call_id, created_at, updated_at) VALUES ('child', 'subagent', 'subagent:general', 'author', 'origin', ?, ?)",
			[NOW, NOW],
		);
		sqlite.run(
			"INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES ('parent', 'author', 'assistant', '[]', ?)",
			[NOW],
		);
		ref("fork", "parent");
		sqlite.run(
			"INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, execution_identity_version, created_at) VALUES ('origin', 'author', 'parent', 'agent-call', 'Agent', 1, ?)",
			[NOW],
		);
		sqlite.run(
			"INSERT INTO narrator_messages (id, narrator_id, role, content_json, body_format, parent_tool_use_id, created_at) VALUES ('message', 'child', 'assistant', ?, 2, 'agent-call', ?)",
			[
				JSON.stringify([
					{
						type: "reasoning",
						id: "r",
						text: "ABC",
						translationGeneration: "g",
						translationLocale: "zh-CN",
					},
				]),
				NOW,
			],
		);
		ref("child");
		blockSync.syncEnvelopeNow("message");
		const block = sqlite
			.query<{ id: string }, []>(
				"SELECT id FROM narrator_blocks WHERE message_id = 'message' AND kind = 'reasoning' LIMIT 1",
			)
			.get();
		if (!block) throw new Error("Missing child block");
		const target = {
			ownerNarratorId: "child",
			messageId: "message",
			blockId: block.id,
			elementId: "r",
		};
		expect(await store.canReferenceVisibleTranslationTarget(target, "fork", signal())).toBe(true);
		const source = await store.loadVisibleTranslationSource(target, viewer("fork"), signal());
		if (!source) throw new Error("Missing child source");
		expect(
			await store.applyVisibleTranslationPart(source, viewer("fork"), part(source), signal()),
		).not.toBeNull();
		sqlite.run("UPDATE narrator_tool_calls SET tool_name = 'Bash' WHERE id = 'origin'");
		expect(await store.canReferenceVisibleTranslationTarget(target, "fork", signal())).toBe(false);
		sqlite.run(
			"UPDATE narrator_tool_calls SET tool_name = 'Agent', is_file_history_checkpoint = 1 WHERE id = 'origin'",
		);
		expect(await store.canReferenceVisibleTranslationTarget(target, "fork", signal())).toBe(false);
		sqlite.run("UPDATE narrator_tool_calls SET is_file_history_checkpoint = 0 WHERE id = 'origin'");
		sqlite.run("DELETE FROM narrator_message_refs WHERE narrator_id = 'child'");
		expect(await store.canReferenceVisibleTranslationTarget(target, "fork", signal())).toBe(false);
	});

	test("revoked refs, body replacement and cancelled writes fail their atomic guard", async () => {
		const target = seed([
			{
				type: "reasoning",
				id: "r",
				text: "ABC",
				translationGeneration: "g",
				translationLocale: "zh-CN",
			},
		]);
		ref("fork");
		const source = await store.loadVisibleTranslationSource(target, viewer("fork"), signal());
		if (!source) throw new Error("Missing source");
		sqlite.run("DELETE FROM narrator_message_refs WHERE narrator_id = 'fork'");
		expect(
			await store.applyVisibleTranslationPart(source, viewer("fork"), part(source), signal()),
		).toBeNull();
		const controller = new AbortController();
		controller.abort();
		await expect(
			store.applyVisibleTranslationPart(source, viewer(), part(source), controller.signal),
		).rejects.toThrow();
		sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = 'message'", [
			JSON.stringify([
				{
					type: "reasoning",
					id: "r",
					text: "NEW",
					translationGeneration: "next",
					translationLocale: "zh-CN",
				},
			]),
		]);
		blockSync.syncEnvelopeNow("message");
		expect(
			await store.applyVisibleTranslationPart(source, viewer(), part(source), signal()),
		).toBeNull();
	});

	test("append accepts an in-flight prefix under its current block revision and rejects replaced lineage", async () => {
		const target = seed([
			{
				type: "reasoning",
				id: "r",
				text: "ABC",
				translationGeneration: "g",
				translationLocale: "zh-CN",
			},
		]);
		const source = await store.loadVisibleTranslationSource(target, viewer(), signal());
		if (!source) throw new Error("Missing prefix source");
		sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = 'message'", [
			JSON.stringify([
				{
					type: "reasoning",
					id: "r",
					text: "ABCD",
					translationGeneration: "g",
					translationLocale: "zh-CN",
				},
			]),
		]);
		blockSync.syncEnvelopeNow("message");
		const applied = await store.applyVisibleTranslationPart(
			source,
			viewer(),
			part(source),
			signal(),
		);
		expect(applied).not.toBeNull();
		const current = sqlite
			.query<{ revision: number }, [string]>("SELECT revision FROM narrator_blocks WHERE id = ?")
			.get(target.blockId);
		expect(applied).toMatchObject({ blockRevision: current?.revision });
		const reopened = await store.loadVisibleTranslationSource(target, viewer(), signal());
		expect(reopened?.text).toBe("ABCD");
		expect(reopened?.parts).toHaveLength(1);
		for (const replacement of [
			{ text: "REPLACED", translationGeneration: "next", translationLocale: "zh-CN" },
			{ text: "ABCD", translationGeneration: "g", translationLocale: "en" },
		]) {
			sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = 'message'", [
				JSON.stringify([{ type: "reasoning", id: "r", ...replacement }]),
			]);
			blockSync.syncEnvelopeNow("message");
			expect(
				await store.applyVisibleTranslationPart(
					source,
					viewer(),
					{ ...part(source), id: "late" },
					signal(),
				),
			).toBeNull();
		}
	});

	test("legacy body-format one uses the existing decoded block identity and reload contract", async () => {
		const target = seed(
			[
				{ type: "text", text: "before" },
				{ type: "reasoning", text: "ABC" },
			],
			1,
		);
		expect(target).toMatchObject({ blockId: "message:1", legacyIndex: 1, legacyVersion: 0 });
		const source = await store.loadVisibleTranslationSource(target, viewer(), signal());
		expect(source?.reload).toBe(true);
		if (!source) throw new Error("Missing legacy source");
		expect(
			await store.applyVisibleTranslationPart(source, viewer(), part(source), signal()),
		).not.toBeNull();
		const restored = await store.loadVisibleTranslationSource(target, viewer(), signal());
		expect(restored?.parts).toHaveLength(1);
		expect(
			await store.loadVisibleTranslationSource({ ...target, legacyIndex: 0 }, viewer(), signal()),
		).toBeNull();
		expect(
			await store.loadVisibleTranslationSource({ ...target, legacyVersion: 1 }, viewer(), signal()),
		).toBeNull();
	});

	test("legacy sources with element IDs keep exact body versions while state-only parts remain composable", async () => {
		const target = seed(
			[
				{
					type: "reasoning",
					id: "r",
					text: "ABC",
					translationGeneration: "g",
					translationLocale: "zh-CN",
				},
			],
			1,
		);
		const source = await store.loadVisibleTranslationSource(target, viewer(), signal());
		if (!source) throw new Error("Missing identified legacy source");
		const before = revisions();
		expect(
			await store.applyVisibleTranslationPart(source, viewer(), part(source), signal()),
		).not.toBeNull();
		expect(revisions()?.body).toBe(before?.body);
		const tail: ReasoningTranslationPart = {
			id: "tail",
			generation: source.generation,
			start: 1,
			end: 2,
			sourceText: "B",
			translatedText: "乙",
		};
		sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = 'message'", [
			JSON.stringify([
				{
					type: "reasoning",
					id: "r",
					text: "ABCD",
					translationGeneration: "g",
					translationLocale: "zh-CN",
					translationParts: [part(source)],
				},
			]),
		]);
		expect(await store.applyVisibleTranslationPart(source, viewer(), tail, signal())).toBeNull();
		const current = await store.loadVisibleTranslationSource(target, viewer(), signal());
		if (!current) throw new Error("Missing current legacy source");
		expect(current.parts).toHaveLength(1);
		const body = revisions()?.body;
		expect(
			await store.applyVisibleTranslationPart(current, viewer(), tail, signal()),
		).not.toBeNull();
		expect(revisions()?.body).toBe(body);
	});

	for (const identity of [
		{ format: 2, elementId: "r" },
		{ format: 1, elementId: "r" },
		{ format: 1, elementId: undefined },
		{ format: 2, elementId: undefined },
	] as const) {
		test(`format ${identity.format} ${identity.elementId ? "identified" : "indexed"} source reuses pending work across exact-content revisions`, async () => {
			const element = {
				type: "reasoning",
				...(identity.elementId ? { id: identity.elementId } : {}),
				text: "ABC",
				completed: false,
				translationGeneration: "g",
				translationLocale: "zh-CN",
			};
			const target = seed([element], identity.format);
			const initial = await store.loadVisibleTranslationSource(target, viewer(), signal());
			if (!initial) throw new Error("Missing original source");
			const originalVersion = initial.version;
			const before = revisions();
			const result = Promise.withResolvers<string>();
			const started = Promise.withResolvers<void>();
			const refreshed = Promise.withResolvers<void>();
			const applied = Promise.withResolvers<unknown | null>();
			const requests: AbortSignal[] = [];
			let loads = 0;
			let refreshedVersion: string | undefined;
			let publications = 0;
			const registry = createVisibility({
				enabled: () => true,
				load: async (identity, observer, abort) => {
					const source = await store.loadVisibleTranslationSource(identity, observer, abort);
					loads++;
					if (loads === 2) {
						refreshedVersion = source?.version;
						refreshed.resolve();
					}
					return source;
				},
				translate: async (_source, _viewer, _task, abort) => {
					requests.push(abort);
					started.resolve();
					return result.promise;
				},
				apply: async (source, observer, part, abort) => {
					const committed = await store.applyVisibleTranslationPart(source, observer, part, abort);
					applied.resolve(committed);
					return committed;
				},
				publish: () => publications++,
			});
			try {
				registry.replace({}, "history", viewer(), [target]);
				await started.promise;
				const content =
					identity.format === 2 && !identity.elementId
						? [element, { type: "text", text: "sibling output" }]
						: [{ ...element, completed: true }];
				sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = 'message'", [
					JSON.stringify(content),
				]);
				if (identity.format === 2) blockSync.syncEnvelopeNow("message");
				expect(revisions()?.body).toBeGreaterThan(before?.body ?? -1);
				if (identity.format === 1 || !identity.elementId)
					expect(
						await store.applyVisibleTranslationPart(initial, viewer(), part(initial), signal()),
					).toBeNull();
				registry.notify("message");
				await refreshed.promise;
				for (let index = 0; index < 100; index++) await Promise.resolve();
				expect(refreshedVersion).toBeString();
				expect(refreshedVersion).not.toBe(originalVersion);
				expect(requests).toHaveLength(1);
				expect(requests[0].aborted).toBe(false);
				result.resolve("甲乙丙");
				expect(await applied.promise).not.toBeNull();
				for (let index = 0; index < 100; index++) await Promise.resolve();
				expect(publications).toBe(1);
				const restored = await store.loadVisibleTranslationSource(target, viewer(), signal());
				expect(restored?.parts).toHaveLength(1);
				expect(restored?.parts?.[0]).toMatchObject({
					sourceText: "ABC",
					translatedText: "甲乙丙",
				});
				expect(requests).toHaveLength(1);
			} finally {
				result.resolve("译");
				await registry.stop();
			}
		});
	}

	for (const phase of ["source read", "authorization", "late notification"]) {
		for (const replacement of [
			undefined,
			{ text: "NEW" },
			{ translationGeneration: "next" },
			{ translationLocale: "ja" },
		]) {
			test(`legacy result during ${phase} ${replacement ? `discards changed ${Object.keys(replacement)[0]}` : "uses the refreshed exact-content CAS"}`, async () => {
				const element = {
					type: "reasoning",
					id: "r",
					text: "ABC",
					completed: false,
					translationGeneration: "g",
					translationLocale: "zh-CN",
				};
				const target = seed([element], 1);
				const result = Promise.withResolvers<string>();
				const laterResult = Promise.withResolvers<string>();
				const started = Promise.withResolvers<void>();
				const paused = Promise.withResolvers<void>();
				const resume = Promise.withResolvers<void>();
				const attempted = Promise.withResolvers<void>();
				const latestLoaded = Promise.withResolvers<void>();
				const requests: AbortSignal[] = [];
				const writes: Array<unknown | null> = [];
				let loads = 0;
				let gated = false;
				let publications = 0;
				const observer = viewer();
				observer.authorize = async () => {
					if (phase === "authorization" && loads === 2 && !gated) {
						gated = true;
						paused.resolve();
						await resume.promise;
					}
					return true;
				};
				const registry = createVisibility({
					enabled: () => true,
					load: async (identity, viewer, abort) => {
						const source = await store.loadVisibleTranslationSource(identity, viewer, abort);
						loads++;
						if (loads === 2 && phase !== "authorization") {
							paused.resolve();
							await resume.promise;
						}
						if (loads === 3) latestLoaded.resolve();
						return source;
					},
					translate: async (_source, _viewer, _task, abort) => {
						requests.push(abort);
						started.resolve();
						return requests.length === 1 ? result.promise : laterResult.promise;
					},
					apply: async (source, viewer, part, abort) => {
						const committed = await store.applyVisibleTranslationPart(source, viewer, part, abort);
						writes.push(committed);
						attempted.resolve();
						return committed;
					},
					publish: () => publications++,
				});
				try {
					registry.replace({}, "history", observer, [target]);
					await started.promise;
					sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = 'message'", [
						JSON.stringify([{ ...element, completed: true }]),
					]);
					if (phase !== "late notification") {
						registry.notify("message");
						await paused.promise;
					}
					result.resolve("甲乙丙");
					await attempted.promise;
					expect(writes).toEqual([null]);
					if (phase === "late notification") {
						for (let index = 0; index < 100; index++) await Promise.resolve();
						registry.notify("message");
						await paused.promise;
					}
					if (replacement) {
						sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = 'message'", [
							JSON.stringify([{ ...element, completed: true, ...replacement }]),
						]);
						registry.notify("message");
					}
					resume.resolve();
					if (replacement) await latestLoaded.promise;
					for (let index = 0; index < 100; index++) await Promise.resolve();
					const restored = await store.loadVisibleTranslationSource(target, observer, signal());
					if (replacement) {
						expect(requests[0].aborted).toBe(true);
						expect(writes).toEqual([null]);
						expect(restored?.parts).toHaveLength(0);
						expect(publications).toBe(0);
					} else {
						expect(requests).toHaveLength(1);
						expect(requests[0].aborted).toBe(false);
						expect(writes).toHaveLength(2);
						expect(writes[1]).not.toBeNull();
						expect(restored?.parts?.[0]?.translatedText).toBe("甲乙丙");
						expect(publications).toBe(1);
					}
				} finally {
					resume.resolve();
					result.resolve("译");
					laterResult.resolve("译");
					await registry.stop();
				}
			});
		}
	}

	test("a multi-job legacy source completes every part and reopens from its persisted coverage", async () => {
		const text = "A".repeat(MAX_REASONING_TRANSLATION_SOURCE_BYTES + 8);
		const target = seed([{ type: "reasoning", text }], 1);
		const before = revisions();
		const calls: number[] = [];
		let complete = () => {};
		let onReload: (() => void) | undefined;
		let publications = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finished = new Promise<void>((resolve, reject) => {
			complete = resolve;
			timer = setTimeout(() => reject(new Error("Legacy parts did not complete")), 9_000);
		});
		const registry = createVisibility({
			enabled: () => true,
			load: async (identity, observer, abort) => {
				const source = await store.loadVisibleTranslationSource(identity, observer, abort);
				onReload?.();
				return source;
			},
			translate: async (_source, _viewer, task) => {
				calls.push(task.sourceText.length);
				return "译";
			},
			apply: store.applyVisibleTranslationPart,
			publish: () => {
				publications++;
				if (publications === 3) complete();
			},
		});
		const connection = {};
		try {
			registry.replace(connection, "history", viewer(), [target]);
			await finished;
			// This dependency intentionally exercises the non-batched 16KiB task path.
			expect(calls).toEqual([
				MAX_REASONING_TRANSLATION_STREAMING_SOURCE_BYTES,
				MAX_REASONING_TRANSLATION_STREAMING_SOURCE_BYTES,
				8,
			]);
			expect(revisions()?.body).toBe(before?.body);
			const restored = await store.loadVisibleTranslationSource(target, viewer(), signal());
			expect(restored?.parts).toHaveLength(3);
			expect(restored?.parts?.map(({ start, end }) => [start, end])).toEqual([
				[0, MAX_REASONING_TRANSLATION_STREAMING_SOURCE_BYTES],
				[MAX_REASONING_TRANSLATION_STREAMING_SOURCE_BYTES, MAX_REASONING_TRANSLATION_SOURCE_BYTES],
				[MAX_REASONING_TRANSLATION_SOURCE_BYTES, text.length],
			]);
			expect(restored?.parts?.map((part) => part.sourceText).join("")).toBe(text);
			expect(restored?.parts?.at(-1)?.end).toBe(text.length);
			registry.release(connection);
			const reloaded = new Promise<void>((resolve) => {
				onReload = resolve;
			});
			registry.replace({}, "reopened", viewer(), [target]);
			await reloaded;
			for (let index = 0; index < 100; index++) await Promise.resolve();
			expect(calls).toHaveLength(3);
		} finally {
			clearTimeout(timer);
			registry.release(connection);
			await registry.stop();
		}
	}, 15_000);

	test("legacy thinking fields translate and reopen without rewriting their original body", async () => {
		const target = seed([{ type: "thinking", thinking: "ABC" }], 1);
		const before = revisions();
		const source = await store.loadVisibleTranslationSource(target, viewer(), signal());
		if (!source) throw new Error("Missing historical thinking source");
		expect(source.text).toBe("ABC");
		expect(
			await store.applyVisibleTranslationPart(source, viewer(), part(source), signal()),
		).not.toBeNull();
		const reopened = await store.loadVisibleTranslationSource(target, viewer(), signal());
		expect(reopened?.parts).toHaveLength(1);
		const row = sqlite
			.query<{ body: string }, []>(
				"SELECT content_json AS body FROM narrator_messages WHERE id = 'message'",
			)
			.get();
		const original = JSON.parse(row?.body ?? "[]")[0];
		expect(original.thinking).toBe("ABC");
		expect(original).not.toHaveProperty("text");
		expect(revisions()?.body).toBe(before?.body);
	});

	test("missing element IDs in physical blocks use an exact position and block revision", async () => {
		const target = seed([{ type: "reasoning", text: "ABC" }]);
		const source = await store.loadVisibleTranslationSource(target, viewer(), signal());
		if (!source) throw new Error("Missing positional source");
		expect(
			await store.applyVisibleTranslationPart(source, viewer(), part(source), signal()),
		).not.toBeNull();
		expect(
			await store.loadVisibleTranslationSource(
				{ ...target, legacyVersion: (target.legacyVersion ?? 0) + 1 },
				viewer(),
				signal(),
			),
		).toBeNull();
	});

	test("cached full translations and bounded locale/part metadata never start additional work", async () => {
		const target = seed([
			{
				type: "reasoning",
				id: "r",
				text: "ABC",
				translationGeneration: "g",
				translationLocale: "zh-CN",
			},
		]);
		for (const state of [
			{ translatedText: "已译", translationLocale: "zh-CN" },
			{ translationLocale: "zh-CN\nextra instruction" },
			{ translationLocale: "x".repeat(36) },
			{ translationLocale: "zh-CN", translationParts: Array.from({ length: 513 }, () => ({})) },
		]) {
			sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = 'message'", [
				JSON.stringify([
					{ type: "reasoning", id: "r", text: "ABC", translationGeneration: "g", ...state },
				]),
			]);
			blockSync.syncEnvelopeNow("message");
			const before = revisions();
			expect(await store.loadVisibleTranslationSource(target, viewer(), signal())).toBeNull();
			expect(revisions()).toEqual(before);
		}
		sqlite.run("UPDATE narrator_messages SET content_text = ? WHERE id = 'message'", [
			"x".repeat(1024 * 1024),
		]);
		expect(await store.loadVisibleTranslationSource(target, viewer(), signal())).toBeNull();
	});

	test("unknown-language existing translations and oversized sources keep their original state", async () => {
		const target = seed([{ type: "reasoning", id: "r", text: "ABC", translatedText: "ancien" }]);
		const before = revisions();
		expect(await store.loadVisibleTranslationSource(target, viewer(), signal())).toBeNull();
		expect(revisions()).toEqual(before);
		sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = 'message'", [
			JSON.stringify([{ type: "reasoning", id: "r", text: "x".repeat(256 * 1024 + 1) }]),
		]);
		blockSync.syncEnvelopeNow("message");
		expect(await store.loadVisibleTranslationSource(target, viewer(), signal())).toBeNull();
	});
});
