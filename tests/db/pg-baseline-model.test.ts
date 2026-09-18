/**
 * Negative tests for the PostgreSQL baseline comparison rules.
 *
 * `pg-baseline.test.ts` needs a container; these do not, so they run everywhere and pin the
 * property that matters most about a gate: that it fails when it should. Each of the four
 * defects that made the earlier version of that gate vacuous gets a test showing the bad
 * behaviour is no longer possible, and every comparison rule gets a tampered input.
 *
 * The catalog-side halves of two of those defects (`WITH ORDINALITY` binding, unquoted JSON
 * alias) are properties of PostgreSQL, not of this code, so they are pinned against the live
 * server in the container test. Here the consequences are pinned: a shortened column list is
 * reported rather than accepted, and a missing facet field is reported rather than read as
 * `undefined`.
 */

import { describe, expect, it } from "bun:test";
import {
	buildDeparseScript,
	buildExpected,
	CATALOG_FACETS,
	type Catalog,
	checkMigrationLedger,
	compareBaseline,
	deparseKey,
	deparseRequests,
	dumpFacet,
	type Expected,
	FACET_WIDTHS,
	facetMetaSql,
	migrationScript,
	normDefault,
	parseCatalog,
	parseDeparseOutput,
	psqlProxyCallback,
	type Snapshot,
	type SnapshotColumn,
	type SnapshotIndex,
	type SnapshotIndexColumn,
	type SnapshotTable,
} from "./pg-baseline-model";

// ---------------------------------------------------------------------------------------
// Fixtures: a miniature but structurally complete baseline
// ---------------------------------------------------------------------------------------

const snapshot = (): Snapshot => ({
	tables: {
		"public.parent": {
			name: "parent",
			schema: "",
			columns: {
				id: { name: "id", type: "text", primaryKey: true, notNull: true },
				label: { name: "label", type: "text", primaryKey: false, notNull: true },
			},
			uniqueConstraints: {
				parent_label_unique: {
					name: "parent_label_unique",
					columns: ["label"],
					nullsNotDistinct: false,
				},
			},
		},
		"public.child": {
			name: "child",
			schema: "",
			columns: {
				id: { name: "id", type: "text", primaryKey: true, notNull: true },
				parent_id: { name: "parent_id", type: "text", primaryKey: false, notNull: false },
				kind: {
					name: "kind",
					type: "text",
					primaryKey: false,
					notNull: true,
					default: "'narrator'",
				},
				retries: {
					name: "retries",
					type: "integer",
					primaryKey: false,
					notNull: true,
					default: "0",
				},
				flagged: {
					name: "flagged",
					type: "boolean",
					primaryKey: false,
					notNull: true,
					default: "false",
				},
				size: { name: "size", type: "bigint", primaryKey: false, notNull: false },
				created_at: { name: "created_at", type: "text", primaryKey: false, notNull: true },
				pending: {
					name: "pending",
					type: "integer",
					primaryKey: false,
					notNull: false,
					generated: { as: "(CASE WHEN \"kind\" = 'narrator' THEN 1 ELSE 0 END)", type: "stored" },
				},
			},
			indexes: {
				idx_child_created: {
					name: "idx_child_created",
					isUnique: false,
					method: "btree",
					with: {},
					columns: [
						{ expression: "created_at", isExpression: false, asc: true, nulls: "last" },
						{ expression: "id", isExpression: false, asc: true, nulls: "last" },
					],
				},
				idx_child_pending: {
					name: "idx_child_pending",
					isUnique: true,
					method: "btree",
					with: {},
					where: '"pending" = 1',
					columns: [{ expression: "id", isExpression: false, asc: true, nulls: "last" }],
				},
			},
			foreignKeys: {
				child_parent_id_parent_id_fk: {
					name: "child_parent_id_parent_id_fk",
					tableFrom: "child",
					tableTo: "parent",
					columnsFrom: ["parent_id"],
					columnsTo: ["id"],
					onDelete: "cascade",
					onUpdate: "no action",
				},
			},
			checkConstraints: {
				ck_child_retries: { name: "ck_child_retries", value: '"retries" >= 0' },
			},
		},
	},
});

/**
 * Typed accessors into the fixture's `child` table.
 *
 * The snapshot type indexes tables, indexes and columns by string, so every direct lookup
 * would need a non-null assertion; these throw with the missing key instead, which is also
 * what a renamed fixture should produce.
 */
function childTable(snap: Snapshot): SnapshotTable {
	const table = snap.tables["public.child"];
	if (!table) throw new Error("fixture lost its child table");
	return table;
}
function childIndex(snap: Snapshot, name = "idx_child_created"): SnapshotIndex {
	const index = childTable(snap).indexes?.[name];
	if (!index) throw new Error(`fixture lost index ${name}`);
	return index;
}
function childColumn(snap: Snapshot, name: string): SnapshotColumn {
	const column = childTable(snap).columns[name];
	if (!column) throw new Error(`fixture lost column ${name}`);
	return column;
}

/** Locate a row of the comparable model, failing loudly rather than silently skipping. */
function find<T>(rows: T[], match: (row: T) => boolean, label: string): T {
	const row = rows.find(match);
	if (!row) throw new Error(`fixture lost ${label}`);
	return row;
}

/** What a correct server reports for the fixture: the deparsed forms PostgreSQL emits. */
const CANONICAL_PREDICATE = "(pending = 1)";
const CANONICAL_CHECK = "CHECK ((retries >= 0))";
const CANONICAL_GENERATED = "CASE WHEN (kind = 'narrator'::text) THEN 1 ELSE 0 END";

function fixture(): {
	expected: Expected;
	catalog: Catalog;
	canonical: Map<string, string>;
	counts: Record<string, number>;
} {
	const built = buildExpected(snapshot());
	expect(built.problems).toEqual([]);
	const canonical = new Map<string, string>([
		[deparseKey("predicate", "child", '"pending" = 1'), CANONICAL_PREDICATE],
		[deparseKey("check", "child", '"retries" >= 0'), CANONICAL_CHECK],
		[
			deparseKey("generated", "child", "(CASE WHEN \"kind\" = 'narrator' THEN 1 ELSE 0 END)"),
			CANONICAL_GENERATED,
		],
	]);
	const catalog: Catalog = {
		tables: ["parent", "child"],
		columns: [
			{
				table: "parent",
				name: "id",
				type: "text",
				notNull: true,
				primaryKey: true,
				default: null,
				generated: null,
				identity: null,
			},
			{
				table: "parent",
				name: "label",
				type: "text",
				notNull: true,
				primaryKey: false,
				default: null,
				generated: null,
				identity: null,
			},
			{
				table: "child",
				name: "id",
				type: "text",
				notNull: true,
				primaryKey: true,
				default: null,
				generated: null,
				identity: null,
			},
			{
				table: "child",
				name: "parent_id",
				type: "text",
				notNull: false,
				primaryKey: false,
				default: null,
				generated: null,
				identity: null,
			},
			{
				table: "child",
				name: "kind",
				type: "text",
				notNull: true,
				primaryKey: false,
				default: "'narrator'::text",
				generated: null,
				identity: null,
			},
			{
				table: "child",
				name: "retries",
				type: "integer",
				notNull: true,
				primaryKey: false,
				default: "0",
				generated: null,
				identity: null,
			},
			{
				table: "child",
				name: "flagged",
				type: "boolean",
				notNull: true,
				primaryKey: false,
				default: "false",
				generated: null,
				identity: null,
			},
			{
				table: "child",
				name: "size",
				type: "bigint",
				notNull: false,
				primaryKey: false,
				default: null,
				generated: null,
				identity: null,
			},
			{
				table: "child",
				name: "created_at",
				type: "text",
				notNull: true,
				primaryKey: false,
				default: null,
				generated: null,
				identity: null,
			},
			{
				table: "child",
				name: "pending",
				type: "integer",
				notNull: false,
				primaryKey: false,
				default: null,
				generated: { as: CANONICAL_GENERATED, stored: true },
				identity: null,
			},
		],
		foreignKeys: [
			{
				name: "child_parent_id_parent_id_fk",
				tableFrom: "child",
				tableTo: "parent",
				columnsFrom: ["parent_id"],
				columnsTo: ["id"],
				onDelete: "cascade",
				onUpdate: "no action",
				columnCount: 1,
				refColumnCount: 1,
			},
		],
		indexes: [
			{
				table: "child",
				name: "idx_child_created",
				columns: ["created_at", "id"],
				options: [0, 0],
				isUnique: false,
				method: "btree",
				where: null,
				keyColumnCount: 2,
				totalColumnCount: 2,
				nullsNotDistinct: false,
				constraintBacked: false,
			},
			{
				table: "child",
				name: "idx_child_pending",
				columns: ["id"],
				options: [0],
				isUnique: true,
				method: "btree",
				where: CANONICAL_PREDICATE,
				keyColumnCount: 1,
				totalColumnCount: 1,
				nullsNotDistinct: false,
				constraintBacked: false,
			},
			{
				table: "parent",
				name: "parent_label_unique",
				columns: ["label"],
				options: [0],
				isUnique: true,
				method: "btree",
				where: null,
				keyColumnCount: 1,
				totalColumnCount: 1,
				nullsNotDistinct: false,
				constraintBacked: true,
			},
		],
		uniques: [
			{
				table: "parent",
				name: "parent_label_unique",
				columns: ["label"],
				nullsNotDistinct: false,
				columnCount: 1,
			},
		],
		checks: [{ table: "child", name: "ck_child_retries", definition: CANONICAL_CHECK }],
		generated: [
			{ table: "child", name: "pending", kind: "s", as: CANONICAL_GENERATED, type: "integer" },
		],
		sequences: [],
	};
	const counts = {
		tables: 2,
		columns: 10,
		foreignKeys: 1,
		uniqueConstraints: 1,
		checkConstraints: 1,
		primaryKeys: 2,
		indexes: 3,
		partialIndexes: 1,
		uniqueIndexes: 2,
		generatedColumns: 1,
		identityColumns: 0,
		sequences: 0,
		bigintColumns: 1,
		booleanColumns: 1,
		nonTableRelations: 0,
	};
	return { expected: built.expected, catalog, canonical, counts };
}

const compare = (mutate: (state: ReturnType<typeof fixture>) => void = () => {}): string[] => {
	const state = fixture();
	mutate(state);
	return compareBaseline(state.expected, state.catalog, state.canonical, state.counts);
};

/** Deep clone so a mutation cannot leak into the next case through a shared reference. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("the baseline fixture agrees with itself", () => {
	it("reports no problems for a faithful catalog", () => {
		expect(compare()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------
// Defect 1: index key columns from a mis-bound WITH ORDINALITY join
// ---------------------------------------------------------------------------------------

describe("index key columns", () => {
	// The mis-bound join returned the table's leading columns in attnum order, so the
	// symptom is a wrong-but-plausible list. The correct binding is asserted against a live
	// server in pg-baseline.test.ts; here the reaction to a wrong list is pinned.
	it("reports the swapped-ordinality column list instead of accepting it", () => {
		const problems = compare((state) => {
			const index = state.catalog.indexes[0];
			// Exactly what `u(n, attnum)` produced for idx_acl_event_created: the first columns
			// of the table rather than the index's own keys.
			index.columns = ["id", "parent_id"];
		});
		expect(problems).toEqual([expect.stringContaining("index child.idx_child_created: expected")]);
		expect(problems[0]).toContain('"created_at","id"');
		expect(problems[0]).toContain('"id","parent_id"');
	});

	it("reports a key column the join failed to resolve", () => {
		expect(
			compare((state) => {
				state.catalog.indexes[0].columns = ["created_at"];
			}),
		).toEqual([
			expect.stringContaining("index child.idx_child_created: expected"),
			"index child.idx_child_created: 1 of 2 columns resolved",
		]);
	});

	it("reports reordered key columns", () => {
		expect(
			compare((state) => {
				state.catalog.indexes[0].columns = ["id", "created_at"];
			}),
		).toEqual([expect.stringContaining("index child.idx_child_created: expected")]);
	});

	it("reports DESC or NULLS FIRST ordering it cannot express", () => {
		expect(
			compare((state) => {
				state.catalog.indexes[0].options = [0, 1];
			}),
		).toEqual(["index child.idx_child_created: non-default key ordering [0,1]"]);
	});

	it("reports INCLUDE columns it cannot express", () => {
		expect(
			compare((state) => {
				state.catalog.indexes[0].totalColumnCount = 3;
				state.catalog.indexes[0].columns = ["created_at", "id", "label"];
			}),
		).toEqual([
			expect.stringContaining("index child.idx_child_created: expected"),
			"index child.idx_child_created: INCLUDE columns are not covered by this gate",
		]);
	});

	it("keeps the value first in every catalog ordinality join", () => {
		// A regression guard on the SQL itself: `u(n, attnum)` is the broken binding.
		for (const body of Object.values(CATALOG_FACETS)) {
			expect(body).not.toContain("u(n, attnum)");
			expect(body).not.toContain("u(n,attnum)");
		}
		expect(CATALOG_FACETS.indexes).toContain("WITH ORDINALITY u(attnum, n)");
	});
});

// ---------------------------------------------------------------------------------------
// Defect 2: an unquoted JSON alias folded to lower case, so foreign keys read as absent
// ---------------------------------------------------------------------------------------

describe("foreign keys", () => {
	it("reports a dropped foreign key rather than reading zero of them", () => {
		expect(
			compare((state) => {
				state.catalog.foreignKeys = [];
				state.counts.foreignKeys = 0;
			}),
		).toEqual([
			"foreign key child_parent_id_parent_id_fk: missing from the server",
			"count foreignKeys: expected 1, server reported 0",
		]);
	});

	it("cannot read an absent facet as agreement", () => {
		// The folded-alias defect surfaced as `undefined` where the rows should be. A facet
		// that returns nothing must fail on the server's own count, not pass silently.
		const problems = compare((state) => {
			state.catalog.foreignKeys = [];
		});
		expect(problems).toEqual(["foreign key child_parent_id_parent_id_fk: missing from the server"]);
	});

	it("reports a changed referential action", () => {
		expect(
			compare((state) => {
				state.catalog.foreignKeys[0].onDelete = "no action";
			}),
		).toEqual([expect.stringContaining("foreign key child_parent_id_parent_id_fk: expected")]);
	});

	it("reports a foreign key the server has but nobody committed", () => {
		expect(
			compare((state) => {
				state.catalog.foreignKeys.push({
					...clone(state.catalog.foreignKeys[0]),
					name: "extra_fk",
				});
				state.counts.foreignKeys = 2;
			}),
		).toEqual([
			"foreign key extra_fk: present on the server, not committed",
			"count foreignKeys: expected 1, server reported 2",
		]);
	});

	it("reports a column list the aggregate could not fully resolve", () => {
		expect(
			compare((state) => {
				state.catalog.foreignKeys[0].columnsTo = [];
			}),
		).toEqual([
			expect.stringContaining("foreign key child_parent_id_parent_id_fk: expected"),
			"foreign key child_parent_id_parent_id_fk: 0 of 1 referenced columns resolved",
		]);
	});

	it("quotes every camelCase JSON alias in the facet queries", () => {
		for (const [name, body] of Object.entries(CATALOG_FACETS)) {
			expect(body, name).toContain('AS "j"');
			expect(body, name).toContain('AS "k"');
			expect(body, name).not.toMatch(/AS [a-z]+[A-Z]/);
		}
	});

	it("counts facet fields so a folded key cannot become undefined", () => {
		// One field short of the declared width: reported, not parsed into undefined.
		const parsed = parseCatalog({
			tables: [["child"]],
			columns: [],
			foreignKeys: [["child", "fk", "parent", ["parent_id"], ["id"], 1, 1, "c"]],
			indexes: [],
			uniques: [],
			checks: [],
			generated: [],
			sequences: [],
		});
		expect(parsed.problems).toEqual([
			expect.stringContaining(`facet foreignKeys: expected ${FACET_WIDTHS.foreignKeys} fields`),
			// The shift also makes the referential actions unreadable, which is reported too:
			// a folded key cannot end up as a plausible-looking "no action".
			'foreign key fk: unknown action ["c",null]',
		]);
	});
});

// ---------------------------------------------------------------------------------------
// Defect 3: snapshot index columns are objects, so String() gave "[object Object]"
// ---------------------------------------------------------------------------------------

describe("snapshot index columns", () => {
	it("reads the column name out of the expression field", () => {
		const built = buildExpected(snapshot());
		expect(built.problems).toEqual([]);
		const index = built.expected.indexes.find((i) => i.name === "idx_child_created");
		expect(index?.columns).toEqual(["created_at", "id"]);
	});

	it("never produces the stringified object that used to compare against every name", () => {
		const built = buildExpected(snapshot());
		for (const index of built.expected.indexes) {
			expect(index.columns.join(",")).not.toContain("[object Object]");
		}
	});

	it("reports an expression key it cannot express instead of naming it", () => {
		const tampered = snapshot();
		childIndex(tampered).columns = [
			{ expression: "lower(created_at)", isExpression: true, asc: true, nulls: "last" },
		];
		const built = buildExpected(tampered);
		expect(built.problems).toEqual([
			"index child.idx_child_created: expression keys are not covered (lower(created_at))",
			"index child.idx_child_created: no key columns",
		]);
	});

	it("reports DESC or NULLS FIRST in the snapshot", () => {
		const tampered = snapshot();
		childIndex(tampered).columns[0].asc = false;
		expect(buildExpected(tampered).problems).toEqual([
			expect.stringContaining("index child.idx_child_created: only ASC/NULLS LAST is covered"),
		]);
	});

	it("reports an unreadable column entry", () => {
		const tampered = snapshot();
		// A bare string where the object belongs: the shape that used to stringify to
		// "[object Object]" is not the only malformed shape possible.
		childIndex(tampered).columns = ["created_at"] as unknown as SnapshotIndexColumn[];
		expect(buildExpected(tampered).problems).toEqual([
			"index child.idx_child_created: unreadable column entry created_at",
			"index child.idx_child_created: no key columns",
		]);
	});
});

// ---------------------------------------------------------------------------------------
// Defect 4: migration bookkeeping asserted against a guessed row count and a replay
// ---------------------------------------------------------------------------------------

describe("migration ledger", () => {
	const entries = [
		{ tag: "0000_first", when: 1_000 },
		{ tag: "0001_second", when: 2_000 },
	];
	const hashes = ["aaa", "bbb"];
	const rows = [
		{ id: 1, hash: "aaa", created_at: "1000" },
		{ id: 2, hash: "bbb", created_at: "2000" },
	];

	it("accepts one row per journal entry", () => {
		expect(checkMigrationLedger(entries, hashes, rows)).toEqual([]);
	});

	it("follows the journal length instead of a fixed number", () => {
		// The one-entry journal that actually exists: a hard-coded "2" could never hold.
		expect(checkMigrationLedger([entries[0]], [hashes[0]], [rows[0]])).toEqual([]);
		expect(checkMigrationLedger([entries[0]], [hashes[0]], rows)).toEqual([
			"ledger: 2 rows recorded for 1 journal entries",
			"ledger: row 2 records an unknown migration hash",
		]);
	});

	it("reports a migration the ledger never recorded", () => {
		expect(checkMigrationLedger(entries, hashes, [rows[0]])).toEqual([
			"ledger: 1 rows recorded for 2 journal entries",
			"ledger: no row for 0001_second (hash bbb…)",
		]);
	});

	it("reports a hash that does not match the file on disk", () => {
		expect(checkMigrationLedger(entries, hashes, [rows[0], { ...rows[1], hash: "zzz" }])).toEqual([
			"ledger: no row for 0001_second (hash bbb…)",
			"ledger: row 2 records an unknown migration hash",
		]);
	});

	it("reports a timestamp that disagrees with the journal", () => {
		expect(
			checkMigrationLedger(entries, hashes, [rows[0], { ...rows[1], created_at: "9999" }]),
		).toEqual(["ledger: 0001_second recorded at 9999, journal says 2000"]);
	});

	it("reports an empty ledger", () => {
		expect(checkMigrationLedger(entries, hashes, [])).toEqual([
			"ledger: 0 rows recorded for 2 journal entries",
			"ledger: no row for 0000_first (hash aaa…)",
			"ledger: no row for 0001_second (hash bbb…)",
		]);
	});

	it("reports an empty journal rather than passing vacuously", () => {
		expect(checkMigrationLedger([], [], [])).toEqual(["journal has no entries"]);
	});
});

describe("migration script assembly", () => {
	it("terminates the migrator's unterminated bookkeeping INSERT", () => {
		expect(migrationScript(["CREATE TABLE a (id text);", "  ", "INSERT INTO m VALUES ('h')"])).toBe(
			"CREATE TABLE a (id text);\nINSERT INTO m VALUES ('h');",
		);
	});

	it("keeps every statement, so a partial apply cannot look complete", () => {
		const queries = ["SELECT 1;", "SELECT 2;", "SELECT 3;"];
		expect(
			migrationScript(queries)
				.split(";")
				.filter((s) => s.trim()).length,
		).toBe(3);
	});
});

describe("psql proxy callback", () => {
	it("wraps reads in json_agg and returns objects", async () => {
		const seen: string[] = [];
		const callback = psqlProxyCallback(async (sql) => {
			seen.push(sql);
			return { code: 0, stdout: '[{"a":1}]', stderr: "" };
		});
		expect(await callback("SELECT a FROM t", [])).toEqual({ rows: [{ a: 1 }] });
		expect(seen[0]).toContain("json_agg");
	});

	it("passes DDL through verbatim", async () => {
		const seen: string[] = [];
		const callback = psqlProxyCallback(async (sql) => {
			seen.push(sql);
			return { code: 0, stdout: "", stderr: "" };
		});
		expect(await callback("CREATE TABLE a (id text);", [])).toEqual({ rows: [] });
		expect(seen[0]).toBe("CREATE TABLE a (id text)");
	});

	it("throws instead of reporting an empty result when psql fails", async () => {
		const callback = psqlProxyCallback(async () => ({ code: 3, stdout: "", stderr: "boom" }));
		await expect(callback("SELECT 1", [])).rejects.toThrow(/psql failed \(3\)/);
	});
});

// ---------------------------------------------------------------------------------------
// Default normalization: notational only
// ---------------------------------------------------------------------------------------

describe("normDefault", () => {
	it("erases a cast to the column's own type", () => {
		expect(normDefault("text", "'narrator'::text")).toBe("'narrator'");
		expect(normDefault("text", "'narrator'")).toBe("'narrator'");
		expect(normDefault("text", "'a'::text::text")).toBe("'a'");
	});

	it("unquotes a numeric literal only for a numeric column", () => {
		expect(normDefault("integer", "'0'")).toBe("0");
		expect(normDefault("double precision", "'-1.5e3'")).toBe("-1.5e3");
		expect(normDefault("text", "'0'")).toBe("'0'");
	});

	it("keeps a cast to any other type, because that IS a different default", () => {
		expect(normDefault("text", "'{}'::jsonb")).toBe("'{}'::jsonb");
		expect(normDefault("text", "'{}'::jsonb")).not.toBe(normDefault("text", "'{}'"));
		expect(normDefault("integer", "0::bigint")).toBe("0::bigint");
	});

	it("never rewrites anything inside quotes", () => {
		expect(normDefault("text", "'a::text'")).toBe("'a::text'");
		expect(normDefault("text", "'::text'")).toBe("'::text'");
	});

	it("does not conflate different values, empty string, or absence", () => {
		expect(normDefault("text", "'a'")).not.toBe(normDefault("text", "'b'"));
		expect(normDefault("text", "''::text")).toBe("''");
		expect(normDefault("text", "''")).not.toBe(normDefault("text", null));
		expect(normDefault("text", null)).toBeNull();
		expect(normDefault("boolean", "false")).not.toBe(normDefault("boolean", "true"));
		expect(normDefault("integer", "0")).not.toBe(normDefault("integer", "1"));
	});

	it("does not turn a function default into a literal", () => {
		expect(normDefault("text", "now()::text")).toBe("now()");
		expect(normDefault("text", "now()")).toBe("now()");
		expect(normDefault("text", "gen_random_uuid()::text")).not.toBe("'gen_random_uuid()'");
	});
});

describe("column comparison", () => {
	it("accepts the server's cast form of a committed text default", () => {
		expect(compare()).toEqual([]);
	});

	it("reports a default the server changed", () => {
		const problems = compare((state) => {
			find(state.catalog.columns, (c) => c.name === "kind", "column").default = "'tampered'::text";
		});
		expect(problems).toEqual([expect.stringContaining("column child.kind: expected")]);
	});

	it("reports a default that was dropped entirely", () => {
		expect(
			compare((state) => {
				find(state.catalog.columns, (c) => c.name === "retries", "column").default = null;
			}),
		).toEqual([expect.stringContaining("column child.retries: expected")]);
	});

	it("reports a flipped boolean default", () => {
		expect(
			compare((state) => {
				find(state.catalog.columns, (c) => c.name === "flagged", "column").default = "true";
			}),
		).toEqual([expect.stringContaining("column child.flagged: expected")]);
	});

	it("reports a widened or narrowed type", () => {
		expect(
			compare((state) => {
				find(state.catalog.columns, (c) => c.name === "size", "column").type = "integer";
				state.counts.bigintColumns = 0;
			}),
		).toEqual([
			expect.stringContaining("column child.size: expected"),
			"count bigintColumns: expected 1, server reported 0",
		]);
	});

	it("reports a boolean column that arrived as integer", () => {
		expect(
			compare((state) => {
				find(state.catalog.columns, (c) => c.name === "flagged", "column").type = "integer";
				state.counts.booleanColumns = 0;
			}),
		).toEqual([
			expect.stringContaining("column child.flagged: expected"),
			"count booleanColumns: expected 1, server reported 0",
		]);
	});

	it("reports a dropped NOT NULL and a lost primary key", () => {
		expect(
			compare((state) => {
				find(state.catalog.columns, (c) => c.name === "kind", "column").notNull = false;
			}),
		).toEqual([expect.stringContaining("column child.kind: expected")]);
		expect(
			compare((state) => {
				find(
					state.catalog.columns,
					(c) => c.table === "child" && c.name === "id",
					"column",
				).primaryKey = false;
				state.counts.primaryKeys = 1;
			}),
		).toEqual([
			expect.stringContaining("column child.id: expected"),
			"count primaryKeys: expected 2, server reported 1",
		]);
	});

	it("reports a reordered table even when every column is still present", () => {
		const problems = compare((state) => {
			const columns = state.catalog.columns;
			const kind = columns.findIndex((c) => c.name === "kind");
			const retries = columns.findIndex((c) => c.name === "retries");
			[columns[kind], columns[retries]] = [columns[retries], columns[kind]];
		});
		expect(problems).toEqual([expect.stringContaining("table child: column order")]);
	});

	it("reports a missing table and an uncommitted one", () => {
		expect(
			compare((state) => {
				state.catalog.tables = ["parent", "child", "surprise"];
				state.counts.tables = 3;
			}),
		).toEqual([
			"table surprise: present on the server, not committed",
			"count tables: expected 2, server reported 3",
		]);
		expect(
			compare((state) => {
				state.catalog.tables = ["parent"];
				state.counts.tables = 1;
			}),
		).toEqual([
			"table child: missing from the server",
			"count tables: expected 2, server reported 1",
		]);
	});
});

describe("generated columns", () => {
	it("reports a generated column that became an ordinary one", () => {
		expect(
			compare((state) => {
				find(state.catalog.columns, (c) => c.name === "pending", "column").generated = null;
				state.catalog.generated = [];
				state.counts.generatedColumns = 0;
			}),
		).toEqual([
			expect.stringContaining("column child.pending: expected"),
			expect.stringContaining("generated child.pending: expected"),
			"generated column child.pending: missing from the server",
			"count generatedColumns: expected 1, server reported 0",
		]);
	});

	it("reports a changed generation expression", () => {
		expect(
			compare((state) => {
				find(state.catalog.columns, (c) => c.name === "pending", "column").generated = {
					as: "CASE WHEN (kind = 'other'::text) THEN 1 ELSE 0 END",
					stored: true,
				};
			}),
		).toEqual([expect.stringContaining("generated child.pending: expected")]);
	});

	it("refuses to compare when the server produced no canonical form", () => {
		expect(
			compare((state) => {
				state.canonical.delete(
					deparseKey("generated", "child", "(CASE WHEN \"kind\" = 'narrator' THEN 1 ELSE 0 END)"),
				);
			}),
		).toEqual(["generated child.pending: no canonical form available"]);
	});

	it("reports a VIRTUAL generated column the snapshot declares", () => {
		const tampered = snapshot();
		childColumn(tampered, "pending").generated = { as: "1", type: "virtual" };
		expect(buildExpected(tampered).problems).toEqual([
			"column child.pending: only STORED generated columns are covered (virtual)",
		]);
	});

	it("does not mistake a generation expression for a default", () => {
		const parsed = parseCatalog({
			tables: [["child"]],
			columns: [["child", "pending", "integer", false, false, "CASE WHEN 1 THEN 1 END", "s", null]],
			foreignKeys: [],
			indexes: [],
			uniques: [],
			checks: [],
			generated: [],
			sequences: [],
		});
		expect(parsed.problems).toEqual([]);
		expect(parsed.catalog.columns[0].default).toBeNull();
		expect(parsed.catalog.columns[0].generated).toEqual({
			as: "CASE WHEN 1 THEN 1 END",
			stored: true,
		});
	});
});

describe("partial indexes and unique constraints", () => {
	it("reports a predicate the server no longer has", () => {
		expect(
			compare((state) => {
				find(state.catalog.indexes, (i) => i.name === "idx_child_pending", "index").where = null;
				state.counts.partialIndexes = 0;
			}),
		).toEqual([
			expect.stringContaining("index child.idx_child_pending: expected"),
			"count partialIndexes: expected 1, server reported 0",
		]);
	});

	it("reports a predicate that was narrowed", () => {
		expect(
			compare((state) => {
				find(state.catalog.indexes, (i) => i.name === "idx_child_pending", "index").where =
					"((pending = 1) AND (kind = 'narrator'::text))";
			}),
		).toEqual([expect.stringContaining("index child.idx_child_pending: expected")]);
	});

	it("reports a unique index that lost its uniqueness", () => {
		expect(
			compare((state) => {
				find(state.catalog.indexes, (i) => i.name === "idx_child_pending", "index").isUnique =
					false;
				state.counts.uniqueIndexes = 1;
			}),
		).toEqual([
			expect.stringContaining("index child.idx_child_pending: expected"),
			"count uniqueIndexes: expected 2, server reported 1",
		]);
	});

	it("expects the index PostgreSQL creates for a UNIQUE constraint", () => {
		// Dropping only the constraint leaves the model expecting both, so both are reported.
		expect(
			compare((state) => {
				state.catalog.uniques = [];
				state.catalog.indexes = state.catalog.indexes.filter(
					(i) => i.name !== "parent_label_unique",
				);
				state.counts.uniqueConstraints = 0;
				state.counts.indexes = 2;
				state.counts.uniqueIndexes = 1;
			}),
		).toEqual([
			"index parent.parent_label_unique: missing from the server",
			"unique constraint parent_label_unique: missing from the server",
			"count uniqueConstraints: expected 1, server reported 0",
			"count indexes: expected 3, server reported 2",
			"count uniqueIndexes: expected 2, server reported 1",
		]);
	});

	it("reports a unique constraint replaced by a plain index of the same name", () => {
		expect(
			compare((state) => {
				state.catalog.uniques = [];
				find(
					state.catalog.indexes,
					(i) => i.name === "parent_label_unique",
					"index",
				).constraintBacked = false;
				state.counts.uniqueConstraints = 0;
			}),
		).toEqual([
			expect.stringContaining("index parent.parent_label_unique: expected"),
			"unique constraint parent_label_unique: missing from the server",
			"count uniqueConstraints: expected 1, server reported 0",
		]);
	});

	it("reports NULLS NOT DISTINCT, which changes what the constraint permits", () => {
		expect(
			compare((state) => {
				state.catalog.uniques[0].nullsNotDistinct = true;
				find(
					state.catalog.indexes,
					(i) => i.name === "parent_label_unique",
					"index",
				).nullsNotDistinct = true;
			}),
		).toEqual([
			expect.stringContaining("index parent.parent_label_unique: expected"),
			expect.stringContaining("unique constraint parent_label_unique: expected"),
		]);
	});

	it("reports a check constraint the server weakened", () => {
		expect(
			compare((state) => {
				state.catalog.checks[0].definition = "CHECK ((retries >= '-1'::integer))";
			}),
		).toEqual([expect.stringContaining("check constraint ck_child_retries: expected")]);
	});

	it("refuses to compare a predicate with no canonical form", () => {
		expect(
			compare((state) => {
				state.canonical.delete(deparseKey("predicate", "child", '"pending" = 1'));
			}),
		).toEqual([expect.stringContaining("index child.idx_child_pending: expected")]);
	});
});

// ---------------------------------------------------------------------------------------
// Server-side counts and shapes the gate refuses to guess about
// ---------------------------------------------------------------------------------------

describe("landmarks", () => {
	it("reports a count the server never returned", () => {
		expect(
			compare((state) => {
				delete (state.counts as Record<string, number | undefined>).columns;
			}),
		).toEqual(["count columns: server reported nothing"]);
	});

	it("reports a column count that disagrees with the dumped rows", () => {
		expect(
			compare((state) => {
				state.counts.columns = 9;
			}),
		).toEqual(["count columns: expected 10, server reported 9"]);
	});

	it("reports views or other relations that appeared in public", () => {
		expect(
			compare((state) => {
				state.counts.nonTableRelations = 2;
			}),
		).toEqual(["public schema holds 2 relations that are neither tables nor indexes"]);
	});

	it("accepts the native number and boolean defaults Drizzle actually writes", () => {
		// Drizzle quotes a text default but writes a numeric or boolean one as a JSON literal;
		// both stringify to the exact SQL PostgreSQL reports.
		const tampered = snapshot();
		childColumn(tampered, "retries").default = 0;
		childColumn(tampered, "flagged").default = false;
		const built = buildExpected(tampered);
		expect(built.problems).toEqual([]);
		expect(
			built.expected.columns
				.filter((c) => ["retries", "flagged"].includes(c.name))
				.map((c) => c.default),
		).toEqual(["0", "false"]);
	});

	it("reports a default that is not a SQL literal at all", () => {
		const tampered = snapshot();
		childColumn(tampered, "retries").default = { raw: 0 };
		expect(buildExpected(tampered).problems).toEqual([
			'column child.retries: default is not a SQL literal ({"raw":0})',
		]);
	});

	it("reports snapshot sections the gate does not cover", () => {
		const tampered = snapshot();
		tampered.enums = { mood: {} };
		tampered.views = { v: {} };
		expect(buildExpected(tampered).problems).toEqual([
			"snapshot enums are not covered by this gate (1)",
			"snapshot views are not covered by this gate (1)",
		]);
	});

	it("reports a composite primary key it cannot express", () => {
		const tampered = snapshot();
		childTable(tampered).compositePrimaryKeys = { pk: { columns: ["id", "kind"] } };
		expect(buildExpected(tampered).problems).toEqual([
			"table child: composite primary keys are not covered",
		]);
	});

	it("reports a non-btree index method", () => {
		const tampered = snapshot();
		childIndex(tampered).method = "hash";
		expect(buildExpected(tampered).problems).toEqual([
			"index child.idx_child_created: only btree is covered (hash)",
		]);
	});

	it("reports index storage parameters", () => {
		const tampered = snapshot();
		childIndex(tampered).with = { fillfactor: 70 };
		expect(buildExpected(tampered).problems).toEqual([
			"index child.idx_child_created: storage parameters are not covered",
		]);
	});

	it("reports an empty snapshot instead of trivially agreeing", () => {
		expect(buildExpected({ tables: {} }).problems).toEqual(["snapshot has no tables"]);
	});
});

// ---------------------------------------------------------------------------------------
// Paged transport
// ---------------------------------------------------------------------------------------

describe("facet paging", () => {
	const rowsOf = (n: number) =>
		Array.from({ length: n }, (_, i) => JSON.stringify([`t${i}`])).join("\n");

	it("reads every page and agrees with the server's row count", async () => {
		const result = await dumpFacet(
			async (sql) => ({
				code: 0,
				stdout: sql.includes("count(*)") ? "5 1" : rowsOf(sql.includes("= 0") ? 3 : 2),
				stderr: "",
			}),
			"tables",
			CATALOG_FACETS.tables,
		);
		expect(result.problems).toEqual([]);
		expect(result.rows).toHaveLength(5);
	});

	it("reports a page that went missing rather than shrinking the comparison", async () => {
		const result = await dumpFacet(
			async (sql) => ({
				code: 0,
				stdout: sql.includes("count(*)") ? "5 1" : sql.includes("= 0") ? rowsOf(3) : "",
				stderr: "",
			}),
			"tables",
			CATALOG_FACETS.tables,
		);
		expect(result.problems).toEqual(["facet tables: read 3 rows, server reported 5"]);
	});

	it("reports a failed page instead of returning a partial dump as complete", async () => {
		const result = await dumpFacet(
			async (sql) =>
				sql.includes("count(*)")
					? { code: 0, stdout: "2 0", stderr: "" }
					: { code: 3, stdout: "", stderr: "output limit" },
			"tables",
			CATALOG_FACETS.tables,
		);
		expect(result.problems).toEqual([expect.stringContaining("facet tables: page 0 failed")]);
	});

	it("reports unreadable output rather than parsing around it", async () => {
		const result = await dumpFacet(
			async (sql) => ({
				code: 0,
				stdout: sql.includes("count(*)") ? "1 0" : "not json",
				stderr: "",
			}),
			"tables",
			CATALOG_FACETS.tables,
		);
		expect(result.problems).toEqual([expect.stringContaining("facet tables: unreadable row")]);
	});

	it("reports a count query that failed", async () => {
		const result = await dumpFacet(
			async () => ({ code: 1, stdout: "", stderr: "boom" }),
			"tables",
			CATALOG_FACETS.tables,
		);
		expect(result.problems).toEqual([expect.stringContaining("facet tables: count query failed")]);
		expect(result.rows).toEqual([]);
	});

	it("asks for no pages when a facet is legitimately empty", async () => {
		const calls: string[] = [];
		const result = await dumpFacet(
			async (sql) => {
				calls.push(sql);
				return { code: 0, stdout: "0 0", stderr: "" };
			},
			"checks",
			CATALOG_FACETS.checks,
		);
		expect(result.problems).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it("keeps the page window inside the harness output budget", () => {
		expect(facetMetaSql(CATALOG_FACETS.columns)).toContain("10000");
	});
});

// ---------------------------------------------------------------------------------------
// Canonicalization plumbing
// ---------------------------------------------------------------------------------------

describe("identity and incremental column order", () => {
	const identityFixture = () => {
		const source = snapshot();
		childTable(source).columns.insert_seq = {
			name: "insert_seq",
			type: "bigint",
			primaryKey: false,
			notNull: true,
			identity: { type: "byDefault", name: "child_insert_seq_seq", schema: "public" },
		};
		const built = buildExpected(source);
		expect(built.problems).toEqual([]);
		const state = fixture();
		state.expected = built.expected;
		const added = built.expected.columns.find((column) => column.name === "insert_seq");
		if (!added) throw new Error("identity fixture column missing");
		state.catalog.columns.push(structuredClone(added));
		state.catalog.sequences = structuredClone(built.expected.sequences);
		state.counts = { ...built.expected.counts, nonTableRelations: 0 };
		return state;
	};
	const diff = (change: (state: ReturnType<typeof identityFixture>) => void) => {
		const state = identityFixture();
		change(state);
		return compareBaseline(state.expected, state.catalog, state.canonical, state.counts);
	};
	it("compares a BY DEFAULT identity without inventing a pg_attrdef default", () => {
		expect(diff(() => {})).toEqual([]);
		expect(identityFixture().expected.columns.at(-1)?.default).toBeNull();
	});
	it("detects lost identity and ALWAYS replacing BY DEFAULT", () => {
		for (const type of [null, "always"] as const) {
			expect(
				diff((state) => {
					const column = state.catalog.columns.at(-1);
					if (!column) throw new Error("fixture missing");
					column.identity = type ? { type, sequenceName: "child_insert_seq_seq" } : null;
				}).join("\n"),
			).toContain("column child.insert_seq: expected");
		}
	});
	it("detects a missing backing sequence", () => {
		expect(
			diff((state) => {
				state.catalog.sequences = [];
			}).join("\n"),
		).toContain("sequence child_insert_seq_seq: missing");
	});
	it("detects changed sequence ownership, increment, cache and bigint bound", () => {
		for (const field of ["ownerColumn", "increment", "cache", "max"] as const) {
			expect(
				diff((state) => {
					state.catalog.sequences[0][field] = "changed";
				}).join("\n"),
			).toContain("sequence child_insert_seq_seq: expected");
		}
	});
	it("replays ADD COLUMN append order across later unchanged snapshots", () => {
		const old = snapshot();
		const next = snapshot();
		const table = childTable(next);
		table.columns = {
			insert_seq: { name: "insert_seq", type: "bigint", notNull: true, primaryKey: false },
			...table.columns,
		};
		const expected = [...Object.keys(childTable(old).columns), "insert_seq"];
		const built = buildExpected(next, [old, next]);
		expect(built.problems).toEqual([]);
		expect(built.expected.columnOrder.get("child")).toEqual(expected);
	});
});

describe("expression canonicalization", () => {
	it("asks the server about every distinct expression, in the owning table", () => {
		const built = buildExpected(snapshot());
		const requests = deparseRequests(built.expected);
		expect(requests.map((r) => `${r.kind}:${r.table}`)).toEqual([
			"predicate:child",
			"check:child",
			"generated:child",
		]);
		const script = buildDeparseScript(requests);
		// Predicates may reference a generated column, so the scratch copy must include them.
		expect(script).toContain('LIKE public."child" INCLUDING GENERATED');
		expect(script).toContain('WHERE "pending" = 1');
		expect(script).toContain("GENERATED ALWAYS AS");
		// It must never touch the schema it is validating.
		expect(script).not.toMatch(/ALTER TABLE public\./);
		expect(script).not.toMatch(/CREATE INDEX \S+ ON public\./);
	});

	it("does not use a generated column as an index key for the scratch copy", () => {
		const built = buildExpected(snapshot());
		const requests = deparseRequests(built.expected);
		const predicate = requests.find((r) => r.kind === "predicate");
		expect(predicate && "keyColumn" in predicate ? predicate.keyColumn : null).toBe("id");
	});

	it("reports an expression the server never answered about", () => {
		const requests = deparseRequests(buildExpected(snapshot()).expected);
		const parsed = parseDeparseOutput(requests, JSON.stringify(["nf_pred_1", "(pending = 1)"]));
		expect(parsed.canonical.size).toBe(1);
		expect(parsed.problems).toEqual([
			"deparse: server returned nothing for check on child",
			"deparse: server returned nothing for generated on child",
		]);
	});

	it("reports unreadable canonicalization output", () => {
		const parsed = parseDeparseOutput([], "not json");
		expect(parsed.problems).toEqual(["deparse: unreadable row not json"]);
	});
});
