import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

export type Reference = {
	table: string;
	column: string;
	onDelete?: string;
	onUpdate?: string;
	/** Effective PostgreSQL constraint name; PG truncates anything longer than 63 bytes. */
	constraintName?: string;
};

/** PostgreSQL silently truncates identifiers at NAMEDATALEN-1 bytes instead of failing. */
export const PG_IDENTIFIER_LIMIT = 63;
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

/**
 * Deterministic shortening for names PostgreSQL would truncate. A truncated prefix alone
 * is not safe: several of these names share their first 63 bytes, so truncation can fuse
 * two different constraints into one identifier. The digest pins the full logical name,
 * and the retained prefix keeps the constraint recognisable.
 */
export function shortenConstraintName(logical: string, limit = PG_IDENTIFIER_LIMIT): string {
	if (byteLength(logical) <= limit) return logical;
	const suffix = `_${createHash("sha256").update(logical).digest("hex").slice(0, 10)}_fk`;
	const budget = limit - byteLength(suffix);
	if (budget <= 0) throw new Error(`identifier limit too small for ${logical}`);
	const base = logical.endsWith("_fk") ? logical.slice(0, -3) : logical;
	let prefix = "";
	for (const character of base) {
		if (byteLength(prefix + character) > budget) break;
		prefix += character;
	}
	return `${prefix.replace(/_+$/, "")}${suffix}`;
}

/** Drizzle's own auto-generated foreign key name, reproduced so we only override long ones. */
export function autoForeignKeyName(
	table: string,
	columns: string[],
	targetTable: string,
	targetColumns: string[],
): string {
	return `${[table, ...columns, targetTable, ...targetColumns].join("_")}_fk`;
}

/** Single JSON encoding, rendered as a PostgreSQL text literal the codec can read back. */
export function jsonTextDefault(value: unknown): string {
	return `'${JSON.stringify(value).replace(/'/g, "''")}'::text`;
}
export type Column = {
	property: string;
	name: string;
	kind: "text" | "integer" | "real";
	mode?: "json" | "boolean" | "timestamp_ms";
	pgType: string;
	notNull: boolean;
	primary: boolean;
	unique: boolean;
	uniqueName?: string;
	defaultValue?: string;
	defaultExpression?: string;
	references?: Reference;
	/**
	 * Column-level `.references()` cannot carry a constraint name, so a reference whose
	 * automatic name would exceed PostgreSQL's identifier limit is emitted as a named
	 * table-level foreign key instead. It stays a column reference in this manifest.
	 */
	emitAsTableConstraint?: boolean;
	generated?: { expression: string; sourceMode: string; mode: "stored" };
	/**
	 * GENERATED ... AS IDENTITY. Only "byDefault" occurs today: the insertion-ordinal
	 * columns accept explicit values so a SQLite→PG migration can backfill ordinals
	 * from rowids. "always" would reject those INSERTs outright.
	 */
	identity?: { type: "byDefault" | "always" };
};
export type Index = {
	name: string;
	columns: string[];
	unique: boolean;
	predicate?: string;
	/**
	 * Drizzle Kit emits every CREATE INDEX after all ALTER TABLE ADD CONSTRAINT statements,
	 * so a foreign key whose target is only covered by a unique index fails to apply. A
	 * unique index that a foreign key depends on is declared as a table unique constraint
	 * instead: it is created with the table, enforces the same uniqueness, and keeps the
	 * index name (PostgreSQL names the constraint's backing index after the constraint).
	 */
	emitAsUniqueConstraint?: boolean;
};
export type Table = {
	exportName: string;
	name: string;
	columns: Column[];
	indexes: Index[];
	checks: string[];
	checkDefinitions: { name: string; expression: string }[];
	foreignKeys: { name?: string; columns: string[]; references: Reference[] }[];
	uniqueConstraints: { name?: string; columns: string[] }[];
	primaryKeys: { name?: string; columns: string[] }[];
};
export class UnsupportedSchemaError extends Error {
	constructor(public readonly unsupported: string[]) {
		super(`Unsupported PostgreSQL schema mappings:\n${unsupported.join("\n")}`);
	}
}

/**
 * PostgreSQL-only identity columns: capabilities PostgreSQL needs that SQLite provides
 * implicitly, so the SQLite schema deliberately does not declare them.
 *
 * `insert_seq` is the insertion ordinal that replaces SQLite's `rowid` on the three
 * tables the legacy-publication boundary compares against a captured top ordinal
 * (see `server/services/agent-runtime/publication-outbox.ts` "THE INSERTION ORDINAL";
 * PostgreSQL has no rowid). Sequence-allocated at INSERT — never MAX+1, which is a
 * lost-update race without a unique constraint and cannot backfill migrated rows.
 * BY DEFAULT (not ALWAYS) is load-bearing: a SQLite→PG data migration backfills each
 * row's ordinal from its SQLite rowid via explicit INSERT values, which only BY
 * DEFAULT accepts. No UNIQUE constraint: identity allocation is unique by
 * construction, and the ordinal is only ever compared, never claimed.
 *
 * Declaring the overlay here keeps the emitted schema, the coverage manifest, the
 * parity gate and the migration flow sourced from one place — `postgres-schema.ts`
 * is never edited by hand, so a PG-only column declared anywhere else would be
 * erased by the next regeneration.
 */
export const PG_ONLY_IDENTITY_COLUMNS: ReadonlyArray<{
	/** The sqliteTable export name the column is appended to. */
	table: string;
	property: string;
	name: string;
}> = [
	{ table: "backgroundTasks", property: "insertSeq", name: "insert_seq" },
	{ table: "narrators", property: "insertSeq", name: "insert_seq" },
	{ table: "narratorToolContinuations", property: "insertSeq", name: "insert_seq" },
];

/**
 * Parse definitions, not comments or regex approximations of chained calls. Fail closed.
 *
 * The PG-only overlay is an explicit parameter rather than an implicit constant read:
 * partial fixture schemas (unit tests) must be able to parse without owning the three
 * real target tables, while the two production call sites — the CLI below and the
 * parity checker's `loadSource` — both pass {@link PG_ONLY_IDENTITY_COLUMNS}. A call
 * site that forgot it would produce a manifest/source mismatch the parity gate rejects.
 */
export function generatePostgresSchema(
	source: string,
	constants: Record<string, unknown> = {},
	pgOnlyIdentityColumns: ReadonlyArray<(typeof PG_ONLY_IDENTITY_COLUMNS)[number]> = [],
) {
	const file = ts.createSourceFile(
		"schema.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const unsupported: string[] = [];
	const tables: Table[] = [];
	const fail = (object: string, detail: string): never => {
		throw new UnsupportedSchemaError([`${object}: ${detail}`]);
	};
	const text = (node: ts.Node) => node.getText(file);
	const unwrap = (node: ts.Expression): ts.Expression =>
		ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
	const string = (node: ts.Node | undefined, object: string): string => {
		if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)))
			return node.text;
		return fail(object, `expected literal string: ${node ? text(node) : "missing"}`);
	};
	const objectProps = (node: ts.Expression | undefined, object: string) => {
		if (!node || !ts.isObjectLiteralExpression(node))
			return fail(object, "expected object literal");
		const result = new Map<string, ts.Expression>();
		for (const property of node.properties) {
			if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name))
				return fail(object, `unsupported property ${text(property)}`);
			const name = ts.isIdentifier(property.name)
				? property.name.text
				: string(property.name, object);
			if (result.has(name)) return fail(object, `duplicate property ${name}`);
			result.set(name, property.initializer);
		}
		return result;
	};
	const literal = (node: ts.Expression, object: string): unknown => {
		node = unwrap(node);
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
		if (ts.isNumericLiteral(node)) return Number(node.text);
		if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
		if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
		if (node.kind === ts.SyntaxKind.NullKeyword) return null;
		if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
			const value = literal(node.operand, object);
			if (typeof value === "number") return -value;
		}
		if (ts.isArrayLiteralExpression(node))
			return node.elements.map((value) => literal(value, object));
		if (ts.isObjectLiteralExpression(node))
			return Object.fromEntries(
				[...objectProps(node, object)].map(([k, v]) => [k, literal(v, object)]),
			);
		if (ts.isIdentifier(node) && Object.hasOwn(constants, node.text)) return constants[node.text];
		return fail(object, `unsupported default ${text(node)}`);
	};
	const chain = (node: ts.Expression, object: string): ts.CallExpression[] => {
		node = unwrap(node);
		if (!ts.isCallExpression(node)) return fail(object, `unsupported builder ${text(node)}`);
		if (ts.isIdentifier(node.expression)) return [node];
		if (ts.isPropertyAccessExpression(node.expression))
			return [...chain(node.expression.expression, object), node];
		return fail(object, `unsupported call ${text(node)}`);
	};
	const callName = (node: ts.CallExpression) =>
		ts.isPropertyAccessExpression(node.expression)
			? node.expression.name.text
			: text(node.expression);
	const ref = (node: ts.Expression | undefined, object: string): Reference => {
		if (node) node = unwrap(node);
		if (!node || !ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression))
			return fail(object, `unsupported reference ${node ? text(node) : "missing"}`);
		return { table: node.expression.text, column: node.name.text };
	};
	const action = (node: ts.Expression | undefined, object: string) => {
		const value = string(node, object);
		if (!["cascade", "restrict", "no action", "set null", "set default"].includes(value))
			return fail(object, `unsupported FK action ${value}`);
		return value;
	};
	const options = (node: ts.Expression | undefined, allowed: string[], object: string) => {
		const props = node ? objectProps(node, object) : new Map<string, ts.Expression>();
		for (const key of props.keys())
			if (!allowed.includes(key)) fail(object, `unsupported option ${key}`);
		return props;
	};
	const sqlExpression = (
		node: ts.Expression | undefined,
		table: Table,
		alias: string,
		object: string,
	) => {
		if (!node || !ts.isTaggedTemplateExpression(node) || text(node.tag) !== "sql")
			return fail(object, `unsupported SQL expression ${node ? text(node) : "missing"}`);
		let sql = "";
		if (ts.isNoSubstitutionTemplateLiteral(node.template)) sql = node.template.text;
		else {
			sql = node.template.head.text;
			for (const span of node.template.templateSpans) {
				const target = ref(span.expression, object);
				const column = table.columns.find((c) => c.property === target.column);
				if (target.table !== alias || !column)
					return fail(object, `unknown SQL column ${text(span.expression)}`);
				sql += `"${column.name}"${span.literal.text}`;
			}
		}
		// The historical ISO-like text default remains text, not a PG timestamp column.
		sql = sql.replace(/\(datetime\('now'\)\)/g, "CURRENT_TIMESTAMP::text");
		// Byte budgets, not character counts: SQLite BLOB length maps to PG octet_length(text).
		sql = sql.replace(/length\(cast\("([\w]+)" as blob\)\)/gi, (_match, name: string) => {
			if (!table.columns.some((column) => column.name === name && column.kind === "text"))
				return fail(object, `byte budget source ${name}`);
			return `octet_length("${name}")`;
		});
		// SQLite dynamically checks integer storage; PG enforces the mapped column type itself.
		sql = sql.replace(/typeof\("([\w]+)"\)\s*=\s*'integer'/g, (match, name: string) => {
			const column = table.columns.find((c) => c.name === name);
			if (!column || column.kind !== "integer" || column.mode === "boolean")
				return fail(object, match);
			return "true";
		});
		// Literal JSON paths used by generated compact_pending, including SQLite's last-array-element syntax.
		sql = sql.replace(
			/json_extract\("([\w]+)",\s*'([^']+)'\)/g,
			(_match, name: string, path: string) => {
				if (!table.columns.some((c) => c.name === name && c.mode === "json"))
					return fail(object, `JSON source ${name}`);
				if (!/^\$(?:\[\d+\]|\[#-\d+\]|\.[A-Za-z_]\w*)+$/.test(path))
					return fail(object, `JSON path ${path}`);
				const parts = [...path.matchAll(/\[(#-\d+|\d+)\]|\.([A-Za-z_]\w*)/g)].map((m) =>
					(m[1] ?? m[2]).replace("#", ""),
				);
				return `("${name}"::jsonb #>> '{${parts.join(",")}}')`;
			},
		);
		for (const column of table.columns.filter((c) => c.mode === "boolean")) {
			const escaped = column.name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
			// SQLite stores boolean mode integers; PostgreSQL requires boolean literals.
			// Keep this column-scoped so numeric 0/1 predicates retain their meaning.
			sql = sql.replace(
				new RegExp(`(\\"${escaped}\\"\\s*(?:=|!=|<>)\\s*)([01])\\b`, "g"),
				(_m, prefix: string, value: string) => `${prefix}${value === "1" ? "TRUE" : "FALSE"}`,
			);
			sql = sql.replace(
				new RegExp(`(\\"${escaped}\\"\\s+IS(?:\\s+NOT)?\\s+)([01])\\b`, "gi"),
				(_m, prefix: string, value: string) => `${prefix}${value === "1" ? "TRUE" : "FALSE"}`,
			);
			sql = sql.replace(
				new RegExp(`(\\"${escaped}\\"\\s+IN\\s*\\([^)]*)`, "gi"),
				(_m, prefix: string) =>
					prefix.replace(/\\b[01]\\b/g, (value) => (value === "1" ? "TRUE" : "FALSE")),
			);
		}
		// SQL is deliberately a small language here. Unknown SQLite functions cannot silently leak into PG.
		const functions = [...sql.matchAll(/\b([a-z_]\w*)\s*\(/gi)].map((m) => m[1].toLowerCase());
		for (const fn of functions)
			if (!["coalesce", "in", "or", "and", "when", "not", "octet_length"].includes(fn))
				fail(object, `unsupported SQL function ${fn}`);
		return sql.trim().replace(/\s+/g, " ");
	};
	const pending: {
		table: Table;
		config?: ts.Expression;
		generated: [Column, ts.CallExpression][];
	}[] = [];
	for (const statement of file.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (
				!declaration.initializer ||
				!ts.isCallExpression(declaration.initializer) ||
				text(declaration.initializer.expression) !== "sqliteTable"
			)
				continue;
			const location = text(declaration.name);
			try {
				if (!ts.isIdentifier(declaration.name))
					fail(location, "table export must be an identifier");
				const [name, columnsNode, config] = declaration.initializer.arguments;
				if (declaration.initializer.arguments.length > 3) fail(location, "extra table arguments");
				const table: Table = {
					exportName: location,
					name: string(name, location),
					columns: [],
					indexes: [],
					checks: [],
					checkDefinitions: [],
					foreignKeys: [],
					uniqueConstraints: [],
					primaryKeys: [],
				};
				const generated: [Column, ts.CallExpression][] = [];
				for (const [property, initializer] of objectProps(columnsNode, location)) {
					const object = `${table.name}.${property}`;
					try {
						const [base, ...methods] = chain(initializer, object);
						const kind = callName(base);
						if (kind !== "text" && kind !== "integer" && kind !== "real")
							fail(object, `unsupported type ${kind}`);
						const opts = options(base.arguments[1], ["mode", "enum"], object);
						const mode = opts.has("mode") ? string(opts.get("mode"), object) : undefined;
						if (
							mode !== undefined &&
							!(
								(kind === "text" && (mode === "json" || mode === "text")) ||
								(kind === "integer" && ["number", "boolean", "timestamp_ms"].includes(mode))
							)
						)
							fail(object, `unsupported ${kind} mode ${mode}`);
						if (base.arguments.length > 2 || (opts.has("enum") && kind !== "text"))
							fail(object, "unsupported column options");
						const c: Column = {
							property,
							name: base.arguments[0] ? string(base.arguments[0], object) : property,
							kind: kind as Column["kind"],
							mode:
								mode === "json" || mode === "boolean" || mode === "timestamp_ms" ? mode : undefined,
							pgType:
								mode === "boolean"
									? "boolean"
									: mode === "timestamp_ms"
										? "bigint"
										: kind === "real"
											? "double precision"
											: kind,
							notNull: false,
							primary: false,
							unique: false,
						};
						for (const method of methods) {
							const name = callName(method);
							const [arg, second] = method.arguments;
							if (name === "$type") {
								if (method.arguments.length) fail(object, "$type arguments");
							} else if (name === "notNull" || name === "primaryKey") {
								if (method.arguments.length) fail(object, `${name} options`);
								c.notNull = true;
								if (name === "primaryKey") c.primary = true;
							} else if (name === "unique") {
								if (method.arguments.length > 1) fail(object, "unique options");
								c.unique = true;
								c.uniqueName = arg ? string(arg, object) : undefined;
							} else if (name === "default") {
								if (!arg || method.arguments.length !== 1) fail(object, "default arguments");
								c.defaultValue = text(arg);
								if (ts.isTaggedTemplateExpression(arg))
									c.defaultExpression = `sql.raw(${JSON.stringify(sqlExpression(arg, table, "table", object))})`;
								else if (c.mode === "json")
									// The JSON codec encodes on write, so a raw JS default would either be
									// encoded twice or, for text-typed custom columns, emitted by Drizzle Kit
									// as a bare unquoted value. Encode once here and hand PostgreSQL the
									// finished text literal the codec reads back.
									c.defaultExpression = `sql.raw(${JSON.stringify(jsonTextDefault(literal(arg, object)))})`;
								else c.defaultExpression = JSON.stringify(literal(arg, object));
							} else if (name === "references") {
								if (!arg || !ts.isArrowFunction(arg) || method.arguments.length > 2)
									fail(object, "reference callback");
								if (ts.isBlock(arg.body)) fail(object, "reference callback must return a column");
								const target = ref(arg.body, object);
								const opts = options(second, ["onDelete", "onUpdate"], object);
								if (opts.has("onDelete")) target.onDelete = action(opts.get("onDelete"), object);
								if (opts.has("onUpdate")) target.onUpdate = action(opts.get("onUpdate"), object);
								c.references = target;
							} else if (name === "generatedAlwaysAs") generated.push([c, method]);
							else fail(object, `unsupported column method ${name}`);
						}
						table.columns.push(c);
					} catch (error) {
						if (error instanceof UnsupportedSchemaError) unsupported.push(...error.unsupported);
						else throw error;
					}
				}
				tables.push(table);
				pending.push({ table, config, generated });
			} catch (error) {
				if (error instanceof UnsupportedSchemaError) unsupported.push(...error.unsupported);
				else throw error;
			}
		}
	}
	for (const { table, config, generated } of pending) {
		try {
			for (const [column, call] of generated) {
				const object = `${table.name}.${column.property}`;
				const opts = options(call.arguments[1], ["mode"], object);
				const sourceMode = opts.has("mode") ? string(opts.get("mode"), object) : "virtual";
				if (!["virtual", "stored"].includes(sourceMode) || call.arguments.length > 2)
					fail(object, "generated options");
				column.generated = {
					expression: sqlExpression(call.arguments[0], table, "table", object),
					sourceMode,
					mode: "stored",
				};
			}
			if (!config) continue;
			if (!ts.isArrowFunction(config)) fail(table.name, "unsupported table config callback");
			if (config.parameters.length !== 1 || !ts.isIdentifier(config.parameters[0].name))
				fail(table.name, "unsupported table config callback");
			const alias = text(config.parameters[0].name);
			if (ts.isBlock(config.body)) fail(table.name, "unsupported table config body");
			const body = unwrap(config.body);
			const entries = ts.isArrayLiteralExpression(body)
				? [...body.elements]
				: [...objectProps(body, table.name).values()];
			const columnList = (nodes: readonly ts.Expression[], object: string) =>
				nodes.map((node) => {
					const target = ref(node, object);
					if (target.table !== alias || !table.columns.some((c) => c.property === target.column))
						return fail(object, `unknown index/constraint column ${text(node)}`);
					return target.column;
				});
			for (const entry of entries) {
				const object = `${table.name}.${text(entry).slice(0, 100)}`;
				try {
					const [base, ...methods] = chain(entry, object);
					const kind = callName(base);
					if (kind === "index" || kind === "uniqueIndex") {
						const i: Index = {
							name: string(base.arguments[0], object),
							columns: [],
							unique: kind === "uniqueIndex",
						};
						for (const method of methods) {
							if (callName(method) === "on" && !i.columns.length)
								i.columns = columnList(method.arguments, object);
							else if (
								callName(method) === "where" &&
								!i.predicate &&
								method.arguments.length === 1
							)
								i.predicate = sqlExpression(method.arguments[0], table, alias, object);
							else fail(object, `unsupported index method ${callName(method)}`);
						}
						if (!i.columns.length || base.arguments.length !== 1)
							fail(object, "invalid index definition");
						table.indexes.push(i);
					} else if (kind === "check") {
						if (methods.length || base.arguments.length !== 2) fail(object, "check arguments");
						const name = string(base.arguments[0], object);
						table.checks.push(name);
						table.checkDefinitions.push({
							name,
							expression: sqlExpression(base.arguments[1], table, alias, object),
						});
					} else if (["foreignKey", "primaryKey", "unique"].includes(kind)) {
						if (kind === "unique") {
							if (
								base.arguments.length > 1 ||
								methods.length !== 1 ||
								callName(methods[0]) !== "on"
							)
								fail(object, "unique constraint options");
							table.uniqueConstraints.push({
								name: base.arguments[0] ? string(base.arguments[0], object) : undefined,
								columns: columnList(methods[0].arguments, object),
							});
							continue;
						}
						const opts = options(
							base.arguments[0],
							kind === "foreignKey" ? ["name", "columns", "foreignColumns"] : ["name", "columns"],
							object,
						);
						const cols = opts.get("columns");
						if (!cols || !ts.isArrayLiteralExpression(cols) || base.arguments.length !== 1)
							fail(object, "constraint columns");
						const columns = columnList(cols.elements, object);
						const name = opts.has("name") ? string(opts.get("name"), object) : undefined;
						if (kind === "primaryKey") {
							if (methods.length) fail(object, "primaryKey methods");
							table.primaryKeys.push({ name, columns });
							continue;
						}
						const foreign = opts.get("foreignColumns");
						if (!foreign || !ts.isArrayLiteralExpression(foreign)) fail(object, "foreign columns");
						const references = foreign.elements.map((node) => {
							const target = ref(node, object);
							if (target.table === alias) target.table = table.exportName;
							return target;
						});
						if (
							!columns.length ||
							columns.length !== references.length ||
							new Set(references.map((r) => r.table)).size !== 1
						)
							fail(object, "invalid composite FK");
						for (const method of methods) {
							const name = callName(method);
							if ((name !== "onDelete" && name !== "onUpdate") || method.arguments.length !== 1)
								fail(object, "FK method");
							for (const target of references)
								target[name as "onDelete" | "onUpdate"] = action(method.arguments[0], object);
						}
						table.foreignKeys.push({ name, columns, references });
					} else fail(object, `unsupported table constraint ${kind}`);
				} catch (error) {
					if (error instanceof UnsupportedSchemaError) unsupported.push(...error.unsupported);
					else throw error;
				}
			}
		} catch (error) {
			if (error instanceof UnsupportedSchemaError) unsupported.push(...error.unsupported);
			else throw error;
		}
	}
	// PG-only overlay columns are appended after parsing so they land at the END of the
	// column list — the same physical position an `ALTER TABLE … ADD COLUMN` gives them
	// on an existing database, keeping definition order and migrated order identical.
	for (const overlay of pgOnlyIdentityColumns) {
		const table = tables.find((t) => t.exportName === overlay.table);
		if (!table) {
			unsupported.push(`PG-only identity column target table missing: ${overlay.table}`);
			continue;
		}
		if (table.columns.some((c) => c.name === overlay.name || c.property === overlay.property)) {
			unsupported.push(
				`PG-only identity column ${table.name}.${overlay.name} clashes with a parsed column`,
			);
			continue;
		}
		table.columns.push({
			property: overlay.property,
			name: overlay.name,
			kind: "integer",
			pgType: "bigint",
			notNull: true,
			primary: false,
			unique: false,
			identity: { type: "byDefault" },
		});
	}
	for (const table of tables) {
		for (const target of [
			...table.columns.flatMap((c) => (c.references ? [c.references] : [])),
			...table.foreignKeys.flatMap((fk) => fk.references),
		]) {
			if (
				!tables
					.find((t) => t.exportName === target.table)
					?.columns.some((c) => c.property === target.column)
			)
				unsupported.push(`${table.name}: missing FK target ${target.table}.${target.column}`);
		}
	}
	if (!tables.length) unsupported.push("schema: no sqliteTable definitions");
	if (unsupported.length) throw new UnsupportedSchemaError(unsupported);

	const byExport = new Map(tables.map((table) => [table.exportName, table]));
	const columnName = (table: Table, property: string) =>
		table.columns.find((c) => c.property === property)?.name ?? property;
	// Resolve every foreign key's effective constraint name and shorten the ones PostgreSQL
	// would truncate. Names are assigned before uniqueness is checked so a shortened name
	// colliding with an existing one is reported rather than silently merged.
	const constraintNames = new Map<string, string[]>();
	for (const table of tables) {
		const claim = (name: string, logical: string) => {
			const owners = constraintNames.get(name) ?? [];
			owners.push(logical);
			constraintNames.set(name, owners);
		};
		for (const column of table.columns) {
			if (!column.references) continue;
			const target = byExport.get(column.references.table);
			if (!target) continue;
			const logical = autoForeignKeyName(table.name, [column.name], target.name, [
				columnName(target, column.references.column),
			]);
			const effective = shortenConstraintName(logical);
			column.references.constraintName = effective;
			// Only a table-level foreignKey() accepts an explicit name.
			column.emitAsTableConstraint = effective !== logical;
			claim(effective, logical);
		}
		for (const foreignKey of table.foreignKeys) {
			const target = byExport.get(foreignKey.references[0]?.table ?? "");
			const logical =
				foreignKey.name ??
				(target
					? autoForeignKeyName(
							table.name,
							foreignKey.columns.map((property) => columnName(table, property)),
							target.name,
							foreignKey.references.map((reference) => columnName(target, reference.column)),
						)
					: undefined);
			if (!logical) continue;
			const effective = shortenConstraintName(logical);
			// An explicit name is authored, not derived: silently rewriting it would break
			// anything that references it by name.
			if (foreignKey.name && effective !== logical)
				unsupported.push(`${table.name}: foreign key name exceeds ${PG_IDENTIFIER_LIMIT} bytes`);
			foreignKey.name = effective;
			for (const reference of foreignKey.references) reference.constraintName = effective;
			claim(effective, logical);
		}
	}
	for (const [effective, owners] of constraintNames)
		if (owners.length > 1)
			unsupported.push(`constraint name collision ${effective}: ${owners.sort().join(", ")}`);

	// A foreign key can only target a column already covered by a unique constraint or index
	// at the time the constraint is added. Drizzle Kit orders all CREATE INDEX after every
	// ALTER TABLE ADD CONSTRAINT, so the covering unique index must become a table constraint.
	const referenced = new Set<string>();
	for (const table of tables) {
		for (const reference of [
			...table.columns.flatMap((c) => (c.references ? [c.references] : [])),
			...table.foreignKeys.flatMap((fk) => fk.references),
		]) {
			const target = byExport.get(reference.table);
			if (target) referenced.add(`${target.name}.${columnName(target, reference.column)}`);
		}
	}
	for (const table of tables) {
		for (const key of referenced) {
			const [tableName, column] = [
				key.slice(0, key.lastIndexOf(".")),
				key.slice(key.lastIndexOf(".") + 1),
			];
			if (tableName !== table.name) continue;
			const targetColumn = table.columns.find((c) => c.name === column);
			if (!targetColumn || targetColumn.primary || targetColumn.unique) continue;
			// A partial unique index cannot back a foreign key at all; promoting it would
			// silently widen the constraint, so report it instead.
			const covering = table.indexes.find(
				(index) =>
					index.unique &&
					!index.predicate &&
					index.columns.length === 1 &&
					columnName(table, index.columns[0]) === column,
			);
			if (!covering) {
				unsupported.push(`${table.name}.${column}: FK target has no usable unique constraint`);
				continue;
			}
			covering.emitAsUniqueConstraint = true;
		}
	}

	// Identifiers we cannot rename without changing the schema's meaning must fail loudly
	// rather than be truncated by PostgreSQL into a different object.
	for (const table of tables) {
		if (byteLength(table.name) > PG_IDENTIFIER_LIMIT)
			unsupported.push(`table name exceeds ${PG_IDENTIFIER_LIMIT} bytes: ${table.name}`);
		for (const column of table.columns)
			if (byteLength(column.name) > PG_IDENTIFIER_LIMIT)
				unsupported.push(
					`column name exceeds ${PG_IDENTIFIER_LIMIT} bytes: ${table.name}.${column.name}`,
				);
		for (const index of table.indexes)
			if (byteLength(index.name) > PG_IDENTIFIER_LIMIT)
				unsupported.push(`index name exceeds ${PG_IDENTIFIER_LIMIT} bytes: ${index.name}`);
		for (const check of table.checks)
			if (byteLength(check) > PG_IDENTIFIER_LIMIT)
				unsupported.push(`check name exceeds ${PG_IDENTIFIER_LIMIT} bytes: ${check}`);
		for (const constraint of [...table.uniqueConstraints, ...table.primaryKeys])
			if (constraint.name && byteLength(constraint.name) > PG_IDENTIFIER_LIMIT)
				unsupported.push(
					`constraint name exceeds ${PG_IDENTIFIER_LIMIT} bytes: ${constraint.name}`,
				);
	}
	if (unsupported.length) throw new UnsupportedSchemaError(unsupported);
	const q = JSON.stringify;
	const fkActions = (r: Reference) =>
		`${r.onDelete ? `.onDelete(${q(r.onDelete)})` : ""}${r.onUpdate ? `.onUpdate(${q(r.onUpdate)})` : ""}`;
	// Import exactly the builders the emitted tables use: an unused import fails lint, and a
	// missing one fails to compile. Deriving both from the same data keeps them consistent.
	const usedBuilders = new Set<string>(["customType", "pgTable"]);
	for (const table of tables) {
		for (const column of table.columns) {
			usedBuilders.add(
				column.mode === "json"
					? "jsonText"
					: column.pgType === "double precision"
						? "doublePrecision"
						: column.pgType,
			);
			if (column.references) {
				usedBuilders.add(column.emitAsTableConstraint ? "foreignKey" : "references");
			}
		}
		for (const i of table.indexes)
			usedBuilders.add(i.emitAsUniqueConstraint ? "unique" : i.unique ? "uniqueIndex" : "index");
		if (table.checkDefinitions.length) usedBuilders.add("check");
		if (table.foreignKeys.length) usedBuilders.add("foreignKey");
		if (table.uniqueConstraints.length) usedBuilders.add("unique");
		if (table.primaryKeys.length) usedBuilders.add("primaryKey");
	}
	// `references` is a column method, not an import; it only implies the PgColumn return type.
	const needsPgColumn = usedBuilders.delete("references");
	usedBuilders.delete("jsonText");
	const imports = [...(needsPgColumn ? ["type PgColumn"] : []), ...usedBuilders].sort((a, b) =>
		a.replace("type ", "").localeCompare(b.replace("type ", "")),
	);
	const lines = [
		"// Generated by scripts/generate-postgres-schema.ts; do not edit.",
		'import { sql } from "drizzle-orm";',
		`import { ${imports.join(", ")} } from "drizzle-orm/pg-core";`,
		"// JSON stays text on disk; the codec preserves SQLite JSON-mode application values.",
		"const jsonText = customType<{ data: unknown; driverData: string }>({",
		'  dataType: () => "text",',
		"  toDriver: (value) => JSON.stringify(value),",
		"  fromDriver: (value) => JSON.parse(value),",
		"});",
		...tables.flatMap((table) => {
			const config = [
				...table.indexes.map((i) =>
					i.emitAsUniqueConstraint
						? `unique(${q(i.name)}).on(${i.columns.map((c) => `table.${c}`).join(", ")})`
						: `${i.unique ? "uniqueIndex" : "index"}(${q(i.name)}).on(${i.columns.map((c) => `table.${c}`).join(", ")})${i.predicate ? `.where(sql.raw(${q(i.predicate)}))` : ""}`,
				),
				...table.checkDefinitions.map((c) => `check(${q(c.name)}, sql.raw(${q(c.expression)}))`),
				// Column references whose automatic name would be truncated are emitted here so
				// they can carry the shortened name.
				...table.columns.flatMap((c) =>
					c.references && c.emitAsTableConstraint
						? [
								`foreignKey({name: ${q(c.references.constraintName ?? "")}, columns: [table.${c.property}], foreignColumns: [${c.references.table === table.exportName ? "table" : c.references.table}.${c.references.column}]})${fkActions(c.references)}`,
							]
						: [],
				),
				...table.foreignKeys.map(
					(fk) =>
						`foreignKey({${fk.name ? `name: ${q(fk.name)}, ` : ""}columns: [${fk.columns.map((c) => `table.${c}`).join(", ")}], foreignColumns: [${fk.references.map((r) => `${r.table === table.exportName ? "table" : r.table}.${r.column}`).join(", ")}]})${fkActions(fk.references[0])}`,
				),
				...table.uniqueConstraints.map(
					(u) =>
						`unique(${u.name ? q(u.name) : ""}).on(${u.columns.map((c) => `table.${c}`).join(", ")})`,
				),
				...table.primaryKeys.map(
					(p) =>
						`primaryKey({${p.name ? `name: ${q(p.name)}, ` : ""}columns: [${p.columns.map((c) => `table.${c}`).join(", ")}]})`,
				),
			];
			return [
				`export const ${table.exportName} = pgTable(${q(table.name)}, {`,
				...table.columns.map((c) => {
					const builder =
						c.mode === "json"
							? "jsonText"
							: c.pgType === "double precision"
								? "doublePrecision"
								: c.pgType;
					return `${c.property}: ${builder}(${q(c.name)}${c.pgType === "bigint" ? ', { mode: "number" }' : ""})${c.primary ? ".primaryKey()" : ""}${c.notNull ? ".notNull()" : ""}${c.unique ? `.unique(${c.uniqueName ? q(c.uniqueName) : ""})` : ""}${c.defaultExpression !== undefined ? `.default(${c.defaultExpression})` : ""}${c.references && !c.emitAsTableConstraint ? `.references((): PgColumn => ${c.references.table}.${c.references.column}, {${c.references.onDelete ? `onDelete: ${q(c.references.onDelete)},` : ""}${c.references.onUpdate ? `onUpdate: ${q(c.references.onUpdate)},` : ""}})` : ""}${c.generated ? `.generatedAlwaysAs(sql.raw(${q(c.generated.expression)}))` : ""}${c.identity ? (c.identity.type === "byDefault" ? ".generatedByDefaultAsIdentity()" : ".generatedAlwaysAsIdentity()") : ""},`;
				}),
				config.length ? `}, (table) => [${config.join(",\n")}]);` : "});",
				"",
			];
		}),
	];
	// Keep a machine-readable manifest; avoid a massive inferred literal union in consumers.
	const coverage = {
		tableCount: tables.length,
		columnCount: tables.reduce((n, t) => n + t.columns.length, 0),
		tables,
		unsupported,
	};
	lines.push(
		`export const POSTGRES_SCHEMA_COVERAGE = ${JSON.stringify(coverage, null, 2)} as const;`,
	);
	return { source: `${lines.join("\n")}\n`, coverage };
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	const { DEFAULT_LOCALE } = await import("../shared/i18n-locales");
	const result = generatePostgresSchema(
		readFileSync(resolve(root, "server/db/schema.ts"), "utf8"),
		{ DEFAULT_LOCALE },
		PG_ONLY_IDENTITY_COLUMNS,
	);
	// Format executable schema only; keep coverage as strict JSON for parity tooling.
	const marker = "export const POSTGRES_SCHEMA_COVERAGE = ";
	const split = result.source.indexOf(marker);
	const executable = result.source.slice(0, split);
	const manifest = `// biome-ignore format: coverage is parsed as strict JSON by parity tooling.\n${marker}${JSON.stringify(result.coverage, null, 2)} as const;\n`;
	const child = Bun.spawn(
		[
			"bunx",
			"@biomejs/biome",
			"check",
			"--write",
			"--vcs-enabled=false",
			"--stdin-file-path=server/db/postgres-schema.ts",
		],
		{ stdin: new Blob([executable]), stdout: "pipe", stderr: "pipe" },
	);
	const timer = setTimeout(() => child.kill(), 30_000);
	const [formatted, error, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	if (code !== 0) throw new Error(`PG schema formatting failed: ${error.slice(0, 4000)}`);
	writeFileSync(resolve(root, "server/db/postgres-schema.ts"), formatted + manifest);
	const { tables } = result.coverage;
	console.log(
		JSON.stringify({
			tables: tables.length,
			columns: result.coverage.columnCount,
			indexes: tables.reduce((n, t) => n + t.indexes.length, 0),
			foreignKeys: tables.reduce(
				(n, t) => n + t.columns.filter((c) => c.references).length + t.foreignKeys.length,
				0,
			),
			checks: tables.reduce((n, t) => n + t.checks.length, 0),
			generated: tables.reduce((n, t) => n + t.columns.filter((c) => c.generated).length, 0),
			unsupported: result.coverage.unsupported,
		}),
	);
}
