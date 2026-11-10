/**
 * Main-thread readers that switched to block bodies in P2c (docs/BLOCK_STORAGE-DESIGN.md
 * §10.1): with `narratorBlocks.read` on they must return exactly what they returned from
 * `content_json`.
 *
 * Each comparison reads once with the switch off, then overwrites every block-format
 * envelope's `content_json` (and clears the sync queue, so nothing re-reads it) and reads
 * again with the switch on. Equal output shows both that the block path is taken and that
 * it reproduces the column.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite, activeDatabaseBackend: "sqlite" }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const { settings } = await import("../../lib/settings");
const compactJson = settings.narratorBlocks.compactJson;
const { blockReadsEnabled, noteRowsOnlyEnvelopes } = await import("../narrator-block-scans");
const blockSync = await import("../narrator-block-sync");
const { narratorMessageQueries } = await import("../narrator-messages");
const bodyReads = await import("../narrator-body-reads");
const { toolContinuationService } = await import("../tool-continuation-service");
const { loadRecentMessages } = await import("../../lib/prompts/prompt-optimize-context");
const { getRuntimePublicationService, runtimePublication } = await import(
	"../agent-runtime/publication"
);
runtimePublication.stop();
const { extractSubagentToPrimary } = await import("../subagent-extract");
const { narratorMessages } = await import("../../db/schema");
const { delegationRegistration } = await import("../../lib/validators/runtime-registration");

const NOW = "2026-10-01T00:00:00.000Z";
const STALE = [{ type: "text", text: "stale" }];

beforeEach(() => {
	cleanDb(sqlite);
	noteRowsOnlyEnvelopes(undefined);
	sqlite.run(
		`INSERT INTO narrators (id, title, model, created_at, updated_at)
		 VALUES ('n1', 'Main', 'claude-opus-4.6', ?, ?)`,
		[NOW, NOW],
	);
});
afterEach(() => {
	settings.narratorBlocks.read = true;
	settings.narratorBlocks.compactJson = compactJson;
});
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

/** A conversation in the shapes the store writes, a translated reasoning item among them. */
async function writeConversation() {
	// This fixture compares the two readable copies; afterEach restores the default.
	settings.narratorBlocks.compactJson = false;
	const input = await narratorStore.appendInput("n1", "List the files, 请");
	const step = await narratorStore.openStep("n1", { uuid: "u1", session_id: "s" });
	await narratorStore.writeStepItem(step.id, "n1", {
		type: "reasoning",
		id: "r1",
		text: "**Plan** run ls",
		completed: true,
		outputIndex: 0,
	});
	await narratorStore.writeStepItem(step.id, "n1", {
		type: "text",
		id: "t1",
		text: "Running.",
		outputIndex: 1,
		completed: true,
	});
	const callRow = await narratorStore.writeStepItem(step.id, "n1", {
		type: "tool_use",
		id: "call_ls",
		name: "Bash",
		input: { command: "ls" },
		outputIndex: 2,
	});
	await narratorStore.settleTool(
		"call_ls",
		{ output: "a.txt", status: "success" },
		step.id,
		callRow,
	);
	await narratorPersistence.patchReasoningTranslation(step.id, 0, "**计划** 运行 ls");
	const reply = await narratorStore.appendStep("n1", {
		uuid: "u2",
		session_id: "s",
		message: { content: [{ type: "text", text: "Found a.txt" }] },
	});
	blockSync.flushChangedEnvelopes();
	return { input, step, reply };
}

/**
 * Every message is block-format, so a message with rows has only them hold its body. One
 * without rows (content that is not an array of elements) keeps reading `content_json`.
 */
function overwriteContentJson(): void {
	const { legacy } = sqlite
		.prepare("SELECT count(*) AS legacy FROM narrator_messages WHERE body_format <> 2")
		.get() as { legacy: number };
	expect(legacy).toBe(0);
	sqlite.run(
		`UPDATE narrator_messages SET content_json = ?
		 WHERE EXISTS (SELECT 1 FROM narrator_blocks b WHERE b.message_id = narrator_messages.id)`,
		[JSON.stringify(STALE)],
	);
	sqlite.run("DELETE FROM narrator_block_sync_queue");
}

/** The overwrite itself bumps each envelope's body revision; nothing else it changes. */
function withoutRevisions<T>(value: T): T {
	return JSON.parse(JSON.stringify(value ?? null), (key, field) =>
		key === "bodyRevision" ? undefined : field,
	);
}

/** Read with the switch off, then from block rows alone with it on. */
async function readBoth<T>(read: () => T | Promise<T>): Promise<{ legacy: T; blocks: T }> {
	settings.narratorBlocks.read = false;
	// A rows-only fixture would force block reads and make this comparison vacuous.
	expect(blockReadsEnabled()).toBe(false);
	const legacy = await read();
	overwriteContentJson();
	settings.narratorBlocks.read = true;
	const blocks = await read();
	return { legacy: withoutRevisions(legacy), blocks: withoutRevisions(blocks) };
}

describe("narrator message queries", () => {
	test("history pages read block bodies", async () => {
		await writeConversation();
		const { legacy, blocks } = await readBoth(async () => ({
			messages: await narratorMessageQueries.getMessages("n1"),
			sinceCompact: await narratorMessageQueries.getMessagesSinceLastCompact("n1"),
			recent: await narratorMessageQueries.getRecentMessages("n1", 4),
			earliest: await narratorMessageQueries.getEarliestMessages("n1", 2),
			latestText: await narratorMessageQueries.getLatestAssistantTextAndId("n1"),
		}));
		expect(blocks).toEqual(legacy);
		expect(JSON.stringify(blocks)).not.toContain("stale");
		expect(legacy.messages.length).toBe(3);
		expect(legacy.latestText?.text).toBe("Found a.txt");
	});

	test("messages before a boundary read block bodies", async () => {
		const { reply } = await writeConversation();
		const { legacy, blocks } = await readBoth(() =>
			narratorMessageQueries.getMessagesBefore("n1", reply.id),
		);
		expect(blocks).toEqual(legacy);
		expect(legacy.length).toBe(2);
	});

	test("the latest compact summary reads its block", async () => {
		await writeConversation();
		await narratorPersistence.persistPlanMessage("n1", "the plan so far");
		const { legacy, blocks } = await readBoth(() =>
			narratorMessageQueries.getLatestSuccessfulCompactSummary("n1"),
		);
		expect(legacy?.summary).toBe("the plan so far");
		expect(blocks).toEqual(legacy);
	});

	test("ContextAsk leaves compact markers out by their blocks", async () => {
		await writeConversation();
		await narratorPersistence.persistPlanMessage("n1", "the plan so far");
		await narratorStore.appendInput("n1", "after the plan");
		const ids = async () =>
			(await narratorMessageQueries.getContextAskHistorySnapshot("n1")).messages.map(
				(message) => message.id,
			);
		const { legacy, blocks } = await readBoth(ids);
		expect(blocks).toEqual(legacy);
		expect(legacy.length).toBe(1);
	});

	test("history recovery measures block bodies by their stored size", async () => {
		await writeConversation();
		const { legacy, blocks } = await readBoth(() =>
			narratorMessageQueries.getHistoryRecovery("n1"),
		);
		expect(blocks.candidates).toEqual(legacy.candidates);
		expect(blocks.thresholds).toEqual(legacy.thresholds);
	});

	test("dismissing a card checks the card in its block", async () => {
		settings.narratorBlocks.compactJson = false;
		const card = await narratorPersistence.persistDisplayMessage("n1", "cwd", [
			{ type: "cwd_recovery", path: "/gone" },
		]);
		blockSync.flushChangedEnvelopes();
		overwriteContentJson();
		settings.narratorBlocks.read = false;
		await expect(narratorMessageQueries.dismissCwdRecoveryMessage("n1", card.id)).rejects.toThrow(
			"not a working directory recovery notice",
		);
		settings.narratorBlocks.read = true;
		await narratorMessageQueries.dismissCwdRecoveryMessage("n1", card.id);
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM narrator_message_refs WHERE message_id = ?")
				.get(card.id),
		).toEqual({ n: 0 });
	});
});

describe("bodies not in rows", () => {
	test("legacy and queued envelopes read content_json, decoded, with block reads on", async () => {
		settings.narratorBlocks.compactJson = false;
		settings.narratorBlocks.write = false;
		try {
			await narratorStore.appendInput("n1", "written legacy");
		} finally {
			settings.narratorBlocks.write = true;
		}
		const queued = await narratorStore.appendInput("n1", "rows behind");
		sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = ?", [
			JSON.stringify([{ type: "text", text: "rewritten outside the store" }]),
			queued.id,
		]);
		const read = async () => ({
			relational: (await narratorMessageQueries.getMessages("n1")).map((m) => m.contentJson),
			core: (await narratorMessageQueries.getRecentMessages("n1", 4)).map((m) => m.contentJson),
		});
		settings.narratorBlocks.read = false;
		const legacy = await read();
		settings.narratorBlocks.read = true;
		const blocks = await read();
		expect(blocks).toEqual(legacy);
		expect(JSON.stringify(blocks.relational)).toContain("rewritten outside the store");
		expect(Array.isArray(blocks.relational[0])).toBe(true);
	});
});

describe("body read helpers", () => {
	test("a body's size is what content_json measures, an input's text counted once", async () => {
		await writeConversation();
		await narratorStore.appendInput("n1", "y".repeat(100_000));
		blockSync.flushChangedEnvelopes();
		const sizes = () =>
			db
				.select({ id: narratorMessages.id, bytes: bodyReads.storedBodyBytesSql() })
				.from(narratorMessages)
				.orderBy(narratorMessages.id)
				.all();
		const { legacy, blocks } = await readBoth(sizes);
		expect(blocks).toEqual(legacy);
		expect(Math.max(...blocks.map((row) => row.bytes))).toBeLessThan(101_000);
	});

	test("with block reads off they are the plain column and options", () => {
		settings.narratorBlocks.read = false;
		expect(bodyReads.contentJsonSql()).toBe(narratorMessages.contentJson as never);
		expect(bodyReads.bodyColumns()).toEqual({});
		expect(bodyReads.bodyColumns({ id: true, contentJson: true })).toEqual({
			columns: { id: true, contentJson: true },
		});
		const rows = [{ id: "m", contentJson: [{ type: "text", text: "kept" }] }];
		expect(bodyReads.fillBodies(rows)).toEqual(rows);
	});
});

describe("segment compaction", () => {
	test("its source messages, hidden messages and summary read block bodies", async () => {
		const { input, step } = await writeConversation();
		const { message } = await narratorPersistence.persistSegmentCompactMarker("n1", [
			input.id,
			step.id,
		]);
		await narratorPersistence.finalizeSegmentCompact(message.id, "n1", "the two of them");
		blockSync.flushChangedEnvelopes();
		const { legacy, blocks } = await readBoth(async () => ({
			source: await narratorPersistence.getMessagesForSegmentCompact("n1", [input.id, step.id]),
			hidden: await narratorPersistence.getSegmentCompactHiddenMessages("n1", message.id),
			summary: await narratorPersistence.getSegmentCompactSummary("n1", message.id),
		}));
		expect(blocks).toEqual(legacy);
		expect(legacy.summary).toBe("the two of them");
		expect(legacy.hidden.length).toBe(2);
	});
});

describe("tool continuation recovery", () => {
	test("orders a message's calls by their blocks without reading its body", async () => {
		settings.narratorBlocks.compactJson = false;
		const step = await narratorStore.openStep("n1", { uuid: "u1", session_id: "s" });
		await narratorStore.writeStepItem(step.id, "n1", {
			type: "text",
			id: "t1",
			text: "Two calls.",
			outputIndex: 0,
			completed: true,
		});
		const calls: string[] = [];
		for (const [index, id] of ["call_a", "call_b"].entries()) {
			const row = await narratorStore.writeStepItem(step.id, "n1", {
				type: "tool_use",
				id,
				name: "Bash",
				input: { command: `echo ${id}` },
				outputIndex: index + 1,
			});
			calls.push(row ?? "");
		}
		blockSync.flushChangedEnvelopes();
		// Created newest call first, so only the stored order puts call_a ahead.
		for (const toolCallId of [...calls].reverse())
			await toolContinuationService.create({
				toolCallId,
				narratorId: "n1",
				updateEpoch: "epoch",
				kind: "deferred_tool",
			});
		const { legacy, blocks } = await readBoth(async () =>
			(await toolContinuationService.listRecoveryQueueByEpoch("epoch")).map((item) => ({
				toolCallId: item.record.toolCallId,
				placed: item.toolUseOrder < Number.MAX_SAFE_INTEGER,
			})),
		);
		expect(blocks).toEqual(legacy);
		expect(legacy).toEqual(calls.map((toolCallId) => ({ toolCallId, placed: true })));
	});
});

describe("prompt optimization context", () => {
	test("recent messages read block bodies", async () => {
		await writeConversation();
		const { legacy, blocks } = await readBoth(() => loadRecentMessages("n1"));
		expect(blocks).toEqual(legacy);
		expect(legacy.length).toBeGreaterThan(0);
	});
});

describe("agent results", () => {
	test("a subagent's result is read from its assistant message's blocks", async () => {
		settings.narratorBlocks.compactJson = false;
		sqlite.run(
			`INSERT INTO narrators (id, type, variant, parent_narrator_id, status, created_at, updated_at)
			 VALUES ('actor', 'subagent', 'subagent:general', 'n1', 'idle', ?, ?)`,
			[NOW, NOW],
		);
		const facade = getRuntimePublicationService();
		const run = (
			await facade.startRun({
				narratorId: "actor",
				binding: { deliverTo: { narratorId: "n1", toolUseId: "test-tool-use" } },
			})
		).publication;
		if (!run) throw new Error("no publication run");
		const output = "Found a.txt and b.txt";
		await narratorStore.appendStep("actor", {
			uuid: "u-actor",
			session_id: "s",
			message: { content: [{ type: "text", text: output }] },
		});
		blockSync.flushChangedEnvelopes();
		await facade.commitAgentTerminal({
			run,
			eventKind: "completed",
			text: output,
			summary: "done",
			delivery: "foreground",
		});
		const { legacy, blocks } = await readBoth(() => facade.readAgentTerminalResult(run));
		expect(legacy?.output).toContain(output);
		expect(blocks).toEqual(legacy);
	});
});

describe("subagent extraction", () => {
	test("a full copy carries the source's block bodies", async () => {
		settings.narratorBlocks.compactJson = false;
		sqlite.run(
			`INSERT INTO narrators (id, type, variant, subagent_type, status, permission_mode, inherit_mode,
				traits, parent_narrator_id, policy_source_narrator_id, runtime_registration_json, title,
				created_at, updated_at)
			 VALUES ('sub', 'subagent', 'subagent:explore', 'explore', 'idle', 'readOnly', 'fresh',
				'[]', 'n1', 'n1', ?, 'Explore', ?, ?)`,
			[JSON.stringify(delegationRegistration("n1", "explore")), NOW, NOW],
		);
		await narratorStore.appendInput("sub", "look around");
		await narratorStore.appendStep("sub", {
			uuid: "u-sub",
			session_id: "s",
			message: {
				content: [
					{ type: "reasoning", id: "r9", text: "Short plan", completed: true },
					{ type: "text", text: "Found a.txt" },
				],
			},
		});
		blockSync.flushChangedEnvelopes();
		const copied = async () => {
			const extracted = await extractSubagentToPrimary("sub", { inheritMode: "full" });
			return (
				sqlite
					.prepare(
						`SELECT m.content_json AS body FROM narrator_message_refs r
						 JOIN narrator_messages m ON m.id = r.message_id WHERE r.narrator_id = ? ORDER BY r.seq`,
					)
					.all(extracted.id) as Array<{ body: string }>
			).map((row) => JSON.parse(row.body));
		};
		const { legacy, blocks } = await readBoth(copied);
		expect(blocks).toEqual(legacy);
		expect(legacy.length).toBe(2);
	});
});
