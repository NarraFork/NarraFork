import { describe, expect, test } from "bun:test";
import {
	checkParity,
	loadManifest,
	loadSource,
	normalizeCoverage,
	normalizeSqlExpression,
	PARITY_MUTATIONS,
	type RawColumn,
	type RawCoverage,
	validateCoverage,
} from "../../check-postgres-schema-parity";

/**
 * A minimal two-table coverage in the generator's own shape. Isolated fixtures keep every rule
 * provable on its own, so a rule stays tested even if the real schema stops exercising it.
 */
function fixture(): RawCoverage {
	return {
		tableCount: 2,
		columnCount: 4,
		tables: [
			{
				exportName: "users",
				name: "users",
				columns: [
					{
						property: "id",
						name: "id",
						kind: "text",
						pgType: "text",
						notNull: true,
						primary: true,
						unique: false,
					},
					{
						property: "email",
						name: "email",
						kind: "text",
						pgType: "text",
						notNull: true,
						primary: false,
						unique: false,
					},
				],
				indexes: [
					{
						name: "idx_users_email",
						columns: ["email"],
						unique: true,
						emitAsUniqueConstraint: true,
					},
				],
				checks: [],
				checkDefinitions: [],
				foreignKeys: [],
				uniqueConstraints: [],
				primaryKeys: [],
			},
			{
				exportName: "posts",
				name: "posts",
				columns: [
					{
						property: "id",
						name: "id",
						kind: "text",
						pgType: "text",
						notNull: true,
						primary: true,
						unique: false,
					},
					{
						property: "authorEmail",
						name: "author_email",
						kind: "text",
						pgType: "text",
						notNull: false,
						primary: false,
						unique: false,
						references: {
							table: "users",
							column: "email",
							onDelete: "cascade",
							constraintName: "posts_author_email_users_email_fk",
						},
						emitAsTableConstraint: false,
					},
				],
				indexes: [],
				checks: [],
				checkDefinitions: [],
				foreignKeys: [],
				uniqueConstraints: [],
				primaryKeys: [],
			},
		],
	};
}
/** Apply a mutation to the target side only; the source stays the untouched fixture. */
function mutate(apply: (target: RawCoverage) => void): string[] {
	const target = fixture();
	apply(target);
	return validateCoverage(fixture(), target);
}
const jsonColumn = (defaultExpression: string): RawColumn => ({
	property: "tags",
	name: "tags",
	kind: "text",
	mode: "json",
	pgType: "text",
	notNull: true,
	primary: false,
	unique: false,
	defaultValue: "[]",
	defaultExpression,
});

describe("parity fixture baseline", () => {
	test("an unmutated fixture compares clean", () => {
		expect(validateCoverage(fixture(), fixture())).toEqual([]);
	});
});

describe("table primary key parity", () => {
	const compositeFixture = () => {
		const source = fixture();
		source.tables[1].columns[0].primary = false;
		source.tables[1].primaryKeys = [{ name: "posts_scope_pk", columns: ["authorEmail", "id"] }];
		return source;
	};

	test("compares table-level PKs without requiring inline column primary flags", () => {
		const source = compositeFixture();
		expect(validateCoverage(source, structuredClone(source))).toEqual([]);
	});

	test.each([
		"name",
		"order",
		"wrong column",
		"missing key",
		"extra key",
	])("detects %s drift", (change) => {
		const source = compositeFixture();
		const target = structuredClone(source);
		const table = target.tables[1];
		switch (change) {
			case "name":
				table.primaryKeys[0].name = "renamed_pk";
				break;
			case "order":
				table.primaryKeys[0].columns.reverse();
				break;
			case "wrong column":
				table.primaryKeys[0].columns = ["id"];
				break;
			case "missing key":
				table.primaryKeys = [];
				break;
			case "extra key":
				table.primaryKeys.push({ name: "extra_pk", columns: ["id"] });
				break;
		}
		expect(validateCoverage(source, target).join("\n")).toContain("primary key");
	});

	test("retains inline column primary flag comparison", () => {
		const source = compositeFixture();
		const target = structuredClone(source);
		target.tables[1].columns[0].primary = true;
		expect(validateCoverage(source, target)).toContain("column mismatch posts.id");
	});
});

describe("constant expression index parity", () => {
	const expressionFixture = () => {
		const source = fixture();
		source.tables[1].indexes.push({
			name: "singleton",
			columns: [],
			expression: "1",
			unique: true,
			predicate: '"author_email" IS NOT NULL',
		});
		return source;
	};
	test("an exact constant expression retains a distinct structural signature", () => {
		const source = expressionFixture();
		expect(validateCoverage(source, structuredClone(source))).toEqual([]);
		expect(
			normalizeCoverage(source, "test").coverage.tables.find((table) => table.name === "posts")
				?.indexes[0].expression,
		).toBe("1");
	});
	test.each([
		"2",
		"1+0",
		"(1)",
		"lower(id)",
		"",
		"true",
	])("rejects unknown expression %s even on both sides", (expression) => {
		const source = expressionFixture();
		source.tables[1].indexes[0].expression = expression;
		expect(validateCoverage(source, structuredClone(source)).join(" ")).toContain(
			"unsupported index expression",
		);
	});
	test("removal or replacement with a column is a mismatch", () => {
		const source = expressionFixture();
		for (const columns of [[], ["id"]]) {
			const target = structuredClone(source);
			delete target.tables[1].indexes[0].expression;
			target.tables[1].indexes[0].columns = columns;
			expect(validateCoverage(source, target).length).toBeGreaterThan(0);
		}
	});
	test("mixed terms, unknown fields and promotion to a unique constraint fail closed", () => {
		for (const extras of [
			{ columns: ["id"] },
			{ unexpectedExpression: "1" },
			{ emitAsUniqueConstraint: true },
		]) {
			const source = expressionFixture();
			Object.assign(source.tables[1].indexes[0], extras);
			expect(validateCoverage(source, structuredClone(source)).length).toBeGreaterThan(0);
		}
	});
	test("a constant expression cannot cover a referenced column", () => {
		const source = fixture();
		source.tables[0].indexes[0] = {
			name: "idx_users_email",
			columns: [],
			expression: "1",
			unique: true,
		};
		expect(validateCoverage(source, structuredClone(source)).join(" ")).toContain(
			"no unique constraint",
		);
	});
});

describe("foreign key constraint names", () => {
	test("a renamed column-level constraint fails", () => {
		const errors = mutate((target) => {
			const column = target.tables[1].columns[1];
			if (column.references) column.references.constraintName = "zzz_posts_author_email";
		});
		expect(errors.join("\n")).toContain("does not match derived");
	});

	test("a renamed table-level constraint fails", () => {
		const source = fixture();
		source.tables[1].foreignKeys = [
			{
				name: "fk_posts_author",
				columns: ["authorEmail"],
				references: [{ table: "users", column: "email", constraintName: "fk_posts_author" }],
			},
		];
		const target = structuredClone(source);
		target.tables[1].foreignKeys[0].name = "zzz_fk_posts_author";
		for (const reference of target.tables[1].foreignKeys[0].references)
			reference.constraintName = "zzz_fk_posts_author";
		expect(validateCoverage(source, target).join("\n")).toContain("foreign key");
	});

	// PostgreSQL truncates at NAMEDATALEN-1 rather than rejecting, so an over-long name silently
	// becomes a different constraint than the one declared.
	test("a name over 63 bytes fails", () => {
		const errors = mutate((target) => {
			const column = target.tables[1].columns[1];
			if (column.references) column.references.constraintName = "x".repeat(64);
		});
		expect(errors.join("\n")).toContain("exceeds 63 bytes");
	});

	test("a name of exactly 63 bytes is accepted when it is the derived name", () => {
		const source = fixture();
		const table = source.tables[1];
		// Pad the column name so the derived constraint name lands exactly on the limit.
		const derived = (columnName: string) => `posts_${columnName}_users_email_fk`;
		let columnName = "author_email";
		while (Buffer.byteLength(derived(columnName)) < 63) columnName += "x";
		expect(Buffer.byteLength(derived(columnName))).toBe(63);
		table.columns[1].name = columnName;
		const reference = table.columns[1].references;
		if (reference) reference.constraintName = derived(columnName);
		expect(validateCoverage(source, structuredClone(source))).toEqual([]);
	});

	test("multi-byte names are measured in bytes, not characters", () => {
		const errors = mutate((target) => {
			const column = target.tables[1].columns[1];
			// 32 three-byte characters is 96 bytes but only 32 characters.
			if (column.references) column.references.constraintName = "名".repeat(32);
		});
		expect(errors.join("\n")).toContain("exceeds 63 bytes");
	});

	test("two constraints sharing one effective name fail as a collision", () => {
		const source = fixture();
		source.tables[1].columns.push({
			property: "editorEmail",
			name: "editor_email",
			kind: "text",
			pgType: "text",
			notNull: false,
			primary: false,
			unique: false,
			references: {
				table: "users",
				column: "email",
				constraintName: "posts_editor_email_users_email_fk",
			},
			emitAsTableConstraint: false,
		});
		source.columnCount = 5;
		const target = structuredClone(source);
		const clash = target.tables[1].columns[2].references;
		if (clash) clash.constraintName = "posts_author_email_users_email_fk";
		expect(validateCoverage(source, target).join("\n")).toContain("collision");
	});

	test("a retargeted reference fails even when its name is left intact", () => {
		const errors = mutate((target) => {
			const column = target.tables[1].columns[1];
			if (column.references) column.references.table = "posts";
		});
		expect(errors.length).toBeGreaterThan(0);
	});

	test("a dropped referential action fails", () => {
		const errors = mutate((target) => {
			const column = target.tables[1].columns[1];
			if (column.references) delete column.references.onDelete;
		});
		expect(errors.join("\n")).toContain("foreign key");
	});

	test("referential action case is treated as formatting", () => {
		const target = fixture();
		const column = target.tables[1].columns[1];
		if (column.references) column.references.onDelete = "CASCADE";
		expect(validateCoverage(fixture(), target)).toEqual([]);
	});
});

describe("foreign key emission shape", () => {
	// A column-level .references() cannot carry a name, so a shortened name has to be emitted as
	// a table-level constraint or PostgreSQL derives the unshortened name again.
	test("a shortened name must set emitAsTableConstraint", () => {
		const source = fixture();
		const column = source.tables[1].columns[1];
		column.name = `author_email_${"x".repeat(60)}`;
		if (column.references) {
			column.references.constraintName = `posts_${column.name}_users_email_fk`.slice(0, 20);
			column.emitAsTableConstraint = true;
		}
		const target = structuredClone(source);
		delete target.tables[1].columns[1].emitAsTableConstraint;
		expect(validateCoverage(source, target).join("\n")).toContain("emitAsTableConstraint");
	});

	test("a short name must not claim emitAsTableConstraint", () => {
		const errors = mutate((target) => {
			target.tables[1].columns[1].emitAsTableConstraint = true;
		});
		expect(errors.join("\n")).toContain("emitAsTableConstraint must be false");
	});

	// Drizzle Kit emits CREATE INDEX after ALTER TABLE ADD CONSTRAINT, so a unique index backing
	// a foreign key must become a table unique constraint or the constraint fails to apply.
	test("dropping emitAsUniqueConstraint on a covering index fails", () => {
		const errors = mutate((target) => {
			delete target.tables[0].indexes[0].emitAsUniqueConstraint;
		});
		expect(errors.join("\n")).toContain("emitAsUniqueConstraint");
	});

	test("an index nobody references does not need the flag", () => {
		const source = fixture();
		source.tables[1].columns[1].references = undefined;
		source.tables[1].columns[1].emitAsTableConstraint = undefined;
		delete source.tables[0].indexes[0].emitAsUniqueConstraint;
		expect(normalizeCoverage(source, "source").errors).toEqual([]);
	});

	test("a partial unique index cannot be promoted to a constraint", () => {
		const source = fixture();
		source.tables[0].indexes[0].predicate = '"email" IS NOT NULL';
		expect(normalizeCoverage(source, "source").errors.join("\n")).toContain(
			"requires an unconditional unique index",
		);
	});

	test("a foreign key target with no unique constraint at all fails", () => {
		const source = fixture();
		source.tables[0].indexes = [];
		expect(normalizeCoverage(source, "source").errors.join("\n")).toContain("no unique constraint");
	});
});

describe("json column defaults", () => {
	test("an encoded text literal through sql.raw is accepted", () => {
		const source = fixture();
		source.tables[0].columns.push(jsonColumn(`sql.raw("'[]'::text")`));
		source.columnCount = 5;
		expect(normalizeCoverage(source, "source").errors).toEqual([]);
	});

	for (const [label, expression] of [
		["a bare JS array", "[]"],
		["a bare JS object", "{}"],
		["an unquoted literal", `sql.raw("[]")`],
		["a literal without the text cast", `sql.raw("'[]'")`],
		["a JS value wrapped in sql.raw's place", `["a"]`],
	] as const) {
		test(`${label} default fails`, () => {
			const source = fixture();
			source.tables[0].columns.push(jsonColumn(expression));
			source.columnCount = 5;
			expect(normalizeCoverage(source, "source").errors.join("\n")).toContain(
				"json default must be an encoded text literal",
			);
		});
	}

	test("a double-encoded default fails", () => {
		const source = fixture();
		source.tables[0].columns.push(jsonColumn(`sql.raw("'\\"[]\\"'::text")`));
		source.columnCount = 5;
		expect(normalizeCoverage(source, "source").errors.join("\n")).toContain("exactly once");
	});

	test("a literal that does not encode the declared default fails", () => {
		const source = fixture();
		source.tables[0].columns.push(jsonColumn(`sql.raw("'[1]'::text")`));
		source.columnCount = 5;
		expect(normalizeCoverage(source, "source").errors.join("\n")).toContain("exactly once");
	});

	test("an embedded quote must stay doubled inside the literal", () => {
		const source = fixture();
		const column = jsonColumn(`sql.raw("'[\\"it''s\\"]'::text")`);
		column.defaultValue = `["it's"]`;
		source.tables[0].columns.push(column);
		source.columnCount = 5;
		expect(normalizeCoverage(source, "source").errors).toEqual([]);
	});

	test("a non-json column keeps its plain default", () => {
		const source = fixture();
		source.tables[0].columns[1].defaultExpression = '"anonymous@example.com"';
		expect(normalizeCoverage(source, "source").errors).toEqual([]);
	});
});

describe("normalisation stays semantic", () => {
	test("collapses whitespace between tokens", () => {
		expect(normalizeSqlExpression('  "a"   =\n\t1  ')).toBe('"a" = 1');
	});
	test("preserves whitespace and case inside literals", () => {
		expect(normalizeSqlExpression("'a  b'")).toBe("'a  b'");
		expect(normalizeSqlExpression("'active'")).not.toBe(normalizeSqlExpression("'ACTIVE'"));
	});
	test("preserves whitespace inside quoted identifiers", () => {
		expect(normalizeSqlExpression('"a  b"')).toBe('"a  b"');
	});
	test("does not strip parentheses", () => {
		expect(normalizeSqlExpression("(a) AND (b)")).toBe("(a) AND (b)");
	});
	test("a default differing only in case still fails parity", () => {
		const source = fixture();
		source.tables[0].columns[1].defaultExpression = "'active'";
		const target = structuredClone(source);
		target.tables[0].columns[1].defaultExpression = "'ACTIVE'";
		expect(validateCoverage(source, target).length).toBeGreaterThan(0);
	});
	test("a default differing only in whitespace passes", () => {
		const source = fixture();
		source.tables[0].columns[1].defaultExpression = "coalesce(a,  b)";
		const target = structuredClone(source);
		target.tables[0].columns[1].defaultExpression = "coalesce(a, b)";
		expect(validateCoverage(source, target)).toEqual([]);
	});
});

describe("field coverage", () => {
	// A generator field no signature mentions is exactly how the earlier checker went blind.
	test("an unhandled column field fails instead of being ignored", () => {
		const errors = mutate((target) => {
			(target.tables[0].columns[0] as Record<string, unknown>).sneaky = true;
		});
		expect(errors.join("\n")).toContain('unhandled schema field "sneaky"');
	});
	test("an unhandled index field fails", () => {
		const errors = mutate((target) => {
			(target.tables[0].indexes[0] as Record<string, unknown>).sneaky = true;
		});
		expect(errors.join("\n")).toContain('unhandled schema field "sneaky"');
	});
	test("an unhandled table field fails", () => {
		const errors = mutate((target) => {
			(target.tables[0] as Record<string, unknown>).sneaky = true;
		});
		expect(errors.join("\n")).toContain('unhandled schema field "sneaky"');
	});
	test("declared counts must match the tables actually present", () => {
		const errors = mutate((target) => {
			target.columnCount = 99;
		});
		expect(errors.join("\n")).toContain("columnCount");
	});
});

describe("real schema parity", () => {
	const source = loadSource();
	const target = loadManifest();

	test("the committed manifest matches the generated schema", () => {
		expect(validateCoverage(source, target)).toEqual([]);
	});

	test("covers 126 tables and 1676 columns including the token accounting version", () => {
		expect(target.tables.length).toBe(126);
		// 1714 SQLite-derived columns include disk_outcome and the two editor recovery columns,
		// plus the three PG-only insert_seq identity columns.
		// The numeric context stats replace the 5-column page cache with pins (3) and stats (4).
		// Block storage (P1) adds 45: narrator_blocks (19), narrator_block_assets (3),
		// narrator_block_sync_queue (1), narrator_text_snapshots (4), narrator_turns (10), six
		// envelope columns and two ledger columns. The P2 backfill adds narrator_block_backfill (6)
		// and narrator_block_diagnostics (4).
		// Bot narrators add chat_messages.sender_narrator_id and reply_to_sender_narrator_id (2).
		// Retiring the narrative line drops six tables (102 columns) and 19 columns elsewhere; the
		// project index adds narrator_project_links (7) and projects.root_key. auth_sessions adds 8.
		// The block sync's cost bookkeeping adds narrator_block_index_queue (2),
		// narrator_blocks.ledger_revision and narrator_messages.blocks_content_hash.
		// Historical token recalculation adds api_requests.token_accounting_version (1).
		expect(target.tables.reduce((count, table) => count + table.columns.length, 0)).toBe(1676);
		expect(
			target.tables
				.find((table) => table.name === "narrator_context_pins")
				?.columns.map((column) => column.property),
		).toEqual(["generation", "narratorId", "segmentsJson"]);
		expect(
			target.tables
				.find((table) => table.name === "narrator_message_context_stats")
				?.columns.map((column) => column.property),
		).toEqual(["messageId", "role", "parentToolUseId", "segmentsJson"]);
		expect(target.tables.some((table) => table.name === "narrator_context_char_pages")).toBe(false);
		for (const name of ["narrator_drafts", "narrator_messages"]) {
			expect(
				target.tables
					.find((table) => table.name === name)
					?.columns.find((column) => column.property === "composerDocument"),
			).toMatchObject({
				name: "composer_document",
				mode: "json",
				pgType: "text",
				notNull: false,
			});
		}
		expect(
			target.tables
				.find((table) => table.name === "knowledge_injection_events")
				?.columns.find((column) => column.property === "personalEntryId"),
		).toMatchObject({
			name: "personal_entry_id",
			pgType: "text",
			notNull: false,
			references: { table: "knowledgeDrafts", column: "id", onDelete: "cascade" },
		});
		expect(target.tables.some((table) => table.name.startsWith("intelligent_ui_"))).toBe(false);
		expect(
			target.tables
				.find((table) => table.name === "model_history_revision_contracts")
				?.columns.map((column) => column.property),
		).toEqual(["id", "installedVersion"]);
		for (const [tableName, property, name] of [
			["narrators", "modelHistoryRevision", "model_history_revision"],
			["narrator_messages", "bodyRevision", "body_revision"],
			["narrator_tool_calls", "modelRevision", "model_revision"],
		]) {
			expect(
				target.tables
					.find((table) => table.name === tableName)
					?.columns.find((column) => column.property === property),
			).toMatchObject({ name, pgType: "integer", notNull: true, defaultExpression: "0" });
		}
		expect(
			target.tables
				.find((table) => table.name === "user_git_identities")
				?.columns.map((column) => column.property),
		).toEqual(["id", "userId", "name", "email", "isDefault", "createdAt"]);
		expect(
			target.tables
				.find((table) => table.name === "narrator_git_identity_bindings")
				?.columns.map((column) => column.property),
		).toEqual(["id", "narratorId", "userId", "identityId", "updatedAt"]);
		expect(
			target.tables
				.find((table) => table.name === "background_tasks")
				?.columns.find((column) => column.property === "backgroundKind"),
		).toMatchObject({ name: "background_kind", notNull: true, defaultExpression: '"task"' });
		for (const name of ["narrators", "api_requests"]) {
			expect(
				target.tables
					.find((table) => table.name === name)
					?.columns.map((column) => column.property),
			).toContain("contextUsageSnapshotJson");
		}
		expect(
			target.tables
				.find((table) => table.name === "narrator_worktree_resources")
				?.columns.map((column) => column.property),
		).toContain("scopeOwnerUserId");
		expect(
			target.tables
				.find((table) => table.name === "narrator_question_events")
				?.columns.map((column) => column.property),
		).toEqual(["questionId", "messageId", "kind", "resolutionJson", "createdAt"]);
		expect(
			target.tables
				.find((table) => table.name === "narrator_questions")
				?.columns.map((column) => column.property),
		).toEqual(
			expect.arrayContaining(["context", "resolutionJson", "withdrawReason", "summaryJson"]),
		);
		expect(
			target.tables
				.find((table) => table.name === "narrators")
				?.columns.map((column) => column.property),
		).toContain("lastStopReason");
	});

	test("the PG-only insert_seq identity columns are present on exactly the three ordinal tables", () => {
		const identityColumns = target.tables.flatMap((table) =>
			table.columns
				.filter((column) => column.identity)
				.map((column) => `${table.name}.${column.name}:${column.identity?.type}`),
		);
		expect(identityColumns.sort()).toEqual([
			"background_tasks.insert_seq:byDefault",
			"narrator_tool_continuations.insert_seq:byDefault",
			"narrators.insert_seq:byDefault",
		]);
		const nextSeq = target.tables
			.find((table) => table.name === "narrators")
			?.columns.find((column) => column.name === "next_seq");
		expect(nextSeq).toMatchObject({
			pgType: "integer",
			notNull: true,
			defaultExpression: "0",
		});
	});

	test.each(
		PARITY_MUTATIONS.map((mutation) => [mutation.name, mutation] as const),
	)("negative mutation is detected: %s", (_name, mutation) => {
		const mutated = structuredClone(target);
		mutation.apply(mutated);
		expect(validateCoverage(source, mutated).length).toBeGreaterThan(0);
	});

	test("checkParity reports no differences and no undetected mutation", () => {
		expect(checkParity(source, target)).toEqual([]);
	});
});
