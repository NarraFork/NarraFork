import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Exercise the generated incremental migration only, never the user's database.
test("字符统计迁移保持旧数据不变且缓存初值为0", async () => {
	const db = new Database(":memory:");
	try {
		db.exec("PRAGMA foreign_keys=ON");
		db.exec(`CREATE TABLE narrators (id TEXT PRIMARY KEY);
		CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_json TEXT);
		CREATE TABLE narrator_tool_calls (id TEXT PRIMARY KEY, input_json TEXT, output_json TEXT);
		CREATE TABLE user_preferences (id TEXT PRIMARY KEY NOT NULL);
		INSERT INTO narrators VALUES ('old');
		INSERT INTO narrator_messages VALUES ('old','not-json-old-body');
		INSERT INTO narrator_tool_calls VALUES ('old','old-input','old-output');
		INSERT INTO user_preferences VALUES ('old-preference');`);
		let migration: string | undefined;
		const folder = fileURLToPath(new URL("../../../drizzle/", import.meta.url));
		// drizzle-kit chooses a random suffix; never bind the test to that filename.
		for await (const path of new Bun.Glob("*.sql").scan({ cwd: folder, absolute: true })) {
			const file = Bun.file(path);
			if (file.size > 64 * 1024) continue;
			const sql = await file.text();
			if (sql.includes("ALTER TABLE `narrator_messages` ADD `context_chars_json`")) {
				migration = sql;
				break;
			}
		}
		if (!migration)
			throw new Error("Generate the incremental character statistics migration first");
		db.exec(migration.replaceAll("--> statement-breakpoint", ""));
		expect(
			db
				.query("SELECT content_json AS body, context_chars_json AS chars FROM narrator_messages")
				.get(),
		).toEqual({ body: "not-json-old-body", chars: null });
		expect(
			db
				.query(
					"SELECT input_json AS inputBody, output_json AS outputBody, input_chars AS input, output_chars AS output FROM narrator_tool_calls",
				)
				.get(),
		).toEqual({ inputBody: "old-input", outputBody: "old-output", input: 0, output: 0 });
		expect(
			db
				.query(
					"SELECT context_summary_chars AS summary, context_system_chars AS system, context_tools_chars AS tools, context_char_revision AS revision, context_char_cache_json AS cache FROM narrators",
				)
				.get(),
		).toEqual({ summary: 0, system: 0, tools: 0, revision: 0, cache: null });
		// Character metadata does not alter unrelated preferences or invent removed legacy columns.
		expect(db.query("SELECT id FROM user_preferences").get()).toEqual({ id: "old-preference" });
		expect(
			(db.query("PRAGMA table_info(user_preferences)").all() as { name: string }[]).map(
				(column) => column.name,
			),
		).toEqual(["id"]);
		// The same complete migration must create the page table and enforce its index and FK.
		db.exec(
			"INSERT INTO narrator_context_char_pages VALUES ('page-old', 'old', 'generation', 0, '[]')",
		);
		expect(() =>
			db.exec(
				"INSERT INTO narrator_context_char_pages VALUES ('page-duplicate', 'old', 'generation', 0, '[]')",
			),
		).toThrow();
		expect(() =>
			db.exec(
				"INSERT INTO narrator_context_char_pages VALUES ('page-orphan', 'missing', 'generation', 1, '[]')",
			),
		).toThrow();
		db.exec("DELETE FROM narrators WHERE id = 'old'");
		expect(db.query("SELECT id FROM narrator_context_char_pages").all()).toEqual([]);
	} finally {
		db.close();
	}
});

// Resource migrations bundled alongside these additions are covered by their own integration fixtures.
test("请求快照新增字段保持旧正文不变且初值为null", async () => {
	const db = new Database(":memory:");
	try {
		db.exec("PRAGMA foreign_keys=ON");
		db.exec(`CREATE TABLE narrators (id TEXT PRIMARY KEY, context_summary TEXT);
		CREATE TABLE api_requests (id TEXT PRIMARY KEY, raw_dump_json TEXT);
		INSERT INTO narrators VALUES ('old', 'old-summary');
		INSERT INTO api_requests VALUES ('old', 'not-json-old-dump');`);
		const folder = fileURLToPath(new URL("../../../drizzle/", import.meta.url));
		const additions: string[] = [];
		for await (const path of new Bun.Glob("*.sql").scan({ cwd: folder, absolute: true })) {
			const file = Bun.file(path);
			if (file.size > 256 * 1024) continue;
			const sql = await file.text();
			for (const statement of sql.split("--> statement-breakpoint")) {
				if (
					/^\s*ALTER TABLE `(api_requests|narrators)` ADD `context_usage_snapshot_json` text;\s*$/.test(
						statement,
					)
				)
					additions.push(statement);
			}
		}
		expect(additions).toHaveLength(2);
		for (const statement of additions) db.exec(statement);
		expect(
			db
				.query(
					"SELECT context_summary AS body, context_usage_snapshot_json AS snapshot FROM narrators",
				)
				.get(),
		).toEqual({ body: "old-summary", snapshot: null });
		expect(
			db
				.query(
					"SELECT raw_dump_json AS body, context_usage_snapshot_json AS snapshot FROM api_requests",
				)
				.get(),
		).toEqual({ body: "not-json-old-dump", snapshot: null });
	} finally {
		db.close();
	}
});
