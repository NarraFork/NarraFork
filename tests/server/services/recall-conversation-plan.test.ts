import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type RecallConversationInput,
	recallConversationQueries,
} from "../../../server/lib/db-worker/recall-reader";

let database: Database;
const indexes = [
	["0000_fine_genesis.sql", "idx_narrator_refs_unique"],
	["0000_fine_genesis.sql", "idx_narrator_refs_seq"],
	["0000_fine_genesis.sql", "idx_narrator_refs_message"],
	["0010_silky_obadiah_stane.sql", "idx_narrator_refs_segment_compact"],
	["0043_sturdy_young_avengers.sql", "idx_narrator_refs_compact_seq"],
	["0184_narrator_refs_narrator_id_index.sql", "idx_narrator_refs_narrator_id"],
] as const;
beforeAll(() => {
	database = new Database(":memory:");
	database.exec(`
		CREATE TABLE narrators(id TEXT PRIMARY KEY,title TEXT,model TEXT,refs_inherited_from TEXT,refs_backfill_cursor INTEGER);
		CREATE TABLE narrator_messages(id TEXT PRIMARY KEY,role TEXT,origin TEXT,content_text TEXT,created_at TEXT);
		CREATE TABLE narrator_message_refs(id TEXT PRIMARY KEY,narrator_id TEXT,message_id TEXT,seq INTEGER,is_compact INTEGER DEFAULT 0,segment_compact_id TEXT);
		INSERT INTO narrators VALUES ('n','Title','model',NULL,NULL);
	`);
	// Use the shipped production index statements, not a test-only covering index.
	for (const [migration, index] of indexes) {
		const source = readFileSync(new URL(`../../../drizzle/${migration}`, import.meta.url), "utf8");
		const ddl = source.match(new RegExp(`CREATE (?:UNIQUE )?INDEX \`${index}\`[^;]+;`))?.[0];
		if (!ddl) throw new Error(`Production index DDL not found: ${index}`);
		database.exec(ddl);
	}
	const message = database.prepare("INSERT INTO narrator_messages VALUES (?,?,?,?,?)");
	const ref = database.prepare(
		"INSERT INTO narrator_message_refs(id,narrator_id,message_id,seq) VALUES (?,'n',?,?)",
	);
	try {
		database.transaction(() => {
			for (let seq = 0; seq < 30000; seq++) {
				const id = `m${String(seq).padStart(5, "0")}`;
				message.run(
					id,
					seq % 2 ? "assistant" : "user",
					seq % 3 ? "assistant" : "user",
					`message ${seq}`,
					"2026-01-01",
				);
				ref.run(`ref-${id}`, id, seq);
			}
			for (const id of ["tie-a", "tie-b", "tie-c"]) {
				message.run(id, "user", "user", id, "2026-01-01");
				ref.run(`ref-${id}`, id, 30000);
			}
		})();
	} finally {
		message.finalize();
		ref.finalize();
	}
});
afterAll(() => database.close());

function run(options: Partial<RecallConversationInput> = {}) {
	const plans: { id: number; parent: number; detail: string }[][] = [];
	const sqls: string[] = [];
	const plan = recallConversationQueries({
		narratorId: "n",
		messageId: null,
		limit: 20,
		...options,
	});
	let step = plan.next();
	while (!step.done) {
		const query = step.value;
		if (query.sql.includes("ORDER BY r.seq")) {
			plans.push(
				database
					.query(`EXPLAIN QUERY PLAN ${query.sql}`)
					.all(...query.params) as (typeof plans)[number],
			);
			sqls.push(query.sql);
		}
		step = plan.next(database.query(query.sql).all(...query.params) as Record<string, unknown>[]);
	}
	return { result: step.value, plans, sqls };
}

function indexedSmallPages(plans: ReturnType<typeof run>["plans"]) {
	expect(plans.length).toBeGreaterThan(0);
	for (const plan of plans) {
		expect(
			plan.some((row) =>
				/SEARCH r USING INDEX idx_narrator_refs_seq \(narrator_id=\?/.test(row.detail),
			),
		).toBe(true);
		// The outer guard may sort the already LIMITED page. Only a right-part tie
		// sort is permitted below it; a full inner ORDER BY would visit all 30k refs.
		const fullSorts = plan.filter((row) => /USE TEMP B-TREE FOR ORDER BY/.test(row.detail));
		expect(fullSorts.every((row) => row.parent === 0)).toBe(true);
		expect(plan.some((row) => /SCAN (?:r|own|closer)(?:$| )/.test(row.detail))).toBe(false);
	}
}

for (const [name, options, expected] of [
	["latest", {}, ["m29983", "tie-c"]],
	["older", { cursor: { seq: 15000, messageId: "m15000" } }, ["m14980", "m14999"]],
	[
		"newer",
		{ direction: "newer", cursor: { seq: 15000, messageId: "m15000" } },
		["m15001", "m15020"],
	],
] as const) {
	test(`standalone ${name} uses production seq index before LIMIT on 30000 refs`, () => {
		const { result, plans, sqls } = run(options);
		expect([result.rows[0].id, result.rows.at(-1)?.id]).toEqual([...expected]);
		indexedSmallPages(plans);
		console.info(
			`Recall 30000-ref ${name} plan`,
			plans[0].filter((row) => /idx_narrator_refs_seq|TEMP B-TREE/.test(row.detail)),
		);
		expect(
			sqls.every((sql) => sql.includes("FROM narrator_message_refs r JOIN narrator_messages")),
		).toBe(true);
	});
}

test("same-seq limit-one and around preserve exact tuple order on direct refs", () => {
	let cursor = { seq: 29999, messageId: "m29999" };
	for (const id of ["tie-a", "tie-b", "tie-c"]) {
		const { result, plans } = run({ direction: "newer", cursor, limit: 1 });
		expect(result.rows.map((row) => row.id)).toEqual([id]);
		indexedSmallPages(plans);
		cursor = result.pagination.newerCursor as typeof cursor;
	}
	cursor = { seq: 30001, messageId: "" };
	for (const id of ["tie-c", "tie-b", "tie-a"]) {
		const { result, plans } = run({ direction: "older", cursor, limit: 1 });
		expect(result.rows.map((row) => row.id)).toEqual([id]);
		cursor = result.pagination.olderCursor as typeof cursor;
		indexedSmallPages(plans);
		const around = run({ messageId: id, direction: "around", limit: 1 });
		expect(around.result.rows.map((row) => row.id)).toEqual([id]);
		indexedSmallPages(around.plans);
		expect(result.rows).toHaveLength(1);
	}
});

test("standalone direct page still fails closed when captured lineage changes", () => {
	const plan = recallConversationQueries({ narratorId: "n", messageId: null, limit: 20 });
	let step = plan.next();
	try {
		expect(() => {
			while (!step.done) {
				const query = step.value;
				if (query.sql.includes("FROM narrator_message_refs r JOIN narrator_messages")) {
					database.run(
						"UPDATE narrators SET refs_inherited_from='new-parent',refs_backfill_cursor=2 WHERE id='n'",
					);
				}
				const rows = database.query(query.sql).all(...query.params) as Record<string, unknown>[];
				if (query.sql.includes("ORDER BY r.seq")) {
					expect(rows[0].recall_lineage_valid).toBe(0);
					expect(rows[0].recall_row_present).toBeNull();
					expect(rows[0].content_prefix).toBeNull();
				}
				step = plan.next(rows);
			}
		}).toThrow("lineage changed");
	} finally {
		database.run(
			"UPDATE narrators SET refs_inherited_from=NULL,refs_backfill_cursor=NULL WHERE id='n'",
		);
	}
});

test("role and origin filters apply before the indexed page LIMIT", () => {
	const { result, plans } = run({ roles: ["user"], origins: ["user"], limit: 20 });
	expect(result.rows).toHaveLength(20);
	expect(result.rows.every((row) => row.role === "user" && row.origin === "user")).toBe(true);
	indexedSmallPages(plans);
});
