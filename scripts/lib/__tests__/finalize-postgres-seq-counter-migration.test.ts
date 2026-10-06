import { describe, expect, test } from "bun:test";
import {
	appendBackfillBlock,
	BACKFILL_BLOCK_MARKER,
	identitySetvalSql,
	NEXT_SEQ_BACKFILL_SQL,
	seqCounterBackfillStatements,
} from "../../finalize-postgres-seq-counter-migration";

describe("seq-counter migration backfill", () => {
	test("derives the backfill from the committed manifest, in a fixed order", () => {
		const statements = seqCounterBackfillStatements();
		expect(statements).toEqual([
			NEXT_SEQ_BACKFILL_SQL,
			identitySetvalSql("background_tasks", "insert_seq"),
			identitySetvalSql("narrators", "insert_seq"),
			identitySetvalSql("narrator_tool_continuations", "insert_seq"),
		]);
	});

	test("next_seq backfill is MAX(refs.seq)+1 per narrator, zero without refs", () => {
		expect(NEXT_SEQ_BACKFILL_SQL).toContain('SET "next_seq" = COALESCE(');
		expect(NEXT_SEQ_BACKFILL_SQL).toContain('MAX("narrator_message_refs"."seq") + 1');
		expect(NEXT_SEQ_BACKFILL_SQL).toContain('"narrator_id" = "narrators"."id"');
		expect(NEXT_SEQ_BACKFILL_SQL.trimEnd()).toMatch(/,\s*0\);$/);
	});

	test("setval parks the sequence at max+1 uncalled, 1 on an empty table", () => {
		const sql = identitySetvalSql("narrators", "insert_seq");
		expect(sql).toBe(
			`SELECT setval(pg_get_serial_sequence('narrators', 'insert_seq'), ` +
				`COALESCE((SELECT MAX("insert_seq") FROM "narrators"), 0) + 1, false);`,
		);
	});

	test("appending is breakpoint-separated and idempotent", () => {
		const ddl = 'ALTER TABLE "narrators" ADD COLUMN "next_seq" integer DEFAULT 0 NOT NULL;';
		const once = appendBackfillBlock(ddl, ["UPDATE a;", "SELECT b;"]);
		expect(once).toContain(`;\n--> statement-breakpoint\n${BACKFILL_BLOCK_MARKER}`);
		expect(once).toContain("UPDATE a;\n--> statement-breakpoint\nSELECT b;");
		expect(appendBackfillBlock(once, ["UPDATE a;", "SELECT b;"])).toBe(once);
	});

	test("appending after a trailing breakpoint does not produce an empty statement", () => {
		const ddl = 'CREATE TABLE "t" ("id" text);--> statement-breakpoint\n';
		const once = appendBackfillBlock(ddl, ["SELECT 1;"]);
		expect(once).not.toContain("statement-breakpoint\n--> statement-breakpoint");
		expect(once.trimEnd().endsWith("SELECT 1;")).toBe(true);
	});

	test("an existing backfill marker cannot hide a tampered statement", () => {
		const original = appendBackfillBlock("SELECT 0;", ["SELECT 1;"]);
		expect(() =>
			appendBackfillBlock(original.replace("SELECT 1;", "SELECT 2;"), ["SELECT 1;"]),
		).toThrow("refusing to rewrite history");
	});

	test("a migration tail that is neither statement nor breakpoint is refused", () => {
		expect(() => appendBackfillBlock("ALTER TABLE t", ["SELECT 1;"])).toThrow();
	});
});
