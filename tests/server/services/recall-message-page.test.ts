import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDomainReadParams } from "../../../server/lib/db-worker/domain-protocol";
import {
	RECALL_DETAIL_BYTES,
	readRecallConversation,
	readRecallMessage,
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
	db.run("INSERT INTO narrator_message_refs VALUES ('n',?,?)", [id, seq]);
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
		olderCursor: 500,
		newerCursor: 700,
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
