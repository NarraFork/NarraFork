import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Exercise the generated incremental migration only, never the user's database.
test("字符统计迁移保持旧数据不变且缓存初值为0", async () => {
	const db = new Database(":memory:");
	try {
		db.exec(`CREATE TABLE narrators (id TEXT PRIMARY KEY);
		CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_json TEXT);
		CREATE TABLE narrator_tool_calls (id TEXT PRIMARY KEY, input_json TEXT, output_json TEXT);
		INSERT INTO narrators VALUES ('old');
		INSERT INTO narrator_messages VALUES ('old','not-json-old-body');
		INSERT INTO narrator_tool_calls VALUES ('old','old-input','old-output');`);
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
				.query("SELECT input_chars AS input, output_chars AS output FROM narrator_tool_calls")
				.get(),
		).toEqual({ input: 0, output: 0 });
		expect(
			db
				.query(
					"SELECT context_summary_chars AS summary, context_system_chars AS system, context_tools_chars AS tools, context_char_revision AS revision, context_char_cache_json AS cache FROM narrators",
				)
				.get(),
		).toEqual({ summary: 0, system: 0, tools: 0, revision: 0, cache: null });
	} finally {
		db.close();
	}
});
