import type { Snapshot } from "./pg-baseline-model";

const MiB = 1024 * 1024;
const MAX_SQL_BYTES = MiB;
const MAX_TOTAL_BYTES = 32 * MiB;
const MAX_SNAPSHOT_BYTES = 8 * MiB;
const MAX_FILES = 4096;
const MAX_TOKENS = 200_000;
const MAX_STATEMENTS = 32_768;
const MAX_DEPTH = 128;
const MAX_TABLES = 4096;
const MAX_COLUMNS = 1600;
const MAX_PROBLEMS = 128;

type Token = { kind: "word" | "identifier" | "literal" | "symbol"; value: string };

/** A deliberately limited lexer, not a PostgreSQL expression or DDL generator.
 * Literal contents are opaque, so commas/semicolons/DDL words in them cannot affect layout. */
function lex(sql: string): Token[] {
	const tokens: Token[] = [];
	const push = (kind: Token["kind"], value: string) => {
		if (tokens.length >= MAX_TOKENS) throw new Error("SQL token limit exceeded");
		tokens.push({ kind, value });
	};
	for (let i = 0; i < sql.length; ) {
		const char = sql[i];
		if (/\s/.test(char)) {
			i++;
			continue;
		}
		if (sql.startsWith("--", i)) {
			const end = sql.indexOf("\n", i + 2);
			i = end === -1 ? sql.length : end + 1;
			continue;
		}
		if (sql.startsWith("/*", i)) {
			i += 2;
			let depth = 1;
			while (i < sql.length && depth > 0) {
				if (sql.startsWith("/*", i)) {
					if (++depth > MAX_DEPTH) throw new Error("Comment nesting limit exceeded");
					i += 2;
				} else if (sql.startsWith("*/", i)) {
					depth--;
					i += 2;
				} else i++;
			}
			if (depth !== 0) throw new Error("Unterminated block comment");
			continue;
		}
		if (char === '"' || char === "'") {
			const escaped =
				char === "'" &&
				i > 0 &&
				/[eE]/.test(sql[i - 1]) &&
				(i < 2 || !/[A-Za-z0-9_$]/.test(sql[i - 2]));
			let value = "";
			let closed = false;
			i++;
			while (i < sql.length) {
				if (escaped && sql[i] === "\\") {
					i += 2;
					continue;
				}
				if (sql[i] === char) {
					if (sql[i + 1] === char) {
						if (char === '"') value += char;
						i += 2;
						continue;
					}
					i++;
					closed = true;
					break;
				}
				if (char === '"') value += sql[i];
				i++;
			}
			if (!closed) throw new Error("Unterminated quoted identifier/string");
			push(char === '"' ? "identifier" : "literal", value);
			continue;
		}
		if (char === "$") {
			const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
			if (delimiter) {
				const end = sql.indexOf(delimiter, i + delimiter.length);
				if (end === -1) throw new Error("Unterminated dollar string");
				i = end + delimiter.length;
				push("literal", "");
				continue;
			}
		}
		if (/[A-Za-z_]/.test(char)) {
			const start = i++;
			while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
			push("word", sql.slice(start, i).toLowerCase());
			continue;
		}
		push("symbol", char);
		i++;
	}
	return tokens;
}

/** Split only at zero grouping depth, including ARRAY[...] defaults. */
function split(tokens: readonly Token[], separator: string): Token[][] {
	const parts: Token[][] = [];
	const stack: string[] = [];
	let current: Token[] = [];
	for (const token of tokens) {
		if (token.kind === "symbol") {
			if (token.value === "(" || token.value === "[") {
				if (stack.length >= MAX_DEPTH) throw new Error("SQL grouping limit exceeded");
				stack.push(token.value === "(" ? ")" : "]");
			} else if (token.value === ")" || token.value === "]") {
				if (stack.pop() !== token.value) throw new Error("Unbalanced SQL grouping");
			} else if (token.value === ";" && stack.length > 0) {
				throw new Error("Semicolon inside SQL grouping");
			}
			if (token.value === separator && stack.length === 0) {
				parts.push(current);
				current = [];
				continue;
			}
		}
		current.push(token);
	}
	if (stack.length > 0) throw new Error("Unbalanced SQL grouping");
	parts.push(current);
	return parts;
}

class Cursor {
	position = 0;
	constructor(readonly tokens: readonly Token[]) {}
	keyword(word: string): boolean {
		const token = this.tokens[this.position];
		if (token?.kind !== "word" || token.value !== word) return false;
		this.position++;
		return true;
	}
	expect(word: string): void {
		if (!this.keyword(word)) throw new Error(`Expected ${word}`);
	}
	symbol(value: string): boolean {
		const token = this.tokens[this.position];
		if (token?.kind !== "symbol" || token.value !== value) return false;
		this.position++;
		return true;
	}
	identifier(): string {
		const token = this.tokens[this.position++];
		if (
			!token ||
			(token.kind !== "word" && token.kind !== "identifier") ||
			!token.value ||
			Buffer.byteLength(token.value) > 63
		)
			throw new Error("Expected supported PostgreSQL identifier (1–63 UTF-8 bytes)");
		return token.value;
	}
	table(): string {
		const name = this.identifier();
		if (!this.symbol(".")) return name;
		if (name !== "public") throw new Error(`Unsupported schema ${name}`);
		return this.identifier();
	}
	end(): void {
		if (this.position !== this.tokens.length) throw new Error("Unsupported trailing SQL syntax");
	}
	rest(): readonly Token[] {
		return this.tokens.slice(this.position);
	}
}

const constraints = new Set(["constraint", "primary", "foreign", "unique", "check", "exclude"]);
function isConstraint(token: Token | undefined): boolean {
	return token?.kind === "word" && constraints.has(token.value);
}
function optionalExists(cursor: Cursor, negated = false): boolean {
	if (!cursor.keyword("if")) return false;
	if (negated) cursor.expect("not");
	cursor.expect("exists");
	return true;
}
function columns(order: Map<string, string[]>, table: string): string[] {
	const list = order.get(table);
	if (!list) throw new Error(`Unknown SQL table ${table}`);
	return list;
}
function append(list: string[], column: string): void {
	if (list.includes(column)) throw new Error(`Duplicate SQL column ${column}`);
	if (list.length >= MAX_COLUMNS) throw new Error("Column count limit exceeded");
	list.push(column);
}
function requireDefinition(tokens: readonly Token[]): void {
	if (!tokens.length || !["word", "identifier"].includes(tokens[0].kind))
		throw new Error("Unsupported/missing column type definition");
}

function createTable(cursor: Cursor, order: Map<string, string[]>): void {
	const ifNotExists = optionalExists(cursor, true);
	const table = cursor.table();
	if (!cursor.symbol("("))
		throw new Error("Unsupported CREATE TABLE AS/OF/LIKE or missing definitions");
	const start = cursor.position;
	let depth = 1;
	while (cursor.position < cursor.tokens.length && depth > 0) {
		if (cursor.symbol("(")) depth++;
		else if (cursor.symbol(")")) depth--;
		else cursor.position++;
	}
	if (depth !== 0) throw new Error("Unbalanced CREATE TABLE definitions");
	const definitions = split(cursor.tokens.slice(start, cursor.position - 1), ",");
	cursor.end(); // INHERITS, partitions, CTAS and typed tables require a different model.
	const list: string[] = [];
	for (const definition of definitions) {
		if (definition.length === 0) throw new Error("Empty CREATE TABLE definition");
		if (isConstraint(definition[0])) continue;
		if (definition[0].kind === "word" && definition[0].value === "like")
			throw new Error("Unsupported CREATE TABLE LIKE");
		const column = new Cursor(definition);
		const name = column.identifier();
		requireDefinition(column.rest());
		append(list, name);
	}
	if (order.has(table)) {
		if (ifNotExists) return;
		throw new Error(`Duplicate SQL table ${table}`);
	}
	if (order.size >= MAX_TABLES) throw new Error("Table count limit exceeded");
	order.set(table, list);
}

function alterTable(cursor: Cursor, order: Map<string, string[]>): void {
	const ifExists = optionalExists(cursor);
	cursor.keyword("only");
	let table = cursor.table();
	if (ifExists && !order.has(table)) return;
	for (const action of split(cursor.rest(), ",")) {
		const part = new Cursor(action);
		const list = columns(order, table);
		if (part.keyword("add")) {
			if (isConstraint(part.tokens[part.position])) continue;
			part.keyword("column");
			const optional = optionalExists(part, true);
			const name = part.identifier();
			requireDefinition(part.rest());
			if (optional && list.includes(name)) continue;
			append(list, name);
		} else if (part.keyword("drop")) {
			if (part.keyword("constraint")) continue;
			part.keyword("column");
			const optional = optionalExists(part);
			const name = part.identifier();
			if (!part.keyword("cascade")) part.keyword("restrict");
			part.end();
			const index = list.indexOf(name);
			if (index === -1 && !optional) throw new Error(`Unknown SQL column ${table}.${name}`);
			if (index !== -1) list.splice(index, 1);
		} else if (part.keyword("rename")) {
			if (part.keyword("constraint")) {
				part.identifier();
				part.expect("to");
				part.identifier();
				part.end();
				continue;
			}
			if (part.keyword("to")) {
				const renamed = part.identifier();
				part.end();
				if (order.has(renamed)) throw new Error(`Duplicate SQL table ${renamed}`);
				order.delete(table);
				order.set(renamed, list);
				table = renamed;
			} else {
				part.keyword("column");
				const old = part.identifier();
				part.expect("to");
				const renamed = part.identifier();
				part.end();
				const index = list.indexOf(old);
				if (index === -1) throw new Error(`Unknown SQL column ${table}.${old}`);
				if (list.includes(renamed)) throw new Error(`Duplicate SQL column ${table}.${renamed}`);
				list[index] = renamed;
			}
		} else if (part.keyword("alter")) {
			if (part.keyword("constraint")) continue;
			part.keyword("column");
			const name = part.identifier();
			if (!list.includes(name)) throw new Error(`Unknown SQL column ${table}.${name}`);
			const words = part.rest().map((token) => (token.kind === "word" ? token.value : "?"));
			const prefix = words.slice(0, 3).join(" ");
			if (
				!words.length ||
				!(
					words[0] === "type" ||
					/^(set|drop) (default|not null|identity|expression|generated|storage|compression|statistics)/.test(
						prefix,
					) ||
					prefix === "set data type" ||
					prefix.startsWith("add generated ")
				)
			)
				throw new Error(`Unsupported ALTER COLUMN action for ${table}.${name}`);
		} else if (part.keyword("validate") && part.keyword("constraint")) {
			part.identifier();
			part.end();
		} else throw new Error(`Unsupported ALTER TABLE action for ${table}`);
	}
}

function dropTable(cursor: Cursor, order: Map<string, string[]>): void {
	const ifExists = optionalExists(cursor);
	const remainder = [...cursor.rest()];
	const last = remainder[remainder.length - 1];
	if (last?.kind === "word" && ["cascade", "restrict"].includes(last.value)) remainder.pop();
	for (const item of split(remainder, ",")) {
		const part = new Cursor(item);
		const table = part.table();
		part.end();
		if (!order.delete(table) && !ifExists) throw new Error(`Unknown SQL table ${table}`);
	}
}

/** The baseline's UPDATE backfill and SELECT setval call only these builtins.
 * Unknown functions/procedural statements could execute dynamic DDL; never infer their effects. */
function dataOnly(tokens: readonly Token[]): void {
	const safe = new Set(["setval", "pg_get_serial_sequence", "coalesce", "max", "in", "values"]);
	for (let i = 0; i < tokens.length - 1; i++) {
		const token = tokens[i];
		if (
			["word", "identifier"].includes(token.kind) &&
			tokens[i + 1].kind === "symbol" &&
			tokens[i + 1].value === "(" &&
			(token.kind !== "word" || !safe.has(token.value) || tokens[i - 1]?.value === ".")
		)
			throw new Error(`Unsupported potentially dynamic SQL function ${token.value}`);
	}
}

function replay(tokens: readonly Token[], order: Map<string, string[]>): void {
	const cursor = new Cursor(tokens);
	if (cursor.keyword("create")) {
		if (cursor.keyword("table")) {
			createTable(cursor, order);
			return;
		}
		cursor.keyword("unique");
		if (cursor.keyword("index")) return;
	} else if (cursor.keyword("alter")) {
		if (cursor.keyword("table")) {
			alterTable(cursor, order);
			return;
		}
		if (cursor.keyword("index")) return;
	} else if (cursor.keyword("drop")) {
		if (cursor.keyword("table")) {
			dropTable(cursor, order);
			return;
		}
		if (cursor.keyword("index")) return;
	} else if (cursor.keyword("comment")) {
		cursor.expect("on");
		return;
	} else if (["select", "update", "insert", "delete"].some((word) => cursor.keyword(word))) {
		dataOnly(tokens);
		return;
	}
	throw new Error("Unsupported SQL statement (including procedural/dynamic DDL)");
}

/** Derive physical order exclusively from the committed SQL, never catalog observations
 * or snapshot declaration order. Snapshot contributes only the final table/column SETS.
 * Any problem is fatal to the calling baseline gate; partial order is diagnostic only. */
export function physicalColumnOrderFromSql(
	sqls: readonly string[],
	snapshot: Snapshot,
): { order: Map<string, string[]>; problems: string[] } {
	const order = new Map<string, string[]>();
	const problems: string[] = [];
	const problem = (message: string) => {
		if (problems.length < MAX_PROBLEMS) problems.push(message.slice(0, 400));
	};
	try {
		if (sqls.length > MAX_FILES) throw new Error("SQL file count limit exceeded");
		let bytes = 0;
		for (const sql of sqls) {
			const size = Buffer.byteLength(sql);
			if (size > MAX_SQL_BYTES) throw new Error("SQL file exceeds 1 MiB");
			bytes += size;
			if (bytes > MAX_TOTAL_BYTES) throw new Error("SQL total exceeds 32 MiB");
		}
		if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_SNAPSHOT_BYTES)
			throw new Error("Snapshot exceeds 8 MiB");
		let statements = 0;
		for (const [file, sql] of sqls.entries()) {
			try {
				for (const tokens of split(lex(sql), ";")) {
					if (!tokens.length) continue;
					if (++statements > MAX_STATEMENTS) throw new Error("SQL statement limit exceeded");
					try {
						replay(tokens, order);
					} catch (cause) {
						problem(`SQL ${file}, statement ${statements}: ${String(cause)}`);
					}
				}
			} catch (cause) {
				problem(`SQL ${file}: ${String(cause)}`);
			}
			if (statements > MAX_STATEMENTS || problems.length >= MAX_PROBLEMS) break;
		}
		const expectedTables = new Set<string>();
		for (const table of Object.values(snapshot.tables)) {
			if (expectedTables.size >= MAX_TABLES) throw new Error("Snapshot table count limit exceeded");
			if (table.schema && table.schema !== "public") {
				problem(`Unsupported snapshot schema ${table.schema}`);
				continue;
			}
			if (expectedTables.has(table.name)) problem(`Duplicate snapshot table ${table.name}`);
			expectedTables.add(table.name);
			const expectedColumns = new Set<string>();
			for (const [key, column] of Object.entries(table.columns)) {
				if (expectedColumns.size >= MAX_COLUMNS)
					throw new Error("Snapshot column count limit exceeded");
				if (key !== column.name) problem(`Snapshot column key/name mismatch ${table.name}.${key}`);
				if (expectedColumns.has(column.name))
					problem(`Duplicate snapshot column ${table.name}.${column.name}`);
				expectedColumns.add(column.name);
			}
			const actual = order.get(table.name);
			if (!actual) {
				problem(`Snapshot table missing from SQL replay: ${table.name}`);
				continue;
			}
			for (const name of actual)
				if (!expectedColumns.has(name))
					problem(`SQL column missing from snapshot: ${table.name}.${name}`);
			for (const name of expectedColumns)
				if (!actual.includes(name))
					problem(`Snapshot column missing from SQL: ${table.name}.${name}`);
		}
		for (const table of order.keys())
			if (!expectedTables.has(table)) problem(`SQL table missing from snapshot: ${table}`);
	} catch (cause) {
		problem(String(cause));
	}
	return { order, problems };
}
