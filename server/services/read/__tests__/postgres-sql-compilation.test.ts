/**
 * What the PostgreSQL read adapter actually SENDS.
 *
 * This suite compiles every read through Drizzle's PostgreSQL dialect and inspects the SQL
 * text, without a server. That is not a substitute for running against PostgreSQL — the
 * parity suite does that — but it catches the class of defect that a SQLite-only test run
 * cannot see at all, and it catches it in a form that names the offending construct.
 *
 * The defect that motivated it: three auxiliary predicates were written as
 * `sql\`${column} = any(${ids})\``. Drizzle renders an array in a template as a
 * parenthesised parameter LIST, so that compiles to `= any(($1, $2, $3))` — and PostgreSQL
 * rejects it outright with "op ANY/ALL (array) requires array on right side". Reading the
 * source, it looks like idiomatic PostgreSQL. Nothing in a SQLite test run touches it, so
 * the first evidence would have been a 500 on a real deployment's story graph.
 *
 * Also pinned here: the user id is a BOUND PARAMETER everywhere. If it were interpolated,
 * the statement text would differ per user (defeating statement caching) and the predicate
 * would be an injection site — and neither shows up in a functional test that happens to use
 * well-behaved ids.
 */

import { describe, expect, test } from "bun:test";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import type { ProjectPrincipal } from "../../project-acl";
import { PostgresProjectReadAdapter } from "../postgres-project-read-adapter";

type Captured = { sql: string; params: unknown[] };

/**
 * One row of nulls, wide enough for any select in this adapter.
 *
 * Drizzle maps a result row positionally and calls each column's decoder on the raw value. A
 * row SHORTER than the select yields `undefined` for the missing positions, and a JSON column's
 * decoder then throws on `undefined` — so a stub row has to be at least as wide as the widest
 * select. `null` is safe for every column type because the decoder is skipped for it.
 */
const NULL_ROW = Array.from({ length: 200 }, () => null);

/**
 * A Drizzle handle that records statements instead of executing them.
 *
 * `answerFirst` exists because some reads gate on an earlier query: `getGraph` and
 * `getGraphAuxiliaryData` only compile their real work once the project lookup returns a row.
 * Answering that first statement with one all-null row is enough — column VALUES are irrelevant
 * to what SQL gets compiled, which is all this suite examines.
 */
function recorder(answerFirst = false): { db: BunSQLDatabase; statements: Captured[] } {
	const statements: Captured[] = [];
	const db = drizzleProxy(async (sql, params) => {
		statements.push({ sql, params });
		return { rows: answerFirst && statements.length === 1 ? [NULL_ROW] : [] };
	}) as unknown as BunSQLDatabase;
	return { db, statements };
}

function principal(userId: string, isAdmin = false): ProjectPrincipal {
	return { userId, isAdmin };
}

/**
 * Run one adapter call and return every statement it compiled.
 *
 * `answerFirst` lets the caller open the project gate so the reads behind it are reached.
 */
async function capture(
	run: (adapter: PostgresProjectReadAdapter) => Promise<unknown>,
	answerFirst = false,
): Promise<Captured[]> {
	const { db, statements } = recorder(answerFirst);
	await run(new PostgresProjectReadAdapter(db));
	return statements;
}

const USER = "u_reader";
const PROJECT = "p_1";
const CHAPTERS = ["c_a", "c_b", "c_c"];

/**
 * Every statement the adapter can emit for a non-admin principal, so a broad assertion
 * ("nowhere does `any(` appear") really covers the whole surface rather than one call.
 *
 * `getGraphAuxiliaryData` is included even though the recorder makes its project lookup return
 * no rows: to compile the auxiliary statements the adapter needs a visible project, so those
 * are captured separately below with a recorder that answers the gate.
 */
async function allStatements(who: ProjectPrincipal): Promise<Captured[]> {
	const out: Captured[] = [];
	out.push(...(await capture((a) => a.listProjects(who))));
	out.push(...(await capture((a) => a.listProjects(who, { limit: 10 }, "active"))));
	out.push(...(await capture((a) => a.getProject(PROJECT, who))));
	out.push(...(await capture((a) => a.anyProjectExists())));
	out.push(...(await capture((a) => a.getChapter("c_a", who))));
	out.push(...(await capture((a) => a.listChapters(PROJECT, who))));
	out.push(...(await capture((a) => a.listChapters(PROJECT, who, "dormant"))));
	out.push(...(await capture((a) => a.listChaptersPage(PROJECT, who, { limit: 5 }))));
	// `true`: open the project gate so the reads behind it are compiled too.
	out.push(...(await capture((a) => a.getGraph(PROJECT, who), true)));
	out.push(...(await capture((a) => a.getGraphAuxiliaryData(PROJECT, CHAPTERS, who), true)));
	return out;
}

/** Statements for the auxiliary reads specifically, with the project gate answered. */
function auxiliaryStatements(who: ProjectPrincipal): Promise<Captured[]> {
	return capture((a) => a.getGraphAuxiliaryData(PROJECT, CHAPTERS, who), true);
}

describe("id lists compile to real PostgreSQL", () => {
	test("no read emits `= any(...)`, which cannot take a parameter list", () => {
		// The exact defect: `sql`${col} = any(${ids})`` renders `any(($1, $2, $3))` and PostgreSQL
		// answers "op ANY/ALL (array) requires array on right side".
		return allStatements(principal(USER)).then((statements) => {
			expect(statements.length).toBeGreaterThan(0);
			for (const statement of statements) {
				expect(statement.sql.toLowerCase()).not.toContain("any(");
			}
		});
	});

	test("chapter id lists become parameterised `in ($1, $2, $3)`", async () => {
		const statements = await auxiliaryStatements(principal(USER));
		const withIdList = statements.filter((s) => /\bin \(\$\d+(, \$\d+)*\)/i.test(s.sql));
		// Three auxiliary reads take the id list: narrators, container instances, detached panels.
		expect(withIdList.length).toBeGreaterThanOrEqual(3);
		for (const statement of withIdList) {
			// Ids arrive as bind parameters, never as inlined literals.
			for (const id of CHAPTERS) expect(statement.params).toContain(id);
			expect(statement.sql).not.toContain("'c_a'");
		}
	});

	test("an empty id list short-circuits instead of compiling `in ()`", async () => {
		// `in ()` is a syntax error on both backends, so the guard has to be in the adapter and
		// not in the SQL builder.
		const statements = await capture((a) => a.getGraphAuxiliaryData(PROJECT, [], principal(USER)));
		expect(statements).toEqual([]);
	});
});

describe("ACL predicates reach PostgreSQL intact", () => {
	test("the auxiliary narrator read carries the narrator ACL, not just the project", async () => {
		const statements = await auxiliaryStatements(principal(USER));
		const narratorRead = statements.find((s) => /from "narrators"/i.test(s.sql));
		expect(narratorRead).toBeDefined();
		const sql = (narratorRead?.sql ?? "").toLowerCase();
		// Before this, the query filtered on chapter ids and the project only, so every project
		// member received every session inside it — including a teammate's private one and every
		// subagent. Passing the project gate is necessary for a narrator, never sufficient.
		expect(sql).toContain("acl_root_narrator_id");
		expect(sql).toContain("visibility = 'public'");
		expect(sql).toContain("visibility = 'project'");
		expect(sql).toContain("scope_type = 'narrator'");
		expect(sql).toContain("domain_kind is null");
	});

	test("the container read reaches the project through the chapter", async () => {
		const statements = await auxiliaryStatements(principal(USER));
		const containerRead = statements.find((s) => /from "container_instances"/i.test(s.sql));
		expect(containerRead).toBeDefined();
		const sql = (containerRead?.sql ?? "").toLowerCase();
		// The project id is compared against `chapters.project_id`, never against a chapter id.
		expect(sql).toContain('inner join "chapters"');
		expect(sql).toMatch(/p\.id = "chapters"\."project_id"/);
		expect(sql).not.toMatch(/p\.id = "container_instances"\."chapter_id"/);
	});

	test("every ACL predicate binds the user id rather than inlining it", async () => {
		const statements = await allStatements(principal(USER));
		const gated = statements.filter((s) => s.sql.includes("acl_grants"));
		expect(gated.length).toBeGreaterThan(0);
		for (const statement of gated) {
			expect(statement.params).toContain(USER);
			expect(statement.sql).not.toContain(USER);
		}
	});

	test("an admin adds no ACL clause, and an absent principal is refused in SQL", async () => {
		const asAdmin = await capture((a) => a.listProjects(principal("u_admin", true)));
		expect(asAdmin[0]?.sql).not.toContain("acl_grants");

		// An empty user id means a route was reached without the auth middleware. It must not
		// degrade to "public", and `isAdmin` must not rescue it — that flag comes from the same
		// unverified place as the id.
		const absent = await capture((a) => a.listProjects(principal("")));
		expect(absent[0]?.sql.toLowerCase()).toContain("false");
		const absentAdmin = await capture((a) => a.listProjects({ userId: "", isAdmin: true }));
		expect(absentAdmin[0]?.sql.toLowerCase()).toContain("false");
	});
});

describe("bounded reads and stable order", () => {
	test("the project list is updatedAt DESC with an id tiebreak, and asks for limit + 1", async () => {
		const statements = await capture((a) => a.listProjects(principal(USER)));
		const sql = statements[0]?.sql.toLowerCase() ?? "";
		// Descending order is the contract every client reads as "most recent first"; the id
		// tiebreak is what makes the cursor safe when rows share `updatedAt`.
		//
		// `collate "c"` on BOTH keys is part of the contract, not an implementation detail:
		// SQLite compares `text` in byte order, PostgreSQL's database collation does not (glibc
		// `en_US.utf8` interleaves case), so without it the two backends disagree about page
		// boundaries. Removing the collation must fail here, loudly.
		expect(sql).toContain(
			'order by "projects"."updated_at" collate "c" desc, "projects"."id" collate "c" asc',
		);
		// 200 + 1: the extra row answers "is there more" without a COUNT over the filtered set.
		expect(statements[0]?.params).toContain(201);
	});

	test("chapter reads are ordered createdAt, id and bounded", async () => {
		const statements = await capture((a) => a.listChapters(PROJECT, principal(USER)));
		const sql = statements[0]?.sql.toLowerCase() ?? "";
		expect(sql).toContain(
			'order by "chapters"."created_at" collate "c" asc, "chapters"."id" collate "c" asc',
		);
		expect(statements[0]?.params).toContain(201);
	});

	test("the chapter listing omits the two per-chapter blobs", async () => {
		const statements = await capture((a) => a.listChapters(PROJECT, principal(USER)));
		const sql = statements[0]?.sql ?? "";
		// A listing returns every chapter of a project, so one blob per row is how a bounded
		// query still produces an unbounded response.
		expect(sql).not.toContain("dock_layout_json");
		expect(sql).not.toContain("detached_panels_json");
		// An explicit column list, not `select *` — which would pick the blobs back up the next
		// time a column is added.
		expect(sql).not.toContain("select *");
		expect(sql).toContain('"title"');
		expect(sql).toContain('"review_source_chapter_id"');
	});

	test("the graph bounds chapters and edges, both ordered", async () => {
		// The gate must pass for the chapter/edge reads to be compiled.
		const statements = await capture((a) => a.getGraph(PROJECT, principal(USER)), true);
		const chapterRead = statements.find(
			(s) => /from "chapters"/i.test(s.sql) && !/from "chapter_edges"/i.test(s.sql),
		);
		expect(chapterRead?.params).toContain(201);
		expect(chapterRead?.sql.toLowerCase()).toContain(
			'order by "chapters"."created_at" collate "c" asc, "chapters"."id" collate "c" asc',
		);

		const edgeRead = statements.find((s) => /from "chapter_edges"/i.test(s.sql));
		expect(edgeRead?.params).toContain(401);
		// Ordered so both backends keep the SAME edges when the cap is hit — byte order, for the
		// same reason as the chapter read above.
		expect(edgeRead?.sql.toLowerCase()).toContain(
			'order by "chapter_edges"."created_at" collate "c" asc',
		);
	});

	test("a cursor is compiled as a keyset comparison, not an offset", async () => {
		const cursor = Buffer.from(
			JSON.stringify({ updatedAt: "2026-01-01T00:00:00.000Z", id: "p_9" }),
		).toString("base64url");
		const statements = await capture((a) => a.listProjects(principal(USER), { limit: 5, cursor }));
		const sql = statements[0]?.sql.toLowerCase() ?? "";
		// An OFFSET would skip or repeat rows precisely when the ACL-filtered set changes between
		// pages, which is the situation paging exists for.
		expect(sql).not.toContain("offset");
		// The keyset comparison carries the same `collate "c"` as the ORDER BY. Collating only
		// one of the pair is the failure mode that loses rows outright: the WHERE clause then
		// excludes rows the ORDER BY had not reached yet, and they vanish from the walk.
		expect(sql).toContain('"projects"."updated_at" collate "c" <');
		expect(sql).toContain('"projects"."id" collate "c" >');
		expect(statements[0]?.params).toContain("p_9");
	});
});
