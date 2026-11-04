import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sqlite } from "../../db";
import { latestToolLoadingEpoch } from "../../lib/agent/tool-loading";
import { queryModelHistory, sqliteHistoryQuery } from "../agent-runtime/model-history-query";
import { applyImport, clearData, exportData, previewImport } from "../data-portability";
import { PrefixSnapshotCollector } from "../narrator-prefix-snapshot-gc";
import {
	closePrefixSnapshotStore,
	getPrefixJson,
	putPrefixJson,
	putPrefixText,
	putPrefixToolDefinitions,
} from "../narrator-prefix-snapshots";
import { attachPrefixHistorySource, loadPrefixState } from "../narrator-prefix-state";

const selection = { sessions: true, requests: false, providers: false };
const oldTime = "2000-01-01T00:00:00.000Z";
const count = (table: string) =>
	(sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(async () => {
	await closePrefixSnapshotStore();
	await clearData("all");
	sqlite.run("DELETE FROM narrator_text_snapshots");
});
afterAll(closePrefixSnapshotStore);

function narrator(id = "owner", context: unknown = { locale: "zh-CN", replyInUserLanguage: true }) {
	sqlite.run(
		"INSERT INTO narrators (id, type, reply_context, created_at, updated_at) VALUES (?, 'primary', ?, ?, ?)",
		[id, JSON.stringify(context), oldTime, oldTime],
	);
}
function message(id: string, seq: number, body: unknown, rowsOnly: boolean, role = "system") {
	sqlite.run(
		"INSERT INTO narrator_messages (id, narrator_id, role, content_json, body_rows_only, created_at) VALUES (?, 'owner', ?, ?, ?, ?)",
		[id, role, JSON.stringify(rowsOnly ? [] : [body]), rowsOnly ? 1 : 0, oldTime],
	);
	if (rowsOnly) {
		sqlite.run("UPDATE narrator_messages SET body_format = 2 WHERE id = ?", [id]);
		sqlite.run(
			"INSERT INTO narrator_blocks (id, message_id, ordinal, kind, subtype, payload, created_at) VALUES (?, ?, 0, 'context', ?, ?, ?)",
			[
				`block:${id}`,
				id,
				(body as { type: string }).type,
				JSON.stringify({ raw: [body] }),
				oldTime,
			],
		);
	}
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, 'owner', ?, ?)",
		[`ref:${id}`, id, seq],
	);
}
async function seedPrefix(rowsOnly = false) {
	narrator();
	const prefix = {
		contract: await putPrefixText("immutable contract"),
		parts: [{ key: "workspace", hash: await putPrefixText("baseline workspace") }],
		tools: await putPrefixToolDefinitions([
			{ name: "Read", description: "read frozen", parameters: { type: "object" } },
		]),
	};
	const update = await putPrefixJson({
		changes: [{ key: "workspace", value: "updated workspace" }],
		modelText: "workspace updated",
	});
	const addition = await putPrefixToolDefinitions([
		{ name: "Write", description: "write frozen", parameters: { type: "object" } },
	]);
	message(
		"epoch",
		1,
		{ type: "epoch", epoch: { reason: "initial", toolNames: ["Read"], prefix } },
		rowsOnly,
	);
	message(
		"update",
		2,
		{ type: "context_update", epochId: "epoch", changes: [], snapshotRef: update },
		rowsOnly,
		"sys",
	);
	message("tool", 3, { type: "tool_loaded", definitionSnapshotRef: addition }, rowsOnly, "user");
	await closePrefixSnapshotStore();
	sqlite.run("UPDATE narrator_text_snapshots SET created_at = ?", [oldTime]);
	return prefix;
}
async function archive() {
	const result = await exportData(selection);
	const bytes = await readFile(result.zipPath);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
async function recover() {
	const source = await queryModelHistory(sqliteHistoryQuery(sqlite), {
		narratorId: "owner",
		versioned: true,
		bodiesFromBlocks: true,
		deadline: Date.now() + 10_000,
	});
	const messages = source.messages.map((row) => ({ ...row }));
	attachPrefixHistorySource(messages, source);
	const epoch = latestToolLoadingEpoch(messages);
	expect(epoch?.prefix).toBeDefined();
	if (!epoch?.prefix) throw new Error("Imported epoch missing");
	const state = await loadPrefixState({ ...epoch, prefix: epoch.prefix }, messages);
	expect(state.baselinePrompt).toContain("immutable contract");
	expect(state.baselinePrompt).toContain("baseline workspace");
	expect(state.parts.get("workspace")).toBe("updated workspace");
	expect(state.definitionSnapshots.map((tool) => tool.name)).toEqual(["Read", "Write"]);
}
function collector() {
	return new PrefixSnapshotCollector(
		async <T>(statement: string, params: Array<string | number>) =>
			sqlite.query(statement).all(...params) as T[],
	);
}
async function collect(gc = collector(), now = Date.now() + 2 * 86_400_000) {
	for (let i = 0; i < 100; i++) {
		if ((await gc.step({ now, batchSize: 128 })).phase === "done") return;
	}
	throw new Error("GC did not finish");
}

for (const rowsOnly of [false, true]) {
	test(`real export -> empty target -> prefix recovery (${rowsOnly ? "rows-only" : "legacy"})`, async () => {
		const prefix = await seedPrefix(rowsOnly);
		const total = count("narrator_text_snapshots");
		const bytes = await archive();
		await clearData("sessions");
		// Clearing sessions intentionally leaves shared content for GC. Remove it only in
		// this isolated test database to model a genuinely empty destination.
		expect(count("narrator_text_snapshots")).toBe(total);
		sqlite.run("DELETE FROM narrator_text_snapshots");
		const preview = await previewImport(bytes, "prefix.zip");
		expect((await applyImport(preview.token, { include: selection })).sessionsInserted).toBe(1);
		expect(count("narrator_text_snapshots")).toBe(total);
		expect(count("narrator_block_assets")).toBe(0);
		const manifest = await getPrefixJson<{ definitions: string[] }>(prefix.tools);
		expect(manifest.definitions).toHaveLength(1);
		await closePrefixSnapshotStore();
		// Beyond import's grace period, legacy/rows-only roots plus manifest children
		// remain reachable even though no block_assets were exported or backfilled.
		await collect();
		expect(count("narrator_text_snapshots")).toBe(total);
		await recover();
	});
}

test("import renews new snapshots AND reused old orphan hashes after GC mark, before sweep", async () => {
	await seedPrefix();
	const total = count("narrator_text_snapshots");
	const bytes = await archive();
	await clearData("sessions");
	const reused = sqlite.query("SELECT sha256 FROM narrator_text_snapshots LIMIT 1").get() as {
		sha256: string;
	};
	sqlite.run("DELETE FROM narrator_text_snapshots WHERE sha256 <> ?", [reused.sha256]);
	const unrelated = await putPrefixText("unrelated old orphan");
	await closePrefixSnapshotStore();
	sqlite.run("UPDATE narrator_text_snapshots SET created_at = ?", [oldTime]);
	const gc = collector();
	const now = Date.now();
	for (let i = 0; i < 100; i++) {
		if ((await gc.step({ now })).phase === "sweep") break;
		if (i === 99) throw new Error("GC did not reach sweep");
	}
	const preview = await previewImport(bytes, "prefix.zip");
	await applyImport(preview.token, { include: selection });
	await collect(gc, now);
	expect(count("narrator_text_snapshots")).toBe(total);
	expect(
		sqlite.query("SELECT 1 FROM narrator_text_snapshots WHERE sha256 = ?").get(unrelated),
	).toBeNull();
	const renewed = sqlite
		.query("SELECT created_at FROM narrator_text_snapshots WHERE sha256 = ?")
		.get(reused.sha256) as { created_at: string };
	expect(renewed.created_at >= new Date(now).toISOString()).toBe(true);
	await recover();
});

test("snapshot publication failure rolls back session roots, contents and renewed leases together", async () => {
	await seedPrefix();
	const bytes = await archive();
	await clearData("sessions");
	const reused = sqlite.query("SELECT sha256 FROM narrator_text_snapshots LIMIT 1").get() as {
		sha256: string;
	};
	sqlite.run("DELETE FROM narrator_text_snapshots WHERE sha256 <> ?", [reused.sha256]);
	const preview = await previewImport(bytes, "prefix.zip");
	sqlite.run(`CREATE TEMP TRIGGER fail_snapshot_publication BEFORE UPDATE ON narrator_text_snapshots
		BEGIN SELECT RAISE(ABORT, 'snapshot publication failed'); END`);
	try {
		await expect(applyImport(preview.token, { include: selection })).rejects.toThrow(
			"snapshot publication failed",
		);
	} finally {
		sqlite.run("DROP TRIGGER fail_snapshot_publication");
	}
	expect(count("narrators")).toBe(0);
	expect(count("narrator_messages")).toBe(0);
	expect(count("narrator_message_refs")).toBe(0);
	expect(count("narrator_text_snapshots")).toBe(1);
	expect(sqlite.query("SELECT created_at FROM narrator_text_snapshots").get()).toEqual({
		created_at: oldTime,
	});
});

test("all-skip and requests-only imports leave snapshot storage untouched", async () => {
	await seedPrefix();
	const bytes = await archive();
	sqlite.run("DELETE FROM narrator_text_snapshots");
	for (const include of [selection, { sessions: false, requests: true, providers: false }]) {
		const preview = await previewImport(bytes, "prefix.zip");
		await applyImport(preview.token, { include, conflictDefault: "skip" });
		expect(count("narrator_text_snapshots")).toBe(0);
	}
});

test("partial import keeps skipped sessions intact and copies the complete shared content store", async () => {
	await seedPrefix();
	narrator("skip");
	const shared = await putPrefixText("shared store, not filtered per narrator");
	await closePrefixSnapshotStore();
	const bytes = await archive();
	await clearData("sessions");
	sqlite.run("DELETE FROM narrator_text_snapshots");
	narrator("skip", { locale: "en", replyInUserLanguage: false });
	const preview = await previewImport(bytes, "prefix.zip");
	const result = await applyImport(preview.token, { include: selection, conflictDefault: "skip" });
	expect(result.sessionsInserted).toBe(1);
	expect(result.sessionsSkipped).toBe(1);
	expect(
		sqlite.query("SELECT 1 FROM narrator_text_snapshots WHERE sha256 = ?").get(shared),
	).not.toBeNull();
	expect(replyContext("skip")).toEqual({ locale: "en", replyInUserLanguage: false });
	await recover();
});

function replyContext(id = "owner") {
	const row = sqlite.query("SELECT reply_context FROM narrators WHERE id = ?").get(id) as {
		reply_context: string | null;
	};
	return row.reply_context === null ? null : JSON.parse(row.reply_context);
}

test("reply context survives new package insert/overwrite while skip preserves local values", async () => {
	narrator();
	const bytes = await archive();
	await clearData("sessions");
	let preview = await previewImport(bytes, "reply.zip");
	await applyImport(preview.token, { include: selection });
	expect(replyContext()).toEqual({ locale: "zh-CN", replyInUserLanguage: true });
	const local = { locale: "en", replyInUserLanguage: false };
	sqlite.run("UPDATE narrators SET reply_context = ?", [JSON.stringify(local)]);
	preview = await previewImport(bytes, "reply.zip");
	await applyImport(preview.token, { include: selection, conflictDefault: "skip" });
	expect(replyContext()).toEqual(local);
	preview = await previewImport(bytes, "reply.zip");
	await applyImport(preview.token, { include: selection, conflictDefault: "overwrite" });
	expect(replyContext()).toEqual({ locale: "zh-CN", replyInUserLanguage: true });
});

test("old packages without snapshots/reply_context import null and preserve absent columns on overwrite", async () => {
	narrator();
	const bytes = await archive();
	await clearData("sessions");
	for (const conflictDefault of ["skip", "overwrite"] as const) {
		const preview = await previewImport(bytes, "legacy.zip");
		const incoming = new Database(preview.snapshotPath);
		incoming.run("DROP TABLE narrator_text_snapshots");
		incoming.run("ALTER TABLE narrators DROP COLUMN reply_context");
		incoming.close();
		await applyImport(preview.token, { include: selection, conflictDefault });
		if (conflictDefault === "skip") {
			expect(replyContext()).toBeNull();
			sqlite.run("UPDATE narrators SET reply_context = ?", [
				JSON.stringify({ locale: "en", replyInUserLanguage: false }),
			]);
		} else {
			expect(replyContext()).toEqual({ locale: "en", replyInUserLanguage: false });
		}
	}
});

test("clearing sessions releases roots but does not synchronously erase shared snapshots or requests", async () => {
	await seedPrefix(true);
	sqlite.run("INSERT INTO api_requests (id, created_at) VALUES ('keep-request', ?)", [oldTime]);
	const total = count("narrator_text_snapshots");
	await clearData("sessions");
	expect(count("narrator_messages")).toBe(0);
	expect(count("narrator_blocks")).toBe(0);
	expect(count("api_requests")).toBe(1);
	expect(count("narrator_text_snapshots")).toBe(total);
	// Orphan manifests conservatively protect children for one additional pass.
	await collect();
	await collect();
	expect(count("narrator_text_snapshots")).toBe(0);
});
