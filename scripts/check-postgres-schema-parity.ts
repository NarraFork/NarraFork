import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_LOCALE } from "../shared/i18n-locales";
import {
	autoForeignKeyName,
	generatePostgresSchema,
	jsonTextDefault,
	PG_IDENTIFIER_LIMIT,
	PG_ONLY_IDENTITY_COLUMNS,
	shortenConstraintName,
} from "./generate-postgres-schema";

/**
 * The raw shape emitted by the generator and committed verbatim into the manifest. Both sides
 * are parsed into this shape and normalised by the same code path on purpose: the earlier
 * version of this checker had one hand-written projection per side, and any field neither
 * projection mentioned (every column-level `references`, every constraint name, both emission
 * flags) silently left the comparison. Field coverage is asserted instead of assumed, so a new
 * generator field fails parity rather than escaping it.
 */
export type RawReference = {
	table: string;
	column: string;
	onDelete?: string;
	onUpdate?: string;
	constraintName?: string;
};
export type RawColumn = {
	property: string;
	name: string;
	kind: string;
	mode?: string;
	pgType: string;
	notNull: boolean;
	primary: boolean;
	unique: boolean;
	uniqueName?: string;
	defaultValue?: string;
	defaultExpression?: string;
	references?: RawReference;
	emitAsTableConstraint?: boolean;
	generated?: { expression: string; sourceMode: string; mode: string };
	identity?: { type: string };
};
export type RawIndex = {
	name: string;
	columns: string[];
	unique: boolean;
	predicate?: string;
	emitAsUniqueConstraint?: boolean;
};
export type RawNamedConstraint = { name?: string; columns: string[] };
export type RawTableForeignKey = { name?: string; columns: string[]; references: RawReference[] };
export type RawTable = {
	exportName: string;
	name: string;
	columns: RawColumn[];
	indexes: RawIndex[];
	checks: string[];
	checkDefinitions: { name: string; expression: string }[];
	foreignKeys: RawTableForeignKey[];
	uniqueConstraints: RawNamedConstraint[];
	primaryKeys: RawNamedConstraint[];
};
export type RawCoverage = {
	tableCount: number;
	columnCount: number;
	tables: RawTable[];
	unsupported?: string[];
};

const COVERAGE_KEYS = new Set(["tableCount", "columnCount", "tables", "unsupported"]);
const TABLE_KEYS = new Set([
	"exportName",
	"name",
	"columns",
	"indexes",
	"checks",
	"checkDefinitions",
	"foreignKeys",
	"uniqueConstraints",
	"primaryKeys",
]);
const COLUMN_KEYS = new Set([
	"property",
	"name",
	"kind",
	"mode",
	"pgType",
	"notNull",
	"primary",
	"unique",
	"uniqueName",
	"defaultValue",
	"defaultExpression",
	"references",
	"emitAsTableConstraint",
	"generated",
	"identity",
]);
const INDEX_KEYS = new Set(["name", "columns", "unique", "predicate", "emitAsUniqueConstraint"]);
const REFERENCE_KEYS = new Set(["table", "column", "onDelete", "onUpdate", "constraintName"]);
const TABLE_FK_KEYS = new Set(["name", "columns", "references"]);
const NAMED_CONSTRAINT_KEYS = new Set(["name", "columns"]);
const GENERATED_KEYS = new Set(["expression", "sourceMode", "mode"]);
const IDENTITY_KEYS = new Set(["type"]);
const CHECK_DEFINITION_KEYS = new Set(["name", "expression"]);

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

/**
 * Collapse whitespace runs between SQL tokens, which is the only difference this checker can
 * prove is formatting. Whitespace inside a single-quoted literal is data and whitespace inside
 * a double-quoted identifier is part of the name, so both spans are copied through untouched.
 * Nothing else is normalised. The previous implementation also lower-cased the whole expression
 * and stripped a leading/trailing paren pair, which made `'active'` and `'ACTIVE'` compare
 * equal (two different PostgreSQL values) and could rewrite `(a) AND (b)` into `a) AND (b`.
 */
export function normalizeSqlExpression(value: string): string {
	let out = "";
	let quote: "'" | '"' | null = null;
	for (const character of value) {
		if (quote) {
			out += character;
			if (character === quote) quote = null;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			out += character;
			continue;
		}
		if (/\s/.test(character)) {
			if (!out.endsWith(" ")) out += " ";
			continue;
		}
		out += character;
	}
	return out.trim();
}
const normExpression = (value: string | null | undefined) =>
	value == null ? null : normalizeSqlExpression(value);
/** Referential actions are a closed lowercase vocabulary, so case is provably formatting. */
const normAction = (value: string | null | undefined) => value?.toLowerCase() ?? null;

export type NormalizedForeignKey = {
	name: string;
	/** How the constraint reaches PostgreSQL; the three forms emit different DDL. */
	emission: "column-reference" | "column-table-constraint" | "table-constraint";
	columns: string[];
	targetTable: string;
	targetColumns: string[];
	onDelete: string | null;
	onUpdate: string | null;
};
export type NormalizedColumn = {
	property: string;
	name: string;
	kind: string;
	mode: string | null;
	pgType: string;
	notNull: boolean;
	primary: boolean;
	unique: boolean;
	uniqueName: string | null;
	defaultValue: string | null;
	defaultExpression: string | null;
	hasDefault: boolean;
	emitAsTableConstraint: boolean;
	generated: { expression: string; sourceMode: string; mode: string } | null;
	identity: "byDefault" | "always" | null;
};
export type NormalizedIndex = {
	name: string;
	columns: string[];
	unique: boolean;
	predicate: string | null;
	emitAsUniqueConstraint: boolean;
};
export type NormalizedTable = {
	exportName: string;
	name: string;
	columns: NormalizedColumn[];
	indexes: NormalizedIndex[];
	checks: string[];
	checkDefinitions: { name: string; expression: string }[];
	foreignKeys: NormalizedForeignKey[];
	uniqueConstraints: { name: string | null; columns: string[] }[];
	primaryKeys: { name: string | null; columns: string[] }[];
};
export type NormalizedCoverage = {
	tableCount: number;
	columnCount: number;
	tables: NormalizedTable[];
	unsupported: string[];
};

function auditKeys(object: object, allowed: Set<string>, label: string, errors: string[]) {
	for (const key of Object.keys(object))
		if (!allowed.has(key)) errors.push(`${label}: unhandled schema field "${key}"`);
}

/** `sql.raw("<literal>")`; the argument is a JSON string literal in the generated source. */
const RAW_SQL_CALL = /^sql\.raw\((".*")\)$/s;
/** A PostgreSQL text literal with doubled single quotes, cast so the codec reads it back. */
const ENCODED_TEXT_LITERAL = /^'(?:[^']|'')*'::text$/;

/**
 * A json-mode column stores JSON in a text column, so its default has to arrive already
 * encoded and quoted. A bare JS array or object would be encoded a second time on write, or
 * emitted by Drizzle Kit as an unquoted value the column cannot hold, and neither failure is
 * visible in a shape-only comparison.
 */
function checkJsonDefault(column: RawColumn, label: string, errors: string[]) {
	if (column.mode !== "json" || column.defaultExpression === undefined) return;
	const call = RAW_SQL_CALL.exec(column.defaultExpression);
	let literal: string | null = null;
	if (call?.[1]) {
		try {
			const parsed: unknown = JSON.parse(call[1]);
			if (typeof parsed === "string") literal = parsed;
		} catch {
			literal = null;
		}
	}
	if (literal === null || !ENCODED_TEXT_LITERAL.test(literal)) {
		errors.push(
			`${label}: json default must be an encoded text literal via sql.raw, got ${column.defaultExpression}`,
		);
		return;
	}
	if (column.defaultValue === undefined) return;
	let declared: unknown;
	try {
		declared = JSON.parse(column.defaultValue);
	} catch {
		return; // The declared default is not a JSON literal; the encoded shape above still holds.
	}
	const expected = jsonTextDefault(declared);
	if (expected !== literal)
		errors.push(
			`${label}: json default ${literal} does not encode ${column.defaultValue} exactly once (expected ${expected})`,
		);
}

/**
 * Parse and check one side. Returned errors are invariants of that side alone (identifier
 * limits, constraint-name collisions, encoded json defaults, foreign keys whose target has no
 * usable unique constraint); differences between the two sides are reported by the comparison.
 */
export function normalizeCoverage(
	raw: RawCoverage,
	origin: string,
): { coverage: NormalizedCoverage; errors: string[] } {
	const errors: string[] = [];
	auditKeys(raw, COVERAGE_KEYS, origin, errors);
	const byExport = new Map(raw.tables.map((table) => [table.exportName, table]));
	const physicalColumn = (table: RawTable, property: string) =>
		table.columns.find((column) => column.property === property)?.name;

	const resolveReference = (
		reference: RawReference,
		label: string,
	): { table: string; column: string } => {
		const target = byExport.get(reference.table);
		if (!target) {
			errors.push(`${label}: foreign key target table "${reference.table}" does not exist`);
			return { table: `__unknown__:${reference.table}`, column: reference.column };
		}
		const column = physicalColumn(target, reference.column);
		if (!column) {
			errors.push(
				`${label}: foreign key target column "${reference.table}.${reference.column}" does not exist`,
			);
			return { table: target.name, column: `__unknown__:${reference.column}` };
		}
		return { table: target.name, column };
	};

	const constraintOwners = new Map<string, string[]>();
	const claimConstraintName = (name: string, label: string) => {
		if (byteLength(name) > PG_IDENTIFIER_LIMIT)
			errors.push(
				`${label}: foreign key name exceeds ${PG_IDENTIFIER_LIMIT} bytes (${byteLength(name)}): ${name}`,
			);
		const owners = constraintOwners.get(name) ?? [];
		owners.push(label);
		constraintOwners.set(name, owners);
	};

	const tables: NormalizedTable[] = [];
	for (const table of raw.tables) {
		auditKeys(table, TABLE_KEYS, `${origin} ${table.name}`, errors);
		const columns: NormalizedColumn[] = [];
		const foreignKeys: NormalizedForeignKey[] = [];
		for (const column of table.columns) {
			const label = `${origin} ${table.name}.${column.name}`;
			auditKeys(column, COLUMN_KEYS, label, errors);
			if (column.generated) auditKeys(column.generated, GENERATED_KEYS, label, errors);
			if (column.identity) {
				auditKeys(column.identity, IDENTITY_KEYS, label, errors);
				if (column.identity.type !== "byDefault" && column.identity.type !== "always") {
					errors.push(`${label}: unknown identity type ${column.identity.type}`);
				}
				if (column.identity.type === "always") {
					// BY DEFAULT is deliberate for the insertion ordinals: a SQLite→PG data
					// migration must INSERT explicit backfilled values, which ALWAYS rejects.
					errors.push(`${label}: GENERATED ALWAYS AS IDENTITY is not an accepted mapping`);
				}
			}
			checkJsonDefault(column, label, errors);
			columns.push({
				property: column.property,
				name: column.name,
				kind: column.kind,
				mode: column.mode ?? null,
				pgType: column.pgType,
				notNull: !!column.notNull,
				primary: !!column.primary,
				unique: !!column.unique,
				uniqueName: column.uniqueName ?? null,
				defaultValue: column.defaultValue ?? null,
				defaultExpression: normExpression(column.defaultExpression),
				hasDefault: column.defaultExpression !== undefined,
				emitAsTableConstraint: !!column.emitAsTableConstraint,
				generated: column.generated
					? {
							expression: normalizeSqlExpression(column.generated.expression),
							sourceMode: column.generated.sourceMode,
							mode: column.generated.mode,
						}
					: null,
				identity:
					column.identity?.type === "byDefault"
						? "byDefault"
						: column.identity?.type === "always"
							? "always"
							: null,
			});
			if (!column.references) continue;
			auditKeys(column.references, REFERENCE_KEYS, `${label} references`, errors);
			const target = resolveReference(column.references, label);
			const name = column.references.constraintName;
			if (!name) {
				errors.push(`${label}: column reference has no resolved constraint name`);
				continue;
			}
			claimConstraintName(name, label);
			// A column-level reference cannot carry an authored name, so its effective name is
			// always derived. Checking the derivation (rather than trusting the recorded string)
			// is what makes a renamed or truncated constraint name fail.
			const logical = autoForeignKeyName(table.name, [column.name], target.table, [target.column]);
			const expected = shortenConstraintName(logical);
			if (name !== expected)
				errors.push(`${label}: foreign key name ${name} does not match derived ${expected}`);
			// Only a table-level foreignKey() accepts an explicit name, so a shortened name must
			// be emitted as a table constraint or PostgreSQL gets the unshortened auto name back.
			const shouldEmitAsTableConstraint = expected !== logical;
			if (!!column.emitAsTableConstraint !== shouldEmitAsTableConstraint)
				errors.push(
					`${label}: emitAsTableConstraint must be ${shouldEmitAsTableConstraint} for name ${name}`,
				);
			foreignKeys.push({
				name,
				emission: column.emitAsTableConstraint ? "column-table-constraint" : "column-reference",
				columns: [column.name],
				targetTable: target.table,
				targetColumns: [target.column],
				onDelete: normAction(column.references.onDelete),
				onUpdate: normAction(column.references.onUpdate),
			});
		}
		for (const [position, foreignKey] of (table.foreignKeys ?? []).entries()) {
			const label = `${origin} ${table.name} foreignKey#${position}`;
			auditKeys(foreignKey, TABLE_FK_KEYS, label, errors);
			const name = foreignKey.name;
			if (!name) {
				errors.push(`${label}: table foreign key has no resolved constraint name`);
				continue;
			}
			claimConstraintName(name, label);
			const targets = foreignKey.references.map((reference) => {
				auditKeys(reference, REFERENCE_KEYS, `${label} reference`, errors);
				return resolveReference(reference, label);
			});
			const distinct = new Set(targets.map((target) => target.table));
			if (distinct.size > 1)
				errors.push(
					`${label}: foreign key spans multiple target tables ${[...distinct].join(", ")}`,
				);
			foreignKeys.push({
				name,
				emission: "table-constraint",
				columns: foreignKey.columns.map(
					(property) => physicalColumn(table, property) ?? `__unknown__:${property}`,
				),
				targetTable: targets[0]?.table ?? "",
				targetColumns: targets.map((target) => target.column),
				onDelete: normAction(foreignKey.references[0]?.onDelete),
				onUpdate: normAction(foreignKey.references[0]?.onUpdate),
			});
		}
		const indexes: NormalizedIndex[] = [];
		for (const index of table.indexes) {
			const label = `${origin} ${table.name}/${index.name}`;
			auditKeys(index, INDEX_KEYS, label, errors);
			if (index.emitAsUniqueConstraint && (!index.unique || index.predicate))
				errors.push(`${label}: emitAsUniqueConstraint requires an unconditional unique index`);
			indexes.push({
				name: index.name,
				columns: index.columns.map((property) => {
					const resolved = physicalColumn(table, property);
					if (!resolved) errors.push(`${label}: index column "${property}" does not exist`);
					return resolved ?? `__unknown__:${property}`;
				}),
				unique: !!index.unique,
				predicate: normExpression(index.predicate),
				emitAsUniqueConstraint: !!index.emitAsUniqueConstraint,
			});
		}
		for (const definition of table.checkDefinitions ?? [])
			auditKeys(definition, CHECK_DEFINITION_KEYS, `${origin} ${table.name}`, errors);
		for (const constraint of [...(table.uniqueConstraints ?? []), ...(table.primaryKeys ?? [])])
			auditKeys(constraint, NAMED_CONSTRAINT_KEYS, `${origin} ${table.name}`, errors);
		tables.push({
			exportName: table.exportName,
			name: table.name,
			columns,
			indexes,
			checks: [...(table.checks ?? [])].sort(),
			checkDefinitions: (table.checkDefinitions ?? [])
				.map((definition) => ({
					name: definition.name,
					expression: normalizeSqlExpression(definition.expression),
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
			foreignKeys: foreignKeys.sort((a, b) => a.name.localeCompare(b.name)),
			uniqueConstraints: (table.uniqueConstraints ?? []).map((constraint) => ({
				name: constraint.name ?? null,
				columns: constraint.columns,
			})),
			primaryKeys: (table.primaryKeys ?? []).map((constraint) => ({
				name: constraint.name ?? null,
				columns: constraint.columns,
			})),
		});
	}
	for (const [name, owners] of constraintOwners)
		if (owners.length > 1)
			errors.push(`${origin}: foreign key name collision ${name}: ${owners.sort().join(", ")}`);

	// Drizzle Kit emits every CREATE INDEX after all ALTER TABLE ADD CONSTRAINT statements, so a
	// foreign key whose target is only covered by a unique index fails to apply. The covering
	// index must be declared as a table unique constraint. Recomputing the requirement here is
	// what keeps a dropped emitAsUniqueConstraint from passing parity.
	const byName = new Map(tables.map((table) => [table.name, table]));
	for (const table of tables) {
		for (const foreignKey of table.foreignKeys) {
			const target = byName.get(foreignKey.targetTable);
			if (!target) continue;
			for (const column of foreignKey.targetColumns) {
				const targetColumn = target.columns.find((item) => item.name === column);
				if (!targetColumn || targetColumn.primary || targetColumn.unique) continue;
				const covering = target.indexes.find(
					(index) =>
						index.unique &&
						!index.predicate &&
						index.columns.length === 1 &&
						index.columns[0] === column,
				);
				if (!covering)
					errors.push(
						`${origin}: ${foreignKey.name} targets ${target.name}.${column} with no unique constraint`,
					);
				else if (!covering.emitAsUniqueConstraint)
					errors.push(
						`${origin}: ${target.name}/${covering.name} backs ${foreignKey.name} and must set emitAsUniqueConstraint`,
					);
			}
		}
	}

	const columnCount = tables.reduce((count, table) => count + table.columns.length, 0);
	if (raw.tableCount !== tables.length)
		errors.push(`${origin}: tableCount ${raw.tableCount} does not match ${tables.length} tables`);
	if (raw.columnCount !== columnCount)
		errors.push(`${origin}: columnCount ${raw.columnCount} does not match ${columnCount} columns`);
	return {
		coverage: {
			tableCount: raw.tableCount,
			columnCount: raw.columnCount,
			tables: tables.sort((a, b) => a.name.localeCompare(b.name)),
			unsupported: [...(raw.unsupported ?? [])],
		},
		errors,
	};
}

const signature = (value: unknown) => JSON.stringify(value);

function compareLists<T>(
	expected: T[],
	actual: T[],
	label: (item: T) => string,
	kind: string,
	errors: string[],
) {
	const expectedByKey = new Map(expected.map((item) => [signature(item), item]));
	const actualKeys = new Set(actual.map(signature));
	for (const [key, item] of expectedByKey)
		if (!actualKeys.has(key)) errors.push(`missing ${kind} ${label(item)}`);
	for (const item of actual)
		if (!expectedByKey.has(signature(item))) errors.push(`unexpected ${kind} ${label(item)}`);
}

/**
 * Compare the generated source of truth against the committed manifest. Both arguments are the
 * raw generator shape; normalising inside means no caller can compare a half-populated
 * projection, which is how the earlier signatures went blind.
 */
export function validateCoverage(expected: RawCoverage, actual: RawCoverage): string[] {
	const source = normalizeCoverage(expected, "source");
	const target = normalizeCoverage(actual, "target");
	const errors = [...source.errors, ...target.errors];
	const expectedTables = new Map(source.coverage.tables.map((table) => [table.name, table]));
	const actualTables = new Map(target.coverage.tables.map((table) => [table.name, table]));
	for (const [name, expectedTable] of expectedTables) {
		const actualTable = actualTables.get(name);
		if (!actualTable) {
			errors.push(`missing table ${name}`);
			continue;
		}
		if (expectedTable.exportName !== actualTable.exportName)
			errors.push(`table export mismatch ${name}`);
		const actualColumns = new Map(actualTable.columns.map((column) => [column.name, column]));
		for (const column of expectedTable.columns) {
			const actualColumn = actualColumns.get(column.name);
			if (!actualColumn) errors.push(`missing column ${name}.${column.name}`);
			else if (signature(column) !== signature(actualColumn))
				errors.push(`column mismatch ${name}.${column.name}`);
		}
		for (const column of actualTable.columns)
			if (!expectedTable.columns.some((item) => item.name === column.name))
				errors.push(`unexpected column ${name}.${column.name}`);
		compareLists(
			expectedTable.indexes,
			actualTable.indexes,
			(index) => `${name}/${index.name}`,
			"index",
			errors,
		);
		compareLists(
			expectedTable.foreignKeys,
			actualTable.foreignKeys,
			(foreignKey) => `${name}/${foreignKey.name}`,
			"foreign key",
			errors,
		);
		compareLists(
			expectedTable.checkDefinitions,
			actualTable.checkDefinitions,
			(definition) => `${name}/${definition.name}`,
			"check",
			errors,
		);
		compareLists(
			expectedTable.uniqueConstraints,
			actualTable.uniqueConstraints,
			(constraint) => `${name}/${constraint.name ?? constraint.columns.join(",")}`,
			"unique constraint",
			errors,
		);
		compareLists(
			expectedTable.primaryKeys,
			actualTable.primaryKeys,
			(constraint) => `${name}/${constraint.name ?? constraint.columns.join(",")}`,
			"primary key",
			errors,
		);
		if (signature(expectedTable.checks) !== signature(actualTable.checks))
			errors.push(`check name mismatch ${name}`);
	}
	for (const name of actualTables.keys())
		if (!expectedTables.has(name)) errors.push(`unexpected table ${name}`);
	if (expectedTables.size !== actualTables.size)
		errors.push(`table set size mismatch ${actualTables.size}/${expectedTables.size}`);
	if (source.coverage.tableCount !== target.coverage.tableCount)
		errors.push(`tableCount mismatch ${target.coverage.tableCount}/${source.coverage.tableCount}`);
	if (source.coverage.columnCount !== target.coverage.columnCount)
		errors.push(
			`columnCount mismatch ${target.coverage.columnCount}/${source.coverage.columnCount}`,
		);
	if (target.coverage.unsupported.length)
		errors.push(`unsupported mappings: ${target.coverage.unsupported.join(", ")}`);
	return errors;
}

export function loadManifest(): RawCoverage {
	const source = readFileSync(resolve(import.meta.dir, "../server/db/postgres-schema.ts"), "utf8");
	const marker = "export const POSTGRES_SCHEMA_COVERAGE = ";
	const start = source.indexOf(marker);
	const end = source.lastIndexOf(" as const;");
	if (start < 0 || end < 0) throw new Error("generated coverage manifest missing");
	return JSON.parse(source.slice(start + marker.length, end)) as RawCoverage;
}
function latestSnapshotPath(dir: string): string {
	const files = readdirSync(dir)
		.filter((file) => /^\d+_snapshot\.json$/.test(file))
		.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
	if (!files.length) throw new Error(`no snapshots in ${dir}`);
	const latest = files.at(-1);
	if (!latest) throw new Error(`no snapshots in ${dir}`);
	return resolve(dir, latest);
}
export function loadSource(): RawCoverage {
	const snapshotPath = latestSnapshotPath(resolve(import.meta.dir, "../drizzle/meta"));
	const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
		tables: Record<string, { columns: Record<string, unknown> }>;
	};
	const snapshotShape = {
		tables: Object.keys(snapshot.tables).length,
		columns: Object.values(snapshot.tables).reduce(
			(count, table) => count + Object.keys(table.columns).length,
			0,
		),
	};
	const generated = generatePostgresSchema(
		readFileSync(resolve(import.meta.dir, "../server/db/schema.ts"), "utf8"),
		{ DEFAULT_LOCALE },
		PG_ONLY_IDENTITY_COLUMNS,
	).coverage;
	if (
		snapshotShape.tables !== generated.tableCount ||
		snapshotShape.columns !== generated.columnCount - PG_ONLY_IDENTITY_COLUMNS.length
	)
		throw new Error(
			`SQLite source/snapshot shape mismatch: ${snapshotShape.tables}/${snapshotShape.columns}`,
		);
	// Counts alone cannot catch replacing a column. Verify exact physical names, excluding PG overlays.
	for (const table of generated.tables) {
		const columns = table.columns
			.filter(
				(column) =>
					!PG_ONLY_IDENTITY_COLUMNS.some(
						(overlay) => overlay.table === table.exportName && overlay.name === column.name,
					),
			)
			.map((column) => column.name)
			.sort();
		const snap = snapshot.tables[table.name];
		if (!snap || JSON.stringify(columns) !== JSON.stringify(Object.keys(snap.columns).sort()))
			throw new Error(`SQLite source/snapshot columns mismatch: ${table.name}`);
	}
	return generated as RawCoverage;
}

/**
 * Every rule this checker claims to enforce is paired with a mutation of the real manifest that
 * must make parity fail. The mutations run on every parity check, so a rule that stops working
 * is reported instead of quietly passing. Each mutation throws when it cannot find its target,
 * so it cannot decay into a no-op that looks like a passing rule.
 */
export type ParityMutation = { name: string; apply: (target: RawCoverage) => void };

function findColumn(
	target: RawCoverage,
	predicate: (column: RawColumn, table: RawTable) => boolean,
	description: string,
): { table: RawTable; column: RawColumn } {
	for (const table of target.tables)
		for (const column of table.columns) if (predicate(column, table)) return { table, column };
	throw new Error(`manifest has no ${description}`);
}
function findIndex(
	target: RawCoverage,
	predicate: (index: RawIndex, table: RawTable) => boolean,
	description: string,
): { table: RawTable; index: RawIndex } {
	for (const table of target.tables)
		for (const index of table.indexes) if (predicate(index, table)) return { table, index };
	throw new Error(`manifest has no ${description}`);
}

export const PARITY_MUTATIONS: ParityMutation[] = [
	{
		name: "table foreign key retargeted",
		apply: (target) => {
			const table = target.tables.find((item) => item.foreignKeys.length);
			if (!table) throw new Error("manifest has no table-level foreign key");
			table.foreignKeys = [
				{
					name: "fk_synthetic",
					columns: [table.columns[0]?.property ?? "id"],
					references: [{ table: "__missing__", column: "id", onDelete: "cascade" }],
				},
			];
		},
	},
	{
		name: "index column changed",
		apply: (target) => {
			const { index } = findIndex(target, () => true, "index");
			index.columns = ["__missing__"];
		},
	},
	{
		name: "default expression changed",
		apply: (target) => {
			const { column } = findColumn(
				target,
				(item) => item.defaultExpression !== undefined && item.mode !== "json",
				"non-json column default",
			);
			column.defaultExpression = '"__changed__"';
		},
	},
	{
		name: "default expression case changed",
		apply: (target) => {
			const { column } = findColumn(
				target,
				(item) => item.defaultExpression !== undefined && /[a-z]/.test(item.defaultExpression),
				"lowercase column default",
			);
			column.defaultExpression = column.defaultExpression?.toUpperCase();
		},
	},
	{
		name: "default removed",
		apply: (target) => {
			const { column } = findColumn(
				target,
				(item) => item.defaultExpression !== undefined,
				"column default",
			);
			delete column.defaultExpression;
			delete column.defaultValue;
		},
	},
	{
		name: "nullability flipped",
		apply: (target) => {
			const column = target.tables[0]?.columns[0];
			if (!column) throw new Error("manifest has no columns");
			column.notNull = !column.notNull;
		},
	},
	{
		name: "generated expression changed",
		apply: (target) => {
			const { column } = findColumn(target, (item) => !!item.generated, "generated column");
			if (column.generated) column.generated.expression = "__changed_generated__";
		},
	},
	{
		name: "pgType widened within its type family",
		apply: (target) => {
			const { column } = findColumn(target, (item) => item.pgType === "bigint", "bigint column");
			column.pgType = "integer";
		},
	},
	{
		name: "all foreign key names rewritten",
		apply: (target) => {
			let renamed = 0;
			for (const table of target.tables) {
				for (const column of table.columns) {
					if (!column.references?.constraintName) continue;
					column.references.constraintName = `zzz_${column.references.constraintName}`;
					renamed++;
				}
				for (const foreignKey of table.foreignKeys) {
					if (!foreignKey.name) continue;
					foreignKey.name = `zzz_${foreignKey.name}`;
					for (const reference of foreignKey.references) reference.constraintName = foreignKey.name;
					renamed++;
				}
			}
			if (!renamed) throw new Error("manifest has no foreign key names");
		},
	},
	{
		name: "foreign key name over the identifier limit",
		apply: (target) => {
			const { column } = findColumn(
				target,
				(item) => !!item.references?.constraintName,
				"column reference",
			);
			if (column.references) column.references.constraintName = "x".repeat(70);
		},
	},
	{
		name: "foreign key names collide after shortening",
		apply: (target) => {
			const names: RawReference[] = [];
			for (const table of target.tables)
				for (const column of table.columns)
					if (column.references?.constraintName) names.push(column.references);
			const [first, second] = names;
			if (!first || !second) throw new Error("manifest has fewer than two column references");
			second.constraintName = first.constraintName;
		},
	},
	{
		name: "emitAsTableConstraint dropped",
		apply: (target) => {
			let dropped = 0;
			for (const table of target.tables)
				for (const column of table.columns)
					if (column.emitAsTableConstraint) {
						delete column.emitAsTableConstraint;
						dropped++;
					}
			if (!dropped) throw new Error("manifest has no emitAsTableConstraint column");
		},
	},
	{
		name: "emitAsUniqueConstraint dropped",
		apply: (target) => {
			let dropped = 0;
			for (const table of target.tables)
				for (const index of table.indexes)
					if (index.emitAsUniqueConstraint) {
						delete index.emitAsUniqueConstraint;
						dropped++;
					}
			if (!dropped) throw new Error("manifest has no emitAsUniqueConstraint index");
		},
	},
	{
		name: "column reference target rewritten",
		apply: (target) => {
			const { column } = findColumn(target, (item) => !!item.references, "column reference");
			if (column.references) column.references.table = "__missing__";
		},
	},
	{
		name: "column reference action dropped",
		apply: (target) => {
			const { column } = findColumn(
				target,
				(item) => !!item.references?.onDelete,
				"column reference with onDelete",
			);
			if (column.references) delete column.references.onDelete;
		},
	},
	{
		name: "json default replaced with a bare JS value",
		apply: (target) => {
			const { column } = findColumn(
				target,
				(item) => item.mode === "json" && item.defaultExpression !== undefined,
				"json column default",
			);
			column.defaultExpression = column.defaultValue ?? "[]";
		},
	},
	{
		name: "json default encoded twice",
		apply: (target) => {
			const { column } = findColumn(
				target,
				(item) => item.mode === "json" && item.defaultExpression !== undefined,
				"json column default",
			);
			column.defaultExpression = `sql.raw(${JSON.stringify(jsonTextDefault(column.defaultValue ?? "[]"))})`;
		},
	},
	{
		name: "check definition expression changed",
		apply: (target) => {
			const table = target.tables.find((item) => item.checkDefinitions.length);
			if (!table) throw new Error("manifest has no check definitions");
			const definition = table.checkDefinitions[0];
			if (definition) definition.expression = "true";
		},
	},
	{
		name: "identity flag removed",
		apply: (target) => {
			const { column } = findColumn(target, (item) => !!item.identity, "identity column");
			delete column.identity;
		},
	},
	{
		name: "identity type flipped to always",
		apply: (target) => {
			const { column } = findColumn(target, (item) => !!item.identity, "identity column");
			if (column.identity) column.identity.type = "always";
		},
	},
	{
		name: "unrecognised schema field added",
		apply: (target) => {
			const column = target.tables[0]?.columns[0];
			if (!column) throw new Error("manifest has no columns");
			(column as Record<string, unknown>).__unhandled__ = true;
		},
	},
];

/** Run the comparison plus the negative mutations that prove each rule still bites. */
export function checkParity(source: RawCoverage, target: RawCoverage): string[] {
	const errors = validateCoverage(source, target);
	for (const mutation of PARITY_MUTATIONS) {
		const mutated = structuredClone(target);
		mutation.apply(mutated);
		if (!validateCoverage(source, mutated).length)
			errors.push(`negative mutation was not detected: ${mutation.name}`);
	}
	return errors;
}

if (import.meta.main) {
	const source = loadSource();
	const target = loadManifest();
	const errors = checkParity(source, target);
	if (errors.length)
		throw new Error(
			`PostgreSQL schema parity failed (${errors.length} differences):\n${errors.slice(0, 100).join("\n")}`,
		);
	console.log(
		JSON.stringify({
			sourceSnapshot: "drizzle/meta/latest",
			tables: target.tables.length,
			columns: target.tables.reduce((count, table) => count + table.columns.length, 0),
			negativeMutations: PARITY_MUTATIONS.length,
		}),
	);
}
