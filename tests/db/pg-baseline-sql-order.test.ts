import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";
import { readBounded, readPgMetadata } from "../../scripts/lib/postgres-migration-metadata";
import { buildExpected, type Catalog, compareBaseline, type Snapshot } from "./pg-baseline-model";
import { physicalColumnOrderFromSql } from "./pg-baseline-sql-order";

function snapshot(tables: Record<string, string[]>): Snapshot {
	return {
		tables: Object.fromEntries(
			Object.entries(tables).map(([name, columns]) => [
				`public.${name}`,
				{
					name,
					schema: "public",
					columns: Object.fromEntries(
						columns.map((column) => [
							column,
							{ name: column, type: "text", notNull: false, primaryKey: false },
						]),
					),
				},
			]),
		),
	};
}
function run(sql: string | string[], tables: Record<string, string[]>) {
	return physicalColumnOrderFromSql(typeof sql === "string" ? [sql] : sql, snapshot(tables));
}
function good(sql: string | string[], tables: Record<string, string[]>) {
	const result = run(sql, tables);
	expect(result.problems).toEqual([]);
	return result.order;
}

describe("SQL-derived physical column order", () => {
	test("ADD appends even when latest schema definition puts the column in the middle", () => {
		const order = good(
			[
				'CREATE TABLE "t" ("first" text, "last" text);',
				'ALTER TABLE "t" ADD COLUMN "middle" text;',
			],
			{ t: ["first", "middle", "last"] },
		);
		expect(order.get("t")).toEqual(["first", "last", "middle"]);
	});

	test("latest snapshot reordering cannot provide a fallback order", () => {
		const sql = ['CREATE TABLE "t" ("b" text, "a" text);', 'ALTER TABLE "t" ADD COLUMN "c" text;'];
		const first = run(sql, { t: ["a", "b", "c"] });
		const second = run(sql, { t: ["c", "a", "b"] });
		expect(first.problems).toEqual([]);
		expect(second.problems).toEqual([]);
		expect(first.order).toEqual(second.order);
		expect(first.order.get("t")).toEqual(["b", "a", "c"]);
	});

	test("drop and re-add appends; surviving columns retain order", () => {
		const order = good(
			`CREATE TABLE t (a text,b text,c text);
			ALTER TABLE t DROP COLUMN b;
			ALTER TABLE t ADD COLUMN b text;`,
			{ t: ["a", "b", "c"] },
		);
		expect(order.get("t")).toEqual(["a", "c", "b"]);
	});

	test("column and table rename preserve physical position, including quoted escapes", () => {
		const order = good(
			`CREATE TABLE "public"."old" ("a" text,"b" text);
			ALTER TABLE public.old RENAME COLUMN "a" TO "a""b";
			ALTER TABLE "old" RENAME TO "new";
			ALTER TABLE "new" ADD "tail" text;`,
			{ new: ['a"b', "b", "tail"] },
		);
		expect(order.get("new")).toEqual(['a"b', "b", "tail"]);
		expect(order.has("old")).toBe(false);
	});

	test("DROP TABLE, recreation, multiple drop targets, and IF EXISTS/NOT EXISTS", () => {
		const order = good(
			`CREATE TABLE t(a text,b text);
			CREATE TABLE IF NOT EXISTS t(ignored text);
			ALTER TABLE t ADD COLUMN IF NOT EXISTS a text;
			ALTER TABLE t DROP COLUMN IF EXISTS absent;
			CREATE TABLE gone(x text);
			DROP TABLE IF EXISTS gone,missing CASCADE;
			DROP TABLE t;
			CREATE TABLE t(b text,a text);`,
			{ t: ["a", "b"] },
		);
		expect(order.get("t")).toEqual(["b", "a"]);
	});

	test("multi-action ALTER separates only top-level commas and handles array/type expressions", () => {
		const order = good(
			`CREATE TABLE t (id text);
			ALTER TABLE ONLY public.t
			ADD COLUMN numeric_col numeric(12,3) DEFAULT greatest(1,2),
			ADD COLUMN xs integer[] DEFAULT ARRAY[1,2,(3+4)],
			ADD COLUMN matrix integer[][] DEFAULT ARRAY[ARRAY[1,2],ARRAY[3,4]];
			ALTER TABLE t DROP id, ADD COLUMN id text;`,
			{ t: ["id", "xs", "numeric_col", "matrix"] },
		);
		expect(order.get("t")).toEqual(["numeric_col", "xs", "matrix", "id"]);
	});

	test("quoted identifiers, Unicode, commas, semicolons, nested defaults, and constraints", () => {
		const order = good(
			`CREATE TABLE "public"."select" (
			"a,b" text DEFAULT 'it''s (a,b); CREATE TABLE phantom (x text)',
			"semi;colon" text DEFAULT concat('x,y',substring('ab' from 1 for 2)),
			"雪" numeric(10,2) DEFAULT ((1+2)*3),
			CONSTRAINT "pk" PRIMARY KEY ("a,b","semi;colon"),
			UNIQUE ("雪","a,b"), CHECK ("雪" > 0),
			FOREIGN KEY ("a,b") REFERENCES another("id")
			);`,
			{ select: ["雪", "semi;colon", "a,b"] },
		);
		expect(order.get("select")).toEqual(["a,b", "semi;colon", "雪"]);
		expect(order.has("phantom")).toBe(false);
	});

	test("ignores line/block/nested comments and opaque dollar/E strings", () => {
		const order = good(
			`-- CREATE TABLE fake (a text);\n
			/* outer ( ; /* nested ADD COLUMN nope; */ still outer */
			CREATE TABLE t(
			a text DEFAULT $tag$);, /* no comment */ 'quote' $$ ; ALTER TABLE t DROP a;$tag$,
			b text DEFAULT $$),;"$$,
			c text DEFAULT E'escaped\\'quote,;()'
			);--> statement-breakpoint
			ALTER /* separator */ TABLE t ADD COLUMN d text;-- ;);`,
			{ t: ["a", "b", "c", "d"] },
		);
		expect(order.get("t")).toEqual(["a", "b", "c", "d"]);
	});

	test("type/default/FK/index/constraint operations do not move columns", () => {
		const order = good(
			`CREATE TABLE t(a text,b text);
			ALTER TABLE t ALTER COLUMN a TYPE varchar(32), ALTER b SET DEFAULT 'a,b';
			ALTER TABLE t ALTER COLUMN b DROP DEFAULT, ALTER COLUMN a SET NOT NULL;
			ALTER TABLE t ALTER COLUMN a DROP NOT NULL;
			ALTER TABLE t ALTER COLUMN a SET DATA TYPE text;
			ALTER TABLE t ADD CONSTRAINT uq UNIQUE(a,b);
			ALTER TABLE t RENAME CONSTRAINT uq TO uq_new;
			ALTER TABLE t VALIDATE CONSTRAINT uq_new;
			ALTER TABLE t ALTER CONSTRAINT uq_new DEFERRABLE;
			ALTER TABLE t DROP CONSTRAINT uq_new;
			CREATE UNIQUE INDEX idx ON t(a,b);
			ALTER INDEX idx RENAME TO idx_new;
			DROP INDEX idx_new;
			COMMENT ON COLUMN t.a IS 'ALTER TABLE t ADD COLUMN fake text;';`,
			{ t: ["b", "a"] },
		);
		expect(order.get("t")).toEqual(["a", "b"]);
	});

	test("identity additions append and safe backfills remain data-only", () => {
		const order = good(
			`CREATE TABLE t(id text);
			ALTER TABLE t ADD COLUMN insert_seq bigint GENERATED BY DEFAULT AS IDENTITY
			(sequence name "seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1);
			UPDATE t SET id=COALESCE((SELECT MAX(id) FROM t),'');
			SELECT setval(pg_get_serial_sequence('t','insert_seq'),COALESCE((SELECT MAX(insert_seq) FROM t),0)+1,false);`,
			{ t: ["insert_seq", "id"] },
		);
		expect(order.get("t")).toEqual(["id", "insert_seq"]);
	});

	test("unquoted identifiers fold to lower case; quoted names retain case", () => {
		const order = good('CREATE TABLE PUBLIC.Mixed (UPPER text,"ExactCase" text);', {
			mixed: ["upper", "ExactCase"],
		});
		expect(order.get("mixed")).toEqual(["upper", "ExactCase"]);
	});

	test("missing SQL cannot synthesize order from snapshot declarations", () => {
		const result = run([], { t: ["a", "b"] });
		expect(result.order.size).toBe(0);
		expect(result.problems.join("\n")).toContain("missing from SQL replay");
	});

	test.each([
		"ALTER TABLE t ATTACH PARTITION p FOR VALUES IN (1);",
		"ALTER TABLE t SET SCHEMA elsewhere;",
		"ALTER TABLE t INHERIT parent;",
		"ALTER TABLE t ALTER COLUMN a MYSTERY ACTION;",
		"CREATE TABLE copy (LIKE t INCLUDING ALL);",
		"CREATE TABLE copy AS SELECT * FROM t;",
		"CREATE TABLE copy(a text) INHERITS(t);",
		"CREATE TABLE copy OF composite_type;",
		"CREATE TABLE copy(a text) PARTITION BY RANGE(a);",
		"DO $$ BEGIN EXECUTE 'ALTER TABLE t ADD COLUMN dynamic text'; END $$;",
		"CREATE FUNCTION mutate() RETURNS void LANGUAGE SQL AS $$ALTER TABLE t DROP COLUMN a$$;",
		"CALL mutate();",
		"EXECUTE dynamic_statement;",
		"SELECT mutate();",
		"SELECT public.setval('seq',1);",
		"COPY t FROM PROGRAM 'dynamic DDL';",
		"SET search_path TO elsewhere;",
		"ROLLBACK;",
	])("fail-closed for unsupported layout/procedural statement %s", (statement) => {
		const result = run(`CREATE TABLE t(a text); ${statement}`, { t: ["a"] });
		expect(result.problems.length).toBeGreaterThan(0);
	});

	test.each([
		"CREATE TABLE t(a text,a text);",
		"CREATE TABLE t(a text); CREATE TABLE t(b text);",
		"ALTER TABLE missing ADD COLUMN a text;",
		"CREATE TABLE t(a text); ALTER TABLE t ADD COLUMN a text;",
		"CREATE TABLE t(a text); ALTER TABLE t DROP COLUMN b;",
		"CREATE TABLE t(a text); ALTER TABLE t RENAME COLUMN b TO c;",
		"CREATE TABLE t(a text,b text); ALTER TABLE t RENAME a TO b;",
		"CREATE TABLE t(a text); CREATE TABLE target(b text); ALTER TABLE t RENAME TO target;",
		"CREATE TABLE other.t(a text);",
		"CREATE TABLE t(a text,);",
		"CREATE TABLE t(a);",
	])("reports malformed/inconsistent layout replay %s", (sql) => {
		expect(run(sql, { t: ["a"] }).problems.length).toBeGreaterThan(0);
	});

	test.each([
		"CREATE TABLE t(a text DEFAULT 'unterminated);",
		'CREATE TABLE "unterminated(a text);',
		"CREATE TABLE t(a text DEFAULT $$unterminated);",
		"/* unterminated",
		"CREATE TABLE t(a text DEFAULT ARRAY[1,2);",
		"CREATE TABLE t(a text DEFAULT (1;2));",
	])("reports invalid/unterminated lexical input %s", (sql) => {
		expect(run(sql, { t: ["a"] }).problems.length).toBeGreaterThan(0);
	});

	test("validates table and column sets, column identity, and schema without filling missing order", () => {
		const extraSql = run("CREATE TABLE t(a text); CREATE TABLE extra(x text);", { t: ["a"] });
		expect(extraSql.problems.join("\n")).toContain("SQL table missing from snapshot: extra");
		const missingColumn = run("CREATE TABLE t(a text);", { t: ["a", "b"] });
		expect(missingColumn.problems.join("\n")).toContain("Snapshot column missing from SQL: t.b");
		expect(missingColumn.order.get("t")).toEqual(["a"]);
		const extraColumn = run("CREATE TABLE t(a text,b text);", { t: ["a"] });
		expect(extraColumn.problems.join("\n")).toContain("SQL column missing from snapshot: t.b");
		const corrupt = snapshot({ t: ["a"] });
		corrupt.tables["public.t"].columns.a.name = "b";
		expect(
			physicalColumnOrderFromSql(["CREATE TABLE t(a text);"], corrupt).problems.join("\n"),
		).toContain("key/name mismatch");
		corrupt.tables["public.t"].schema = "other";
		expect(
			physicalColumnOrderFromSql(["CREATE TABLE t(a text);"], corrupt).problems.join("\n"),
		).toContain("Unsupported snapshot schema");
	});

	test("order tamper remains detectable as an ordered array, not only a set", () => {
		const wanted = snapshot({ t: ["a", "b", "middle"] });
		const derived = physicalColumnOrderFromSql(
			["CREATE TABLE t(a text,b text); ALTER TABLE t ADD COLUMN middle text;"],
			wanted,
		);
		const expected = buildExpected(wanted).expected;
		expected.columnOrder = derived.order;
		expect(derived.problems).toEqual([]);
		expect(expected.columnOrder.get("t")).toEqual(["a", "b", "middle"]);
		// Pure invented catalog fixture, never sampled from a database or used to derive expected.
		const actual: Catalog = {
			tables: expected.tables,
			columns: structuredClone(expected.columns),
			foreignKeys: [],
			indexes: [],
			uniques: [],
			checks: [],
			generated: [],
			sequences: [],
		};
		expect(compareBaseline(expected, actual, new Map(), expected.counts)).toEqual([]);
		for (const names of [
			["a", "middle", "b"],
			["a", "b"],
			["a", "b", "middle", "middle"],
		]) {
			const changed = structuredClone(actual);
			changed.columns = names.map((name) => {
				const column = actual.columns.find((column) => column.name === name);
				if (!column) throw new Error(`Missing invented fixture column ${name}`);
				return { ...column };
			});
			expect(compareBaseline(expected, changed, new Map(), expected.counts).join("\n")).toContain(
				"column order",
			);
		}
	});
});

describe("bounds, real committed assets, and source AST guard", () => {
	test("enforces file/count/total/schema byte limits before replay", () => {
		expect(run(" ".repeat(1024 * 1024 + 1), {}).problems.join("\n")).toContain("1 MiB");
		expect(
			run(
				Array.from({ length: 4097 }, () => ""),
				{},
			).problems.join("\n"),
		).toContain("file count");
		const sql = " ".repeat(1024 * 1024);
		expect(
			run(
				Array.from({ length: 33 }, () => sql),
				{},
			).problems.join("\n"),
		).toContain("32 MiB");
		const large = snapshot({ t: ["a"] });
		large.tables["public.t"].columns.a.default = "x".repeat(8 * 1024 * 1024);
		expect(physicalColumnOrderFromSql([], large).problems.join("\n")).toContain("8 MiB");
	});

	test("caps nesting, token count, statement count, and diagnostics", () => {
		expect(
			run(
				`CREATE TABLE t(a text DEFAULT ${"(".repeat(129)}1${")".repeat(129)});`,
				{},
			).problems.join("\n"),
		).toContain("grouping limit");
		expect(run(`${"/*".repeat(129)}${"*/".repeat(129)}`, {}).problems.join("\n")).toContain(
			"nesting limit",
		);
		expect(run("+ ".repeat(200001), {}).problems.join("\n")).toContain("token limit");
		expect(run("SELECT 1;".repeat(32769), {}).problems.join("\n")).toContain("statement limit");
		const result = run("DO $$ BEGIN END $$;".repeat(150), {});
		expect(result.problems).toHaveLength(128);
		expect(result.problems.every((problem) => problem.length <= 400)).toBe(true);
	});

	test("real journal-ordered SQL matches current snapshot column sets without history snapshots", () => {
		const folder = join(import.meta.dir, "../../drizzle-postgres");
		const metadata = readPgMetadata(folder);
		const sqls = metadata.journal.entries.map((entry) =>
			readBounded(join(folder, `${entry.tag}.sql`), 1024 * 1024),
		);
		const result = physicalColumnOrderFromSql(sqls, metadata.snapshot as unknown as Snapshot);
		expect(result.problems).toEqual([]);
		expect(result.order.size).toBe(
			Object.keys((metadata.snapshot as unknown as Snapshot).tables).length,
		);
		const narrators = result.order.get("narrators");
		expect(narrators?.slice(-2)).toEqual([
			"context_char_cache_json",
			"context_usage_snapshot_json",
		]);
		expect(narrators?.indexOf("next_seq")).toBeLessThan(narrators?.indexOf("insert_seq") ?? -1);
		expect(result.order.get("background_tasks")?.at(-1)).toBe("insert_seq");
	});

	test("AST pins a pure SQL helper with no catalog access or snapshot-order writes", () => {
		const source = readBounded(join(import.meta.dir, "pg-baseline-sql-order.ts"), 1024 * 1024);
		const ast = ts.createSourceFile(
			"helper.ts",
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		const imports: ts.ImportDeclaration[] = [];
		const orderWrites: ts.CallExpression[] = [];
		const externalCalls: string[] = [];
		const visit = (node: ts.Node) => {
			if (ts.isImportDeclaration(node)) imports.push(node);
			if (ts.isCallExpression(node)) {
				if (
					ts.isPropertyAccessExpression(node.expression) &&
					ts.isIdentifier(node.expression.expression) &&
					node.expression.expression.text === "order" &&
					node.expression.name.text === "set"
				)
					orderWrites.push(node);
				if (
					ts.isIdentifier(node.expression) &&
					/^(exec|query|readFile|fetch)/.test(node.expression.text)
				)
					externalCalls.push(node.expression.text);
			}
			ts.forEachChild(node, visit);
		};
		visit(ast);
		expect(imports).toHaveLength(1);
		expect(imports[0].importClause?.isTypeOnly).toBe(true);
		expect((imports[0].moduleSpecifier as ts.StringLiteral).text).toBe("./pg-baseline-model");
		expect(externalCalls).toEqual([]);
		expect(orderWrites).toHaveLength(2);
		for (const call of orderWrites) expect(call.arguments[1].getText(ast)).toBe("list");
	});
});
