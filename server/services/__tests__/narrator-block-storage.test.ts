/**
 * Block storage dual-write (docs/BLOCK_STORAGE-DESIGN.md P1): every block-format envelope
 * keeps `narrator_blocks` rows that assemble back to its stored content, through the
 * store's own writes and through the queue for everyone else's.
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { assembleContent } from "@shared/narrator-blocks/storage";
import { z } from "zod/v4";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const blockSync = await import("../narrator-block-sync");
const turns = await import("../narrator-turns");
const epochs = await import("../narrator-epochs");
const { toolRegistry } = await import("../../lib/agent/tool-registry");

const NOW = "2026-10-01T00:00:00.000Z";

beforeEach(() => {
	cleanDb(sqlite);
	for (const id of ["n1", "n2"])
		sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			id,
			`Narrator ${id}`,
			NOW,
			NOW,
		]);
});
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

interface BlockRow {
	id: string;
	kind: string;
	subtype: string | null;
	phase: string;
	attemptId: string | null;
	originBlockId: string | null;
	wireId: string | null;
	payload: string;
	state: string | null;
}

function blocks(messageId: string): BlockRow[] {
	return sqlite
		.prepare(
			`SELECT id, kind, subtype, phase, attempt_id AS attemptId, origin_block_id AS originBlockId,
				wire_id AS wireId, payload, state
			 FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal`,
		)
		.all(messageId) as BlockRow[];
}

function assembled(messageId: string): unknown[] {
	return assembleContent(
		blocks(messageId).map((row) => ({
			payload: JSON.parse(row.payload),
			state: row.state ? JSON.parse(row.state) : null,
		})),
	);
}

function envelope(messageId: string) {
	return sqlite
		.prepare(
			`SELECT narrator_id AS narratorId, author_narrator_id AS authorNarratorId,
				body_format AS bodyFormat, turn_id AS turnId, content_json AS contentJson
			 FROM narrator_messages WHERE id = ?`,
		)
		.get(messageId) as {
		narratorId: string;
		authorNarratorId: string | null;
		bodyFormat: number;
		turnId: string | null;
		contentJson: string;
	};
}

const content = (messageId: string) => JSON.parse(envelope(messageId).contentJson) as unknown[];

const queued = () =>
	(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get() as { n: number }).n;

describe("block storage dual-write", () => {
	test("a streamed step keeps one row per item, equal to its content", async () => {
		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		expect(envelope(step.id)).toMatchObject({ bodyFormat: 2, authorNarratorId: "n1" });

		await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "text", id: "t1", text: "Hel", completed: false, outputIndex: 0 },
			{ attemptId: "a1" },
		);
		const [open] = blocks(step.id);
		expect(open).toMatchObject({ kind: "output", phase: "open", attemptId: "a1" });

		await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "text", id: "t1", text: "Hello", completed: true, outputIndex: 0 },
			{ attemptId: "a1" },
		);
		const [sealed] = blocks(step.id);
		// The checkpoint rewrote the same row, not a new one.
		expect(sealed).toMatchObject({ id: open.id, phase: "done" });

		const toolCallId = await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" }, outputIndex: 1 },
			{ attemptId: "a1" },
		);
		const tool = blocks(step.id)[1];
		expect(tool).toMatchObject({ kind: "tool", subtype: "Bash", wireId: "c1", phase: "open" });
		const ledger = () =>
			sqlite
				.prepare("SELECT block_id AS blockId FROM narrator_tool_calls WHERE id = ?")
				.get(toolCallId ?? "") as { blockId: string | null };
		expect(ledger().blockId).toBe(tool.id);

		await narratorStore.settleTool(
			"c1",
			{ output: "a.txt", status: "success" },
			step.id,
			toolCallId,
		);
		expect(blocks(step.id)[1]).toMatchObject({ id: tool.id, phase: "done" });
		expect(assembled(step.id)).toEqual(content(step.id));
		expect(queued()).toBe(0);
	});

	test("a discarded attempt loses exactly the blocks it created", async () => {
		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "text", id: "t1", text: "kept", completed: true, outputIndex: 0 },
			{ attemptId: "a1" },
		);
		await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "text", id: "t2", text: "replayed", completed: true, outputIndex: 1 },
			{ attemptId: "a2" },
		);
		await narratorStore.writeStepItem(
			step.id,
			"n1",
			{ type: "tool_use", id: "c2", name: "Read", input: { file_path: "x" }, outputIndex: 2 },
			{ attemptId: "a2" },
		);
		// A baseline past the end would drop nothing: the attempt id decides.
		const discarded = await narratorStore.discardAttempt("n1", step.id, 99, "a2");
		expect(discarded).toMatchObject({ discardedBlocks: 2, removedToolUseIds: ["c2"] });
		const messageId = discarded?.messageId ?? step.id;
		expect(content(messageId)).toEqual([
			expect.objectContaining({ type: "text", id: "t1", text: "kept" }),
		]);
		expect(blocks(messageId).map((row) => row.attemptId)).toEqual(["a1"]);
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM narrator_tool_calls WHERE tool_use_id = 'c2'")
				.get(),
		).toEqual({ n: 0 });
		// Nothing of a1 is touched by discarding an attempt that wrote nothing.
		expect(await narratorStore.discardAttempt("n1", messageId, 99, "a3")).toBeNull();
	});

	test("a copy belongs to its holder, keeps its author, and points at the blocks it copies", async () => {
		const input = await narratorStore.appendInput("n1", "shared question");
		sqlite.run(
			"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('r2', 'n2', ?, 0)",
			[input.id],
		);
		const [source] = blocks(input.id);
		const copyId = await narratorPersistence.copyOnWriteMessage("n2", input.id, {
			contentJson: [{ type: "text", text: "edited question" }],
			contentText: "edited question",
		});
		expect(copyId).not.toBe(input.id);
		expect(envelope(copyId)).toMatchObject({ narratorId: "n2", authorNarratorId: "n1" });
		expect(blocks(copyId)).toEqual([
			expect.objectContaining({ kind: "input", originBlockId: source.id }),
		]);
		expect(assembled(copyId)).toEqual(content(copyId));
		// The original is untouched for the narrator still holding it.
		expect(content(input.id)).toEqual([{ type: "text", text: "shared question" }]);
	});

	test("a write outside the store converges through the queue", async () => {
		const input = await narratorStore.appendInput("n1", "before");
		sqlite.run("UPDATE narrator_messages SET content_json = ?, content_text = ? WHERE id = ?", [
			JSON.stringify([{ type: "text", text: "after" }]),
			"after",
			input.id,
		]);
		expect(queued()).toBe(1);
		blockSync.flushChangedEnvelopes();
		expect(queued()).toBe(0);
		expect(assembled(input.id)).toEqual([{ type: "text", text: "after" }]);
	});

	test("the dual-write audit finds and repairs rows that differ from their envelope", async () => {
		const input = await narratorStore.appendInput("n1", "audited");
		expect(blockSync.auditRecentEnvelopes()).toEqual([]);
		sqlite.run("UPDATE narrator_blocks SET payload = ? WHERE message_id = ?", [
			JSON.stringify({ raw: [{ type: "text", text: "tampered" }] }),
			input.id,
		]);
		expect(blockSync.auditRecentEnvelopes()).toEqual([input.id]);
		expect(assembled(input.id)).toEqual(content(input.id));
	});

	test("a legacy-format envelope keeps no rows and queues nothing", () => {
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('legacy', 'n1', 'user', '[{"type":"text","text":"old"}]', ?)`,
			[NOW],
		);
		sqlite.run(
			`UPDATE narrator_messages SET content_json = '[{"type":"text","text":"new"}]' WHERE id = 'legacy'`,
		);
		expect(queued()).toBe(0);
		expect(blocks("legacy")).toEqual([]);
	});
});

describe("narrator turns", () => {
	test("a run is one row: its trigger, its envelopes, its counts", async () => {
		const input = await narratorStore.appendInput("n1", "go");
		const turnId = turns.startTurn("n1");
		expect(turnId).toBeString();
		expect(envelope(input.id).turnId).toBe(turnId);

		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		expect(envelope(step.id).turnId).toBe(turnId);
		turns.recordTurnStep("n1", "anthropic:claude", { inputTokens: 10, completionTokens: 4 });
		turns.recordTurnToolCall("n1");
		turns.endTurn("n1", turnId, { status: "completed", stopReason: "end_turn" });

		const row = sqlite
			.prepare(
				`SELECT status, trigger_message_id AS triggerMessageId, stop_reason AS stopReason,
					step_count AS stepCount, tool_call_count AS toolCallCount, usage_json AS usageJson
				 FROM narrator_turns WHERE id = ?`,
			)
			.get(turnId ?? "") as Record<string, unknown>;
		expect(row).toMatchObject({
			status: "completed",
			triggerMessageId: input.id,
			stopReason: "end_turn",
			stepCount: 1,
			toolCallCount: 1,
		});
		expect(JSON.parse(String(row.usageJson))).toMatchObject({
			"anthropic:claude": { requests: 1, inputTokens: 10, outputTokens: 4 },
		});
		// Idle writes belong to no run.
		const idle = await narratorStore.appendInput("n1", "later");
		expect(envelope(idle.id).turnId).toBeNull();
	});

	test("a run cut off by a restart ends interrupted", async () => {
		const turnId = turns.startTurn("n1");
		expect(turns.recoverInterruptedTurns()).toBe(1);
		expect(
			sqlite
				.prepare("SELECT status, stop_reason AS stopReason FROM narrator_turns WHERE id = ?")
				.get(turnId ?? ""),
		).toEqual({ status: "interrupted", stopReason: "restart" });
		// The in-memory run of the old process is gone with it; a late end is a no-op.
		turns.endTurn("n1", turnId, { status: "completed", stopReason: "end_turn" });
		expect(
			sqlite.prepare("SELECT status FROM narrator_turns WHERE id = ?").get(turnId ?? ""),
		).toEqual({ status: "interrupted" });
	});
});

describe("epoch reconcile", () => {
	const managed = new Set(["WebFetch", "Knowledge"]);
	const target = (fingerprint: string) => () => ({ fingerprint, cacheTtlMs: 5 * 60_000 });

	async function rows() {
		const { narratorService } = await import("../narrator-service");
		return narratorService.getModelHistorySinceLastCompact("n1");
	}

	async function stepAt(createdAt: string) {
		const step = await narratorStore.openStep("n1", {
			uuid: crypto.randomUUID(),
			session_id: "s",
			provider: "anthropic",
			model: "claude",
		});
		sqlite.run("UPDATE narrator_messages SET created_at = ? WHERE id = ?", [createdAt, step.id]);
	}

	const reconcile = async (current: string[], fingerprint: string, now: number) =>
		(
			await epochs.reconcileEpoch({
				narratorId: "n1",
				messages: await rows(),
				managed,
				current,
				model: "claude",
				provider: "anthropic",
				noticeText: (kind, name) => `${kind}:${name}`,
				now,
				resolveTarget: target(fingerprint),
			})
		).changed;

	test("a cold cache opens an epoch only when the rebuild changes the tools", async () => {
		await stepAt("2026-10-01T00:00:00.000Z");
		expect(await reconcile([], "t", Date.parse("2026-10-01T00:00:01.000Z"))).toBe(true);
		const later = Date.parse("2026-10-01T01:00:00.000Z");
		// Nothing was loaded inside the epoch: rebuilding gives the same bytes.
		expect(await reconcile([], "t", later)).toBe(false);

		await narratorStore.appendToolChange("n1", {
			type: "tool_loaded",
			toolName: "WebFetch",
			toolNames: ["WebFetch"],
			text: "loaded",
		});
		expect(await reconcile(["WebFetch"], "t", later)).toBe(true);
		const marker = (await rows()).at(-1);
		expect(marker?.contentJson).toEqual([
			{
				type: "epoch",
				epoch: {
					reason: "cold",
					target: "t",
					toolNames: ["WebFetch"],
					registryRevision: toolRegistry.revision,
				},
			},
		]);
		// The new epoch froze the set; with the cache warm again nothing more is written.
		expect(await reconcile(["WebFetch"], "t", Date.parse("2026-10-01T00:00:01.000Z"))).toBe(false);
	});

	test("a same-name schema change opens a new epoch rather than rewriting its prefix", async () => {
		const { toolRegistry } = await import("../../lib/agent/tool-registry");
		const name = "mcp__epoch_test__run";
		const definition = {
			name,
			description: "old",
			parameters: z.object({}),
			rawJsonSchema: { type: "object", properties: {} },
			execute: async () => ({ output: "ok" }),
		};
		toolRegistry.register(definition);
		try {
			await narratorStore.openEpoch("n1", {
				reason: "manual",
				target: "t",
				toolNames: [name],
			});
			const upgrade = async () =>
				(
					await epochs.reconcileEpoch({
						narratorId: "n1",
						messages: await rows(),
						managed: new Set([name]),
						current: [name],
						model: "claude",
						provider: "anthropic",
						noticeText: () => "changed",
						resolveTarget: target("t"),
					})
				).changed;
			// A legacy SQLite epoch gets one names-only boundary, not repeated rewrites.
			expect(await upgrade()).toBe(true);
			expect(await upgrade()).toBe(false);
			toolRegistry.register({ ...definition, description: "new" });
			expect(
				(
					await epochs.reconcileEpoch({
						narratorId: "n1",
						messages: await rows(),
						managed: new Set([name]),
						current: [name],
						model: "claude",
						provider: "anthropic",
						noticeText: () => "changed",
						resolveTarget: target("t"),
					})
				).changed,
			).toBe(true);
			expect((await rows()).at(-1)?.contentJson).toMatchObject([
				{
					type: "epoch",
					epoch: { reason: "manual", toolNames: [name], registryRevision: toolRegistry.revision },
				},
			]);
		} finally {
			toolRegistry.unregister(name);
		}
	});

	test("request history rebuild reconciles same-name schema changes before projecting definitions", async () => {
		const { toolRegistry } = await import("../../lib/agent/tool-registry");
		const { buildContextManagementHooks } = await import("../narrator-session");
		const runtimeHistory = await import("../agent-runtime/history");
		const { deriveToolLoadingState } = await import("../../lib/agent/tool-loading");
		const realReconcile = epochs.reconcileEpoch;
		const reconcileSpy = spyOn(epochs, "reconcileEpoch").mockImplementation((input) =>
			realReconcile({ ...input, resolveTarget: target("request-test") }),
		);
		// Keep the DB/epoch/state derivation real; only bypass provider-specific wire encoding.
		const projectionSpy = spyOn(runtimeHistory, "buildRuntimeHistory").mockImplementation(
			async (options) => {
				const sourceMessages = [...(options.sourceMessages ?? [])];
				if (!options.toolLoading) throw new Error("Expected request loading state");
				return {
					history: [],
					sourceMessages,
					modelMessages: sourceMessages,
					replayedInjectionMessageIds: [],
					currentText: "",
					currentInputText: "",
					currentInputPersisted: false,
					endsWithToolResults: false,
					endsWithInput: false,
					toolLoading: deriveToolLoadingState(
						sourceMessages,
						options.toolLoading.managed,
						options.toolLoading.current,
						options.toolLoading.epoch,
						options.toolLoading.candidates,
					),
					toolCandidates: options.toolLoading.candidates,
				};
			},
		);
		const name = "mcp__request_schema__run";
		const definition = {
			name,
			description: "request schema",
			parameters: z.object({}),
			rawJsonSchema: { type: "object", properties: { old: { type: "string" } } },
			execute: async () => ({ output: "ok" }),
		};
		toolRegistry.register(definition);
		try {
			const hooks = buildContextManagementHooks({
				narratorId: "n1",
				locale: "en",
				getModel: () => "claude",
				getProvider: () => "anthropic",
				getToolLoading: () => ({
					managed: new Set([name]),
					current: new Set([name]),
					candidates: toolRegistry.all(),
					registryRevision: toolRegistry.revision,
				}),
			});
			const first = await hooks.rebuildRequestHistory();
			expect(first.toolLoading?.definitionSnapshots).toEqual([]);
			expect(first.toolCandidates?.find((tool) => tool.name === name)?.rawJsonSchema).toBe(
				definition.rawJsonSchema,
			);
			const firstRows = await rows();
			const replacement = { type: "object", properties: { updated: { type: "number" } } };
			toolRegistry.register({ ...definition, rawJsonSchema: replacement });
			const second = await hooks.rebuildRequestHistory();
			expect(second.toolLoading?.definitionSnapshots).toEqual([]);
			expect(second.toolCandidates?.find((tool) => tool.name === name)?.rawJsonSchema).toBe(
				replacement,
			);
			expect(second.toolLoading?.epochMarkerId).not.toBe(first.toolLoading?.epochMarkerId);
			expect((await rows()).length).toBeGreaterThan(firstRows.length);
			expect((await rows()).at(-1)?.contentJson).toMatchObject([
				{ type: "epoch", epoch: { toolNames: [name], registryRevision: toolRegistry.revision } },
			]);
		} finally {
			toolRegistry.unregister(name);
			reconcileSpy.mockRestore();
			projectionSpy.mockRestore();
		}
	});

	test("inside a frozen epoch, a load that bypassed /load becomes a system notice", async () => {
		await narratorStore.openEpoch("n1", {
			reason: "manual",
			target: "t",
			toolNames: [],
			registryRevision: toolRegistry.revision,
		});
		await stepAt(new Date().toISOString());
		expect(await reconcile(["Knowledge"], "t", Date.now())).toBe(true);
		const notice = (await rows()).at(-1);
		expect(notice).toMatchObject({
			role: "user",
			origin: "system",
			contentJson: [
				{
					type: "tool_loaded",
					toolName: "Knowledge",
					toolNames: ["Knowledge"],
					text: "tool_loaded:Knowledge",
				},
			],
		});
		expect(await reconcile(["Knowledge"], "t", Date.now())).toBe(false);
	});
});
