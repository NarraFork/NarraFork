import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	assertResourceMigrationValidated,
	finalizeResourceMigration,
	type ResourceMigrationSnapshot,
} from "../../finalize-sqlite-resource-migration";
import { generatePostgresSchema } from "../../generate-postgres-schema";

const before: ResourceMigrationSnapshot = {
	tables: {
		users: { columns: { id: { name: "id", type: "text", primaryKey: true } }, foreignKeys: {} },
		resources: {
			columns: {
				id: { name: "id", type: "text", primaryKey: true },
				owner: { name: "owner", type: "text" },
			},
			foreignKeys: {},
		},
	},
};
const after: ResourceMigrationSnapshot = {
	tables: {
		...before.tables,
		resources: {
			columns: {
				...before.tables.resources.columns,
				scope_kind: { name: "scope_kind", type: "text", notNull: true, default: "'unknown'" },
				new_owner: { name: "new_owner", type: "text" },
			},
			foreignKeys: {
				new_owner: {
					columnsFrom: ["new_owner"],
					tableTo: "users",
					columnsTo: ["id"],
					onDelete: "restrict",
					onUpdate: "no action",
				},
			},
		},
	},
};
const create = `CREATE TABLE \`__new_resources\` (id text primary key, owner text, scope_kind text not null default 'unknown', new_owner text, FOREIGN KEY (new_owner) REFERENCES users(id) ON UPDATE no action ON DELETE restrict);`;
const copy =
	'INSERT INTO `__new_resources`("id", "owner", "scope_kind", "new_owner") SELECT "id", "owner", "scope_kind", "new_owner" FROM `resources`;';
const sql = `${create}\n${copy}\nDROP TABLE resources; ALTER TABLE \`__new_resources\` RENAME TO resources;`;
test("pure additions keep data and use DDL defaults in real memory SQLite, without missing-column string literals", () => {
	const finalized = finalizeResourceMigration(sql, before, after);
	expect(finalized).toContain(
		'INSERT INTO `__new_resources`("id", "owner") SELECT "id", "owner" FROM `resources`;',
	);
	expect(finalizeResourceMigration(finalized, before, after)).toBe(finalized);
	expect(() => assertResourceMigrationValidated(sql, before, after)).toThrow("Unvalidated");
	expect(() => assertResourceMigrationValidated(finalized, before, after)).not.toThrow();
	const sqlite = new Database(":memory:");
	try {
		sqlite.exec(
			"CREATE TABLE users(id text primary key); CREATE TABLE resources(id text primary key, owner text); INSERT INTO resources VALUES ('fixture','真实owner');",
		);
		sqlite.exec(finalized);
		expect(sqlite.query("SELECT * FROM resources").get()).toEqual({
			id: "fixture",
			owner: "真实owner",
			scope_kind: "unknown",
			new_owner: null,
		});
		sqlite.exec("INSERT INTO users VALUES ('user'); UPDATE resources SET new_owner='user';");
		expect(sqlite.query("PRAGMA foreign_key_list(resources)").all()).toContainEqual(
			expect.objectContaining({
				table: "users",
				from: "new_owner",
				to: "id",
				on_update: "NO ACTION",
				on_delete: "RESTRICT",
			}),
		);
		expect(() => sqlite.exec("DELETE FROM users WHERE id='user'")).toThrow("FOREIGN KEY");
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		sqlite.close();
	}
});
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
function renameFixture(table: string, from: string, to: string) {
	const previous: ResourceMigrationSnapshot = {
		tables: {
			[table]: {
				columns: {
					id: { name: "id", type: "text", primaryKey: true },
					[from]: { name: from, type: "text" },
				},
				foreignKeys: {},
			},
		},
	};
	const next: ResourceMigrationSnapshot = {
		tables: {
			[table]: {
				columns: {
					id: { name: "id", type: "text", primaryKey: true },
					[to]: { name: to, type: "text" },
					added: { name: "added", type: "text", default: "'new-default'" },
				},
				foreignKeys: {},
			},
		},
	};
	const temp = `__new_${table}`;
	const source = `ALTER TABLE ${q(table)} RENAME COLUMN ${q(from)} TO ${q(to)};
		CREATE TABLE ${q(temp)} (id text primary key, ${q(to)} text, added text default 'new-default');
		INSERT INTO ${q(temp)}("id", ${q(to)}, "added") SELECT "id", ${q(to)}, "added" FROM ${q(table)};
		DROP TABLE ${q(table)}; ALTER TABLE ${q(temp)} RENAME TO ${q(table)};`;
	const finalized = finalizeResourceMigration(source, previous, next);
	const sqlite = new Database(":memory:");
	try {
		sqlite.exec(`CREATE TABLE ${q(table)}(id text primary key, ${q(from)} text);`);
		sqlite
			.prepare(`INSERT INTO ${q(table)} VALUES (?,?)`)
			.run("fixture", '{"原文":"保留", "raw":"a; b"}');
		sqlite.exec(finalized);
		expect(sqlite.query(`SELECT ${q(to)} as value, added FROM ${q(table)}`).get()).toEqual({
			value: '{"原文":"保留", "raw":"a; b"}',
			added: "new-default",
		});
		expect(finalizeResourceMigration(finalized, previous, next)).toBe(finalized);
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
		// Reject an already-damaged artifact too: omitting a live renamed column is not a safe default.
		const damaged = source
			.replace(`"id", ${q(to)}, "added"`, '"id", "added"')
			.replace(`SELECT "id", ${q(to)}, "added"`, 'SELECT "id", "added"');
		expect(() => assertResourceMigrationValidated(damaged, previous, next)).toThrow(
			"Existing source column omitted",
		);
	} finally {
		sqlite.close();
	}
}
test("rename then rebuild preserves the renamed nullable value rather than silently writing NULL", () =>
	renameFixture("resources", "old", "renamed"));
test("escaped identifiers containing quotes, commas, semicolons and breakpoint text are lossless", () =>
	renameFixture(
		'资源; --> statement-breakpoint "`',
		'old,; "` 名',
		'renamed; --> statement-breakpoint "` 名',
	));
test("quoted punctuation in identifiers, defaults and CHECK literals is never treated as delimiters", () => {
	renameFixture("resource ( )", "old ( ; )", "renamed ) ( ,");
	const next = structuredClone(after);
	next.tables.resources.columns.scope_kind.default = "'a; (, )'";
	next.tables.resources.checkConstraints = { ck: { name: "ck", value: "scope_kind <> ')'" } };
	const source = sql
		.replace("scope_kind text", "scope_kind text check(scope_kind <> ')')")
		.replace("default 'unknown'", "default 'a; (, )'");
	const valid = finalizeResourceMigration(source, before, next);
	expect(() => assertResourceMigrationValidated(valid, before, next)).not.toThrow();
	const db = new Database(":memory:");
	try {
		db.exec(
			"CREATE TABLE users(id text primary key); CREATE TABLE resources(id text primary key, owner text); INSERT INTO resources VALUES('fixture','keep');",
		);
		db.exec(valid);
		expect(db.query("SELECT scope_kind FROM resources").get()).toEqual({ scope_kind: "a; (, )" });
	} finally {
		db.close();
	}
});
test("table rename and chained column rename are tracked in statement order", () => {
	const previous: ResourceMigrationSnapshot = {
		tables: {
			old_table: {
				columns: {
					id: { name: "id", type: "text", primaryKey: true },
					old: { name: "old", type: "text" },
				},
				foreignKeys: {},
			},
		},
	};
	const next: ResourceMigrationSnapshot = {
		tables: {
			resources: {
				columns: {
					id: { name: "id", type: "text", primaryKey: true },
					renamed: { name: "renamed", type: "text" },
					added: { name: "added", type: "text", default: "'default'" },
				},
				foreignKeys: {},
			},
		},
	};
	const source = `ALTER TABLE old_table RENAME TO resources; ALTER TABLE resources RENAME COLUMN old TO intermediate; ALTER TABLE resources RENAME COLUMN intermediate TO renamed;
	CREATE TABLE __new_resources(id text primary key, renamed text, added text default 'default');
	INSERT INTO __new_resources(id, renamed, added) SELECT id, renamed, added FROM resources; DROP TABLE resources; ALTER TABLE __new_resources RENAME TO resources;`;
	const finalized = finalizeResourceMigration(source, previous, next);
	const sqlite = new Database(":memory:");
	try {
		sqlite.exec(
			"CREATE TABLE old_table(id text primary key, old text); INSERT INTO old_table VALUES ('fixture','data');",
		);
		sqlite.exec(finalized);
		expect(sqlite.query("SELECT * FROM resources").get()).toEqual({
			id: "fixture",
			renamed: "data",
			added: "default",
		});
	} finally {
		sqlite.close();
	}
});
test("ADD before rebuild makes its real default column available to copy", () => {
	const source = `ALTER TABLE resources ADD scope_kind text not null default 'unknown'; ${sql}`;
	const finalized = finalizeResourceMigration(source, before, after);
	expect(finalized).toContain('SELECT "id", "owner", "scope_kind" FROM `resources`');
});
test("added escaped FK derives snapshot actions and actual SQLite deletion is restricted", () => {
	const table = 'resource " name';
	const column = 'owner, " key';
	const target = 'user; " name';
	const previous: ResourceMigrationSnapshot = {
		tables: {
			[table]: { columns: { id: { name: "id", type: "text", primaryKey: true } }, foreignKeys: {} },
		},
	};
	const next: ResourceMigrationSnapshot = {
		tables: {
			[table]: {
				columns: {
					id: { name: "id", type: "text", primaryKey: true },
					[column]: { name: column, type: "text" },
				},
				foreignKeys: {
					fk: {
						columnsFrom: [column],
						tableTo: target,
						columnsTo: ["id"],
						onDelete: "restrict",
						onUpdate: "no action",
					},
				},
			},
		},
	};
	const finalized = finalizeResourceMigration(
		`ALTER TABLE ${q(table)} ADD ${q(column)} text REFERENCES ${q(target)}(id);`,
		previous,
		next,
	);
	expect(finalized).toContain("ON UPDATE no action ON DELETE restrict;");
	expect(finalizeResourceMigration(finalized, previous, next)).toBe(finalized);
	const sqlite = new Database(":memory:");
	try {
		sqlite.exec(
			`PRAGMA foreign_keys=ON; CREATE TABLE ${q(table)}(id text primary key); CREATE TABLE ${q(target)}(id text primary key); INSERT INTO ${q(target)} VALUES ('user');`,
		);
		sqlite.exec(finalized);
		sqlite.prepare(`INSERT INTO ${q(table)} VALUES (?,?)`).run("fixture", "user");
		expect(() => sqlite.exec(`DELETE FROM ${q(target)}`)).toThrow("FOREIGN KEY");
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		sqlite.close();
	}
});
test("unknown SQL, ambiguous renames, expression copies and FK suffixes fail closed", () => {
	for (const source of [
		"UPDATE resources SET owner = NULL;",
		"ALTER TABLE resources RENAME COLUMN owner TO renamed EXTRA;",
		"ALTER TABLE resources RENAME COLUMN missing TO renamed;",
		"ALTER TABLE resources RENAME COLUMN owner TO id;",
		`${create} INSERT INTO __new_resources(id,owner) SELECT id,coalesce(owner,'x') FROM resources;`,
		"ALTER TABLE resources ADD new_owner text REFERENCES users(id) DEFERRABLE;",
		"ALTER TABLE resources ADD new_owner text REFERENCES wrong(id);",
	])
		expect(() => finalizeResourceMigration(source, before, after)).toThrow();
	expect(() =>
		finalizeResourceMigration(
			`${create} INSERT INTO __new_resources(id,owner) SELECT id,owner FROM wrong;`,
			before,
			after,
		),
	).toThrow("source");
	const required = structuredClone(after);
	required.tables.resources.columns.scope_kind.default = undefined;
	expect(() =>
		finalizeResourceMigration(sql.replace(" default 'unknown'", ""), before, required),
	).toThrow("Unbackfilled");
});
test.each([
	[
		"missing FK",
		(source: string) =>
			source.replace(
				", FOREIGN KEY (new_owner) REFERENCES users(id) ON UPDATE no action ON DELETE restrict",
				"",
			),
	],
	[
		"wrong FK delete action",
		(source: string) => source.replace("ON DELETE restrict", "ON DELETE cascade"),
	],
	[
		"wrong FK update action",
		(source: string) => source.replace("ON UPDATE no action", "ON UPDATE cascade"),
	],
	[
		"wrong FK target table",
		(source: string) => source.replace("REFERENCES users(id)", "REFERENCES resources(id)"),
	],
	[
		"wrong FK target column",
		(source: string) => source.replace("REFERENCES users(id)", "REFERENCES users(wrong)"),
	],
	["wrong default", (source: string) => source.replace("default 'unknown'", "default 'wrong'")],
	["missing default", (source: string) => source.replace(" default 'unknown'", "")],
	["missing not-null", (source: string) => source.replace("not null ", "")],
	["extra not-null", (source: string) => source.replace("owner text,", "owner text not null,")],
	["wrong type", (source: string) => source.replace("scope_kind text", "scope_kind integer")],
	["missing primary key", (source: string) => source.replace(" primary key", "")],
	[
		"unexpected uniqueness",
		(source: string) => source.replace("owner text,", "owner text unique,"),
	],
	[
		"unexpected check",
		(source: string) =>
			source.replace("scope_kind text", "scope_kind text check (scope_kind is null)"),
	],
] as const)("CREATE target semantics reject %s in generation and receipt-less validation", (_label, alter) => {
	const valid = finalizeResourceMigration(sql, before, after);
	const damaged = alter(valid);
	const db = new Database(":memory:");
	try {
		db.exec(
			"CREATE TABLE users(id text primary key); CREATE TABLE resources(id text primary key, owner text);",
		);
		// All negative artifacts are syntactically executable SQLite DDL, not text-only probes.
		db.exec(damaged);
		expect(db.query("PRAGMA table_xinfo(resources)").all().length).toBe(4);
		expect(() => finalizeResourceMigration(damaged, before, after)).toThrow("Target DDL differs");
		expect(() => assertResourceMigrationValidated(damaged, before, after)).toThrow(
			"Target DDL differs",
		);
	} finally {
		db.close();
	}
});
test("snapshot PK, unique, CHECK and partial/composite indices are verified in real SQLite", () => {
	const next = structuredClone(after);
	next.tables.resources.uniqueConstraints = { unique: { columns: ["owner", "scope_kind"] } };
	next.tables.resources.checkConstraints = {
		ck: { name: "ck", value: "scope_kind in ('unknown', 'project')" },
	};
	next.tables.resources.indexes = {
		idx: {
			name: "idx",
			columns: ["owner", "new_owner"],
			isUnique: true,
			where: "new_owner is not null",
		},
	};
	const source = `${sql.replace(
		"new_owner text,",
		"new_owner text, CONSTRAINT uq UNIQUE(owner, scope_kind), CONSTRAINT ck CHECK(scope_kind in ('unknown', 'project')),",
	)} CREATE UNIQUE INDEX idx ON resources(owner, new_owner) WHERE new_owner is not null;`;
	const valid = finalizeResourceMigration(source, before, next);
	expect(() => assertResourceMigrationValidated(valid, before, next)).not.toThrow();
	for (const damaged of [
		valid.replace("CONSTRAINT uq UNIQUE(owner, scope_kind), ", ""),
		valid.replace("CONSTRAINT ck CHECK(scope_kind in ('unknown', 'project')), ", ""),
		valid.replace("'project'", "'wrong'"),
		valid.replace("CREATE UNIQUE INDEX", "CREATE INDEX"),
		valid.replace("(owner, new_owner) WHERE", "(new_owner, owner) WHERE"),
		valid.replace("new_owner is not null;", "new_owner is null;"),
		valid.replace(
			"CREATE UNIQUE INDEX idx ON resources(owner, new_owner) WHERE new_owner is not null;",
			"",
		),
	]) {
		const db = new Database(":memory:");
		try {
			db.exec(
				"CREATE TABLE users(id text primary key); CREATE TABLE resources(id text primary key, owner text);",
			);
			db.exec(damaged);
			expect(() => finalizeResourceMigration(damaged, before, next)).toThrow("Target DDL differs");
		} finally {
			db.close();
		}
	}
});
test("composite primary key order is semantic; unsupported expressions/constraints fail closed", () => {
	const next = structuredClone(before);
	next.tables.resources.columns.id.primaryKey = false;
	next.tables.resources.compositePrimaryKeys = { pk: { columns: ["id", "owner"] } };
	const source =
		"CREATE TABLE __new_resources(id text, owner text, PRIMARY KEY(id,owner)); INSERT INTO __new_resources(id,owner) SELECT id,owner FROM resources; DROP TABLE resources; ALTER TABLE __new_resources RENAME TO resources;";
	const valid = finalizeResourceMigration(source, before, next);
	expect(() => assertResourceMigrationValidated(valid, before, next)).not.toThrow();
	expect(() =>
		finalizeResourceMigration(
			valid.replace("PRIMARY KEY(id,owner)", "PRIMARY KEY(owner,id)"),
			before,
			next,
		),
	).toThrow("Target DDL differs");
	const unknown = structuredClone(after);
	unknown.tables.resources.columns.scope_kind.default = "(random())";
	expect(() => finalizeResourceMigration(sql, before, unknown)).toThrow(
		"Unsupported schema expression",
	);
	expect(() =>
		finalizeResourceMigration(
			sql.replace("ON DELETE restrict", "ON DELETE restrict DEFERRABLE INITIALLY DEFERRED"),
			before,
			after,
		),
	).toThrow("Unsupported schema DDL");
});
test.each([
	"virtual",
	"stored",
] as const)("generated %s columns verify expression/mode and recompute in real SQLite", (mode) => {
	const next = structuredClone(after);
	next.tables.resources.columns.new_owner.generated = { as: "lower(owner)", type: mode };
	const generated = `GENERATED ALWAYS AS (lower(owner)) ${mode}`;
	const source = sql.replace("new_owner text,", `new_owner text ${generated},`);
	const valid = finalizeResourceMigration(source, before, next);
	expect(() => assertResourceMigrationValidated(valid, before, next)).not.toThrow();
	// SQLite permits the AS shorthand too: table_xinfo, not a GENERATED keyword,
	// determines whether a column is derived.
	expect(() =>
		assertResourceMigrationValidated(valid.replace("GENERATED ALWAYS AS", "AS"), before, next),
	).not.toThrow();
	const sqlite = new Database(":memory:");
	try {
		sqlite.exec(
			"CREATE TABLE users(id text primary key); INSERT INTO users VALUES ('mixed'),('changed'); CREATE TABLE resources(id text primary key, owner text); INSERT INTO resources VALUES ('fixture','Mixed');",
		);
		sqlite.exec(valid);
		expect(sqlite.query("PRAGMA table_xinfo(resources)").all()).toContainEqual(
			expect.objectContaining({ name: "new_owner", hidden: mode === "virtual" ? 2 : 3 }),
		);
		expect(sqlite.query("SELECT new_owner FROM resources").get()).toEqual({ new_owner: "mixed" });
		sqlite.exec("UPDATE resources SET owner='Changed';");
		expect(sqlite.prepare("SELECT new_owner FROM resources").get()).toEqual({
			new_owner: "changed",
		});
	} finally {
		sqlite.close();
	}
	for (const damaged of [
		valid.replace(` ${generated}`, ""),
		valid.replace("lower(owner)", "upper(owner)"),
		valid.replace(` ${mode},`, ` ${mode === "virtual" ? "stored" : "virtual"},`),
	]) {
		const sqlite = new Database(":memory:");
		try {
			sqlite.exec(
				"CREATE TABLE users(id text primary key); CREATE TABLE resources(id text primary key, owner text);",
			);
			sqlite.exec(damaged);
			expect(() => finalizeResourceMigration(damaged, before, next)).toThrow("Target DDL differs");
			expect(() => assertResourceMigrationValidated(damaged, before, next)).toThrow(
				"Target DDL differs",
			);
		} finally {
			sqlite.close();
		}
	}
});
test("rebuild never inserts an existing generated source column into a generated target", () => {
	const previous = structuredClone(before),
		next = structuredClone(after);
	const generated = { as: "lower(owner)", type: "virtual" as const };
	previous.tables.resources.columns.new_owner = { name: "new_owner", type: "text", generated };
	next.tables.resources.columns.new_owner.generated = generated;
	const source = sql.replace("new_owner text,", "new_owner text AS(lower(owner)) VIRTUAL,");
	const valid = finalizeResourceMigration(source, previous, next);
	expect(valid).toContain(
		'INSERT INTO `__new_resources`("id", "owner") SELECT "id", "owner" FROM `resources`;',
	);
	expect(() => assertResourceMigrationValidated(valid, previous, next)).not.toThrow();
	const sqlite = new Database(":memory:");
	try {
		sqlite.exec(
			"CREATE TABLE users(id text primary key); INSERT INTO users VALUES ('mixed'); CREATE TABLE resources(id text primary key, owner text, new_owner text AS(lower(owner)) VIRTUAL); INSERT INTO resources(id,owner) VALUES('fixture','Mixed');",
		);
		sqlite.exec(valid);
		expect(sqlite.query("SELECT new_owner FROM resources").get()).toEqual({ new_owner: "mixed" });
	} finally {
		sqlite.close();
	}
});
test("real 0189 remains valid with both pre-existing generated expressions preserved", () => {
	const read = (path: string) => readFileSync(resolve(import.meta.dir, "../../..", path), "utf8");
	const previous = JSON.parse(read("drizzle/meta/0188_snapshot.json")) as ResourceMigrationSnapshot;
	const next = JSON.parse(read("drizzle/meta/0189_snapshot.json")) as ResourceMigrationSnapshot;
	expect(next.tables.narrator_messages.columns.compact_pending.generated?.type).toBe("virtual");
	expect(next.tables.narrator_tool_calls.columns.started_at.generated?.type).toBe("virtual");
	expect(() =>
		assertResourceMigrationValidated(read("drizzle/0189_pale_red_ghost.sql"), previous, next),
	).not.toThrow();
});
test("PG maps exact UTC text defaults and byte rather than character budgets", () => {
	const source = `import { sql } from "drizzle-orm"; import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";
	export const resources = sqliteTable("resources", { config: text("config", {mode:"json"}), createdAt: text("created_at").notNull().default(sql\`(datetime('now'))\`) }, (table) => [ check("config_bytes", sql\`\${table.config} is null or length(cast(\${table.config} as blob)) <= 16384\`) ]);`;
	const generated = generatePostgresSchema(source);
	expect(generated.coverage.tables[0]?.columns[1]?.defaultExpression).toBe(
		'sql.raw("CURRENT_TIMESTAMP::text")',
	);
	expect(generated.coverage.tables[0]?.checkDefinitions[0]?.expression).toBe(
		'"config" is null or octet_length("config") <= 16384',
	);
});
