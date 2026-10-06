import { Database } from "bun:sqlite";

interface SnapshotTable {
	columns: Record<
		string,
		{
			name: string;
			type: string;
			primaryKey?: boolean;
			notNull?: boolean;
			default?: unknown;
			autoincrement?: boolean;
			generated?: { as: string; type: "virtual" | "stored" };
		}
	>;
	indexes?: Record<string, { name: string; columns: string[]; isUnique: boolean; where?: string }>;
	compositePrimaryKeys?: Record<string, { columns: string[] }>;
	uniqueConstraints?: Record<string, { columns: string[] }>;
	checkConstraints?: Record<string, { name: string; value: string }>;
	foreignKeys: Record<
		string,
		{
			columnsFrom: string[];
			tableTo: string;
			columnsTo: string[];
			onDelete?: string;
			onUpdate?: string;
		}
	>;
}
export interface ResourceMigrationSnapshot {
	tables: Record<string, SnapshotTable>;
}
interface Token {
	kind: "word" | "identifier" | "string" | "symbol";
	value: string;
	start: number;
	end: number;
}
interface Statement {
	tokens: Token[];
	sql: string;
}
const key = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const keyword = (token: Token | undefined, value: string) =>
	token?.kind === "word" && token.value.toUpperCase() === value;
const symbol = (token: Token | undefined, value: string) =>
	token?.kind === "symbol" && token.value === value;
function identifier(token: Token | undefined): string {
	if (
		!token ||
		(token.kind !== "identifier" && (token.kind !== "word" || /^[0-9]/.test(token.value)))
	)
		throw new Error("Unsupported SQL identifier");
	return token.value;
}
/** Tokenize delimiters only outside identifiers, literals and comments. Regex cannot safely
 * split escaped names containing commas, semicolons or the Drizzle breakpoint marker. */
function statementsOf(sql: string): Statement[] {
	const statements: Statement[] = [];
	let tokens: Token[] = [];
	const deadline = performance.now() + 5000;
	for (let offset = 0; offset < sql.length; ) {
		if ((offset & 1023) === 0 && performance.now() > deadline)
			throw new Error("Migration parse deadline exceeded");
		const start = offset;
		const character = sql[offset];
		if (/\s/.test(character)) {
			offset++;
			continue;
		}
		if (sql.startsWith("--", offset)) {
			const end = sql.indexOf("\n", offset);
			offset = end < 0 ? sql.length : end + 1;
			continue;
		}
		if (sql.startsWith("/*", offset)) {
			const end = sql.indexOf("*/", offset + 2);
			if (end < 0) throw new Error("Unterminated SQL comment");
			offset = end + 2;
			continue;
		}
		if (["'", '"', "`", "["].includes(character)) {
			const close = character === "[" ? "]" : character;
			let value = "";
			let closed = false;
			offset++;
			while (offset < sql.length) {
				if (sql[offset] === close) {
					if (character !== "[" && sql[offset + 1] === close) {
						value += close;
						offset += 2;
						continue;
					}
					offset++;
					closed = true;
					break;
				}
				value += sql[offset++];
			}
			if (!closed) throw new Error("Unterminated SQL quote");
			tokens.push({ kind: character === "'" ? "string" : "identifier", value, start, end: offset });
		} else if (/[\p{L}\p{N}_$]/u.test(character)) {
			offset++;
			while (offset < sql.length && /[\p{L}\p{N}_$]/u.test(sql[offset])) offset++;
			tokens.push({ kind: "word", value: sql.slice(start, offset), start, end: offset });
		} else if (character === ";") {
			offset++;
			if (tokens.length) statements.push({ tokens, sql: sql.slice(tokens[0].start, offset) });
			tokens = [];
		} else {
			offset++;
			tokens.push({ kind: "symbol", value: character, start, end: offset });
		}
	}
	if (tokens.length) throw new Error("Migration statement is not terminated");
	return statements;
}
function list(
	tokens: Token[],
	start: number,
): { names: string[]; identifiers: Token[]; next: number } {
	if (!symbol(tokens[start], "(")) throw new Error("Unsupported SQL column list");
	const names: string[] = [];
	const identifiers: Token[] = [];
	let offset = start + 1;
	for (;;) {
		identifiers.push(tokens[offset]);
		names.push(identifier(tokens[offset++]));
		if (symbol(tokens[offset], ")")) return { names, identifiers, next: offset + 1 };
		if (!symbol(tokens[offset++], ",")) throw new Error("Unexpected generated copy expressions");
	}
}
function declaredColumns(tokens: Token[], start: number): string[] {
	if (!symbol(tokens[start], "(") || !symbol(tokens.at(-1), ")"))
		throw new Error("Unsupported CREATE TABLE SQL");
	const columns: string[] = [];
	let depth = 0;
	let boundary = true;
	for (let offset = start + 1; offset < tokens.length - 1; offset++) {
		const token = tokens[offset];
		if (boundary) {
			if (
				!["CONSTRAINT", "FOREIGN", "PRIMARY", "UNIQUE", "CHECK"].some((word) =>
					keyword(token, word),
				)
			)
				columns.push(identifier(token));
			boundary = false;
		}
		if (symbol(token, "(")) depth++;
		if (symbol(token, ")")) depth--;
		if (depth < 0) throw new Error("Unbalanced CREATE TABLE SQL");
		if (symbol(token, ",") && depth === 0) boundary = true;
	}
	if (depth !== 0 || boundary) throw new Error("Unbalanced CREATE TABLE SQL");
	return columns;
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const expressionWords = new Set(
	"AND OR NOT IS NULL IN BETWEEN LIKE GLOB ESCAPE CASE WHEN THEN ELSE END AS BLOB TEXT INTEGER REAL NUMERIC TRUE FALSE COLLATE BINARY NOCASE RTRIM CURRENT_TIME CURRENT_DATE CURRENT_TIMESTAMP".split(
		" ",
	),
);
const expressionFunctions = new Set([
	"datetime",
	"date",
	"time",
	"strftime",
	"julianday",
	"unixepoch",
	"typeof",
	"length",
	"cast",
	"abs",
	"coalesce",
	"json_extract",
	"ifnull",
	"lower",
	"upper",
	"trim",
	"round",
]);
/** Conservative lexical equivalence, never remove arbitrary qualifiers/functions/constraints.
 * Unknown expressions fail closed; no evaluation of defaults is needed to compare them. */
function expressionSignature(source: string, table: string, columns: string[]): string {
	const parsed = statementsOf(`${source};`);
	if (parsed.length !== 1 || parsed[0].tokens.length > 4096)
		throw new Error("Unsupported schema expression");
	let tokens = parsed[0].tokens;
	// SQLite removes wrapping parentheses from dflt_value. Remove only complete outer pairs.
	while (symbol(tokens[0], "(") && symbol(tokens.at(-1), ")")) {
		let depth = 0;
		let wraps = true;
		for (let i = 0; i < tokens.length - 1; i++) {
			if (symbol(tokens[i], "(")) depth++;
			if (symbol(tokens[i], ")")) depth--;
			if (depth === 0) {
				wraps = false;
				break;
			}
		}
		if (!wraps) break;
		tokens = tokens.slice(1, -1);
	}
	const normalized: unknown[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (
			(t.kind === "identifier" || t.kind === "word") &&
			key(t.value) === key(table) &&
			symbol(tokens[i + 1], ".")
		) {
			i++;
			continue;
		}
		if (t.kind === "string") normalized.push(["string", t.value]);
		else if (t.kind === "symbol") {
			if (!"()+-*/%,.=<>!|&~".includes(t.value))
				throw new Error("Unsupported schema expression operator");
			normalized.push(t.value);
		} else if (/^\d+$/.test(t.value)) normalized.push(["number", t.value]);
		else if (t.kind === "word" && ["TRUE", "FALSE"].includes(t.value.toUpperCase()))
			normalized.push(["number", t.value.toUpperCase() === "TRUE" ? "1" : "0"]);
		else if (symbol(tokens[i + 1], "(") && expressionFunctions.has(key(t.value)))
			normalized.push(["function", key(t.value)]);
		else if (t.kind === "word" && expressionWords.has(t.value.toUpperCase()))
			normalized.push(t.value.toUpperCase());
		else if (columns.some((c) => key(c) === key(t.value)))
			normalized.push(["column", key(t.value)]);
		else throw new Error(`Unsupported schema expression: ${t.value}`);
	}
	return JSON.stringify(normalized);
}
function snapshotDDL(name: string, table: SnapshotTable): string[] {
	const columns = Object.keys(table.columns);
	const expression = (value: unknown) => {
		const text = String(value);
		expressionSignature(text, name, columns);
		return text;
	};
	const definitions = Object.values(table.columns).map((column) => {
		if (!/^(?:text|integer|real|blob|numeric)$/i.test(column.type))
			throw new Error(`Unsupported snapshot column type: ${column.type}`);
		const generated = column.generated;
		if (
			column.generated !== undefined &&
			(!generated ||
				typeof generated.as !== "string" ||
				!["virtual", "stored"].includes(generated.type))
		)
			throw new Error("Unsupported snapshot generated definition/mode");
		return `${quote(column.name)} ${column.type}${column.primaryKey ? " PRIMARY KEY" : ""}${column.autoincrement ? " AUTOINCREMENT" : ""}${column.notNull ? " NOT NULL" : ""}${column.default !== undefined ? ` DEFAULT ${expression(column.default)}` : ""}${generated ? ` GENERATED ALWAYS AS (${expression(generated.as)}) ${generated.type}` : ""}`;
	});
	for (const constraint of Object.values(table.compositePrimaryKeys ?? {}))
		definitions.push(`PRIMARY KEY (${constraint.columns.map(quote).join(",")})`);
	for (const constraint of Object.values(table.uniqueConstraints ?? {}))
		definitions.push(`UNIQUE (${constraint.columns.map(quote).join(",")})`);
	for (const constraint of Object.values(table.checkConstraints ?? {}))
		definitions.push(
			`CONSTRAINT ${quote(constraint.name)} CHECK (${expression(constraint.value)})`,
		);
	for (const fk of Object.values(table.foreignKeys)) {
		const action = (value = "no action") => {
			if (
				!["no action", "restrict", "cascade", "set null", "set default"].includes(
					value.toLowerCase(),
				)
			)
				throw new Error("Unsupported snapshot FK action");
			return value;
		};
		definitions.push(
			`FOREIGN KEY (${fk.columnsFrom.map(quote).join(",")}) REFERENCES ${quote(fk.tableTo)} (${fk.columnsTo.map(quote).join(",")}) ON UPDATE ${action(fk.onUpdate)} ON DELETE ${action(fk.onDelete)}`,
		);
	}
	return [
		`CREATE TABLE ${quote(name)} (${definitions.join(",")});`,
		...Object.values(table.indexes ?? {}).map(
			(index) =>
				`CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${quote(name)} (${index.columns.map(quote).join(",")})${index.where ? ` WHERE ${expression(index.where)}` : ""};`,
		),
	];
}
function tableSignature(db: Database, name: string): string {
	const schema = db
		.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
		.get(name);
	if (!schema) throw new Error(`Missing target table ${name}`);
	const info = db
		.query<
			{
				name: string;
				type: string;
				notnull: number;
				dflt_value: string | null;
				pk: number;
				hidden: number;
			},
			[]
		>(`PRAGMA table_xinfo(${quote(name)})`)
		.all();
	const columns = info.map((c) => c.name);
	const expr = (source: string) => expressionSignature(source, name, columns);
	const tokens = statementsOf(`${schema.sql};`)[0].tokens;
	const checks: string[] = [];
	const generated = new Map<string, string>();
	const inspectDefinition = (definition: Token[]) => {
		if (
			!definition.length ||
			["CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK"].some((word) =>
				keyword(definition[0], word),
			)
		)
			return;
		const name = identifier(definition[0]);
		const column = info.find((row) => key(row.name) === key(name));
		if (!column?.hidden) return;
		if (![2, 3].includes(column.hidden)) throw new Error("Unsupported hidden column semantics");
		let depth = 0;
		let as = -1;
		for (let i = 1; i < definition.length; i++) {
			if (depth === 0 && keyword(definition[i], "AS")) {
				as = i;
				break;
			}
			if (symbol(definition[i], "(")) depth++;
			if (symbol(definition[i], ")")) depth--;
		}
		if (as < 0 || !symbol(definition[as + 1], "("))
			throw new Error("Unsupported generated expression");
		depth = 1;
		let end = as + 2;
		while (end < definition.length && depth) {
			if (symbol(definition[end], "(")) depth++;
			if (symbol(definition[end], ")")) depth--;
			end++;
		}
		if (depth) throw new Error("Unbalanced generated expression");
		generated.set(
			key(name),
			expr(schema.sql.slice(definition[as + 1].end, definition[end - 1].start)),
		);
	};
	// AS can occur inside CAST/default/CHECK expressions too. Inspect only top-level
	// column definitions and require table_xinfo's generated flag, never text presence.
	let boundary = tokens.findIndex((token) => symbol(token, "(")) + 1;
	let depth = 0;
	for (let i = boundary; i < tokens.length; i++) {
		if (depth === 0 && (symbol(tokens[i], ",") || symbol(tokens[i], ")"))) {
			inspectDefinition(tokens.slice(boundary, i));
			boundary = i + 1;
			if (symbol(tokens[i], ")")) break;
		}
		if (symbol(tokens[i], "(")) depth++;
		if (symbol(tokens[i], ")")) depth--;
	}
	for (let i = 0; i < tokens.length; i++) {
		if (keyword(tokens[i], "DEFERRABLE") || keyword(tokens[i], "MATCH"))
			throw new Error("Unsupported table constraint semantics");
		if (keyword(tokens[i], "CHECK")) {
			if (!symbol(tokens[i + 1], "(")) throw new Error("Unsupported CHECK expression");
			let depth = 1;
			let end = i + 2;
			while (end < tokens.length && depth) {
				if (symbol(tokens[end], "(")) depth++;
				if (symbol(tokens[end], ")")) depth--;
				end++;
			}
			if (depth) throw new Error("Unbalanced CHECK expression");
			checks.push(expr(`${schema.sql.slice(tokens[i + 1].end, tokens[end - 1].start)}`));
			i = end - 1;
		}
	}
	const fks = db
		.query<
			{
				id: number;
				seq: number;
				table: string;
				from: string;
				to: string;
				on_update: string;
				on_delete: string;
				match: string;
			},
			[]
		>(`PRAGMA foreign_key_list(${quote(name)})`)
		.all();
	const groups = new Map<number, typeof fks>();
	for (const fk of fks) {
		const group = groups.get(fk.id) ?? [];
		group.push(fk);
		groups.set(fk.id, group);
	}
	const foreignKeys = [...groups.values()].map((group) =>
		group
			.sort((a, b) => a.seq - b.seq)
			.map((fk) => [
				key(fk.table),
				key(fk.from),
				fk.to === null ? null : key(fk.to),
				fk.on_update,
				fk.on_delete,
				fk.match,
			]),
	);
	const indices = db
		.query<{ name: string; unique: number; origin: string; partial: number }, []>(
			`PRAGMA index_list(${quote(name)})`,
		)
		.all()
		.map((index) => {
			const sql = db
				.query<{ sql: string | null }, [string]>(
					"SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
				)
				.get(index.name)?.sql;
			const it = sql ? statementsOf(`${sql};`)[0].tokens : [];
			const where = it.findIndex((t) => keyword(t, "WHERE"));
			const rows = db
				.query<{ cid: number; name: string | null; desc: number; coll: string; key: number }, []>(
					`PRAGMA index_xinfo(${quote(index.name)})`,
				)
				.all()
				.filter((row) => row.key);
			if (rows.some((row) => row.cid < 0)) throw new Error("Unsupported expression index");
			return [
				index.origin === "c" ? key(index.name) : index.origin,
				index.unique,
				index.partial,
				rows.map((row) => [row.name === null ? null : key(row.name), row.desc, row.coll]),
				where < 0 ? null : expr(sql?.slice(it[where].end) ?? ""),
			];
		});
	const sort = (values: unknown[]) => values.map((v) => JSON.stringify(v)).sort();
	return JSON.stringify({
		columns: sort(
			info.map((c) => [
				key(c.name),
				c.type.toUpperCase(),
				c.notnull,
				c.pk,
				c.hidden,
				c.dflt_value === null ? null : expr(c.dflt_value),
				generated.get(key(c.name)) ?? null,
			]),
		),
		foreignKeys: sort(foreignKeys),
		indices: sort(indices),
		checks: checks.sort(),
		autoincrement: tokens.some((t) => keyword(t, "AUTOINCREMENT")),
	});
}
/** Execute only already-classified schema DDL in two private memory databases. Never run
 * INSERT, arbitrary SQL, ATTACH, user paths, or any user database. SQLite resolves column,
 * FK, PK and index semantics; CHECK/predicate equivalence remains deliberately conservative. */
function validateTargetDDL(
	statements: Statement[],
	before: ResourceMigrationSnapshot,
	after: ResourceMigrationSnapshot,
): void {
	const actual = new Database(":memory:");
	let expected: Database | undefined;
	try {
		expected = new Database(":memory:");
		for (const [name, table] of Object.entries(before.tables))
			for (const ddl of snapshotDDL(name, table)) actual.exec(ddl);
		for (const [name, table] of Object.entries(after.tables))
			for (const ddl of snapshotDDL(name, table)) expected.exec(ddl);
		for (const statement of statements) {
			const t = statement.tokens;
			if (keyword(t[0], "PRAGMA") || keyword(t[0], "INSERT")) continue;
			if (
				t.some((token) =>
					[
						"ATTACH",
						"DETACH",
						"SELECT",
						"TRIGGER",
						"TEMP",
						"TEMPORARY",
						"DEFERRABLE",
						"MATCH",
						"COLLATE",
						"CONFLICT",
					].some((word) => keyword(token, word)),
				)
			)
				throw new Error("Unsupported schema DDL semantics");
			actual.exec(statement.sql);
		}
		const names = (db: Database) =>
			db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all()
				.map((row) => row.name);
		if (JSON.stringify(names(actual)) !== JSON.stringify(names(expected)))
			throw new Error("Target table set differs from generated snapshot");
		for (const name of names(expected)) {
			const observed = JSON.parse(tableSignature(actual, name));
			const target = JSON.parse(tableSignature(expected, name));
			const differences = Object.keys(target).filter(
				(part) => JSON.stringify(observed[part]) !== JSON.stringify(target[part]),
			);
			if (differences.length)
				throw new Error(
					`Target DDL differs from generated snapshot: ${name} (${differences.join(", ")})`,
				);
		}
	} finally {
		expected?.close();
		actual.close();
	}
}
/** Correct Drizzle's missing-new-column copy bug WITHOUT losing earlier DDL renames.
 * Source columns are an ordered SQL-state model seeded from the previous snapshot.
 * Unrecognised SQL/copy expressions fail closed instead of leaking double-quoted literals.
 * Only private memory databases verify schema DDL; no user database, journal or history
 * file is opened or rewritten by this function. */
export function finalizeResourceMigration(
	sql: string,
	before: ResourceMigrationSnapshot,
	after: ResourceMigrationSnapshot,
): string {
	if (Buffer.byteLength(sql) > 1024 * 1024) throw new Error("Migration exceeds generator budget");
	const statements = statementsOf(sql);
	const tables = new Map(
		Object.entries(before.tables).map(([name, table]) => [
			key(name),
			new Set(Object.keys(table.columns).map(key)),
		]),
	);
	const renames = new Map<string, string>();
	for (const { tokens } of statements) {
		if (
			tokens.length === 6 &&
			keyword(tokens[0], "ALTER") &&
			keyword(tokens[1], "TABLE") &&
			keyword(tokens[3], "RENAME") &&
			keyword(tokens[4], "TO")
		)
			renames.set(key(identifier(tokens[2])), identifier(tokens[5]));
	}
	function snapshotFor(name: string): SnapshotTable {
		let logical = name.startsWith("__new_") ? name.slice(6) : name;
		const seen = new Set<string>();
		while (renames.has(key(logical))) {
			if (seen.has(key(logical))) throw new Error("Ambiguous table rename cycle");
			seen.add(key(logical));
			logical = renames.get(key(logical)) as string;
		}
		const match = Object.entries(after.tables).find(([table]) => key(table) === key(logical));
		if (!match) throw new Error(`Unexpected migration table ${name}`);
		return match[1];
	}
	const output: string[] = [];
	for (const statement of statements) {
		const t = statement.tokens;
		let rendered = statement.sql;
		if (keyword(t[0], "PRAGMA")) {
			if (
				t.length !== 4 ||
				key(identifier(t[1])) !== "foreign_keys" ||
				t[2].value !== "=" ||
				(!keyword(t[3], "ON") && !keyword(t[3], "OFF"))
			)
				throw new Error("Unsupported migration PRAGMA");
			continue;
		}
		if (keyword(t[0], "ALTER") && keyword(t[1], "TABLE")) {
			const table = identifier(t[2]);
			const columns = tables.get(key(table));
			if (!columns) throw new Error(`Unknown ALTER source ${table}`);
			if (
				keyword(t[3], "RENAME") &&
				keyword(t[4], "COLUMN") &&
				keyword(t[6], "TO") &&
				t.length === 8
			) {
				const from = identifier(t[5]);
				const to = identifier(t[7]);
				if (!columns.has(key(from)) || columns.has(key(to)))
					throw new Error("Unknown or conflicting column rename");
				columns.delete(key(from));
				columns.add(key(to));
			} else if (keyword(t[3], "RENAME") && keyword(t[4], "TO") && t.length === 6) {
				const to = identifier(t[5]);
				if (tables.has(key(to))) throw new Error("Conflicting table rename");
				tables.delete(key(table));
				tables.set(key(to), columns);
			} else if (keyword(t[3], "DROP") && keyword(t[4], "COLUMN") && t.length === 6) {
				if (!columns.delete(key(identifier(t[5])))) throw new Error("Unknown dropped column");
			} else if (keyword(t[3], "ADD")) {
				const offset = keyword(t[4], "COLUMN") ? 5 : 4;
				const column = identifier(t[offset]);
				const definition = snapshotFor(table);
				if (
					columns.has(key(column)) ||
					!Object.keys(definition.columns).some((name) => key(name) === key(column)) ||
					t.length <= offset + 1
				)
					throw new Error("Unknown or conflicting added column");
				columns.add(key(column));
				const ref = t.findIndex((token) => keyword(token, "REFERENCES"));
				if (ref >= 0) {
					const target = identifier(t[ref + 1]);
					const refs = list(t, ref + 2);
					const fk = Object.values(definition.foreignKeys).find(
						(entry) => entry.columnsFrom.length === 1 && key(entry.columnsFrom[0]) === key(column),
					);
					if (
						!fk ||
						key(fk.tableTo) !== key(target) ||
						refs.names.length !== 1 ||
						key(refs.names[0]) !== key(fk.columnsTo[0])
					)
						throw new Error("Unexpected added FK");
					// Only exact referential clauses may follow REFERENCES; unknown syntax is not patched.
					let end = refs.next;
					while (end < t.length) {
						if (
							!keyword(t[end], "ON") ||
							(!keyword(t[end + 1], "UPDATE") && !keyword(t[end + 1], "DELETE"))
						)
							throw new Error("Unsupported added FK suffix");
						end += 2;
						if (keyword(t[end], "CASCADE") || keyword(t[end], "RESTRICT")) end++;
						else if (
							(keyword(t[end], "NO") && keyword(t[end + 1], "ACTION")) ||
							(keyword(t[end], "SET") &&
								(keyword(t[end + 1], "NULL") || keyword(t[end + 1], "DEFAULT")))
						)
							end += 2;
						else throw new Error("Unsupported added FK action");
					}
					rendered = `${sql.slice(t[0].start, t[refs.next - 1].end)} ON UPDATE ${fk.onUpdate ?? "no action"} ON DELETE ${fk.onDelete ?? "no action"};`;
				}
			} else throw new Error("Unsupported ALTER TABLE SQL");
		} else if (keyword(t[0], "CREATE") && keyword(t[1], "TABLE")) {
			const table = identifier(t[2]);
			const columns = declaredColumns(t, 3);
			const snapshot = snapshotFor(table);
			if (
				tables.has(key(table)) ||
				columns.length !== Object.keys(snapshot.columns).length ||
				columns.some(
					(column) => !Object.keys(snapshot.columns).some((name) => key(name) === key(column)),
				)
			)
				throw new Error("CREATE TABLE differs from generated snapshot");
			tables.set(key(table), new Set(columns.map(key)));
		} else if (keyword(t[0], "DROP") && keyword(t[1], "TABLE") && t.length === 3) {
			if (!tables.delete(key(identifier(t[2])))) throw new Error("Unknown dropped table");
		} else if (keyword(t[0], "INSERT")) {
			if (!keyword(t[1], "INTO")) throw new Error("Unexpected generated copy expressions");
			const target = identifier(t[2]);
			const columns = list(t, 3);
			if (
				!target.startsWith("__new_") ||
				!tables.has(key(target)) ||
				!keyword(t[columns.next], "SELECT")
			)
				throw new Error("Unexpected migration copy source");
			const sourceNames: string[] = [];
			const sourceTokens: Token[] = [];
			let end = columns.next + 1;
			while (!keyword(t[end], "FROM")) {
				sourceTokens.push(t[end]);
				sourceNames.push(identifier(t[end++]));
				if (keyword(t[end], "FROM")) break;
				if (t[end++]?.value !== ",") throw new Error("Unexpected generated copy expressions");
			}
			const source = identifier(t[end + 1]);
			if (
				end + 2 !== t.length ||
				columns.names.length !== sourceNames.length ||
				!tables.has(key(source)) ||
				new Set(columns.names.map(key)).size !== columns.names.length
			)
				throw new Error("Unexpected migration copy source");
			const available = tables.get(key(source)) as Set<string>;
			const definition = snapshotFor(target);
			if (snapshotFor(source) !== definition) throw new Error("Unexpected migration copy source");
			for (const [name, meta] of Object.entries(definition.columns)) {
				if (
					!meta.generated &&
					available.has(key(name)) &&
					!columns.names.some((column) => key(column) === key(name))
				)
					throw new Error(`Existing source column omitted from copy: ${name}`);
			}
			const retained: { target: Token; source: Token }[] = [];
			for (const [index, column] of columns.names.entries()) {
				const sourceColumn = sourceNames[index];
				const meta = Object.entries(definition.columns).find(
					([name]) => key(name) === key(column),
				)?.[1];
				if (!meta) throw new Error("Unknown generated copy target");
				// Derived columns are computed by SQLite, never legal INSERT targets even
				// when the old table exposes the same generated column to SELECT.
				if (meta.generated) continue;
				if (available.has(key(sourceColumn)))
					retained.push({ target: columns.identifiers[index], source: sourceTokens[index] });
				else if (key(sourceColumn) !== key(column) || (meta.notNull && meta.default === undefined))
					throw new Error(`Unbackfilled new required column ${target}.${column}`);
			}
			if (!retained.length) throw new Error("Empty generated copy projection");
			const text = (token: Token) => sql.slice(token.start, token.end);
			rendered = `INSERT INTO ${text(t[2])}(${retained.map((column) => text(column.target)).join(", ")}) SELECT ${retained.map((column) => text(column.source)).join(", ")} FROM ${text(t[end + 1])};`;
		} else if (
			keyword(t[0], "CREATE") &&
			(keyword(t[1], "INDEX") || (keyword(t[1], "UNIQUE") && keyword(t[2], "INDEX")))
		) {
			const offset = keyword(t[1], "UNIQUE") ? 3 : 2;
			identifier(t[offset]);
			if (
				!keyword(t[offset + 1], "ON") ||
				!tables.has(key(identifier(t[offset + 2]))) ||
				t[offset + 3]?.value !== "(" ||
				t.at(-1)?.value === ";"
			)
				throw new Error("Unsupported CREATE INDEX SQL");
		} else if (keyword(t[0], "DROP") && keyword(t[1], "INDEX") && t.length === 3) identifier(t[2]);
		else throw new Error(`Unsupported migration SQL: ${t[0]?.value}`);
		output.push(rendered);
	}
	const finalized = `${["PRAGMA foreign_keys=OFF;", ...output, "PRAGMA foreign_keys=ON;"].join("\n--> statement-breakpoint\n")}\n`;
	if (Buffer.byteLength(finalized) > 1024 * 1024)
		throw new Error("Finalized migration exceeds byte budget");
	validateTargetDDL(statementsOf(finalized), before, after);
	return finalized;
}
/** Existing history is never repaired implicitly. A missing generation receipt may be
 * accepted only when a read-only replay proves the finalizer would change no SQL semantics. */
export function assertResourceMigrationValidated(
	sql: string,
	before: ResourceMigrationSnapshot,
	after: ResourceMigrationSnapshot,
): void {
	const finalized = finalizeResourceMigration(sql, before, after);
	const signature = (source: string) =>
		JSON.stringify(
			statementsOf(source).map(({ tokens }) =>
				tokens.map((token) => [
					token.kind,
					token.kind === "word" ? token.value.toUpperCase() : token.value,
				]),
			),
		);
	if (signature(sql) !== signature(finalized))
		throw new Error(
			"Unvalidated generated migration; pending provenance is required before rewriting",
		);
}
