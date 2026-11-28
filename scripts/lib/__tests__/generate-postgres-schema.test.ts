import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { canonicalCommunicationPair } from "../../../shared/narrator-communication";
import {
	autoForeignKeyName,
	generatePostgresSchema,
	jsonTextDefault,
	PG_IDENTIFIER_LIMIT,
	shortenConstraintName,
	UnsupportedSchemaError,
} from "../../generate-postgres-schema";

const schema = `
import { sql } from "drizzle-orm";
import { integer, sqliteTable, index } from "drizzle-orm/sqlite-core";
export const items = sqliteTable("items", {
  enabled: integer("enabled", { mode: "boolean" }),
  amount: integer("amount"),
}, (table) => [
  index("items_enabled").on(table.enabled).where(sql\`"items"."enabled" = 1 OR "items"."enabled" IS 0\`),
  index("items_amount").on(table.amount).where(sql\`"items"."amount" = 1\`),
]);
`;

test("communication canonical pairs pin PG C collation to SQLite BINARY and JS ASCII ordering only", () => {
	const fixture = `import {sql} from 'drizzle-orm'; import {text,check,sqliteTable} from 'drizzle-orm/sqlite-core';
 export const peers=sqliteTable('narrator_communication_peers',{endpointLo:text('endpoint_lo'),endpointHi:text('endpoint_hi')},(table)=>[check('canonical',sql\`\${table.endpointLo} < \${table.endpointHi}\`)]);
 export const ordinary=sqliteTable('ordinary',{endpointLo:text('endpoint_lo'),endpointHi:text('endpoint_hi')},(table)=>[check('ordinary_compare',sql\`\${table.endpointLo} < \${table.endpointHi}\`)]);`;
	const { coverage } = generatePostgresSchema(fixture);
	expect(coverage.tables[0].checkDefinitions[0].expression).toBe(
		'("endpoint_lo" COLLATE "C") < ("endpoint_hi" COLLATE "C")',
	);
	expect(coverage.tables[1].checkDefinitions[0].expression).toBe('"endpoint_lo" < "endpoint_hi"');
	const sqlite = new Database(":memory:");
	try {
		for (const a of ["A", "Z", "a", "z", "_", "-", "0", "9"])
			for (const b of ["A", "Z", "a", "z", "_", "-", "0", "9"]) {
				if (a === b) continue;
				const [lo, hi] = canonicalCommunicationPair(a, b);
				expect(
					sqlite.query("SELECT (? COLLATE BINARY) < (? COLLATE BINARY) AS ordered").get(lo, hi),
				).toEqual({ ordered: 1 });
			}
	} finally {
		sqlite.close();
	}
});

describe("PostgreSQL boolean expression conversion", () => {
	test("converts boolean comparisons and IS predicates only for boolean columns", () => {
		const { coverage } = generatePostgresSchema(schema);
		const predicates =
			coverage.tables[0]?.indexes.map((index) => index.predicate ?? "").join("\n") ?? "";
		expect(predicates).toContain('"items"."enabled" = TRUE OR "items"."enabled" IS FALSE');
		expect(predicates).toContain('"items"."amount" = 1');
		expect(predicates).not.toContain('"items"."enabled" = 1');
		expect(predicates).not.toContain('"items"."enabled" IS 0');
	});
});

const HEAD = `import { sql } from "drizzle-orm";
import { foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
`;
/** Collect the fail-closed reasons; a thrown non-schema error must not be swallowed. */
function reasons(source: string): string[] {
	try {
		generatePostgresSchema(source);
		return [];
	} catch (error) {
		if (error instanceof UnsupportedSchemaError) return error.unsupported;
		throw error;
	}
}

describe("controlled constant expression indexes and text length", () => {
	const fixture = (term: string) => `${HEAD}
export const t = sqliteTable("t", { id: text("id"), payload: text("payload", { mode: "json" }) }, (table) => [
  uniqueIndex("singleton").on(${term}).where(sql\`\${table.id} IS NOT NULL\`),
]);`;
	test.each([
		"1",
		"(1)",
		"(( 1 ))",
	])("preserves the constant %s separately from columns", (value) => {
		const result = generatePostgresSchema(fixture(`sql\`${value}\``));
		expect(result.coverage.tables[0].indexes[0]).toEqual({
			name: "singleton",
			columns: [],
			expression: "1",
			unique: true,
			predicate: '"id" IS NOT NULL',
		});
		expect(result.source).toContain('uniqueIndex("singleton").on(sql.raw("(1)"))');
		expect(result.coverage.tables[0].indexes[0].emitAsUniqueConstraint).toBeUndefined();
	});
	test.each([
		"2",
		"1+0",
		"true",
		"'1'",
		"abs(1)",
		"1); DROP TABLE t; --",
		"(1",
		"1)",
	])("rejects arbitrary index expression %s", (value) => {
		expect(reasons(fixture(`sql\`${value}\``)).join(" ")).toContain("unsupported index expression");
	});
	test.each([
		'sql.raw("(1)")',
		"sql`1`, table.id",
		`sql\`\${table.id}\``,
		"other`1`",
	])("rejects unsupported index term %s", (value) =>
		expect(reasons(fixture(value)).length).toBeGreaterThan(0));
	test("a constant index cannot be promoted to cover an FK column", () => {
		const source =
			fixture("sql`1`").replace(`.where(sql\`\${table.id} IS NOT NULL\`)`, "") +
			'export const child = sqliteTable("child", { parent: text("parent").references(() => t.id) });';
		expect(reasons(source).join(" ")).toContain("FK target has no usable unique constraint");
	});
	const checkFixture = (expression: string) => `${HEAD}
export const t = sqliteTable("t", { id: text("id"), payload: text("payload", {mode: "json"}), count: integer("count") }, (table) => [
  check("bound", sql\`${expression}\`),
]);`;
	test("only emits a table callback parameter when the executable config uses it", () => {
		expect(generatePostgresSchema(checkFixture(`\${table.count} >= 0`)).source).toContain(
			"}, () => [",
		);
		expect(generatePostgresSchema(fixture("sql`1`")).source).toContain("}, () => [");
		const indexed = `${HEAD}export const t = sqliteTable("t", { id: text("id") }, (table) => [index("by_id").on(table.id)]);`;
		expect(generatePostgresSchema(indexed).source).toContain("}, (table) => [");
	});
	test("preserves character length for text and JSON text, but maps byte budgets separately", () => {
		for (const expression of [
			`length(\${table.id}) <= 2048`,
			`length(\${table.payload}) <= 8192`,
		]) {
			const result = generatePostgresSchema(checkFixture(expression));
			expect(result.coverage.tables[0].checkDefinitions[0].expression).toContain("length(");
			expect(result.source).not.toContain("octet_length");
		}
		expect(
			generatePostgresSchema(checkFixture(`length(cast(\${table.payload} as blob)) <= 8192`))
				.source,
		).toContain('octet_length(\\"payload\\")');
	});
	test.each([
		`length(\${table.count})`,
		`length(\${table.id}, 1)`,
		`length(lower(\${table.id}))`,
		"length(unknown)",
		"length('literal')",
		"random()",
	])("rejects unsupported length/function expression %s", (expression) => {
		expect(reasons(checkFixture(`${expression} <= 8`)).length).toBeGreaterThan(0);
	});
});

describe("JSON column defaults", () => {
	// The codec JSON-encodes on write. A raw JS default would either be encoded twice or,
	// because the column is text-typed, emitted by Drizzle Kit as a bare unquoted value.
	test("encodes once as a PostgreSQL text literal", () => {
		expect(jsonTextDefault([])).toBe("'[]'::text");
		expect(jsonTextDefault(["authorization_code", "refresh_token"])).toBe(
			`'["authorization_code","refresh_token"]'::text`,
		);
		expect(jsonTextDefault({ a: 1 })).toBe(`'{"a":1}'::text`);
	});
	test("escapes single quotes so the literal cannot be terminated early", () => {
		expect(jsonTextDefault(["it's"])).toBe(`'["it''s"]'::text`);
	});
	test("emits the literal through sql.raw rather than a JS value", () => {
		const { coverage } = generatePostgresSchema(`${HEAD}
export const t = sqliteTable("t", {
  id: text("id").primaryKey(),
  tags: text("tags", { mode: "json" }).notNull().default([]),
});
`);
		const column = coverage.tables[0].columns.find((c) => c.name === "tags");
		expect(column?.defaultExpression).toBe(`sql.raw("'[]'::text")`);
	});
});

describe("PG-only identity column overlay", () => {
	const overlaySchema = `${HEAD}
export const narrators = sqliteTable("narrators", {
  id: text("id").primaryKey(),
  nextSeq: integer("next_seq").notNull().default(0),
});
`;
	const overlay = [{ table: "narrators", property: "insertSeq", name: "insert_seq" }];

	test("appends the identity column at the end of the table, where ALTER TABLE puts it", () => {
		const { source, coverage } = generatePostgresSchema(overlaySchema, {}, overlay);
		const table = coverage.tables[0];
		expect(table.columns.map((c) => c.name)).toEqual(["id", "next_seq", "insert_seq"]);
		const column = table.columns.at(-1);
		expect(column).toMatchObject({
			property: "insertSeq",
			pgType: "bigint",
			notNull: true,
			primary: false,
			unique: false,
			identity: { type: "byDefault" },
		});
		expect(column?.references).toBeUndefined();
		expect(column?.defaultExpression).toBeUndefined();
		expect(source).toContain(
			`insertSeq: bigint("insert_seq", { mode: "number" }).notNull().generatedByDefaultAsIdentity(),`,
		);
	});

	test("a missing overlay target fails closed", () => {
		try {
			generatePostgresSchema(
				`${HEAD}
export const items = sqliteTable("items", { id: text("id").primaryKey() });
`,
				{},
				overlay,
			);
			expect.unreachable("a missing overlay target must throw");
		} catch (error) {
			expect(error).toBeInstanceOf(UnsupportedSchemaError);
			expect((error as UnsupportedSchemaError).unsupported.join(" | ")).toContain(
				"PG-only identity column target table missing: narrators",
			);
		}
	});

	test("an overlay column clashing with a parsed column fails closed", () => {
		expect(
			reasons(`${HEAD}
export const narrators = sqliteTable("narrators", {
  id: text("id").primaryKey(),
  insertSeq: integer("insert_seq"),
});
`),
		).toEqual([]);
		// The clash check only applies when the overlay is passed: same table, same name.
		try {
			generatePostgresSchema(
				`${HEAD}
export const narrators = sqliteTable("narrators", {
  id: text("id").primaryKey(),
  insertSeq: integer("insert_seq"),
});
`,
				{},
				overlay,
			);
			expect.unreachable("clashing overlay must throw");
		} catch (error) {
			expect(error).toBeInstanceOf(UnsupportedSchemaError);
			expect((error as UnsupportedSchemaError).unsupported.join(" | ")).toContain(
				"narrators.insert_seq clashes",
			);
		}
	});
});

describe("PostgreSQL identifier limit", () => {
	test("shortening stays in budget, is deterministic, and keeps a readable prefix", () => {
		const logical = autoForeignKeyName("a".repeat(40), ["b".repeat(20)], "c".repeat(20), ["d"]);
		const shortened = shortenConstraintName(logical);
		expect(Buffer.byteLength(shortened)).toBeLessThanOrEqual(PG_IDENTIFIER_LIMIT);
		expect(shortened).toBe(shortenConstraintName(logical));
		expect(shortened.startsWith("aaaa")).toBe(true);
		expect(shortened.endsWith("_fk")).toBe(true);
	});
	test("names sharing their first 63 bytes get distinct short names", () => {
		// Plain truncation would fuse these two constraints into one identifier.
		const prefix = "x".repeat(70);
		const first = shortenConstraintName(`${prefix}_alpha_fk`);
		const second = shortenConstraintName(`${prefix}_beta_fk`);
		expect(first).not.toBe(second);
		expect(Buffer.byteLength(first)).toBeLessThanOrEqual(PG_IDENTIFIER_LIMIT);
		expect(Buffer.byteLength(second)).toBeLessThanOrEqual(PG_IDENTIFIER_LIMIT);
	});
	test("names already within the limit are left untouched", () => {
		expect(shortenConstraintName("child_parent_id_parent_id_fk")).toBe(
			"child_parent_id_parent_id_fk",
		);
	});
	test("a long automatic foreign key name is shortened and emitted as a named constraint", () => {
		const table = "t".repeat(30);
		const column = "c".repeat(30);
		const { coverage } = generatePostgresSchema(`${HEAD}
export const parent = sqliteTable("parent", { id: text("id").primaryKey() });
export const child = sqliteTable("${table}", {
  id: text("id").primaryKey(),
  ${column}: text("${column}").references(() => parent.id),
});
`);
		const reference = coverage.tables
			.find((t) => t.name === table)
			?.columns.find((c) => c.name === column)?.references;
		expect(reference?.constraintName).toBeDefined();
		expect(Buffer.byteLength(reference?.constraintName ?? "")).toBeLessThanOrEqual(
			PG_IDENTIFIER_LIMIT,
		);
		// A column-level .references() cannot carry a name, so it must move to the table config.
		expect(
			coverage.tables.find((t) => t.name === table)?.columns.find((c) => c.name === column)
				?.emitAsTableConstraint,
		).toBe(true);
	});
	for (const [label, source, needle] of [
		[
			"table name",
			`${HEAD}export const t = sqliteTable("${"t".repeat(64)}", { id: text("id").primaryKey() });`,
			"table name exceeds",
		],
		[
			"column name",
			`${HEAD}export const t = sqliteTable("t", { id: text("id").primaryKey(), c: text("${"c".repeat(64)}") });`,
			"column name exceeds",
		],
		[
			"index name",
			`${HEAD}export const t = sqliteTable("t", { id: text("id").primaryKey(), a: text("a") }, (table) => [index("${"i".repeat(64)}").on(table.a)]);`,
			"index name exceeds",
		],
		[
			"explicit foreign key name",
			`${HEAD}
export const parent = sqliteTable("parent", { id: text("id").primaryKey() });
export const child = sqliteTable("child", { id: text("id").primaryKey(), p: text("p") },
  (table) => [foreignKey({ name: "${"f".repeat(64)}", columns: [table.p], foreignColumns: [parent.id] })]);`,
			"foreign key name exceeds",
		],
	] as const) {
		// These cannot be renamed without changing what the schema means, so PostgreSQL's
		// silent truncation has to become a generation failure.
		test(`rejects an over-limit ${label} instead of letting PostgreSQL truncate it`, () => {
			expect(reasons(source).join(" | ")).toContain(needle);
		});
	}
});

describe("foreign key targets need an applicable unique constraint", () => {
	// Drizzle Kit emits every CREATE INDEX after all ALTER TABLE ADD CONSTRAINT, so a target
	// covered only by a unique index is not yet unique when the foreign key is added.
	test("promotes the covering unique index to a table unique constraint", () => {
		const { coverage } = generatePostgresSchema(`${HEAD}
export const parent = sqliteTable("parent", {
  id: text("id").primaryKey(),
  digest: text("digest").notNull(),
}, (table) => [uniqueIndex("u_parent_digest").on(table.digest)]);
export const child = sqliteTable("child", {
  id: text("id").primaryKey(),
  d: text("d").references(() => parent.digest),
});
`);
		const index = coverage.tables
			.find((t) => t.name === "parent")
			?.indexes.find((i) => i.name === "u_parent_digest");
		expect(index?.emitAsUniqueConstraint).toBe(true);
	});
	test("leaves unique indexes no foreign key depends on as indexes", () => {
		const { coverage } = generatePostgresSchema(`${HEAD}
export const parent = sqliteTable("parent", {
  id: text("id").primaryKey(),
  digest: text("digest").notNull(),
}, (table) => [uniqueIndex("u_parent_digest").on(table.digest)]);
`);
		expect(coverage.tables[0].indexes[0].emitAsUniqueConstraint).toBeUndefined();
	});
	test("rejects a target with no unique cover at all", () => {
		expect(
			reasons(`${HEAD}
export const parent = sqliteTable("parent", { id: text("id").primaryKey(), digest: text("digest").notNull() });
export const child = sqliteTable("child", { id: text("id").primaryKey(), d: text("d").references(() => parent.digest) });
`).join(" | "),
		).toContain("no usable unique constraint");
	});
	test("rejects a target covered only by a partial unique index", () => {
		// Promoting a partial index would silently widen the constraint to every row.
		expect(
			reasons(`${HEAD}
export const parent = sqliteTable("parent", {
  id: text("id").primaryKey(),
  digest: text("digest").notNull(),
  live: integer("live", { mode: "boolean" }),
}, (table) => [uniqueIndex("u_partial").on(table.digest).where(sql\`"live" = 1\`)]);
export const child = sqliteTable("child", { id: text("id").primaryKey(), d: text("d").references(() => parent.digest) });
`).join(" | "),
		).toContain("no usable unique constraint");
	});
	test("accepts a primary key target without inventing a constraint", () => {
		const { coverage } = generatePostgresSchema(`${HEAD}
export const parent = sqliteTable("parent", { id: text("id").primaryKey() });
export const child = sqliteTable("child", { id: text("id").primaryKey(), p: text("p").references(() => parent.id) });
`);
		expect(coverage.unsupported).toEqual([]);
		expect(coverage.tables.find((t) => t.name === "parent")?.indexes).toEqual([]);
	});
});

test("file history byte totals retain SQLite's 64-bit capacity in PostgreSQL", () => {
	const { coverage, source } = generatePostgresSchema(`${HEAD}
export const budgets = sqliteTable("file_change_storage_budgets", {
  usedBytes: integer("used_bytes").notNull().default(0),
  reservedBytes: integer("reserved_bytes").notNull().default(0),
  quotaBytes: integer("quota_bytes").notNull(),
  generation: integer("generation").notNull().default(0),
});
export const other = sqliteTable("other", { quotaBytes: integer("quota_bytes") });
`);
	for (const name of ["used_bytes", "reserved_bytes", "quota_bytes"]) {
		expect(coverage.tables[0].columns.find((column) => column.name === name)?.pgType).toBe(
			"bigint",
		);
		expect(source).toContain(`bigint("${name}", { mode: "number" })`);
	}
	expect(coverage.tables[0].columns.find((column) => column.name === "generation")?.pgType).toBe(
		"integer",
	);
	expect(coverage.tables[1].columns[0].pgType).toBe("integer");
});

test("plugin settings and resource revisions use safe 64-bit counters without widening unrelated integers", () => {
	const { coverage } = generatePostgresSchema(`${HEAD}
export const settings = sqliteTable("plugin_provider_settings", { revision: integer("revision").notNull(), schemaVersion: integer("schema_version").notNull() });
export const resources = sqliteTable("plugin_resource_entries", { revision: integer("revision").notNull(), bytes: integer("bytes").notNull() });
`);
	for (const table of coverage.tables) {
		expect(table.columns[0].pgType).toBe("bigint");
		expect(table.columns[1].pgType).toBe("integer");
	}
});
