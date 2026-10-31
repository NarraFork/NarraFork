import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import type { DbMessage } from "@shared/agent-protocol/types";
import type { ContextUpdate } from "@shared/prefix-context";
import { modelHistoryFixtureSql } from "./agent-runtime/model-history-fixture";
import { queryModelHistory, sqliteHistoryQuery } from "./agent-runtime/model-history-query";
import { renderModelHistoryRevisionSql } from "./agent-runtime/model-history-revision-sql";
import { attachPrefixHistorySource, createPrefixStateLoader } from "./narrator-prefix-state";

const connections: Database[] = [];
afterEach(() => {
	for (const db of connections.splice(0)) db.close();
});
function fixture() {
	const db = new Database(":memory:");
	connections.push(db);
	db.run(modelHistoryFixtureSql);
	db.run(renderModelHistoryRevisionSql("sqlite"));
	db.run("INSERT INTO narrators (id, title) VALUES ('owner', 'Owner')");
	return db;
}
function add(db: Database, id: string, seq: number, block: unknown, role = "sys") {
	db.query(
		"INSERT INTO narrator_messages (id,narrator_id,role,content_json,content_text) VALUES (?,'owner',?,?,'notice')",
	).run(id, role, JSON.stringify([block]));
	db.query(
		"INSERT INTO narrator_message_refs (id,narrator_id,message_id,seq) VALUES (?,'owner',?,?)",
	).run(`ref:${id}`, id, seq);
}
async function read(db: Database) {
	const source = await queryModelHistory(sqliteHistoryQuery(db), {
		narratorId: "owner",
		versioned: true,
		deadline: Date.now() + 10_000,
	});
	const messages = source.messages.map((row) => ({ ...row }));
	attachPrefixHistorySource(messages, source);
	return { source, messages };
}
function update(ref: string, epochId = "epoch"): ContextUpdate {
	return { type: "context_update", epochId, changes: [], snapshotRef: ref };
}
const epoch = {
	markerId: "epoch",
	prefix: { contract: "contract", parts: [{ key: "cwd", hash: "cwd" }], tools: "tools" },
};
function harness(cacheBytes = 1024 * 1024) {
	const reads: string[] = [];
	const payloads = new Map<string, unknown>();
	const loader = createPrefixStateLoader(
		{
			async getPrefixText(hash) {
				reads.push(hash);
				return hash === "cwd" ? "/baseline" : "fixed contract";
			},
			async getPrefixJson<T>(hash: string) {
				reads.push(hash);
				if (!payloads.has(hash)) throw new Error(`missing ${hash}`);
				return structuredClone(payloads.get(hash)) as T;
			},
			async getPrefixToolDefinitions(hash) {
				reads.push(hash);
				return [{ name: hash === "tools" ? "Read" : hash, description: hash, parameters: {} }];
			},
		},
		{ cacheBytes, cacheEntries: 2 },
	);
	return { loader, reads, payloads };
}

test("distinct views of one source are zero-IO; appended source only replays new events", async () => {
	const db = fixture();
	add(db, "epoch", 1, { type: "epoch" });
	add(db, "u1", 2, update("one"));
	add(db, "t1", 3, { type: "tool_loaded", definitionSnapshotRef: "Write" }, "user");
	const { loader, reads, payloads } = harness();
	payloads.set("one", { changes: [{ key: "cwd", value: "/one" }], modelText: "one-text" });
	payloads.set("two", { changes: [{ key: "cwd", value: "/two" }], modelText: "two-text" });
	const first = await read(db);
	const state = await loader.loadPrefixState(epoch, first.messages);
	expect(state.parts.get("cwd")).toBe("/one");
	expect(state.definitionSnapshots.map((item) => item.name)).toEqual(["Read", "Write"]);
	const secondView = first.source.messages.map((row) => ({ ...row }));
	attachPrefixHistorySource(secondView, first.source);
	reads.length = 0;
	expect(await loader.loadPrefixState(epoch, secondView)).toBe(state);
	expect(reads).toEqual([]);
	add(db, "u2", 4, update("two"));
	const appended = await read(db);
	const next = await loader.loadPrefixState(epoch, appended.messages);
	expect(reads).toEqual(["two"]);
	expect(next.parts.get("cwd")).toBe("/two");
	expect(state.parts.get("cwd")).toBe("/one");
	reads.length = 0;
	const hydrated = await loader.hydrateContextUpdates(
		appended.messages.map((row) => ({ ...row })),
		undefined,
		appended.messages,
	);
	expect(hydrated.find((row) => row.id === "u2")?.contentText).toBe("two-text");
	expect(reads).toEqual([]);
});

test("real body_revision changes and rollback rebuild the merged state", async () => {
	const db = fixture();
	add(db, "u1", 1, update("one"));
	add(db, "u2", 2, update("two"));
	const { loader, reads, payloads } = harness();
	for (const name of ["one", "two", "edit"])
		payloads.set(name, { changes: [{ key: "cwd", value: name }], modelText: name });
	const initial = await read(db);
	await loader.loadPrefixState(epoch, initial.messages);
	db.query("UPDATE narrator_messages SET content_json = ? WHERE id = 'u1'").run(
		JSON.stringify([update("edit")]),
	);
	db.run("DELETE FROM narrator_message_refs WHERE message_id = 'u2'");
	const edited = await read(db);
	expect(edited.messages[0].bodyRevision).toBeGreaterThan(initial.messages[0].bodyRevision);
	reads.length = 0;
	const state = await loader.loadPrefixState(epoch, edited.messages);
	expect(state.parts.get("cwd")).toBe("edit");
	expect(reads).toContain("contract");
	expect(reads).toContain("edit");
	db.run("DELETE FROM narrator_message_refs WHERE message_id = 'u1'");
	const rollback = await loader.loadPrefixState(epoch, (await read(db)).messages);
	expect(rollback.parts.get("cwd")).toBe("/baseline");
});

test("compact source boundary invalidates even when remaining views have identical rows", async () => {
	const { loader, reads } = harness();
	const rows: DbMessage[] = [];
	attachPrefixHistorySource(rows, { compactSeq: 1 });
	await loader.loadPrefixState(epoch, rows);
	const newRows: DbMessage[] = [];
	attachPrefixHistorySource(newRows, { compactSeq: 2 });
	reads.length = 0;
	await loader.loadPrefixState(epoch, newRows);
	expect(reads).toContain("contract");
});

test("large active state survives LRU eviction and keeps request payloads across long hydration", async () => {
	const { loader, reads, payloads } = harness(128);
	const messages = Array.from({ length: 4100 }, (_, index) => {
		const ref = `u${index}`;
		payloads.set(ref, {
			changes: [{ key: "cwd", value: `${index}:${"x".repeat(1024)}` }],
			modelText: `model:${index}`,
		});
		return {
			id: ref,
			role: "sys" as const,
			contentJson: [update(ref)],
			contentText: "stub",
			bodyRevision: 1,
			parentToolUseId: null,
			messageUuid: null,
		};
	});
	const source = {};
	attachPrefixHistorySource(messages, source);
	const active = await loader.loadPrefixState(epoch, messages);
	const secondView = messages.map((row) => ({ ...row }));
	attachPrefixHistorySource(secondView, source);
	expect(await loader.loadPrefixState(epoch, secondView)).toBe(active);
	expect(loader.stats().residentBytes).toBeLessThanOrEqual(128);
	expect(active.parts.get("cwd")).toStartWith("4099:");
	reads.length = 0;
	const hydrated = await loader.hydrateContextUpdates(
		secondView.map((row) => ({ ...row })),
		undefined,
		secondView,
	);
	expect(hydrated[0].contentText).toBe("model:0");
	expect(hydrated.at(-1)?.contentText).toBe("model:4099");
	expect(reads).toEqual([]);
	// Exceed even the weak-key index, while the runtime still owns its opaque state.
	for (let index = 0; index < 12; index++) {
		await loader.loadPrefixState({ ...epoch, markerId: `other:${index}` }, []);
	}
	reads.length = 0;
	const thirdView = messages.map((row) => ({ ...row }));
	attachPrefixHistorySource(thirdView, source);
	const again = await loader.loadPrefixState(
		{ ...epoch, prefixState: active.keepalive },
		thirdView,
	);
	expect(again).toBe(active);
	expect(reads).toEqual([]);
	expect(loader.stats().residentBytes).toBeLessThanOrEqual(128);
});

test("ordinary assistant body edits do not invalidate prefix events", async () => {
	const db = fixture();
	add(db, "u1", 1, update("one"));
	add(db, "answer", 2, { type: "text", text: "partial" }, "assistant");
	const { loader, reads, payloads } = harness();
	payloads.set("one", { changes: [{ key: "cwd", value: "/one" }] });
	const first = await read(db);
	const state = await loader.loadPrefixState(epoch, first.messages);
	db.query("UPDATE narrator_messages SET content_json = ? WHERE id = 'answer'").run(
		JSON.stringify([{ type: "text", text: "finished" }]),
	);
	const next = await read(db);
	expect(next.messages[1].bodyRevision).toBeGreaterThan(first.messages[1].bodyRevision);
	reads.length = 0;
	expect(await loader.loadPrefixState(epoch, next.messages)).toBe(state);
	expect(reads).toEqual([]);
});

test("large definitions are never serialized for size and their schema is measured only once", async () => {
	let schemaReads = 0;
	const definition = {
		name: "large",
		description: "x".repeat(40 * 1024 * 1024),
		get parameters() {
			schemaReads++;
			return { type: "object", properties: { text: { type: "string" } } };
		},
	};
	Object.defineProperty(definition, "toJSON", {
		value() {
			throw new Error("schema serialized on main thread");
		},
	});
	const loader = createPrefixStateLoader(
		{
			async getPrefixText() {
				return "baseline";
			},
			async getPrefixToolDefinitions() {
				return [definition];
			},
			async getPrefixJson<T>() {
				return { changes: [{ key: "cwd", value: "/next" }] } as T;
			},
		},
		{ cacheBytes: 128 },
	);
	const state = await loader.loadPrefixState(epoch, []);
	expect(schemaReads).toBe(1);
	const appended = await loader.loadPrefixState({ ...epoch, prefixState: state.keepalive }, [
		{ id: "u1", role: "sys", contentJson: [update("next")] } as DbMessage,
	]);
	expect(appended.parts.get("cwd")).toBe("/next");
	expect(appended.definitionSnapshots[0]).toBe(definition);
	expect(schemaReads).toBe(1);
	expect(loader.stats().residentBytes).toBeLessThanOrEqual(128);
});

test("aborted incremental reads do not publish partial merged state", async () => {
	const { loader, payloads } = harness();
	const state = await loader.loadPrefixState(epoch, []);
	payloads.set("new", { changes: [{ key: "cwd", value: "wrong" }], modelText: "new" });
	const controller = new AbortController();
	controller.abort(new Error("cancel"));
	await expect(
		loader.loadPrefixState(
			epoch,
			[{ id: "new", role: "sys", contentJson: [update("new")] } as DbMessage],
			controller.signal,
		),
	).rejects.toThrow("cancel");
	expect(await loader.loadPrefixState(epoch, [])).toBe(state);
});
