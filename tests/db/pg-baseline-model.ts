/**
 * The PostgreSQL baseline model: what `drizzle-postgres` promises, what a real server has,
 * and how the two are compared.
 *
 * Split out of `pg-baseline.test.ts` so every comparison rule is a pure function the
 * negative tests can feed tampered input to. The container test wires these together and
 * owns no comparison logic of its own.
 *
 * Rules that shape everything here:
 *
 *  - **Expressions are never normalized by hand.** Index predicates, CHECK bodies and
 *    generated expressions are committed as the text Drizzle emitted, while PostgreSQL
 *    reports its own deparsed form (`"a" is not null` becomes `(a IS NOT NULL)`). Rather
 *    than guess at that transformation, the expected text is fed back through the same
 *    server (`buildDeparseScript`) and the two deparsed strings are compared verbatim. A
 *    hand-written normalizer would have to be as clever as the deparser to avoid either
 *    false alarms or silently accepting a changed predicate.
 *  - **Only literal column defaults are normalized textually** (`normDefault`): they
 *    differ only by a cast to the column's own type and by quoting of numeric literals.
 *    Expression defaults use the server deparser at the actual target type, never a
 *    hand-written parenthesis/cast rewrite. Literal casts to other types remain distinct.
 *  - **A shape this model cannot represent is a problem, not a silent pass.** Expression
 *    index keys, DESC/NULLS FIRST ordering, non-btree methods, INCLUDE columns, composite
 *    primary keys, enums/views/standalone sequences/policies: none exist in this baseline, and
 *    any of them appearing is reported rather than dropped on the floor.
 */

/** Bytes of payload per `psql` page. The harness aborts a command past 16KiB of output. */
const PAGE_BUDGET = 10_000;
/** Hard cap on the pages of one facet, so a runaway query fails instead of looping. */
const MAX_PAGES = 200;
/** Problem strings stay short: they are read in a test report, not parsed. */
const PROBLEM_LIMIT = 400;

function clip(value: unknown): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	return text.length > PROBLEM_LIMIT ? `${text.slice(0, PROBLEM_LIMIT)}…` : text;
}

// ---------------------------------------------------------------------------------------
// Drizzle snapshot shapes (only the parts this gate reads)
// ---------------------------------------------------------------------------------------

export type SnapshotColumn = {
	name: string;
	type: string;
	notNull: boolean;
	primaryKey: boolean;
	default?: unknown;
	generated?: { as: string; type: string };
	identity?: {
		type: string;
		name?: string;
		schema?: string;
		increment?: string;
		minValue?: string;
		maxValue?: string;
		startWith?: string;
		cache?: string;
		cycle?: boolean;
	};
};
export type SnapshotIndexColumn = {
	expression: string;
	isExpression: boolean;
	asc: boolean;
	nulls?: string;
};
export type SnapshotIndex = {
	name: string;
	columns: SnapshotIndexColumn[];
	isUnique: boolean;
	method?: string;
	where?: string;
	with?: Record<string, unknown>;
};
export type SnapshotForeignKey = {
	name: string;
	tableFrom: string;
	tableTo: string;
	columnsFrom: string[];
	columnsTo: string[];
	onDelete: string;
	onUpdate: string;
};
export type SnapshotTable = {
	name: string;
	schema?: string;
	columns: Record<string, SnapshotColumn>;
	indexes?: Record<string, SnapshotIndex>;
	foreignKeys?: Record<string, SnapshotForeignKey>;
	uniqueConstraints?: Record<
		string,
		{ name: string; columns: string[]; nullsNotDistinct?: boolean }
	>;
	checkConstraints?: Record<string, { name: string; value: string }>;
	compositePrimaryKeys?: Record<string, unknown>;
	policies?: Record<string, unknown>;
	isRLSEnabled?: boolean;
};
export type Snapshot = {
	tables: Record<string, SnapshotTable>;
	enums?: Record<string, unknown>;
	sequences?: Record<string, unknown>;
	views?: Record<string, unknown>;
	roles?: Record<string, unknown>;
	policies?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------------------
// Expected model
// ---------------------------------------------------------------------------------------

export type ExpectedColumn = {
	table: string;
	name: string;
	type: string;
	notNull: boolean;
	primaryKey: boolean;
	default: string | null;
	/** `null` unless the column is GENERATED ALWAYS ... STORED. */
	generated: { as: string; stored: boolean } | null;
	/** `null` unless the column is GENERATED ... AS IDENTITY. */
	identity: { type: "always" | "byDefault"; sequenceName: string } | null;
};
export type ExpectedIndex = {
	table: string;
	name: string;
	columns: string[];
	isUnique: boolean;
	method: string;
	/** Raw snapshot predicate; canonicalized through the server before comparison. */
	where: string | null;
	/** True for the index PostgreSQL creates to back a UNIQUE constraint. */
	constraintBacked: boolean;
	nullsNotDistinct: boolean;
};
export type ExpectedUnique = {
	table: string;
	name: string;
	columns: string[];
	nullsNotDistinct: boolean;
};
export type ExpectedCheck = { table: string; name: string; value: string };
/**
 * The sequence backing an identity column. Values are compared as TEXT: seqmax for a
 * bigint identity is 9223372036854775807, past Number.MAX_SAFE_INTEGER, so reading it
 * as a JSON number would round it and compare unequal against itself.
 */
export type ExpectedSequence = {
	name: string;
	ownerTable: string;
	ownerColumn: string;
	start: string;
	increment: string;
	min: string;
	max: string;
	cache: string;
	cycle: boolean;
};

export type BaselineCounts = {
	tables: number;
	columns: number;
	foreignKeys: number;
	uniqueConstraints: number;
	checkConstraints: number;
	primaryKeys: number;
	indexes: number;
	partialIndexes: number;
	uniqueIndexes: number;
	generatedColumns: number;
	identityColumns: number;
	sequences: number;
	bigintColumns: number;
	booleanColumns: number;
};

export type Expected = {
	tables: string[];
	columns: ExpectedColumn[];
	foreignKeys: SnapshotForeignKey[];
	indexes: ExpectedIndex[];
	uniques: ExpectedUnique[];
	checks: ExpectedCheck[];
	sequences: ExpectedSequence[];
	/**
	 * Expected PHYSICAL column order per table. A fresh CREATE TABLE lays columns out in
	 * definition order, but an incremental migration's ADD COLUMN appends; the committed
	 * snapshot is always in definition order, so the physical expectation is replayed over
	 * the snapshot chain (see {@link buildExpected}'s `prior` argument).
	 */
	columnOrder: Map<string, string[]>;
	counts: BaselineCounts;
};

/**
 * Fold the committed snapshot into the flat model compared against the catalog.
 *
 * Problems are returned rather than thrown: a snapshot shape this gate cannot express is a
 * gap in the gate, and the caller must fail on it alongside real differences.
 *
 * `prior` is the snapshot chain BEFORE `snapshot` (0000, 0001, … in journal order). It is
 * used only to compute the expected PHYSICAL column order: columns added by an incremental
 * migration are appended by PostgreSQL, so "snapshot definition order" is the right answer
 * only for the baseline snapshot.
 */
export function buildExpected(
	snapshot: Snapshot,
	prior: Snapshot[] = [],
): { expected: Expected; problems: string[] } {
	const problems: string[] = [];
	const tables: string[] = [];
	const columns: ExpectedColumn[] = [];
	const foreignKeys: SnapshotForeignKey[] = [];
	const indexes: ExpectedIndex[] = [];
	const uniques: ExpectedUnique[] = [];
	const checks: ExpectedCheck[] = [];
	const sequences: ExpectedSequence[] = [];

	for (const section of ["enums", "sequences", "views", "roles", "policies"] as const) {
		const size = Object.keys(snapshot[section] ?? {}).length;
		if (size > 0) problems.push(`snapshot ${section} are not covered by this gate (${size})`);
	}
	if (Object.keys(snapshot.tables ?? {}).length === 0) problems.push("snapshot has no tables");

	for (const table of Object.values(snapshot.tables ?? {})) {
		if (table.schema) problems.push(`table ${table.name}: non-public schema ${table.schema}`);
		if (table.isRLSEnabled) problems.push(`table ${table.name}: RLS is not covered by this gate`);
		if (Object.keys(table.compositePrimaryKeys ?? {}).length > 0) {
			problems.push(`table ${table.name}: composite primary keys are not covered`);
		}
		if (Object.keys(table.policies ?? {}).length > 0) {
			problems.push(`table ${table.name}: policies are not covered`);
		}
		tables.push(table.name);
		for (const column of Object.values(table.columns)) {
			if (column.generated && column.generated.type !== "stored") {
				problems.push(
					`column ${table.name}.${column.name}: only STORED generated columns are covered (${clip(column.generated.type)})`,
				);
			}
			if (column.generated && column.identity) {
				problems.push(`column ${table.name}.${column.name}: both generated and identity`);
			}
			let identity: ExpectedColumn["identity"] = null;
			if (column.identity) {
				if (column.identity.type !== "always" && column.identity.type !== "byDefault") {
					problems.push(
						`column ${table.name}.${column.name}: unknown identity type ${clip(column.identity.type)}`,
					);
				} else if (!column.identity.name) {
					problems.push(`column ${table.name}.${column.name}: identity has no sequence name`);
				} else if (column.identity.schema && column.identity.schema !== "public") {
					problems.push(
						`column ${table.name}.${column.name}: identity sequence in non-public schema ${clip(column.identity.schema)}`,
					);
				} else {
					identity = {
						type: column.identity.type,
						sequenceName: column.identity.name,
					};
					sequences.push({
						name: column.identity.name,
						ownerTable: table.name,
						ownerColumn: column.name,
						start: column.identity.startWith ?? "1",
						increment: column.identity.increment ?? "1",
						min: column.identity.minValue ?? "1",
						max: column.identity.maxValue ?? "9223372036854775807",
						cache: column.identity.cache ?? "1",
						cycle: column.identity.cycle ?? false,
					});
				}
			}
			// Drizzle writes a text default as a quoted SQL string but a numeric or boolean one
			// as a native JSON number/boolean, which stringifies to exactly the literal
			// PostgreSQL reports. An object or array would not, and is reported instead of
			// being compared as "[object Object]".
			if (
				column.default !== undefined &&
				!["string", "number", "boolean"].includes(typeof column.default)
			) {
				problems.push(
					`column ${table.name}.${column.name}: default is not a SQL literal (${clip(column.default)})`,
				);
			}
			columns.push({
				table: table.name,
				name: column.name,
				type: column.type,
				notNull: column.notNull,
				primaryKey: column.primaryKey,
				// Identity allocation is represented by attidentity, not a pg_attrdef default.
				default: column.default === undefined ? null : String(column.default),
				generated: column.generated
					? { as: column.generated.as, stored: column.generated.type === "stored" }
					: null,
				identity,
			});
		}
		for (const fk of Object.values(table.foreignKeys ?? {})) foreignKeys.push(fk);
		for (const index of Object.values(table.indexes ?? {})) {
			indexes.push({
				table: table.name,
				name: index.name,
				columns: expectedIndexColumns(table.name, index, problems),
				isUnique: !!index.isUnique,
				method: index.method ?? "btree",
				where: index.where ?? null,
				constraintBacked: false,
				nullsNotDistinct: false,
			});
			if (Object.keys(index.with ?? {}).length > 0) {
				problems.push(`index ${table.name}.${index.name}: storage parameters are not covered`);
			}
			if ((index.method ?? "btree") !== "btree") {
				problems.push(
					`index ${table.name}.${index.name}: only btree is covered (${clip(index.method)})`,
				);
			}
		}
		for (const unique of Object.values(table.uniqueConstraints ?? {})) {
			uniques.push({
				table: table.name,
				name: unique.name,
				columns: [...unique.columns],
				nullsNotDistinct: !!unique.nullsNotDistinct,
			});
			// PostgreSQL implements a UNIQUE constraint with an index of the same name, so it
			// must be expected on the index side too or the catalog looks like it has extras.
			indexes.push({
				table: table.name,
				name: unique.name,
				columns: [...unique.columns],
				isUnique: true,
				method: "btree",
				where: null,
				constraintBacked: true,
				nullsNotDistinct: !!unique.nullsNotDistinct,
			});
		}
		for (const check of Object.values(table.checkConstraints ?? {})) {
			checks.push({ table: table.name, name: check.name, value: check.value });
		}
	}

	const counts: BaselineCounts = {
		tables: tables.length,
		columns: columns.length,
		foreignKeys: foreignKeys.length,
		uniqueConstraints: uniques.length,
		checkConstraints: checks.length,
		primaryKeys: tables.filter((name) =>
			columns.some((column) => column.table === name && column.primaryKey),
		).length,
		indexes: indexes.length,
		partialIndexes: indexes.filter((index) => index.where !== null).length,
		uniqueIndexes: indexes.filter((index) => index.isUnique).length,
		generatedColumns: columns.filter((column) => column.generated !== null).length,
		identityColumns: columns.filter((column) => column.identity !== null).length,
		sequences: sequences.length,
		bigintColumns: columns.filter((column) => column.type === "bigint").length,
		booleanColumns: columns.filter((column) => column.type === "boolean").length,
	};

	return {
		expected: {
			tables,
			columns,
			foreignKeys,
			indexes,
			uniques,
			checks,
			sequences,
			columnOrder: physicalColumnOrder(snapshot, prior, problems),
			counts,
		},
		problems,
	};
}

/**
 * Replay the snapshot chain into the physical column order PostgreSQL produces.
 *
 * The baseline snapshot's CREATE TABLEs lay columns out in definition order; every later
 * migration's ADD COLUMN appends to the end of the table, whatever position the column
 * holds in the schema definition. Definition-only reordering keeps the physical order.
 * A column DROP or RENAME (indistinguishable from drop+add at this level) is reported
 * as a problem rather than silently compared against a guessed order.
 */
export function physicalColumnOrder(
	snapshot: Snapshot,
	prior: Snapshot[],
	problems: string[],
): Map<string, string[]> {
	const order = new Map<string, string[]>();
	for (const step of [...prior, snapshot]) {
		const present = new Set(Object.values(step.tables ?? {}).map((table) => table.name));
		for (const name of [...order.keys()]) if (!present.has(name)) order.delete(name);
		for (const table of Object.values(step.tables ?? {})) {
			const current = Object.keys(table.columns);
			const previous = order.get(table.name);
			if (!previous) {
				order.set(table.name, current);
				continue;
			}
			const surviving = previous.filter((name) => current.includes(name));
			if (surviving.length !== previous.length) {
				problems.push(`table ${table.name}: dropped columns between snapshots are not covered`);
			}
			// Reordering a schema declaration emits no ALTER COLUMN POSITION in PostgreSQL.
			// Preserve the old physical order, including across later unchanged snapshots.
			const added = current.filter((name) => !previous.includes(name));
			order.set(table.name, [...surviving, ...added]);
		}
	}
	return order;
}

/**
 * Column names of a snapshot index, in index order.
 *
 * Snapshot index columns are objects (`{expression, isExpression, asc, nulls}`), so the
 * name lives in `expression`; stringifying the object yields "[object Object]", which
 * compares unequal against every real column name and therefore reports every index as
 * broken. Anything this gate cannot express — an expression key, DESC, NULLS FIRST — is
 * reported instead of being flattened into a name.
 */
export function expectedIndexColumns(
	table: string,
	index: SnapshotIndex,
	problems: string[],
): string[] {
	const names: string[] = [];
	for (const column of index.columns ?? []) {
		if (typeof column !== "object" || column === null || typeof column.expression !== "string") {
			problems.push(`index ${table}.${index.name}: unreadable column entry ${clip(column)}`);
			continue;
		}
		if (column.isExpression) {
			problems.push(
				`index ${table}.${index.name}: expression keys are not covered (${clip(column.expression)})`,
			);
			continue;
		}
		if (column.asc === false || (column.nulls ?? "last") !== "last") {
			problems.push(
				`index ${table}.${index.name}: only ASC/NULLS LAST is covered (${clip(column)})`,
			);
		}
		names.push(column.expression);
	}
	if (names.length === 0) problems.push(`index ${table}.${index.name}: no key columns`);
	return names;
}

// ---------------------------------------------------------------------------------------
// Default normalization
// ---------------------------------------------------------------------------------------

const NUMERIC_TYPES = new Set([
	"smallint",
	"integer",
	"bigint",
	"real",
	"double precision",
	"numeric",
]);

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Canonical form of a column default, for the two differences that are purely notational.
 *
 * PostgreSQL deparses `DEFAULT 'narrator'` on a text column as `'narrator'::text`, and
 * accepts a quoted numeric literal for a numeric column. Both are the same default written
 * differently.
 *
 * What it deliberately does NOT do: strip a cast to any type other than the column's own.
 * `'{}'::jsonb` on a text column is a different default from `'{}'` and stays different, no
 * value inside quotes is rewritten (`'a::text'` survives intact), and a numeric literal is
 * only unquoted for a numeric column.
 */
export function normDefault(type: string, value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	let text = String(value).trim();
	if (text === "") return "";
	const ownCast = new RegExp(`::\\s*(?:"${escapeRegExp(type)}"|${escapeRegExp(type)})$`, "i");
	// Repeat for the unusual but legal `'x'::text::text`.
	for (let i = 0; i < 4 && ownCast.test(text); i += 1) text = text.replace(ownCast, "").trim();
	if (NUMERIC_TYPES.has(type.toLowerCase())) {
		const quoted = text.match(/^'(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)'$/);
		if (quoted) text = quoted[1];
	}
	return text;
}

// Classify only simple literals (and literal casts), never normalize expressions here.
// E/dollar strings, operators, parentheses and SQL keywords such as CURRENT_TIMESTAMP
// go through PostgreSQL even when their text happens to resemble a literal.
const DEFAULT_CAST_IDENTIFIER = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';
const DEFAULT_CAST_TYPE = [
	DEFAULT_CAST_IDENTIFIER,
	String.raw`(?:\s*\.\s*${DEFAULT_CAST_IDENTIFIER})?`,
	String.raw`(?:\s+(?:precision|varying|(?:with|without)\s+time\s+zone))?`,
	String.raw`(?:\s*\(\s*\d+(?:\s*,\s*\d+)*\s*\))?`,
	String.raw`(?:\s*\[\s*\])*`,
].join("");
const LITERAL_DEFAULT = new RegExp(
	String.raw`^(?:'(?:[^']|'')*'|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|true|false|null)(?:\s*::\s*${DEFAULT_CAST_TYPE})*$`,
	"i",
);
function isExpressionDefault(value: string | null): boolean {
	return value !== null && !LITERAL_DEFAULT.test(value.trim());
}

// ---------------------------------------------------------------------------------------
// Catalog facets
// ---------------------------------------------------------------------------------------

const PUBLIC_TABLE = "pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace";
const IS_PUBLIC_TABLE = "n.nspname = 'public' AND c.relkind = 'r'";

/**
 * One SQL body per facet, each producing a sort key `k` and a JSON array `j`.
 *
 * Positional JSON arrays keep the payload small enough to page through `psql`, and JSON
 * escaping guarantees one row per line even for a multi-line generated expression. Every
 * alias that must survive as written is double-quoted, because PostgreSQL folds an unquoted
 * alias to lower case — `AS foreignKeys` becomes `foreignkeys`, and a reader that looks up
 * `foreignKeys` then sees `undefined`, i.e. "no foreign keys", for a schema that has 207.
 *
 * `unnest(...) WITH ORDINALITY u(attnum, n)` names the VALUE first and the ordinality
 * second; that order is what binds `u.attnum` to the column number and `u.n` to the
 * position. Swapping the two names joins on the ordinal instead, which yields the table's
 * leading columns in attnum order — a plausible-looking column list that is wrong.
 */
export const CATALOG_FACETS = {
	tables: `SELECT c.relname AS "k", json_build_array(c.relname) AS "j"
		FROM ${PUBLIC_TABLE} WHERE ${IS_PUBLIC_TABLE}`,

	columns: `SELECT c.relname || '#' || lpad(a.attnum::text, 5, '0') AS "k",
			json_build_array(
				c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
				EXISTS(SELECT 1 FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p'
					AND a.attnum = ANY(p.conkey)),
				pg_get_expr(d.adbin, d.adrelid), nullif(a.attgenerated::text, ''),
				nullif(a.attidentity::text, '')
			) AS "j"
		FROM ${PUBLIC_TABLE}
		JOIN pg_attribute a ON a.attrelid = c.oid
		LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
		WHERE ${IS_PUBLIC_TABLE} AND a.attnum > 0 AND NOT a.attisdropped`,

	foreignKeys: `SELECT k2.conname AS "k",
			json_build_array(
				c.relname, k2.conname, replace(k2.confrelid::regclass::text, 'public.', ''),
				(SELECT json_agg(z.attname ORDER BY u.n) FROM unnest(k2.conkey) WITH ORDINALITY u(attnum, n)
					JOIN pg_attribute z ON z.attrelid = c.oid AND z.attnum = u.attnum),
				(SELECT json_agg(z.attname ORDER BY u.n) FROM unnest(k2.confkey) WITH ORDINALITY u(attnum, n)
					JOIN pg_attribute z ON z.attrelid = k2.confrelid AND z.attnum = u.attnum),
				array_length(k2.conkey, 1), array_length(k2.confkey, 1),
				k2.confdeltype::text, k2.confupdtype::text
			) AS "j"
		FROM pg_constraint k2 JOIN ${PUBLIC_TABLE} ON c.oid = k2.conrelid
		WHERE ${IS_PUBLIC_TABLE} AND k2.contype = 'f'`,

	indexes: `SELECT c.relname || '#' || i.relname AS "k",
			json_build_array(
				c.relname, i.relname, ix.indisunique,
				(SELECT json_agg(z.attname ORDER BY u.n) FROM unnest(ix.indkey) WITH ORDINALITY u(attnum, n)
					JOIN pg_attribute z ON z.attrelid = ix.indrelid AND z.attnum = u.attnum),
				(SELECT json_agg(u.opt ORDER BY u.n) FROM unnest(ix.indoption) WITH ORDINALITY u(opt, n)),
				am.amname, pg_get_expr(ix.indpred, ix.indrelid),
				ix.indnatts, ix.indnkeyatts, ix.indnullsnotdistinct,
				(SELECT k2.contype::text FROM pg_constraint k2 WHERE k2.conindid = ix.indexrelid LIMIT 1)
			) AS "j"
		FROM pg_index ix
		JOIN pg_class i ON i.oid = ix.indexrelid
		JOIN pg_am am ON am.oid = i.relam
		JOIN ${PUBLIC_TABLE} ON c.oid = ix.indrelid
		WHERE ${IS_PUBLIC_TABLE} AND NOT ix.indisprimary`,

	uniques: `SELECT k2.conname AS "k",
			json_build_array(
				c.relname, k2.conname,
				(SELECT json_agg(z.attname ORDER BY u.n) FROM unnest(k2.conkey) WITH ORDINALITY u(attnum, n)
					JOIN pg_attribute z ON z.attrelid = c.oid AND z.attnum = u.attnum),
				array_length(k2.conkey, 1), coalesce(ix.indnullsnotdistinct, false)
			) AS "j"
		FROM pg_constraint k2 JOIN ${PUBLIC_TABLE} ON c.oid = k2.conrelid
		LEFT JOIN pg_index ix ON ix.indexrelid = k2.conindid
		WHERE ${IS_PUBLIC_TABLE} AND k2.contype = 'u'`,

	checks: `SELECT k2.conname AS "k",
			json_build_array(c.relname, k2.conname, pg_get_constraintdef(k2.oid)) AS "j"
		FROM pg_constraint k2 JOIN ${PUBLIC_TABLE} ON c.oid = k2.conrelid
		WHERE ${IS_PUBLIC_TABLE} AND k2.contype = 'c'`,

	generated: `SELECT c.relname || '#' || a.attname AS "k",
			json_build_array(
				c.relname, a.attname, a.attgenerated::text, pg_get_expr(d.adbin, d.adrelid),
				format_type(a.atttypid, a.atttypmod)
			) AS "j"
		FROM ${PUBLIC_TABLE}
		JOIN pg_attribute a ON a.attrelid = c.oid
		LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
		WHERE ${IS_PUBLIC_TABLE} AND a.attgenerated <> ''`,

	// Identity backing sequences are real relations in `public`; without this facet they
	// would be invisible to the gate. The dependency link (deptype 'a' serial-style or
	// 'i' identity-internal) names the owning table and column. Sequence parameters are
	// read as text — seqmax for bigint exceeds Number.MAX_SAFE_INTEGER.
	sequences: `SELECT s.relname AS "k",
			json_build_array(
				s.relname, t.relname, a.attname,
				q.seqstart::text, q.seqincrement::text, q.seqmin::text, q.seqmax::text,
				q.seqcache::text, q.seqcycle
			) AS "j"
		FROM pg_class s
		JOIN pg_namespace n ON n.oid = s.relnamespace
		JOIN pg_sequence q ON q.seqrelid = s.oid
		LEFT JOIN pg_depend dep ON dep.classid = 'pg_class'::regclass AND dep.objid = s.oid
			AND dep.refclassid = 'pg_class'::regclass AND dep.deptype IN ('a', 'i')
		LEFT JOIN pg_class t ON t.oid = dep.refobjid
		LEFT JOIN pg_attribute a ON a.attrelid = dep.refobjid AND a.attnum = dep.refobjsubid
		WHERE n.nspname = 'public' AND s.relkind = 'S'`,
} as const;

export type FacetName = keyof typeof CATALOG_FACETS;

/** Field count per facet row, so a folded alias or dropped projection cannot pass as data. */
export const FACET_WIDTHS: Record<FacetName, number> = {
	tables: 1,
	columns: 8,
	foreignKeys: 9,
	indexes: 11,
	uniques: 5,
	checks: 3,
	generated: 5,
	sequences: 9,
};

/** Server-side totals, read independently of the paged dumps as a landmark. */
export const COUNTS_SQL = `SELECT json_build_object(
	'tables', (SELECT count(*) FROM ${PUBLIC_TABLE} WHERE ${IS_PUBLIC_TABLE}),
	'columns', (SELECT count(*) FROM ${PUBLIC_TABLE} JOIN pg_attribute a ON a.attrelid = c.oid
		WHERE ${IS_PUBLIC_TABLE} AND a.attnum > 0 AND NOT a.attisdropped),
	'foreignKeys', (SELECT count(*) FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace AND contype = 'f'),
	'uniqueConstraints', (SELECT count(*) FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace AND contype = 'u'),
	'checkConstraints', (SELECT count(*) FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace AND contype = 'c'),
	'primaryKeys', (SELECT count(*) FROM pg_constraint
		WHERE connamespace = 'public'::regnamespace AND contype = 'p'),
	'indexes', (SELECT count(*) FROM pg_index ix JOIN ${PUBLIC_TABLE} ON c.oid = ix.indrelid
		WHERE ${IS_PUBLIC_TABLE} AND NOT ix.indisprimary),
	'partialIndexes', (SELECT count(*) FROM pg_index ix JOIN ${PUBLIC_TABLE} ON c.oid = ix.indrelid
		WHERE ${IS_PUBLIC_TABLE} AND ix.indpred IS NOT NULL),
	'uniqueIndexes', (SELECT count(*) FROM pg_index ix JOIN ${PUBLIC_TABLE} ON c.oid = ix.indrelid
		WHERE ${IS_PUBLIC_TABLE} AND ix.indisunique AND NOT ix.indisprimary),
	'generatedColumns', (SELECT count(*) FROM ${PUBLIC_TABLE} JOIN pg_attribute a ON a.attrelid = c.oid
		WHERE ${IS_PUBLIC_TABLE} AND a.attgenerated <> ''),
	'identityColumns', (SELECT count(*) FROM ${PUBLIC_TABLE} JOIN pg_attribute a ON a.attrelid = c.oid
		WHERE ${IS_PUBLIC_TABLE} AND a.attidentity <> ''),
	'sequences', (SELECT count(*) FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace
		WHERE n.nspname = 'public' AND s.relkind = 'S'),
	'bigintColumns', (SELECT count(*) FROM ${PUBLIC_TABLE} JOIN pg_attribute a ON a.attrelid = c.oid
		WHERE ${IS_PUBLIC_TABLE} AND a.attnum > 0 AND NOT a.attisdropped
			AND format_type(a.atttypid, a.atttypmod) = 'bigint'),
	'booleanColumns', (SELECT count(*) FROM ${PUBLIC_TABLE} JOIN pg_attribute a ON a.attrelid = c.oid
		WHERE ${IS_PUBLIC_TABLE} AND a.attnum > 0 AND NOT a.attisdropped
			AND format_type(a.atttypid, a.atttypmod) = 'boolean'),
	'nonTableRelations', (SELECT count(*) FROM ${PUBLIC_TABLE}
		WHERE n.nspname = 'public' AND c.relkind NOT IN ('r', 'i', 'S'))
)::text`;

const pagedCte = (body: string) =>
	`WITH src AS (${body}), acc AS (
		SELECT "k", "j"::text AS "t", sum(length("j"::text) + 1) OVER (ORDER BY "k") AS "b" FROM src
	)`;

export const facetMetaSql = (body: string) =>
	`${pagedCte(body)} SELECT count(*)::text || ' ' || coalesce(max(("b" - 1) / ${PAGE_BUDGET}), 0)::text FROM acc;`;

export const facetPageSql = (body: string, page: number) =>
	`${pagedCte(body)} SELECT "t" FROM acc WHERE ("b" - 1) / ${PAGE_BUDGET} = ${page} ORDER BY "k";`;

export type Exec = (sql: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Read one facet in pages, verifying the row count the server itself reported.
 *
 * The row total is read first and re-checked after paging, so a page lost to the output cap
 * or a bucketing mistake cannot quietly shrink the comparison set.
 */
export async function dumpFacet(
	exec: Exec,
	name: string,
	body: string,
): Promise<{ rows: unknown[][]; problems: string[] }> {
	const problems: string[] = [];
	const meta = await exec(facetMetaSql(body));
	if (meta.code !== 0) {
		return { rows: [], problems: [`facet ${name}: count query failed: ${clip(meta.stderr)}`] };
	}
	const [totalText, lastPageText] = meta.stdout.trim().split(/\s+/);
	const total = Number(totalText);
	const lastPage = Number(lastPageText);
	if (!Number.isInteger(total) || !Number.isInteger(lastPage)) {
		return { rows: [], problems: [`facet ${name}: unreadable count ${clip(meta.stdout)}`] };
	}
	if (lastPage + 1 > MAX_PAGES) {
		return { rows: [], problems: [`facet ${name}: ${lastPage + 1} pages exceeds the page cap`] };
	}
	const rows: unknown[][] = [];
	for (let page = 0; total > 0 && page <= lastPage; page += 1) {
		const result = await exec(facetPageSql(body, page));
		if (result.code !== 0) {
			problems.push(`facet ${name}: page ${page} failed: ${clip(result.stderr)}`);
			return { rows, problems };
		}
		for (const line of result.stdout.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				problems.push(`facet ${name}: unreadable row ${clip(trimmed)}`);
				return { rows, problems };
			}
			if (!Array.isArray(parsed)) {
				problems.push(`facet ${name}: row is not an array ${clip(trimmed)}`);
				return { rows, problems };
			}
			rows.push(parsed);
		}
	}
	if (rows.length !== total) {
		problems.push(`facet ${name}: read ${rows.length} rows, server reported ${total}`);
	}
	return { rows, problems };
}

// ---------------------------------------------------------------------------------------
// Catalog parsing
// ---------------------------------------------------------------------------------------

export type ActualColumn = ExpectedColumn;
export type ActualIndex = {
	table: string;
	name: string;
	columns: string[];
	options: number[];
	isUnique: boolean;
	method: string;
	where: string | null;
	keyColumnCount: number;
	totalColumnCount: number;
	nullsNotDistinct: boolean;
	constraintBacked: boolean;
};
export type ActualForeignKey = SnapshotForeignKey & { columnCount: number; refColumnCount: number };
export type ActualUnique = ExpectedUnique & { columnCount: number };
export type ActualCheck = { table: string; name: string; definition: string };
export type ActualGenerated = {
	table: string;
	name: string;
	kind: string;
	as: string;
	type: string;
};
export type ActualSequence = ExpectedSequence;

export type Catalog = {
	tables: string[];
	columns: ActualColumn[];
	foreignKeys: ActualForeignKey[];
	indexes: ActualIndex[];
	uniques: ActualUnique[];
	checks: ActualCheck[];
	generated: ActualGenerated[];
	sequences: ActualSequence[];
};

const FK_ACTIONS: Record<string, string> = {
	a: "no action",
	r: "restrict",
	c: "cascade",
	n: "set null",
	d: "set default",
};

const asString = (value: unknown) => (typeof value === "string" ? value : null);
const asStrings = (value: unknown): string[] =>
	Array.isArray(value) ? value.map((entry) => String(entry)) : [];
const asNumbers = (value: unknown): number[] =>
	Array.isArray(value) ? value.map((entry) => Number(entry)) : [];

/**
 * Turn the paged facet rows into the comparable catalog.
 *
 * Row width is checked per facet: a JSON key folded to lower case by an unquoted alias, or
 * a field dropped from the projection, must surface as a problem rather than an
 * `undefined` that compares equal to "nothing expected". A facet that is entirely absent
 * is reported the same way instead of crashing the fold.
 */
export function parseCatalog(facets: Record<FacetName, unknown[][]>): {
	catalog: Catalog;
	problems: string[];
} {
	const problems: string[] = [];
	for (const name of Object.keys(FACET_WIDTHS) as FacetName[]) {
		if (!Array.isArray(facets[name])) {
			problems.push(`facet ${name}: missing entirely`);
			facets[name] = [];
		}
		for (const row of facets[name]) {
			if (!Array.isArray(row) || row.length !== FACET_WIDTHS[name]) {
				problems.push(`facet ${name}: expected ${FACET_WIDTHS[name]} fields, got ${clip(row)}`);
			}
		}
	}

	const catalog: Catalog = {
		tables: facets.tables.map((row) => String(row[0])),
		columns: facets.columns.map((row) => {
			const expression = asString(row[5]);
			const generatedKind = asString(row[6]);
			const identityKind = asString(row[7]);
			if (generatedKind !== null && generatedKind !== "s") {
				problems.push(
					`column ${row[0]}.${row[1]}: unsupported generation kind ${clip(generatedKind)}`,
				);
			}
			if (identityKind !== null && identityKind !== "d" && identityKind !== "a") {
				problems.push(
					`column ${row[0]}.${row[1]}: unsupported identity kind ${clip(identityKind)}`,
				);
			}
			if (generatedKind !== null && identityKind !== null) {
				problems.push(`column ${row[0]}.${row[1]}: both generated and identity`);
			}
			return {
				table: String(row[0]),
				name: String(row[1]),
				type: String(row[2]),
				notNull: row[3] === true,
				primaryKey: row[4] === true,
				// A generated column keeps its expression in pg_attrdef too; it is not a default.
				default: generatedKind ? null : expression,
				generated: generatedKind ? { as: expression ?? "", stored: generatedKind === "s" } : null,
				identity:
					identityKind === "d" || identityKind === "a"
						? {
								type: identityKind === "d" ? ("byDefault" as const) : ("always" as const),
								// The catalog column row does not name the sequence; the sequences facet
								// pins the ownership link. The shape comparison only needs the kind here.
								sequenceName: "",
							}
						: null,
			};
		}),
		foreignKeys: facets.foreignKeys.map((row) => {
			const onDelete = FK_ACTIONS[String(row[7])];
			const onUpdate = FK_ACTIONS[String(row[8])];
			if (!onDelete || !onUpdate) {
				problems.push(`foreign key ${row[1]}: unknown action ${clip([row[7], row[8]])}`);
			}
			return {
				tableFrom: String(row[0]),
				name: String(row[1]),
				tableTo: String(row[2]),
				columnsFrom: asStrings(row[3]),
				columnsTo: asStrings(row[4]),
				columnCount: Number(row[5]),
				refColumnCount: Number(row[6]),
				onDelete: onDelete ?? `unknown(${String(row[7])})`,
				onUpdate: onUpdate ?? `unknown(${String(row[8])})`,
			};
		}),
		indexes: facets.indexes.map((row) => ({
			table: String(row[0]),
			name: String(row[1]),
			isUnique: row[2] === true,
			columns: asStrings(row[3]),
			options: asNumbers(row[4]),
			method: String(row[5]),
			where: asString(row[6]),
			totalColumnCount: Number(row[7]),
			keyColumnCount: Number(row[8]),
			nullsNotDistinct: row[9] === true,
			constraintBacked: String(row[10]) === "u",
		})),
		uniques: facets.uniques.map((row) => ({
			table: String(row[0]),
			name: String(row[1]),
			columns: asStrings(row[2]),
			columnCount: Number(row[3]),
			nullsNotDistinct: row[4] === true,
		})),
		checks: facets.checks.map((row) => ({
			table: String(row[0]),
			name: String(row[1]),
			definition: String(row[2]),
		})),
		generated: facets.generated.map((row) => ({
			table: String(row[0]),
			name: String(row[1]),
			kind: String(row[2]),
			as: String(row[3]),
			type: String(row[4]),
		})),
		sequences: facets.sequences.map((row) => {
			if (row[1] === null || row[2] === null) {
				problems.push(`sequence ${row[0]}: no owning column (unowned sequences are not covered)`);
			}
			return {
				name: String(row[0]),
				ownerTable: String(row[1]),
				ownerColumn: String(row[2]),
				start: String(row[3]),
				increment: String(row[4]),
				min: String(row[5]),
				max: String(row[6]),
				cache: String(row[7]),
				cycle: row[8] === true,
			};
		}),
	};
	return { catalog, problems };
}

// ---------------------------------------------------------------------------------------
// Expression canonicalization through the server
// ---------------------------------------------------------------------------------------

export type DeparseRequest =
	| { id: string; kind: "predicate"; table: string; keyColumn: string; text: string }
	| { id: string; kind: "check"; table: string; text: string }
	| { id: string; kind: "generated"; table: string; type: string; text: string }
	| { id: string; kind: "default"; table: string; type: string; text: string };

/** DEFAULT coercion depends on the target type; existing expression keys stay compatible. */
export const deparseKey = (kind: string, table: string, text: string, type?: string) =>
	`${kind}\u0000${table}\u0000${text}${type === undefined ? "" : `\u0000${type}`}`;

function requestKey(request: DeparseRequest): string {
	return deparseKey(
		request.kind,
		request.table,
		request.text,
		request.kind === "default" ? request.type : undefined,
	);
}

/** Every distinct expression the snapshot expects, with the table it must be parsed in. */
export function deparseRequests(expected: Expected): DeparseRequest[] {
	const firstColumn = new Map<string, string>();
	for (const column of expected.columns) {
		if (!firstColumn.has(column.table) && column.generated === null) {
			firstColumn.set(column.table, column.name);
		}
	}
	const requests: DeparseRequest[] = [];
	const seen = new Set<string>();
	let counter = 0;
	const push = (request: DeparseRequest) => {
		if (seen.has(requestKey(request))) return;
		seen.add(requestKey(request));
		requests.push(request);
	};
	for (const index of expected.indexes) {
		if (index.where === null) continue;
		counter += 1;
		push({
			id: `pred_${counter}`,
			kind: "predicate",
			table: index.table,
			keyColumn: firstColumn.get(index.table) ?? index.columns[0],
			text: index.where,
		});
	}
	for (const check of expected.checks) {
		counter += 1;
		push({ id: `chk_${counter}`, kind: "check", table: check.table, text: check.value });
	}
	for (const column of expected.columns) {
		if (column.generated === null) continue;
		counter += 1;
		push({
			id: `gen_${counter}`,
			kind: "generated",
			table: column.table,
			type: column.type,
			text: column.generated.as,
		});
	}
	for (const column of expected.columns) {
		if (column.default === null || !isExpressionDefault(column.default)) continue;
		counter += 1;
		push({
			id: `def_${counter}`,
			kind: "default",
			table: column.table,
			type: column.type,
			text: column.default,
		});
	}
	return requests;
}

/**
 * A script that makes the server deparse each expected expression, in the right table.
 *
 * Scratch copies are temporary, so the script must create and read them in one session;
 * `INCLUDING GENERATED` is required because some predicates reference a generated column.
 * Nothing here touches `public`, which has already been dumped by the time this runs.
 */
export function buildDeparseScript(requests: DeparseRequest[]): string {
	const tables = [...new Set(requests.map((request) => request.table))];
	const alias = new Map(tables.map((table, i) => [table, `nf_scratch_${i}`]));
	const lines: string[] = [];
	for (const table of tables) {
		lines.push(
			`CREATE TEMP TABLE ${alias.get(table)} (LIKE public."${table}" INCLUDING GENERATED);`,
		);
	}
	for (const request of requests) {
		const scratch = alias.get(request.table);
		if (request.kind === "predicate") {
			lines.push(
				`CREATE INDEX nf_${request.id} ON ${scratch} ("${request.keyColumn}") WHERE ${request.text};`,
			);
		} else if (request.kind === "check") {
			lines.push(`ALTER TABLE ${scratch} ADD CONSTRAINT nf_${request.id} CHECK (${request.text});`);
		} else if (request.kind === "generated") {
			lines.push(
				`ALTER TABLE ${scratch} ADD COLUMN nf_${request.id} ${request.type} GENERATED ALWAYS AS (${request.text}) STORED;`,
			);
		} else {
			// PostgreSQL applies the actual target-type coercion and deparses it itself.
			lines.push(
				`ALTER TABLE ${scratch} ADD COLUMN nf_${request.id} ${request.type} DEFAULT (${request.text});`,
			);
		}
	}
	lines.push(`SELECT json_build_array(i.relname, pg_get_expr(ix.indpred, ix.indrelid))::text
		FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid WHERE i.relname LIKE 'nf\\_pred\\_%'
	UNION ALL
	SELECT json_build_array(conname, pg_get_constraintdef(oid))::text
		FROM pg_constraint WHERE conname LIKE 'nf\\_chk\\_%'
	UNION ALL
	SELECT json_build_array(a.attname, pg_get_expr(d.adbin, d.adrelid))::text
		FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
		WHERE a.attname LIKE 'nf\\_gen\\_%' OR a.attname LIKE 'nf\\_def\\_%';`);
	return lines.join("\n");
}

/** Map every request to the server's canonical text, or report what is missing. */
export function parseDeparseOutput(
	requests: DeparseRequest[],
	stdout: string,
): { canonical: Map<string, string>; problems: string[] } {
	const problems: string[] = [];
	const byName = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			problems.push(`deparse: unreadable row ${clip(trimmed)}`);
			continue;
		}
		if (
			!Array.isArray(parsed) ||
			parsed.length !== 2 ||
			typeof parsed[0] !== "string" ||
			typeof parsed[1] !== "string" ||
			parsed[0].length === 0 ||
			parsed[1].length === 0
		) {
			problems.push(`deparse: unexpected row shape ${clip(trimmed)}`);
			continue;
		}
		if (byName.has(parsed[0])) {
			problems.push(`deparse: duplicate result name ${clip(parsed[0])}`);
			continue;
		}
		byName.set(parsed[0], parsed[1]);
	}
	const canonical = new Map<string, string>();
	for (const request of requests) {
		const value = byName.get(`nf_${request.id}`);
		if (value === undefined) {
			problems.push(`deparse: server returned nothing for ${request.kind} on ${request.table}`);
			continue;
		}
		canonical.set(requestKey(request), value);
	}
	return { canonical, problems };
}

// ---------------------------------------------------------------------------------------
// Migration ledger
// ---------------------------------------------------------------------------------------

export type JournalEntry = { tag: string; when: number };
export type LedgerRow = { id: unknown; hash: unknown; created_at: unknown };

/**
 * Check Drizzle's own bookkeeping table against the journal on disk.
 *
 * The migration SQL does not create `drizzle.__drizzle_migrations`; the migrator does, and
 * writes one row per applied migration whose `hash` is the sha256 of the whole `.sql` file
 * and whose `created_at` is the journal's `when`. So the row count follows the journal
 * length (currently 1) — a fixed expectation like "2" cannot hold, and a replay of
 * `sqls[1]` cannot even be attempted when only one migration exists.
 */
export function checkMigrationLedger(
	entries: JournalEntry[],
	hashes: string[],
	rows: LedgerRow[],
): string[] {
	const problems: string[] = [];
	if (entries.length === 0) problems.push("journal has no entries");
	if (entries.length !== hashes.length) {
		problems.push(
			`ledger: ${hashes.length} migration hashes for ${entries.length} journal entries`,
		);
		return problems;
	}
	if (rows.length !== entries.length) {
		problems.push(`ledger: ${rows.length} rows recorded for ${entries.length} journal entries`);
	}
	const byHash = new Map(rows.map((row) => [String(row.hash), row]));
	for (const [i, entry] of entries.entries()) {
		const row = byHash.get(hashes[i]);
		if (!row) {
			problems.push(`ledger: no row for ${entry.tag} (hash ${hashes[i].slice(0, 12)}…)`);
			continue;
		}
		if (Number(row.created_at) !== Number(entry.when)) {
			problems.push(
				`ledger: ${entry.tag} recorded at ${clip(row.created_at)}, journal says ${entry.when}`,
			);
		}
	}
	for (const row of rows) {
		if (!hashes.includes(String(row.hash))) {
			problems.push(`ledger: row ${clip(row.id)} records an unknown migration hash`);
		}
	}
	return problems;
}

/**
 * Concatenate the migrator's queries into one `psql` script.
 *
 * Each statement Drizzle hands over already ends in `;` (it splits the file on
 * `--> statement-breakpoint`); its own bookkeeping INSERT does not, so it is terminated
 * here. One script instead of ~700 `podman exec` round trips, with `ON_ERROR_STOP=1` still
 * aborting at the first failing statement.
 */
export function migrationScript(queries: string[]): string {
	return queries
		.map((query) => query.trim())
		.filter((query) => query.length > 0)
		.map((query) => (query.endsWith(";") ? query : `${query};`))
		.join("\n");
}

/**
 * A `pg-proxy` callback backed by the harness' `psql` exec.
 *
 * Only Drizzle's migrator runs through this, and it uses `db.execute`, which returns the
 * callback's rows unmapped — so rows are returned as objects, wrapped in `json_agg` to keep
 * the transport one line whatever the column types are. Statements are executed verbatim:
 * wrapping a DDL statement in a SELECT is a syntax error.
 */
export function psqlProxyCallback(exec: Exec) {
	return async (query: string, _params: unknown[]): Promise<{ rows: unknown[] }> => {
		const bare = query.trim().replace(/;\s*$/, "");
		const isQuery = /^\s*(select|with)\b/i.test(bare);
		const statement = isQuery
			? `SELECT coalesce(json_agg(r), '[]'::json)::text FROM (${bare}) r`
			: bare;
		const result = await exec(statement);
		if (result.code !== 0) {
			throw new Error(`psql failed (${result.code}): ${clip(result.stderr)}`);
		}
		if (!isQuery) return { rows: [] };
		const text = result.stdout.trim();
		if (text === "") return { rows: [] };
		return { rows: JSON.parse(text) as unknown[] };
	};
}

// ---------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------

function diffKeyed(
	label: string,
	expected: Map<string, unknown>,
	actual: Map<string, unknown>,
	problems: string[],
): void {
	for (const [key, value] of expected) {
		if (!actual.has(key)) {
			problems.push(`${label} ${key}: missing from the server`);
			continue;
		}
		const got = JSON.stringify(actual.get(key));
		const want = JSON.stringify(value);
		if (got !== want) problems.push(`${label} ${key}: expected ${clip(want)}, got ${clip(got)}`);
	}
	for (const key of actual.keys()) {
		if (!expected.has(key)) problems.push(`${label} ${key}: present on the server, not committed`);
	}
}

/**
 * Compare the committed baseline against the live catalog, one problem per disagreement.
 *
 * `canonical` maps each expected expression to the server's own deparsed form. A missing
 * entry is reported rather than compared against the raw snapshot text, which would fail
 * for a correct schema and teach the reader to ignore the result.
 */
export function compareBaseline(
	expected: Expected,
	actual: Catalog,
	canonical: Map<string, string>,
	serverCounts: Partial<BaselineCounts> & { nonTableRelations?: number },
): string[] {
	const problems: string[] = [];

	diffKeyed(
		"table",
		new Map(expected.tables.map((name) => [name, true])),
		new Map(actual.tables.map((name) => [name, true])),
		problems,
	);

	// Column order is part of the schema (`SELECT *`, `INSERT` without a column list), so
	// names are compared as an ordered list per table on top of the per-column diff. The
	// expected side is the replayed PHYSICAL order (baseline definition order plus
	// incrementally appended columns), not the snapshot's definition order.
	const actualOrder = new Map<string, string[]>();
	for (const column of actual.columns) {
		const list = actualOrder.get(column.table) ?? [];
		list.push(column.name);
		actualOrder.set(column.table, list);
	}
	for (const [table, names] of expected.columnOrder) {
		const got = actualOrder.get(table);
		if (!got) continue;
		if (JSON.stringify(got) !== JSON.stringify(names)) {
			problems.push(`table ${table}: column order ${clip(got)} does not match ${clip(names)}`);
		}
	}

	const expressionDefaults = new Map(
		expected.columns
			.filter((column) => isExpressionDefault(column.default))
			.map((column) => [`${column.table}.${column.name}`, column]),
	);
	const columnShape = (column: ExpectedColumn) => ({
		type: column.type,
		notNull: column.notNull,
		primaryKey: column.primaryKey,
		// Expression defaults are compared verbatim against server canonical text below.
		default: expressionDefaults.has(`${column.table}.${column.name}`)
			? null
			: normDefault(column.type, column.default),
		generated: column.generated === null ? null : { stored: column.generated.stored },
		// The sequences facet pins the backing sequence and ownership; this pins the kind.
		identity: column.identity === null ? null : column.identity.type,
	});
	diffKeyed(
		"column",
		new Map(expected.columns.map((c) => [`${c.table}.${c.name}`, columnShape(c)])),
		new Map(actual.columns.map((c) => [`${c.table}.${c.name}`, columnShape(c)])),
		problems,
	);

	for (const column of expressionDefaults.values()) {
		// The filter above excludes null; keeping the guard makes this narrowing explicit.
		if (column.default === null) continue;
		const want = canonical.get(deparseKey("default", column.table, column.default, column.type));
		const got = actual.columns.find(
			(entry) => entry.table === column.table && entry.name === column.name,
		)?.default;
		if (want === undefined) {
			problems.push(`default ${column.table}.${column.name}: no canonical form available`);
		} else if (got !== want) {
			problems.push(
				`default ${column.table}.${column.name}: expected ${clip(want)}, got ${clip(got ?? null)}`,
			);
		}
	}

	// Generated expressions are compared against the server's deparse of the committed text.
	for (const column of expected.columns) {
		if (column.generated === null) continue;
		const want = canonical.get(deparseKey("generated", column.table, column.generated.as));
		const got = actual.columns.find(
			(entry) => entry.table === column.table && entry.name === column.name,
		)?.generated?.as;
		if (want === undefined) {
			problems.push(`generated ${column.table}.${column.name}: no canonical form available`);
		} else if (got !== want) {
			problems.push(
				`generated ${column.table}.${column.name}: expected ${clip(want)}, got ${clip(got ?? null)}`,
			);
		}
	}

	const fkShape = (fk: SnapshotForeignKey) => ({
		tableFrom: fk.tableFrom,
		tableTo: fk.tableTo,
		columnsFrom: fk.columnsFrom,
		columnsTo: fk.columnsTo,
		onDelete: fk.onDelete,
		onUpdate: fk.onUpdate,
	});
	diffKeyed(
		"foreign key",
		new Map(expected.foreignKeys.map((fk) => [fk.name, fkShape(fk)])),
		new Map(actual.foreignKeys.map((fk) => [fk.name, fkShape(fk)])),
		problems,
	);
	for (const fk of actual.foreignKeys) {
		// A dropped column (say from a mis-bound ordinality join) shortens the aggregated list
		// without changing the constraint, so the server's own key length is checked too.
		if (fk.columnsFrom.length !== fk.columnCount) {
			problems.push(
				`foreign key ${fk.name}: ${fk.columnsFrom.length} of ${fk.columnCount} referencing columns resolved`,
			);
		}
		if (fk.columnsTo.length !== fk.refColumnCount) {
			problems.push(
				`foreign key ${fk.name}: ${fk.columnsTo.length} of ${fk.refColumnCount} referenced columns resolved`,
			);
		}
	}

	const indexKey = (index: { table: string; name: string }) => `${index.table}.${index.name}`;
	diffKeyed(
		"index",
		new Map(
			expected.indexes.map((index) => [
				indexKey(index),
				{
					columns: index.columns,
					isUnique: index.isUnique,
					method: index.method,
					where:
						index.where === null
							? null
							: (canonical.get(deparseKey("predicate", index.table, index.where)) ??
								`<no canonical form for ${index.where}>`),
					nullsNotDistinct: index.nullsNotDistinct,
					constraintBacked: index.constraintBacked,
				},
			]),
		),
		new Map(
			actual.indexes.map((index) => [
				indexKey(index),
				{
					columns: index.columns,
					isUnique: index.isUnique,
					method: index.method,
					where: index.where,
					nullsNotDistinct: index.nullsNotDistinct,
					constraintBacked: index.constraintBacked,
				},
			]),
		),
		problems,
	);
	for (const index of actual.indexes) {
		if (index.columns.length !== index.totalColumnCount) {
			problems.push(
				`index ${indexKey(index)}: ${index.columns.length} of ${index.totalColumnCount} columns resolved`,
			);
		}
		if (index.keyColumnCount !== index.totalColumnCount) {
			problems.push(`index ${indexKey(index)}: INCLUDE columns are not covered by this gate`);
		}
		if (index.options.some((option) => option !== 0)) {
			problems.push(`index ${indexKey(index)}: non-default key ordering ${clip(index.options)}`);
		}
	}

	const uniqueShape = (unique: ExpectedUnique) => ({
		table: unique.table,
		columns: unique.columns,
		nullsNotDistinct: unique.nullsNotDistinct,
	});
	diffKeyed(
		"unique constraint",
		new Map(expected.uniques.map((unique) => [unique.name, uniqueShape(unique)])),
		new Map(actual.uniques.map((unique) => [unique.name, uniqueShape(unique)])),
		problems,
	);
	for (const unique of actual.uniques) {
		if (unique.columns.length !== unique.columnCount) {
			problems.push(
				`unique constraint ${unique.name}: ${unique.columns.length} of ${unique.columnCount} columns resolved`,
			);
		}
	}

	diffKeyed(
		"check constraint",
		new Map(
			expected.checks.map((check) => [
				check.name,
				{
					table: check.table,
					definition:
						canonical.get(deparseKey("check", check.table, check.value)) ??
						`<no canonical form for ${check.name}>`,
				},
			]),
		),
		new Map(
			actual.checks.map((check) => [
				check.name,
				{ table: check.table, definition: check.definition },
			]),
		),
		problems,
	);

	// Generated columns are also listed by their own facet, so a column the column facet
	// misread cannot slip past unnoticed.
	diffKeyed(
		"generated column",
		new Map(
			expected.columns
				.filter((column) => column.generated !== null)
				.map((column) => [`${column.table}.${column.name}`, { kind: "s", type: column.type }]),
		),
		new Map(
			actual.generated.map((entry) => [
				`${entry.table}.${entry.name}`,
				{ kind: entry.kind, type: entry.type },
			]),
		),
		problems,
	);

	// Identity backing sequences: name, owning column and every sequence parameter.
	diffKeyed(
		"sequence",
		new Map(
			expected.sequences.map((sequence) => [
				sequence.name,
				{
					ownerTable: sequence.ownerTable,
					ownerColumn: sequence.ownerColumn,
					start: sequence.start,
					increment: sequence.increment,
					min: sequence.min,
					max: sequence.max,
					cache: sequence.cache,
					cycle: sequence.cycle,
				},
			]),
		),
		new Map(
			actual.sequences.map((sequence) => [
				sequence.name,
				{
					ownerTable: sequence.ownerTable,
					ownerColumn: sequence.ownerColumn,
					start: sequence.start,
					increment: sequence.increment,
					min: sequence.min,
					max: sequence.max,
					cache: sequence.cache,
					cycle: sequence.cycle,
				},
			]),
		),
		problems,
	);

	// Server-reported totals, so a facet that silently returned nothing cannot pass.
	for (const [key, value] of Object.entries(expected.counts) as Array<
		[keyof BaselineCounts, number]
	>) {
		const reported = serverCounts[key];
		if (reported === undefined) {
			problems.push(`count ${key}: server reported nothing`);
			continue;
		}
		if (Number(reported) !== value) {
			problems.push(`count ${key}: expected ${value}, server reported ${reported}`);
		}
	}
	if (Number(serverCounts.nonTableRelations ?? 0) !== 0) {
		problems.push(
			`public schema holds ${serverCounts.nonTableRelations} relations that are neither tables nor indexes`,
		);
	}

	return problems;
}
