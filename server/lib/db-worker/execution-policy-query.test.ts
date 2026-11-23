import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTestDb } from "../../../tests/setup";
import { openSchemaCopyAt } from "../../../tests/sqlite-schema-image";
import { readExecutionPolicySnapshot } from "./execution-policy-query";

test.each([
	0, 1, 2001,
])("policy iteration releases its snapshot after reading %s rules", (count) => {
	const root = mkdtempSync(join(tmpdir(), "policy-reader-"));
	const template = getTestDb();
	const writer = openSchemaCopyAt(template.sqlite, join(root, "state.db"));
	template.sqlite.close();
	writer.exec("PRAGMA journal_mode=WAL");
	const reader = new Database(writer.filename, { readonly: true });
	try {
		const insert = writer.query(
			"INSERT INTO narrators (id, type, cwd, created_at, updated_at) VALUES (?, 'primary', '.', 'now', 'now')",
		);
		insert.run("first");
		if (count) {
			writer
				.query(
					`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
					INSERT INTO narrator_blacklist_cmds (id, narrator_id, pattern, created_at)
					SELECT 'rule-'||i, 'first', 'command-'||i, 'now' FROM n`,
				)
				.run(count);
		}
		const read = () => readExecutionPolicySnapshot(reader, "first", new AbortController().signal);
		if (count > 2000) expect(read).toThrow("Permission rule budget exceeded");
		else expect(read().commandBlacklist).toHaveLength(count);
		expect(reader.inTransaction).toBe(false);
		insert.run("later");
		expect(reader.query("SELECT id FROM narrators WHERE id = ?").get("later")).toEqual({
			id: "later",
		});
		writer.query("DELETE FROM narrator_blacklist_cmds").run();
		expect(read().commandBlacklist).toEqual([]);
	} finally {
		reader.close(true);
		writer.close(true);
		rmSync(root, { recursive: true, force: true });
	}
});
