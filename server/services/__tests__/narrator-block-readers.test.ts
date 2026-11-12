/**
 * Readers that switched to block bodies (docs/BLOCK_STORAGE-DESIGN.md §9, §10.5): the
 * External API reasoning scan, transcript export and session interchange. With
 * `narratorBlocks.read` on they must produce exactly what they produced from `content_json`.
 *
 * Each comparison reads once with the switch off, then overwrites every block-format
 * envelope's `content_json` (and clears the sync queue, so nothing re-reads it) and reads
 * again with the switch on. Equal output therefore shows both that the block path is
 * taken and that it reproduces the column.
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	setSystemTime,
	test,
} from "bun:test";
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
const { externalReasoningScan } = await import("../external-resource-service");
const { NARRATOR_EXPORT_DEFAULTS, streamNarratorExport } = await import("../narrator-export");
const { narratorToInterchange } = await import("../session-interchange/export");

const NOW = "2026-10-01T00:00:00.000Z";

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
	setSystemTime();
});
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

/** Non-ASCII on purpose: SQL lengths count characters and bytes differently. */
const LONG_TEXT = "Résumé of the tree — 目录很长。".repeat(300);

/**
 * A conversation in the shapes the store writes: an input, a step with reasoning (later
 * translated, which moves a field into block state), text and a Task call, and the
 * subagent transcript under that call — one child small enough to export whole, two
 * clamped (one of them with translated reasoning).
 */
async function writeConversation() {
	// This fixture compares the two readable copies; afterEach restores the default.
	settings.narratorBlocks.compactJson = false;
	const input = await narratorStore.appendInput("n1", "List the files, 请");
	const step = await narratorStore.openStep("n1", { uuid: "u1", session_id: "s" });
	await narratorStore.writeStepItem(step.id, "n1", {
		type: "reasoning",
		id: "r1",
		text: "**Plan** run ls\n\n**Check** the output",
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
		id: "call_task",
		name: "Task",
		input: { prompt: "look around", description: "Explore" },
		outputIndex: 2,
	});
	await narratorStore.settleTool(
		"call_task",
		{ output: "found a.txt", status: "success" },
		step.id,
		callRow,
	);
	await narratorPersistence.patchReasoningTranslation(step.id, 0, "**计划** 运行 ls");

	sqlite.run(
		`INSERT INTO narrators (id, title, type, variant, parent_narrator_id, origin_tool_call_id,
			subagent_origin_kind, created_at, updated_at)
		 VALUES ('sub1', 'Explore', 'subagent', 'subagent:explore', 'n1', ?, 'tool', ?, ?)`,
		[callRow ?? null, NOW, NOW],
	);
	const placement = { parentToolUseId: "call_task" };
	await narratorStore.appendInput(
		"sub1",
		"look around",
		undefined,
		null,
		null,
		undefined,
		placement,
	);
	const small = await narratorStore.appendStep("sub1", {
		uuid: "u2",
		session_id: "s",
		parent_tool_use_id: "call_task",
		message: {
			content: [
				{ type: "reasoning", id: "r2", text: "Short plan", completed: true },
				{ type: "text", text: "Found a.txt" },
			],
		},
	});
	const clamped = await narratorStore.appendStep("sub1", {
		uuid: "u3",
		session_id: "s",
		parent_tool_use_id: "call_task",
		message: {
			content: [
				{ type: "reasoning", id: "r3", text: LONG_TEXT, completed: true },
				{ type: "text", text: "Summary" },
			],
		},
	});
	await narratorStore.appendStep("sub1", {
		uuid: "u4",
		session_id: "s",
		parent_tool_use_id: "call_task",
		message: { content: [{ type: "text", text: LONG_TEXT }] },
	});
	await narratorPersistence.patchReasoningTranslation(small.id, 0, "简短计划");
	await narratorPersistence.patchReasoningTranslation(clamped.id, 0, "很长的计划");
	blockSync.flushChangedEnvelopes();
	return { input, step };
}

/** Every message is block-format with current rows, so only the rows hold its body. */
function overwriteContentJson(): void {
	const { legacy } = sqlite
		.prepare("SELECT count(*) AS legacy FROM narrator_messages WHERE body_format <> 2")
		.get() as { legacy: number };
	expect(legacy).toBe(0);
	sqlite.run(`UPDATE narrator_messages SET content_json = '[{"type":"text","text":"stale"}]'`);
	sqlite.run("DELETE FROM narrator_block_sync_queue");
}

/** Read with the switch off, then from block rows alone with it on. */
async function readBoth<T>(read: () => Promise<T>): Promise<{ legacy: T; blocks: T }> {
	settings.narratorBlocks.read = false;
	// A rows-only fixture would force block reads and make this comparison vacuous.
	expect(blockReadsEnabled()).toBe(false);
	const legacy = await read();
	overwriteContentJson();
	settings.narratorBlocks.read = true;
	const blocks = await read();
	return { legacy, blocks };
}

function messageIds(): string[] {
	return (
		sqlite.prepare("SELECT id FROM narrator_messages ORDER BY id").all() as { id: string }[]
	).map((row) => row.id);
}

async function exportText(narratorId: string, format: "markdown" | "json"): Promise<string> {
	setSystemTime(new Date(NOW));
	let out = "";
	for await (const chunk of streamNarratorExport(narratorId, {
		...NARRATOR_EXPORT_DEFAULTS,
		format,
		scope: "full",
	}))
		out += chunk;
	return out;
}

async function scanReasoning(ids: string[]) {
	const reasoning = await externalReasoningScan.loadExternalReasoningBlocks(ids);
	const unscannable = await externalReasoningScan.findUnscannableReasoningMessages(ids);
	return { reasoning: [...reasoning], unscannable: [...unscannable].sort() };
}

describe("readers on block bodies", () => {
	test("the External API reasoning scan returns the same bodies", async () => {
		await writeConversation();
		const ids = messageIds();
		const { legacy, blocks } = await readBoth(() => scanReasoning(ids));
		expect(legacy.reasoning.length).toBeGreaterThan(1);
		expect(blocks).toEqual(legacy);
	});

	test("an envelope over the scan limit is unavailable either way when its reasoning is", async () => {
		settings.narratorBlocks.compactJson = false;
		const step = await narratorStore.openStep("n1", { uuid: "u1", session_id: "s" });
		await narratorStore.writeStepItem(step.id, "n1", {
			type: "reasoning",
			id: "r1",
			text: "x".repeat(300 * 1024),
			completed: true,
			outputIndex: 0,
		});
		blockSync.flushChangedEnvelopes();
		const { legacy, blocks } = await readBoth(() => scanReasoning([step.id]));
		expect(legacy.unscannable).toEqual([step.id]);
		expect(blocks).toEqual(legacy);
	});

	test("a large tool block no longer hides the reasoning beside it", async () => {
		settings.narratorBlocks.compactJson = false;
		const step = await narratorStore.openStep("n1", { uuid: "u1", session_id: "s" });
		await narratorStore.writeStepItem(step.id, "n1", {
			type: "reasoning",
			id: "r1",
			text: "**Plan** write the file",
			completed: true,
			outputIndex: 0,
		});
		await narratorStore.writeStepItem(step.id, "n1", {
			type: "tool_use",
			id: "call_write",
			name: "Write",
			input: { file_path: "a.txt", content: "x".repeat(300 * 1024) },
			outputIndex: 1,
		});
		blockSync.flushChangedEnvelopes();
		const { legacy, blocks } = await readBoth(() => scanReasoning([step.id]));
		// The whole envelope exceeded the scan limit; its reasoning row does not.
		expect(legacy).toEqual({ reasoning: [], unscannable: [step.id] });
		expect(blocks).toEqual({
			reasoning: [[step.id, ["**Plan** write the file"]]],
			unscannable: [],
		});
	});

	test("transcript export is byte-identical, including clamped subagent messages", async () => {
		await writeConversation();
		const markdown = await readBoth(() => exportText("n1", "markdown"));
		expect(markdown.legacy).toContain("_[");
		expect(markdown.blocks).toBe(markdown.legacy);
	});

	test("transcript export as JSON is byte-identical", async () => {
		await writeConversation();
		const json = await readBoth(() => exportText("n1", "json"));
		const parsed = JSON.parse(json.legacy) as { messages: Array<{ toolCalls: unknown[] }> };
		expect(JSON.stringify(parsed)).toContain('"contentTruncated":true');
		expect(json.blocks).toBe(json.legacy);
	});

	test("the session interchange is identical", async () => {
		await writeConversation();
		const { legacy, blocks } = await readBoth(async () =>
			JSON.stringify(await narratorToInterchange("n1")),
		);
		expect(legacy).toContain("look around");
		expect(blocks).toBe(legacy);
	});

	test("with the switch off, readers read content_json", async () => {
		await writeConversation();
		const before = await exportText("n1", "json");
		overwriteContentJson();
		settings.narratorBlocks.read = false;
		const after = await exportText("n1", "json");
		expect(after).not.toBe(before);
		expect(after).toContain('"stale"');
	});
});
