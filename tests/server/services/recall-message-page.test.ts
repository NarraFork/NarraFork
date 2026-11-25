import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDomainReadParams } from "../../../server/lib/db-worker/domain-protocol";
import {
	RECALL_DETAIL_BYTES,
	readRecallConversation,
	readRecallMessage,
	recallConversationQueries,
} from "../../../server/lib/db-worker/recall-reader";

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.run("CREATE TABLE narrators(id TEXT PRIMARY KEY,title TEXT,model TEXT)");
	db.run(
		"CREATE TABLE narrator_messages(id TEXT PRIMARY KEY,role TEXT,origin TEXT,origin_label TEXT,content_text TEXT,content_json TEXT,created_at TEXT,body_revision INTEGER,state_revision INTEGER,body_format INTEGER,body_rows_only INTEGER,body_bytes INTEGER)",
	);
	db.run("CREATE TABLE narrator_message_refs(narrator_id TEXT,message_id TEXT,seq INTEGER)");
	db.run(
		"CREATE TABLE narrator_tool_calls(id TEXT,tool_use_id TEXT,tool_name TEXT,status TEXT,input_json TEXT,message_id TEXT,narrator_id TEXT,created_at TEXT)",
	);
	db.run("CREATE TABLE narrator_block_sync_queue(message_id TEXT)");
	db.run("CREATE TABLE narrator_blocks(message_id TEXT,ordinal INTEGER,payload TEXT,state TEXT)");
	db.run("INSERT INTO narrators VALUES ('n','Title','model'),('other','Other','model')");
	db.run("ALTER TABLE narrators ADD COLUMN refs_inherited_from TEXT");
	db.run("ALTER TABLE narrators ADD COLUMN refs_backfill_cursor INTEGER");
	db.run("ALTER TABLE narrator_message_refs ADD COLUMN segment_compact_id TEXT");
});
afterEach(() => db.close());
function message(
	id: string,
	seq: number,
	text: string,
	role = "user",
	origin: string | null = "user",
	blocks: unknown[] = [{ type: "text", text }],
) {
	db.run("INSERT INTO narrator_messages VALUES (?,?,?,?,?,?,?,3,0,1,0,0)", [
		id,
		role,
		origin,
		"original",
		`summary:${text.slice(0, 10)}`,
		JSON.stringify(blocks),
		"2026-06-01",
	]);
	db.run("INSERT INTO narrator_message_refs(narrator_id,message_id,seq) VALUES ('n',?,?)", [
		id,
		seq,
	]);
}
function conversation(options = {}) {
	return readRecallConversation(db, { narratorId: "n", messageId: null, limit: 2, ...options });
}

test("sparse seq uses filtered matching rows, strict unknown and exclusive stable pages", () => {
	for (let i = 1; i <= 7; i++)
		message(`m${i}`, i * 100, `text${i}`, i % 2 ? "user" : "assistant", i === 3 ? null : "user");
	const latest = conversation({ roles: ["user"] });
	expect(latest.rows.map((r) => r.seq)).toEqual([500, 700]);
	expect(latest.pagination).toEqual({
		hasOlder: true,
		hasNewer: false,
		olderCursor: { seq: 500, messageId: "m5" },
		newerCursor: { seq: 700, messageId: "m7" },
	});
	const older = conversation({ roles: ["user"], cursor: 500 });
	expect(older.rows.map((r) => r.seq)).toEqual([100, 300]);
	expect(older.pagination.hasNewer).toBe(true);
	expect(conversation({ roles: ["user"], direction: "newer" }).rows.map((r) => r.seq)).toEqual([
		100, 300,
	]);
	expect(
		conversation({ roles: ["user"], direction: "newer", cursor: 300 }).rows.map((r) => r.seq),
	).toEqual([500, 700]);
	expect(conversation({ origins: ["unknown"] }).rows.map((r) => r.id)).toEqual(["m3"]);
	expect(conversation({ origins: ["user"], roles: ["user"] }).rows.map((r) => r.id)).toEqual([
		"m5",
		"m7",
	]);
	expect(conversation({ createdFrom: "2026-07-01" }).rows).toEqual([]);
});
test("around selects matching rows, strict limit one/fifty and verifies refs before scope", () => {
	for (let i = 0; i < 61; i++) message(`m${i}`, i * 100, "text", i % 2 ? "assistant" : "user");
	expect(conversation({ messageId: "m30", limit: 1 }).rows.map((r) => r.id)).toEqual(["m30"]);
	const near = conversation({ messageId: "m30", limit: 5, roles: ["user"] });
	expect(near.rows.map((r) => r.seq)).toEqual([2600, 2800, 3000, 3200, 3400]);
	expect(conversation({ messageId: "m30", limit: 50 }).rows).toHaveLength(50);
	expect(conversation({ messageId: "m0", limit: 50 }).rows).toHaveLength(50);
	expect(conversation({ messageId: "m60", limit: 50 }).rows).toHaveLength(50);
	expect(conversation({ messageId: "missing" }).messageMissing).toBe(true);
});
test("tool summaries are opt-in and target owned, previews expose truncation and NUL", () => {
	message("m", 9, "text");
	db.run("UPDATE narrator_messages SET content_text=?", [`hello\0${"写😄".repeat(300)}`]);
	db.run(
		"INSERT INTO narrator_tool_calls VALUES ('t','use','Read','success','{\"path\":\"/visible.txt\"}','m','n','2026'),('o','private','Read','success','{\"path\":\"/private.txt\"}','m','other','2026')",
	);
	expect(conversation().tools).toEqual([]);
	const page = conversation({ includeToolCalls: true });
	expect(page.tools.map((t) => t.tool_use_id)).toEqual(["use"]);
	expect(page.tools[0].summary).toBe("visible.txt");
	expect(page.rows[0].truncated).toBe(true);
	expect(Array.from(page.rows[0].content_text ?? "")).toHaveLength(500);
	expect(page.rows[0].content_text).toContain("hello\0写😄");
	db.run(
		"INSERT INTO narrator_tool_calls VALUES ('ask','ask-use','AskUserQuestion','success',?,'m','n','2026')",
		[JSON.stringify({ questions: [{ header: "选择方案", question: "x".repeat(20000) }] })],
	);
	expect(
		conversation({ includeToolCalls: true }).tools.find((tool) => tool.tool_use_id === "ask-use")
			?.summary,
	).toBe("选择方案");
});
test("legacy and native model text paginate Unicode without summary or sender prefixes", () => {
	const original = "原话😄🌿".repeat(100);
	message("m", 42, original, "user", null, [
		{ type: "text", text: original },
		{ type: "image", source: { secret: "bytes" } },
		{ type: "system_injection", modelText: "native" },
		{ type: "tool_use", id: "use", name: "Read", input: {} },
	]);
	let joined = "",
		offset = 0;
	while (true) {
		const page = readRecallMessage(db, { narratorId: "n", messageId: "m", offset, maxChars: 7 });
		expect(page).toMatchObject({
			seq: 42,
			bodyRevision: 3,
			origin: null,
			omittedBlocks: ["image", "tool_use"],
		});
		joined += page?.text;
		if (!page?.hasMore) {
			expect(page?.nextOffset).toBeNull();
			break;
		}
		offset = page.nextOffset as number;
	}
	expect(joined).toBe(`${original}\nnative`);
	expect(
		readRecallMessage(db, { narratorId: "other", messageId: "m", offset: 0, maxChars: 10 }),
	).toBeNull();
	expect(
		readRecallMessage(db, { narratorId: "n", messageId: "m", offset: 99999, maxChars: 10 }),
	).toMatchObject({ text: "", hasMore: false, nextOffset: null });
});
test("block-only reads reconstruct rows, queued body uses projection, excessive body fails", () => {
	message("m", 1, "legacy");
	db.run("UPDATE narrator_messages SET body_format=2,body_rows_only=1,content_json='[]'");
	db.run("INSERT INTO narrator_blocks VALUES ('m',0,?,NULL)", [
		JSON.stringify({ raw: [{ type: "text", text: "rows😄" }] }),
	]);
	expect(
		readRecallMessage(db, { narratorId: "n", messageId: "m", offset: 0, maxChars: 20 })?.text,
	).toBe("rows😄");
	db.run("UPDATE narrator_messages SET body_rows_only=0,content_json=?", [
		JSON.stringify([{ type: "text", text: "queued" }]),
	]);
	db.run("INSERT INTO narrator_block_sync_queue VALUES ('m')");
	expect(
		readRecallMessage(db, { narratorId: "n", messageId: "m", offset: 0, maxChars: 20 })?.text,
	).toBe("queued");
	db.run("UPDATE narrator_messages SET content_json=CAST(zeroblob(?) AS TEXT)", [
		RECALL_DETAIL_BYTES + 1,
	]);
	expect(() =>
		readRecallMessage(db, { narratorId: "n", messageId: "m", offset: 0, maxChars: 1 }),
	).toThrow("budget");
});
test("lazy fork reads bounded effective history without materializing or exposing ancestor metadata", () => {
	message("old", 1, "original request");
	message("shared", 2, "partially copied");
	message("hidden", 3, "compacted segment");
	message("middle-only", 4, "middle history");
	message("root-boundary", 4, "ancestor after nested fork boundary");
	message("after-fork", 5, "parent later message");
	db.run("UPDATE narrator_message_refs SET narrator_id='other'");
	db.run("UPDATE narrator_message_refs SET segment_compact_id='compact' WHERE message_id='hidden'");
	db.run(
		"INSERT INTO narrators(id,title,model,refs_inherited_from,refs_backfill_cursor) VALUES ('middle','Middle','model','other',4)",
	);
	db.run("UPDATE narrators SET refs_inherited_from='middle',refs_backfill_cursor=5 WHERE id='n'");
	db.run(
		"INSERT INTO narrator_message_refs(narrator_id,message_id,seq) VALUES ('middle','middle-only',4),('n','shared',2)",
	);
	const changes = db.query("SELECT total_changes() AS n").get();
	const page = readRecallMessage(db, {
		narratorId: "n",
		messageId: "old",
		offset: 0,
		maxChars: 100,
	});
	expect(page).toMatchObject({
		narratorId: "n",
		narratorTitle: "Title",
		text: "original request",
		seq: 1,
	});
	expect(page).not.toHaveProperty("originLabel");
	expect(
		readRecallMessage(db, {
			narratorId: "n",
			messageId: "root-boundary",
			offset: 0,
			maxChars: 100,
		}),
	).toBeNull();
	expect(
		readRecallMessage(db, { narratorId: "n", messageId: "after-fork", offset: 0, maxChars: 100 }),
	).toBeNull();
	expect(
		readRecallMessage(db, { narratorId: "n", messageId: "hidden", offset: 0, maxChars: 100 }),
	).toBeNull();
	const browse = conversation({ limit: 50 });
	expect(browse.rows.map((row) => row.id)).toEqual(["old", "shared", "middle-only"]);
	expect(conversation({ messageId: "old", limit: 1 }).rows.map((row) => row.id)).toEqual(["old"]);
	expect(db.query("SELECT total_changes() AS n").get()).toEqual(changes);
	// The target's reference wins, even if a closer ancestor carries a different seq.
	db.run("UPDATE narrator_message_refs SET seq=8 WHERE narrator_id='n' AND message_id='shared'");
	expect(conversation({ limit: 50 }).rows.map((row) => [row.id, row.seq])).toEqual([
		["old", 1],
		["middle-only", 4],
		["shared", 8],
	]);
});

test("tuple cursor pages every same-seq row in both directions and pins exact around anchors", () => {
	for (const id of ["a", "b", "c", "d"]) message(id, 5, id, id === "b" ? "assistant" : "user");
	for (const direction of ["older", "newer"] as const) {
		const ids: string[] = [];
		let cursor: { seq: number; messageId: string } | undefined;
		for (let i = 0; i < 5; i++) {
			const page = conversation({ direction, cursor, limit: 1 });
			ids.push(...page.rows.map((row) => row.id));
			if (!(direction === "older" ? page.pagination.hasOlder : page.pagination.hasNewer)) break;
			cursor =
				(direction === "older" ? page.pagination.olderCursor : page.pagination.newerCursor) ??
				undefined;
		}
		expect(ids).toEqual(direction === "older" ? ["d", "c", "b", "a"] : ["a", "b", "c", "d"]);
	}
	for (const id of ["a", "b", "c", "d"])
		expect(conversation({ messageId: id, limit: 1 }).rows.map((row) => row.id)).toEqual([id]);
	expect(conversation({ messageId: "c", limit: 3 }).rows.map((row) => row.id)).toEqual([
		"b",
		"c",
		"d",
	]);
	const filtered = conversation({ roles: ["user"], limit: 1 });
	expect(filtered.rows.map((row) => row.id)).toEqual(["d"]);
	expect(
		conversation({ roles: ["user"], limit: 1, cursor: filtered.pagination.olderCursor }).rows.map(
			(row) => row.id,
		),
	).toEqual(["c"]);
	expect(
		conversation({
			roles: ["user"],
			direction: "newer",
			limit: 1,
			cursor: { seq: 5, messageId: "a" },
		}).rows.map((row) => row.id),
	).toEqual(["c"]);
	expect(conversation({ cursor: 5, limit: 50 }).rows).toEqual([]);
	expect(conversation({ cursor: 5, direction: "newer", limit: 50 }).rows).toEqual([]);
});

test("cursor stays stable when inherited refs are partially materialized between pages", () => {
	for (const id of ["a", "b", "c"]) message(id, 1, id);
	db.run("UPDATE narrator_message_refs SET narrator_id='other'");
	db.run("UPDATE narrators SET refs_inherited_from='other',refs_backfill_cursor=2 WHERE id='n'");
	const first = conversation({ direction: "newer", limit: 1 });
	expect(first.rows[0].id).toBe("a");
	db.run(
		"INSERT INTO narrator_message_refs(narrator_id,message_id,seq) VALUES ('n','b',1),('n','c',1)",
	);
	const second = conversation({
		direction: "newer",
		limit: 1,
		cursor: first.pagination.newerCursor,
	});
	expect(second.rows.map((row) => row.id)).toEqual(["b"]);
	expect(
		conversation({ direction: "newer", limit: 1, cursor: second.pagination.newerCursor }).rows.map(
			(row) => row.id,
		),
	).toEqual(["c"]);
});

test("invalid and cyclic lazy lineages fail explicitly rather than leaking partial history", () => {
	message("m", 1, "text");
	db.run("UPDATE narrators SET refs_inherited_from='other',refs_backfill_cursor=2 WHERE id='n'");
	db.run("UPDATE narrators SET refs_inherited_from='n',refs_backfill_cursor=2 WHERE id='other'");
	expect(() => conversation()).toThrow("cycle");
	db.run("UPDATE narrators SET refs_inherited_from='missing' WHERE id='n'");
	expect(() => conversation()).toThrow("no longer exists");
});

test("conversation final SQL rejects captured lineage after materialization and ancestor COW", () => {
	message("m1", 1, "fork original request");
	message("m2", 1, "ancestor edited private request");
	for (const direction of ["older", "newer", "around"] as const) {
		db.run("DELETE FROM narrator_message_refs");
		db.run("INSERT INTO narrator_message_refs(narrator_id,message_id,seq) VALUES ('other','m1',1)");
		db.run("UPDATE narrators SET refs_inherited_from='other',refs_backfill_cursor=2 WHERE id='n'");
		const input = {
			narratorId: "n",
			messageId: direction === "around" ? "m1" : null,
			direction,
			limit: 5,
		};
		const run = (mutate = false) => {
			const plan = recallConversationQueries(input);
			let step = plan.next();
			let injected = false;
			while (!step.done) {
				const query = step.value;
				if (mutate && !injected && query.sql.includes("recall_lineage_guard")) {
					injected = true;
					// Exact interleaving: captured B -> A(bound 2), then B finishes cache
					// materialization and clears its pointer before A replaces the shared ref.
					db.run(
						"INSERT INTO narrator_message_refs(narrator_id,message_id,seq) VALUES ('n','m1',1)",
					);
					db.run(
						"UPDATE narrators SET refs_inherited_from=NULL,refs_backfill_cursor=NULL WHERE id='n'",
					);
					db.run("UPDATE narrator_message_refs SET message_id='m2' WHERE narrator_id='other'");
				}
				const rows = db.query(query.sql).all(...query.params) as Record<string, unknown>[];
				if (injected) {
					expect(rows).toHaveLength(1);
					expect(rows[0].recall_lineage_valid).toBe(0);
					expect(rows[0].recall_row_present).toBeNull();
					expect(JSON.stringify(rows)).not.toContain("ancestor edited private request");
				}
				step = plan.next(rows);
			}
			return step.value;
		};
		expect(run().rows.map((row) => row.id)).toEqual(["m1"]);
		expect(() => run(true)).toThrow("lineage changed");
		expect(conversation({ limit: 5 }).rows.map((row) => row.id)).toEqual(["m1"]);
	}
});

test("effective history accepts 32 lineage hops and rejects deeper chains", () => {
	for (let i = 1; i <= 33; i++) {
		db.run("INSERT INTO narrators(id,refs_inherited_from,refs_backfill_cursor) VALUES (?,?,?)", [
			`ancestor-${i}`,
			i < 33 ? `ancestor-${i + 1}` : null,
			i < 33 ? 9 : null,
		]);
	}
	db.run(
		"UPDATE narrators SET refs_inherited_from='ancestor-1',refs_backfill_cursor=9 WHERE id='n'",
	);
	expect(() => conversation()).toThrow("too deep");
	db.run(
		"UPDATE narrators SET refs_inherited_from=NULL,refs_backfill_cursor=NULL WHERE id='ancestor-32'",
	);
	expect(conversation().rows).toEqual([]);
});

test("domain accepts old conversation shape and rejects invalid filters and page units", () => {
	const base = { narratorId: "n", messageId: null, limit: 5 };
	expect(createDomainReadParams("recallConversation", base).input).toEqual(base);
	for (const extra of [
		{ roles: [] },
		{ roles: ["bogus"] },
		{ origins: [] },
		{ cursor: 1.5 },
		{ direction: "around" },
		{ messageId: "m", cursor: 3 },
		{ messageId: "m", direction: "newer" },
		{ includeToolCalls: 1 },
		{ createdFrom: "no" },
		{ extra: 1 },
	])
		expect(() =>
			createDomainReadParams("recallConversation", { ...base, ...extra } as never),
		).toThrow();
	expect(
		createDomainReadParams("recallConversation", { ...base, cursor: { seq: 2, messageId: "m" } })
			.input,
	).toMatchObject({ cursor: { seq: 2, messageId: "m" } });
	for (const cursor of [
		{ seq: 2 },
		{ messageId: "m" },
		{ seq: -1, messageId: "m" },
		{ seq: 2.5, messageId: "m" },
		{ seq: 2, messageId: "" },
		{ seq: 2, messageId: "m", extra: true },
		{ seq: "2", messageId: "m" },
	])
		expect(() =>
			createDomainReadParams("recallConversation", { ...base, cursor } as never),
		).toThrow();
	for (const offset of [-1, 0.5, NaN])
		expect(() =>
			createDomainReadParams("recallMessage", {
				narratorId: "n",
				messageId: "m",
				offset,
				maxChars: 3,
			}),
		).toThrow();
	for (const maxChars of [0, 20001, 0.5])
		expect(() =>
			createDomainReadParams("recallMessage", {
				narratorId: "n",
				messageId: "m",
				offset: 0,
				maxChars,
			}),
		).toThrow();
});
