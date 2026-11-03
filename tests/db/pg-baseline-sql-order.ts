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

/** `start`/`end` are source offsets, so a statement's exact text (including the opaque body of a
 * dollar-quoted literal) can be recovered for the procedural allow-list digest. */
type Token = {
	kind: "word" | "identifier" | "literal" | "symbol";
	value: string;
	start: number;
	end: number;
};

/** A deliberately limited lexer, not a PostgreSQL expression or DDL generator.
 * Literal contents are opaque, so commas/semicolons/DDL words in them cannot affect layout. */
function lex(sql: string): Token[] {
	const tokens: Token[] = [];
	let tokenStart = 0;
	const push = (kind: Token["kind"], value: string, end: number) => {
		if (tokens.length >= MAX_TOKENS) throw new Error("SQL token limit exceeded");
		tokens.push({ kind, value, start: tokenStart, end });
	};
	for (let i = 0; i < sql.length; ) {
		tokenStart = i;
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
			push(char === '"' ? "identifier" : "literal", value, i);
			continue;
		}
		if (char === "$") {
			const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
			if (delimiter) {
				const end = sql.indexOf(delimiter, i + delimiter.length);
				if (end === -1) throw new Error("Unterminated dollar string");
				i = end + delimiter.length;
				push("literal", "", i);
				continue;
			}
		}
		if (/[A-Za-z_]/.test(char)) {
			const start = i++;
			while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
			push("word", sql.slice(start, i).toLowerCase(), i);
			continue;
		}
		push("symbol", char, i + 1);
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
		} else if (
			(part.keyword("disable") || part.keyword("enable")) &&
			part.keyword("row") &&
			part.keyword("level") &&
			part.keyword("security")
		) {
			// drizzle-kit emits this before DROP TABLE. It does not add, drop, or reorder columns.
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

/**
 * Reviewed procedural statements, admitted by EXACT text only.
 *
 * Layout replay cannot see inside a dollar-quoted body, so procedural DDL stays fail-closed in
 * general. Admitted statements are the model-history revision triggers of migration 0012 (they
 * bump integer counters), the numeric context-stats copy of migration 0022 (it upserts one
 * existing table), the model-history v2 reinstall of migration 0029 (it drops the v1
 * triggers and functions; v2 also sets a tool block's phase and queues envelopes for block
 * sync), and the v3 reinstall of migration 0032 (v2's bodies, skipping state-only writes). None of them alter, create or drop a relation or column. Each entry is the
 * SHA-256 of the statement as written in the SQL file (trimmed, without its terminating
 * semicolon); a single changed character falls back to the generic rejection and requires a
 * fresh review here.
 */
const REVIEWED_PROCEDURAL_STATEMENTS = new Map<string, string>([
	// 0012_narrator_model_history_revision.sql
	[
		"4771573f041a0f54e3ea0665ef68ee93aea8f0be9c027c72de57d693732cce33",
		"function model_history_v1_message",
	],
	[
		"9dcbda8218ea5783c1bc304ab0d7472816d21a45a0fb4dc0d9b955a8ba113c39",
		"trigger model_history_v1_message",
	],
	[
		"2a90b0a82ef23a094793b4b8ae322c6725192bcaa2a0f829720cb816c3063f67",
		"function model_history_v1_tool",
	],
	[
		"135b8ca862703e6c811b7f2e7da3585600201e6d6be1f187b9c297a9edf94446",
		"trigger model_history_v1_tool",
	],
	[
		"a1e81f82f84ea6999608cba94b3cb28c6d9e46ec1a62c4538a67e42a70feb16f",
		"function model_history_v1_ref",
	],
	[
		"d59312f6957e2345c014e0f9ea6ec918edf029e7bceb02909bbe8d13220fffcf",
		"trigger model_history_v1_ref",
	],
	[
		"4a4d437cd8296f4b050c4f812bdfab84876a3dd5090821a8da85f70c7fa6e4d8",
		"function model_history_v1_sender",
	],
	[
		"f6f18636aabff4b30eb9d592463bb999f5b249322c936328371b9abbdd928798",
		"trigger model_history_v1_sender",
	],
	[
		"5f257c52cde5633aaee32d32c6afbee74353d707b668edddd38573edea2983bb",
		"function model_history_v1_narrator",
	],
	[
		"5121c08ad3af983c5dbeb029b7bf4f0a43831fc3d945f9455e0d4596b270f2da",
		"trigger model_history_v1_narrator",
	],
	[
		"4549dcc98c05b70107eed1856f9687b2ab67795464f97dd8acd77d38b58d73ae",
		"seed model_history_revision_contracts",
	],
	// 0022_context_numeric_stats.sql — copy numeric segment stats into the narrow table.
	// The function and triggers only upsert that table; they do not create or alter relations.
	[
		"dc09f67bd5b97b0440d33d62c4c50db8b69957264bc8e8edda207e51dabf1dec",
		"seed narrator_message_context_stats",
	],
	[
		"83352de61b413232368259136465e60f215807870009912ce46b176471f38519",
		"function narrator_message_context_stats_sync",
	],
	[
		"e7c8c9b44becb63fe0e904db984449dceeac533d2d1e47def2b13705b1741ea6",
		"trigger narrator_message_context_stats_insert",
	],
	[
		"adb48fb8a2e584de04374d4bdd36395b87299f1d5b0b53e726ecdef2890b4c13",
		"trigger narrator_message_context_stats_update",
	],
	// 0029_block_storage.sql — model-history contract v2, a versioned reinstall: drops the v1
	// triggers and functions, then installs v2 (revision bumps, tool-block phase, sync queue).
	[
		"4c5764c911db08f3937bfb02348d51f48280d288fd440d90c95235e89151cf65",
		"drop trigger model_history_v1_message",
	],
	[
		"9cc4e00ae32c088206b57b187ad78ac2b0c7bf380b6eb4936bada7c229549d89",
		"drop function model_history_v1_message",
	],
	[
		"80d20309b0e1aa94bf39cd0b73152c1d444e56991090fb94c9462dfb96d12898",
		"drop trigger model_history_v1_tool",
	],
	[
		"f4c0a8ae4394d7101a6f7137079df965ef6e3d1a542dd3207f2cda47674facaa",
		"drop function model_history_v1_tool",
	],
	[
		"f0f0e5450bd8f2b7df6ac44f58762509439d064f8b0cd5d7a2fda96b051fa826",
		"drop trigger model_history_v1_ref",
	],
	[
		"b65f55e72fbae77dac9e1b63b070dc6f75cc3f219847e4e252d3694b4cdf0c65",
		"drop function model_history_v1_ref",
	],
	[
		"31b85ca08d3bbb2704492e773a6e78207730060c751cbd3c21c7424cefbcdd5d",
		"drop trigger model_history_v1_sender",
	],
	[
		"7083bf694ecddeb70dddc3a4df5864cb2948c399d6f90ec6478a2d5c649dd219",
		"drop function model_history_v1_sender",
	],
	[
		"958ca35d4a6c3d643555c98f6615fc6d239edd9454beb4766bc470c661fa9206",
		"drop trigger model_history_v1_narrator",
	],
	[
		"d87ec539a72e18ec8105ef0f96b3b0c151e9936983a42ea26b1e8ed03205c9c1",
		"drop function model_history_v1_narrator",
	],
	[
		"d783a8a4723fbbb75d7d996779701210b04332be4fc49aabb8a373e283363062",
		"function model_history_v2_message",
	],
	[
		"d6926c3eda8bf3ece36d20a00d1b3184ecdfb353c73def2e6e275e96c489965b",
		"trigger model_history_v2_message",
	],
	[
		"0e7d7020a026dd1ac6a13676237aeab86ca933c2c70652e64c913b65ffb5b93f",
		"function model_history_v2_tool",
	],
	[
		"931aa34270cceff36c06bd857b4ae3d40f0c454ef58a9c87d6543358673954eb",
		"trigger model_history_v2_tool",
	],
	[
		"b9503fe634712ea69dee9063f32d4fbaffa22ea4d22a135b5c0827d719afcafb",
		"function model_history_v2_ref",
	],
	[
		"a5a5a58b2b2ac2cb01b590dfa994d229ada38a7b1a0afb8f9767201c32c153b4",
		"trigger model_history_v2_ref",
	],
	[
		"3928308ba47d26eca2c8ee3e3656343fcfba7a7c300668ca4a6c057540a5fb6a",
		"function model_history_v2_block",
	],
	[
		"ecd3e22563f3ae338b9ffdc5733647b6df08aa0ff27307b2e4b138b7bd58083a",
		"trigger model_history_v2_block",
	],
	[
		"0064fe3b4d6636f136b40229e77e5f7139599b01426f55a7b6fb61eacf4ca619",
		"function model_history_v2_tool_phase",
	],
	[
		"8abd70c11747beb4501aa6b16b77a5c9cb584a7a95878d36178ee7c7448e4e56",
		"trigger model_history_v2_tool_phase",
	],
	[
		"e5fbbb143be30768ed5ca37e5738736c27bd8c6a6aa464f53073194540ec1c8c",
		"function model_history_v2_sync_message",
	],
	[
		"7a7df5459db3608e9741bc53f873d62ec43f334f6c3be435d647d85a23e14fb0",
		"trigger model_history_v2_sync_message",
	],
	[
		"89f64c3a69622dbdba888396475006455439f8b6fd40c4fee36f17cc75f3be5a",
		"function model_history_v2_sync_tool",
	],
	[
		"6d9fb645eb12b0fda8257f307d3fb49a8466d7c5f8f1a828e8fb66339584f9fb",
		"trigger model_history_v2_sync_tool",
	],
	[
		"075a5660d50efb2b6d80c78fbc307a97968f193077a52fb401e5b2110c8f94ce",
		"function model_history_v2_sender",
	],
	[
		"a611b18a131d1585f1e704216651a30292b3bbc0f6c8751b3a9fe7352f13d61e",
		"trigger model_history_v2_sender",
	],
	[
		"b75813f047288bbb4c995647fbae67d429184528c606d587b9c4542083b33190",
		"function model_history_v2_narrator",
	],
	[
		"1b39a2e3c3f5d8351c562cc8efb72579929b1a7fec62a689174dc815105ae48b",
		"trigger model_history_v2_narrator",
	],
	[
		"86db7cec3aadd9b1a291f6450f678045f020d93eca502eb0924b656714aeedd4",
		"seed model_history_revision_contracts",
	], // 0032_block_state_writes.sql — model-history contract v3, a versioned reinstall: drops the
	// v1 (identical to 0029's, admitted above) and v2 triggers and functions, then installs v3.
	// Bodies are v2's (revision bumps, tool-block phase, sync queue) except that a body change
	// carried by a state-only write (`state_revision` moved) neither bumps nor queues a sync.
	[
		"b6fa9ca4db465b23963167c07ff13bdf207b1e90ec699cc2cf4499d3155904e7",
		"drop trigger model_history_v2_block",
	],
	[
		"6a3ee70dd6f715cc01046f22e81b17d9d8b397a1929657e73391d0d2a4ae3600",
		"drop function model_history_v2_block",
	],
	[
		"4eb14de8c064df13cf4f55fab91a2065138618c0e212c5476f262cd282a98a1f",
		"drop trigger model_history_v2_message",
	],
	[
		"4159a609e64b7c0bacac8cb6a1250b202e7b7199e14a34d02b95f6f01aba6ac0",
		"drop function model_history_v2_message",
	],
	[
		"ebc69d839041de603db650762610740ef1d27fafac90ea5d7bc433c795dde767",
		"drop trigger model_history_v2_narrator",
	],
	[
		"d26a2c3a5ba9852941afe8bce2bdef4392d7de1b92e314080ff64af99228ad0d",
		"drop function model_history_v2_narrator",
	],
	[
		"8d6d1e0ee8f0bb2ea558fe2d4a0be9c0c572eb2ba7e81e80498b18bd7320d910",
		"drop trigger model_history_v2_ref",
	],
	[
		"f21e81752ea0b9f01314fb72f8c4600250da6d8cdb5182ee4f55a6a7bab90608",
		"drop function model_history_v2_ref",
	],
	[
		"6caf6fcce3d7670a6e9edb7de332471199d497b33238e32702e8c1482958779c",
		"drop trigger model_history_v2_sender",
	],
	[
		"f7a07fd1769a53dc8a60c0981f29408a428c0c5ba50c7a2a22ef932bb5c01306",
		"drop function model_history_v2_sender",
	],
	[
		"08171cf681fc4601755d291f5f9b849a5ffa711aff056925a854b60513dc3c39",
		"drop trigger model_history_v2_sync_message",
	],
	[
		"8fe829fc0eaceb62eea8851e08440a529f98de00ad46d0fbc9ac659e5bcd75c0",
		"drop function model_history_v2_sync_message",
	],
	[
		"80c35a995699fdc3292f00a05563b3e2230162ee9aedd6568845da76752b1ab4",
		"drop trigger model_history_v2_sync_tool",
	],
	[
		"71a6e897ee0f6c2392fc0322598996751512313cd941b46c1445c9c3f7e12bec",
		"drop function model_history_v2_sync_tool",
	],
	[
		"fca67a32fcdb7653bd79dd39d2a96d73742ff3b8a46b23e99b0498e707ac4606",
		"drop trigger model_history_v2_tool",
	],
	[
		"7adc55ea56705d46f4242d39141054cf5c218c0dcac264fb3567788c6b79b7a5",
		"drop function model_history_v2_tool",
	],
	[
		"6c3d9cc888d18bd3567e1c623cbb41140dcec11e45cc5fc2640ef2df1332fe19",
		"drop trigger model_history_v2_tool_phase",
	],
	[
		"1fca4d050230bb00020906ff571fe8cfb275e5a6c7c2474067f824f1beecaa97",
		"drop function model_history_v2_tool_phase",
	],
	[
		"020480d2ea4635270a066281a091742c73789cae058757fee4ea4ba6adceead7",
		"function model_history_v3_block",
	],
	[
		"0f613861586109fa19aa61a049a81a15b3609158e1a600fb24bb35cf6bca2b36",
		"trigger model_history_v3_block",
	],
	[
		"db6b7224bb19de85748d5d760373b8ac2976a70749943be3838dd771b2b62a71",
		"function model_history_v3_message",
	],
	[
		"4885eb7f72868b5a4792a6c80360fbb714207dd4392a129ee6a520ed9f8c6610",
		"trigger model_history_v3_message",
	],
	[
		"96231aea585f6b11b6877a679212ca9f62dd5550400c057a289a87eb3a1a7adc",
		"function model_history_v3_narrator",
	],
	[
		"74f5fe69acf0817face9e59b0aa00d0c18c19b64d1dcd7a4f958d5a3fdd8ba68",
		"trigger model_history_v3_narrator",
	],
	[
		"95c8339e98c6e96244dc83a18e2bc8cfd4d3a9184eed8a2c5e4fa7495656af41",
		"function model_history_v3_ref",
	],
	[
		"7d0491e5804a0a0cac246852f87333b89904cc8a2e7176da494fa8049f58aaf7",
		"trigger model_history_v3_ref",
	],
	[
		"47b4e2022b027855363bb27c5481543158f83e2252e32322d2b17b591f159b2d",
		"function model_history_v3_sender",
	],
	[
		"42f50663431da03b0d5618b33c363404f1a83bed1a2b570bb75823517f1b3ff1",
		"trigger model_history_v3_sender",
	],
	[
		"043a5a5b2ca706f3e92343f1c75587faf422d629b7a7dc8b7f6f0f03302f878b",
		"function model_history_v3_sync_message",
	],
	[
		"7e4357cec3310e9367e81cce1c7f9a1856e9db3a9cc3725b8f46994903ab1bc4",
		"trigger model_history_v3_sync_message",
	],
	[
		"4315610a299d811a48e9745135efa16b4bead351ac6a1b0370fbf7a7ffa1ea81",
		"function model_history_v3_sync_tool",
	],
	[
		"c5f7c4d4864a67a29412954459d5b2ef6f9a21f0b112430883f2efb74d263326",
		"trigger model_history_v3_sync_tool",
	],
	[
		"be786fc8166920136d4c1dbe393c9cb9578a883a92e4849c12618598fad21474",
		"function model_history_v3_tool",
	],
	[
		"7092284af0e6812ced6d97d7d28163d80d5d05d8bc526dfc4584cf1c03714183",
		"trigger model_history_v3_tool",
	],
	[
		"96a9a42f3ce3c279dd98562c0f102403d3c276adbf582325c5767387b2462a66",
		"function model_history_v3_tool_phase",
	],
	[
		"3c0bad8c22b457442fb7555b1fd17e9bb037a23b043d386bbc6bdae202ce7e5f",
		"trigger model_history_v3_tool_phase",
	],
	[
		"cb31b756676a5cda7d00a35e241e806f9acbace1f5f71d3ffa8d0574cc90c4ce",
		"seed model_history_revision_contracts",
	],
]);

/** The exact source text of one statement, as the allow-list digests were computed. */
function statementText(tokens: readonly Token[], sql: string): string {
	const first = tokens[0];
	const last = tokens[tokens.length - 1];
	return first && last ? sql.slice(first.start, last.end).trim() : "";
}

function reviewedProcedural(tokens: readonly Token[], sql: string): boolean {
	const digest = new Bun.CryptoHasher("sha256").update(statementText(tokens, sql)).digest("hex");
	const label = REVIEWED_PROCEDURAL_STATEMENTS.get(digest);
	if (!label) return false;
	// Defence in depth: the digest pins the text, the label pins what kind of statement it is.
	const cursor = new Cursor(tokens);
	if (label.startsWith("seed ")) return cursor.keyword("insert") && cursor.keyword("into");
	const [verb, kind] = label.split(" ");
	if (verb === "drop") return cursor.keyword("drop") && cursor.keyword(kind);
	return cursor.keyword("create") && cursor.keyword(verb);
}

// 0047 contains conditional DDL, unlike the layout-neutral procedural allow-list above.
// Pin each entire DO statement, then model its effect in the fresh-journal baseline only.
function reviewedNativeMedia(
	tokens: readonly Token[],
	order: Map<string, string[]>,
	sql: string,
): boolean {
	if (
		tokens.length !== 2 ||
		tokens[0].kind !== "word" ||
		tokens[0].value !== "do" ||
		tokens[1].kind !== "literal"
	)
		return false;
	const digest = new Bun.CryptoHasher("sha256").update(statementText(tokens, sql)).digest("hex");
	if (digest === "36a3c3e0d2507d106d39d5a8b5b2764b3b070a9ee0322636e09b285f7dc43748") {
		// The successful branch appends the column if absent; otherwise its position survives.
		alterTable(
			new Cursor(lex('"narrator_buffered_messages" ADD COLUMN IF NOT EXISTS "media_json" text')),
			order,
		);
		return true;
	}
	if (digest === "98f2d53888afee6f78e3bcde908a989422596be1b733ec98aba7a121d1a4720a") {
		// In a fresh ordered journal, 0046 already ran, so the compensation branch is not
		// entered. Require its layout effects to exist instead of silently ignoring them.
		for (const [table, required] of [
			[
				"outline_task_claims",
				[
					"task_block_id",
					"holder_narrator_id",
					"holder_user_id",
					"epoch",
					"task_version_at_claim",
					"claimed_at",
					"expires_at",
					"last_holder_narrator_id",
					"last_holder_user_id",
				],
			],
			["outline_blocks", ["in_process"]],
			["outline_spaces", ["in_process_ready", "in_process_epoch"]],
		] as const) {
			const list = columns(order, table);
			for (const name of required)
				if (!list.includes(name))
					throw new Error(`0047 compensation baseline missing ${table}.${name}`);
		}
		return true;
	}
	if (digest === "414813a7b4bed0c6f7e194c10befc5738a540dc5aa03860bb05417100eb5863d") {
		// On the fresh baseline upstream 0047 has already supplied these columns.
		const list = columns(order, "narrators");
		for (const name of ["hidden_from_lists", "modeltrace_key"])
			if (!list.includes(name))
				throw new Error(`0048 compensation baseline missing narrators.${name}`);
		return true;
	}
	return false;
}

function replay(tokens: readonly Token[], order: Map<string, string[]>, sql = ""): void {
	if (sql && (reviewedProcedural(tokens, sql) || reviewedNativeMedia(tokens, order, sql))) return;
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
						replay(tokens, order, sql);
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
