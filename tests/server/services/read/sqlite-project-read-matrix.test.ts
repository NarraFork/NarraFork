/**
 * The SQLite read adapter against real, non-empty data.
 *
 * This is the reference side of the PostgreSQL parity suite: the same fixtures are
 * written to both backends, so any expectation encoded here is also what PostgreSQL
 * must answer. Two rules shape every case:
 *
 *   - a positive case must return non-empty data. `expect([]).toEqual([])` passes just
 *     as happily when the ACL predicate is broken as when it is right, so it proves
 *     nothing at all;
 *   - a negative case must point at data that EXISTS and is merely unreadable. Asserting
 *     that a nonexistent id is absent tests the fixture, not the gate.
 *
 * Covered: visibility (public/private), authority (admin / owner / read / write / manage
 * grant), the `domain_kind` trap, unknown and missing principals, cross-project chapter
 * reads, the graph's five edge types and its narrator/container/detached-panel auxiliary
 * data, cursor paging where every row shares `updatedAt`, limit clamping, and the 200/201
 * truncation caps.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "../../../../server/db/schema";
import type { ProjectPrincipal } from "../../../../server/services/project-acl";
// Constants and pure helpers only; this module does not import `server/db`, so it needs no
// deferral behind the mock below.
import { READ_LIMITS } from "../../../../server/services/read/project-read-adapter";
import { cleanDb, getTestDb } from "../../../setup";
import { type FixtureTable, seedFixtures } from "./read-fixture-seed";
import {
	BULK_CHAPTER_COUNT,
	BULK_PROJECT_COUNT,
	bulkChapterIds,
	bulkProjectIds,
	CASE_MIX_CHAPTER_IDS,
	CASE_MIX_CHAPTER_IDS_BYTE_ORDER,
	CASE_MIX_EDGE_IDS,
	CASE_MIX_EDGE_IDS_BYTE_ORDER,
	CASE_MIX_PROJECT_IDS,
	CASE_MIX_PROJECT_IDS_BYTE_ORDER,
	CHAPTER,
	caseInsensitiveOrderDiffers,
	EDGE,
	GHOST_USER,
	NARRATOR,
	PRIV_CHAPTER_IDS_ORDERED,
	PRIV_EDGE_IDS,
	PROJECT,
	USER,
} from "./read-fixtures";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../../server/db")) };
mock.module("../../../../server/db", () => ({ db, sqlite }));

const { SqliteProjectReadAdapter } = await import(
	"../../../../server/services/read/sqlite-project-read-adapter"
);

const adapter = new SqliteProjectReadAdapter();

const TABLES: Record<FixtureTable, unknown> = {
	users: schema.users,
	projects: schema.projects,
	chapters: schema.chapters,
	chapterEdges: schema.chapterEdges,
	narrators: schema.narrators,
	containerInstances: schema.containerInstances,
	aclGrants: schema.aclGrants,
};

type AnyDb = BunSQLiteDatabase<Record<string, unknown>>;

beforeAll(async () => {
	await seedFixtures(async (table, rows) => {
		// biome-ignore lint/suspicious/noExplicitAny: fixture rows are backend-agnostic bags
		await (db as unknown as AnyDb).insert(TABLES[table] as any).values(rows as any);
	});
});

afterAll(() => {
	mock.module("../../../../server/db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
	sqlite.close();
});

function principal(userId: string, isAdmin = false): ProjectPrincipal {
	return { userId, isAdmin };
}

/**
 * Every project id the principal can reach, walked to the end.
 *
 * Paging fully matters: an admin sees 211 rows, so a single 200-row page would drop
 * real projects and make an authority assertion fail for a paging reason. The bulk
 * ids are then dropped from the result — they exist only to exercise limits and caps.
 */
async function listedProjectIds(who: ProjectPrincipal, status?: string): Promise<string[]> {
	const bulk = new Set(bulkProjectIds());
	const ids: string[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await adapter.listProjects(who, { limit: 200, cursor }, status);
		ids.push(...(page.rows as Array<{ id: string }>).map((row) => row.id));
		cursor = page.nextCursor ?? undefined;
		pages += 1;
		if (pages > 20) throw new Error("listProjects paging did not terminate");
	} while (cursor);
	return ids.filter((id) => !bulk.has(id));
}

describe("listProjects authority matrix", () => {
	it("gives the owner their private, public and archived projects", async () => {
		const ids = await listedProjectIds(principal(USER.owner));
		expect(ids).toContain(PROJECT.priv);
		expect(ids).toContain(PROJECT.arch);
		expect(ids).toContain(PROJECT.pub);
		// A public project someone else owns is still readable — visibility, not ownership.
		expect(ids).toContain(PROJECT.pub2);
		// Another owner's private project is not.
		expect(ids).not.toContain(PROJECT.other);
	});

	it("gives an admin every project including ones nobody granted them", async () => {
		const ids = await listedProjectIds(principal(USER.admin, true));
		expect(ids.sort()).toEqual(
			[
				PROJECT.pub,
				PROJECT.pub2,
				PROJECT.priv,
				PROJECT.arch,
				PROJECT.other,
				PROJECT.bulk,
				PROJECT.caseMix,
				...CASE_MIX_PROJECT_IDS,
			].sort(),
		);
	});

	it("gives a user with no grant only the public projects, which are non-empty", async () => {
		const ids = await listedProjectIds(principal(USER.none));
		expect(ids.sort()).toEqual([PROJECT.pub, PROJECT.pub2].sort());
		expect(ids.length).toBeGreaterThan(0);
	});

	it.each([
		["read", USER.read],
		["write", USER.write],
		["manage", USER.manage],
	])("a direct %s grant opens the private project", async (_capability, userId) => {
		const ids = await listedProjectIds(principal(userId));
		expect(ids).toContain(PROJECT.priv);
		// The grant is scoped to p_priv; it must not spill onto another owner's project.
		expect(ids).not.toContain(PROJECT.other);
	});

	it("does not treat a project-scoped grant with a domain_kind as project read", async () => {
		const ids = await listedProjectIds(principal(USER.domain));
		expect(ids).not.toContain(PROJECT.priv);
		// The row genuinely exists, so this is a denial rather than a missing fixture.
		const grant = await db.query.aclGrants.findFirst({
			where: (g, { eq }) => eq(g.id, "g_domain"),
		});
		expect(grant?.scopeId).toBe(PROJECT.priv);
		expect(grant?.domainKind).toBe("clearance");
		// And the same user still sees what visibility opens, so they are not simply blocked.
		expect(ids).toContain(PROJECT.pub);
	});

	it("returns nothing at all for an absent principal, even an admin-flagged one", async () => {
		// An empty user id means a route was reached without the auth middleware. It must
		// not degrade to "public", and `isAdmin` must not rescue it either — that flag
		// comes from the same unverified place as the id.
		expect(await listedProjectIds(principal(""))).toEqual([]);
		expect(await listedProjectIds({ userId: "", isAdmin: true })).toEqual([]);
	});

	it("gives an unknown user id public projects only, never a private one", async () => {
		// `public` means "every signed-in user", and the adapter does not re-verify that
		// the id names a live account — `requireSessionAuth` already rejects a token whose
		// user is gone (USER_GONE), so this state is unreachable through a route. What the
		// adapter must still guarantee is that an id matching no grant and no ownership row
		// reaches nothing private.
		const ids = await listedProjectIds(principal(GHOST_USER));
		expect(ids.sort()).toEqual([PROJECT.pub, PROJECT.pub2].sort());
		expect(ids).not.toContain(PROJECT.priv);
		expect(ids).not.toContain(PROJECT.arch);
		expect(ids).not.toContain(PROJECT.other);
	});

	it("filters by status without losing the ACL predicate", async () => {
		expect(await listedProjectIds(principal(USER.owner), "archived")).toEqual([PROJECT.arch]);
		const active = await listedProjectIds(principal(USER.owner), "active");
		expect(active).toContain(PROJECT.priv);
		expect(active).not.toContain(PROJECT.arch);
		// An unrelated status filter must not widen access.
		expect(await listedProjectIds(principal(USER.none), "archived")).toEqual([]);
	});
});

describe("listProjects cursor paging", () => {
	it("walks 205 identically timestamped projects without duplicates or gaps", async () => {
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await adapter.listProjects(principal(USER.bulk), { limit: 50, cursor });
			const ids = (page.rows as Array<{ id: string }>).map((row) => row.id);
			seen.push(...ids);
			cursor = page.nextCursor ?? undefined;
			pages += 1;
			expect(pages).toBeLessThan(20);
		} while (cursor);

		const bulk = new Set(bulkProjectIds());
		const bulkSeen = seen.filter((id) => bulk.has(id));
		expect(bulkSeen).toHaveLength(BULK_PROJECT_COUNT);
		expect(new Set(bulkSeen).size).toBe(BULK_PROJECT_COUNT);
		// Every fixture row was reached: no gap hidden by the shared updatedAt.
		expect([...bulk].every((id) => bulkSeen.includes(id))).toBe(true);
		// The whole walk is strictly ordered, which is what makes the cursor safe.
		expect([...seen]).toEqual([...seen].sort());
	});

	it("clamps limit to 1..200 and reports a continuation only when more remain", async () => {
		const tiny = await adapter.listProjects(principal(USER.bulk), { limit: 0 });
		expect(tiny.rows).toHaveLength(1);
		expect(tiny.nextCursor).not.toBeNull();

		const negative = await adapter.listProjects(principal(USER.bulk), { limit: -5 });
		expect(negative.rows).toHaveLength(1);

		const huge = await adapter.listProjects(principal(USER.bulk), { limit: 5000 });
		expect(huge.rows).toHaveLength(200);
		// 206 rows are visible to u_bulk (205 bulk + p_bulk), so paging must continue.
		expect(huge.nextCursor).not.toBeNull();

		const last = await adapter.listProjects(principal(USER.bulk), {
			limit: 200,
			cursor: huge.nextCursor ?? undefined,
		});
		expect(last.rows.length).toBeGreaterThan(0);
		expect(last.nextCursor).toBeNull();
	});

	it("ignores a malformed cursor rather than failing open or closed silently", async () => {
		const page = await adapter.listProjects(principal(USER.none), { cursor: "not-base64url!!" });
		expect((page.rows as Array<{ id: string }>).map((row) => row.id).sort()).toEqual(
			[PROJECT.pub, PROJECT.pub2].sort(),
		);
	});
});

describe("mixed-case ids: byte order is the actual contract", () => {
	/**
	 * Why this describe exists at all: SQLite compares `text` in byte order and cannot be
	 * configured otherwise, so these expectations pin the REFERENCE behaviour the PostgreSQL
	 * adapter must reproduce with `COLLATE "C"`. The parity suite then checks agreement
	 * against live PostgreSQL on a musl AND a glibc image.
	 *
	 * The expected sequences are written out literally and deliberately NOT derived with
	 * `.sort()`: computing them with the same codepoint rule the check relies on would make
	 * the assertion circular — any ordering at all would "match".
	 */

	it("pins the fixture property: these ids order differently by case sensitivity", () => {
		// A fixture claiming to expose a collation difference must actually have one. This
		// fails loudly if a later edit normalises the ids to a single case, which is exactly
		// the edit that let the original defect hide for so long.
		for (const ids of [
			CASE_MIX_PROJECT_IDS,
			CASE_MIX_CHAPTER_IDS,
			CASE_MIX_EDGE_IDS,
			bulkProjectIds(),
		]) {
			expect(caseInsensitiveOrderDiffers(ids)).toBe(true);
		}
	});

	it("orders projects by id in byte order when every row shares updatedAt", async () => {
		// `u_CaseMix` owns the group plus `p_CaseMix` — and also sees the two PUBLIC projects,
		// which is itself useful: `p_pub`/`p_pub2` sort after every `p_cm*` id in byte order
		// (`c` = 0x63 < `p` = 0x70), so they sit at the end rather than interleaving. All nine
		// rows share `updatedAt`, so what comes back is the id tiebreak and nothing else.
		// `p_CaseMix` sorts FIRST: `C` (0x43) precedes every lowercase letter, which is the
		// opposite of what a case-insensitive locale does with these strings.
		const ids = await listedProjectIds(principal(USER.caseMix));
		expect(ids).toEqual([
			PROJECT.caseMix,
			...CASE_MIX_PROJECT_IDS_BYTE_ORDER,
			PROJECT.pub,
			PROJECT.pub2,
		]);
	});

	it("walks the group one row at a time without skipping or repeating any row", async () => {
		// `limit: 1` makes every row its own page, so every adjacent pair in the group crosses
		// a real cursor boundary — the keyset comparison, not just the ORDER BY. The cursor
		// strings are opaque, so the assertion is on the resulting sequence and its
		// completeness.
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 20; page += 1) {
			const result = await adapter.listProjects(principal(USER.caseMix), { limit: 1, cursor });
			seen.push(...(result.rows as Array<{ id: string }>).map((row) => row.id));
			if (!result.nextCursor) break;
			cursor = result.nextCursor;
		}
		expect(seen).toEqual([
			PROJECT.caseMix,
			...CASE_MIX_PROJECT_IDS_BYTE_ORDER,
			PROJECT.pub,
			PROJECT.pub2,
		]);
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("orders chapters by id in byte order when every row shares createdAt", async () => {
		const rows = (await adapter.listChapters(PROJECT.caseMix, principal(USER.caseMix))) as Array<{
			id: string;
		}>;
		expect(rows.map((row) => row.id)).toEqual([...CASE_MIX_CHAPTER_IDS_BYTE_ORDER]);
	});

	it("orders graph chapters and edges by id in byte order", async () => {
		const graph = (await adapter.getGraph(PROJECT.caseMix, principal(USER.caseMix))) as {
			chapters: Array<{ id: string }>;
			edges: Array<{ id: string }>;
		};
		expect(graph.chapters.map((ch) => ch.id)).toEqual([...CASE_MIX_CHAPTER_IDS_BYTE_ORDER]);
		expect(graph.edges.map((edge) => edge.id)).toEqual([...CASE_MIX_EDGE_IDS_BYTE_ORDER]);
	});

	it("keeps byte order across the 200-row clamp and the 201-row chapter cap", async () => {
		// The bulk ids interleave two letter cases by number (`bA001`, `ba001`, `bA002`, …).
		// Byte order therefore keeps a DIFFERENT SET at the caps than a case-insensitive
		// locale would, not merely a reshuffled one — so these expectations cannot pass
		// under a locale collation.
		const clamped = await adapter.listProjects(principal(USER.bulk), { limit: 5000 });
		const projectIds = (clamped.rows as Array<{ id: string }>).map((row) => row.id);
		expect(projectIds).toHaveLength(200);
		expect(projectIds).toEqual([...projectIds].sort());
		// Under byte order the uppercase run (`p_bA…`) entirely precedes the lowercase one
		// (`p_ba…`), so the first 200 rows are all 103 uppercase ids plus 97 lowercase ones.
		expect(projectIds.filter((id) => id.startsWith("p_bA"))).toHaveLength(103);
		expect(projectIds.filter((id) => id.startsWith("p_ba"))).toHaveLength(97);

		const chapters = (await adapter.listChapters(PROJECT.bulk, principal(USER.bulk))) as Array<{
			id: string;
		}>;
		expect(chapters).toHaveLength(201);
		expect(chapters.map((row) => row.id)).toEqual([...chapters.map((row) => row.id)].sort());
		expect(chapters.filter((row) => row.id.startsWith("c_bkA"))).toHaveLength(103);
		expect(chapters.filter((row) => row.id.startsWith("c_bka"))).toHaveLength(98);
	});
});

describe("getProject", () => {
	it("returns the row for every authority that should reach it", async () => {
		for (const who of [USER.owner, USER.read, USER.write, USER.manage]) {
			const row = (await adapter.getProject(PROJECT.priv, principal(who))) as {
				id: string;
				name: string;
			} | null;
			expect(row?.id).toBe(PROJECT.priv);
			expect(row?.name).toBe("Private project");
		}
		expect(
			((await adapter.getProject(PROJECT.other, principal(USER.admin, true))) as { id: string }).id,
		).toBe(PROJECT.other);
	});

	it("returns null for existing but unreadable projects", async () => {
		// p_other exists (the admin case above proves it) and is still denied here.
		expect(await adapter.getProject(PROJECT.other, principal(USER.none))).toBeNull();
		expect(await adapter.getProject(PROJECT.priv, principal(USER.domain))).toBeNull();
		expect(await adapter.getProject(PROJECT.priv, principal(GHOST_USER))).toBeNull();
		expect(await adapter.getProject(PROJECT.priv, principal(""))).toBeNull();
	});
});

describe("listChapters and getChapter", () => {
	it("returns the project's chapters in createdAt,id order for a grant holder", async () => {
		const rows = (await adapter.listChapters(PROJECT.priv, principal(USER.read))) as Array<{
			id: string;
		}>;
		expect(rows.map((row) => row.id)).toEqual(PRIV_CHAPTER_IDS_ORDERED);
	});

	it("applies the status filter while keeping the gate", async () => {
		const dormant = (await adapter.listChapters(
			PROJECT.priv,
			principal(USER.owner),
			"dormant",
		)) as Array<{ id: string }>;
		expect(dormant.map((row) => row.id)).toEqual([CHAPTER.c]);
		expect(await adapter.listChapters(PROJECT.priv, principal(USER.none), "dormant")).toEqual([]);
	});

	it("hides another project's chapters even though they exist", async () => {
		// Proven non-empty through an authority that may see them.
		const asAdmin = (await adapter.listChapters(
			PROJECT.other,
			principal(USER.admin, true),
		)) as Array<{ id: string }>;
		expect(asAdmin.map((row) => row.id)).toEqual([CHAPTER.other1, CHAPTER.other2]);
		expect(await adapter.listChapters(PROJECT.other, principal(USER.read))).toEqual([]);
		expect(await adapter.getChapter(CHAPTER.other1, principal(USER.read))).toBeNull();
		expect(await adapter.getChapter(CHAPTER.other1, principal(USER.domain))).toBeNull();
		expect(await adapter.getChapter(CHAPTER.other1, principal(GHOST_USER))).toBeNull();
	});

	it("reads a single chapter through the project gate", async () => {
		const row = (await adapter.getChapter(CHAPTER.review, principal(USER.write))) as {
			id: string;
			role: string;
			reviewSourceChapterId: string | null;
		} | null;
		expect(row?.id).toBe(CHAPTER.review);
		expect(row?.role).toBe("review");
		expect(row?.reviewSourceChapterId).toBe(CHAPTER.a);
	});

	it("caps a large chapter listing at 201 rows", async () => {
		const rows = (await adapter.listChapters(PROJECT.bulk, principal(USER.bulk))) as Array<{
			id: string;
		}>;
		// 205 chapters exist; the adapter returns limit+1 so a caller can detect truncation.
		expect(BULK_CHAPTER_COUNT).toBeGreaterThan(rows.length);
		expect(rows).toHaveLength(201);
		expect(new Set(rows.map((row) => row.id)).size).toBe(201);
		expect(bulkChapterIds()).toHaveLength(BULK_CHAPTER_COUNT);
	});
});

describe("getGraph", () => {
	it("returns every edge type with its metadata, plus the chapters", async () => {
		const graph = (await adapter.getGraph(PROJECT.priv, principal(USER.read))) as {
			chapters: Array<{ id: string; role: string; graphX: number | null }>;
			edges: Array<{ id: string; type: string; sourceId: string; targetId: string }>;
		};
		expect(graph.chapters.map((ch) => ch.id)).toEqual(PRIV_CHAPTER_IDS_ORDERED);
		expect(graph.edges.map((edge) => edge.id).sort()).toEqual([...PRIV_EDGE_IDS].sort());
		expect(graph.edges.map((edge) => edge.type).sort()).toEqual(
			["cherry_pick", "dependency", "fork", "merge", "review"].sort(),
		);
		const fork = graph.edges.find((edge) => edge.id === EDGE.fork);
		expect(fork).toMatchObject({ sourceId: CHAPTER.a, targetId: CHAPTER.b, type: "fork" });
		// Edges never cross the project boundary.
		expect(graph.edges.map((edge) => edge.id)).not.toContain(EDGE.otherProject);
	});

	it("returns an empty graph for an existing project the caller cannot read", async () => {
		const asAdmin = (await adapter.getGraph(PROJECT.other, principal(USER.admin, true))) as {
			chapters: unknown[];
			edges: Array<{ id: string }>;
		};
		// Non-empty for someone allowed, so the denial below is a real one.
		expect(asAdmin.chapters.length).toBeGreaterThan(0);
		expect(asAdmin.edges.map((edge) => edge.id)).toEqual([EDGE.otherProject]);

		for (const who of [principal(USER.none), principal(USER.domain), principal(GHOST_USER)]) {
			expect(await adapter.getGraph(PROJECT.other, who)).toEqual({ chapters: [], edges: [] });
		}
	});

	/**
	 * A >200-chapter graph is bounded AND says so.
	 *
	 * This was a deliberately-red test while SQLite's `getGraph` had no chapter limit and
	 * returned all 205 rows against PostgreSQL's cap. Both adapters now stop at
	 * `READ_LIMITS.graphChapters` and set `truncated`, so it is green for the right reason
	 * and the docblock no longer claims otherwise — a stale "kept failing on purpose" note
	 * invites the next reader to ignore a genuine failure here.
	 *
	 * The bound is asserted EXACTLY rather than as `<= 201`: the point of the flag is that a
	 * canvas losing chapters also loses every edge attached to them, which reads as "those
	 * branches were deleted", and a range would let the cap drift without failing. That the
	 * PostgreSQL adapter agrees on both the count and the flag is pinned by the parity
	 * matrix's `getGraph(bulk)` cases, which are no longer skipped.
	 */
	it("bounds a large graph at the chapter cap and marks it as truncated", async () => {
		const graph = (await adapter.getGraph(PROJECT.bulk, principal(USER.bulk))) as {
			chapters: Array<{ id: string }>;
			truncated?: boolean;
		};
		expect(BULK_CHAPTER_COUNT).toBe(205);
		expect(BULK_CHAPTER_COUNT).toBeGreaterThan(READ_LIMITS.graphChapters);
		expect(graph.chapters).toHaveLength(READ_LIMITS.graphChapters);
		expect(graph.truncated).toBe(true);
	});
});

describe("getGraphAuxiliaryData", () => {
	it("returns narrator, container and detached-panel data for a readable project", async () => {
		const aux = await adapter.getGraphAuxiliaryData(
			PROJECT.priv,
			PRIV_CHAPTER_IDS_ORDERED,
			principal(USER.read),
		);
		const narratorIds = aux.narrators.map((n) => n.id).sort();
		// Public, own-private, project-visible (via the project grant) and narrator-granted
		// sessions are all readable; another user's plain private session is not.
		expect(narratorIds).toEqual(
			[NARRATOR.pubOther, NARRATOR.projOther, NARRATOR.ownRead, NARRATOR.granted].sort(),
		);
		expect(narratorIds).not.toContain(NARRATOR.privOther);
		// The hidden narrator exists — an admin sees it.
		const asAdmin = await adapter.getGraphAuxiliaryData(
			PROJECT.priv,
			PRIV_CHAPTER_IDS_ORDERED,
			principal(USER.admin, true),
		);
		expect(asAdmin.narrators.map((n) => n.id)).toContain(NARRATOR.privOther);

		expect(aux.detachedPanels).toEqual([{ id: CHAPTER.a, detachedPanelsJson: '[{"id":"dp-a"}]' }]);
	});

	it("hides a private narrator inside a public project", async () => {
		const aux = await adapter.getGraphAuxiliaryData(
			PROJECT.pub,
			[CHAPTER.pub],
			principal(USER.none),
		);
		// The project gate is open to everyone here, so only the narrator ACL can filter.
		expect(aux.narrators.map((n) => n.id)).toEqual([NARRATOR.pubVisible]);
		expect(aux.detachedPanels.map((row) => row.id)).toEqual([CHAPTER.pub]);
	});

	/**
	 * RED — container badges vanish for every non-admin principal.
	 *
	 * `sqlite-project-read-adapter.ts` filters the container query with
	 * `projectReadableWhereForColumn(principal, containerInstances.chapterId)`, which
	 * compiles to `p.id = container_instances.chapter_id`: a PROJECT id compared against a
	 * CHAPTER id, so the EXISTS is never satisfied. Admins are unaffected only because the
	 * helper returns `undefined` for them, which `and(...)` drops.
	 *
	 * The rows are readable — the same call with `isAdmin: true` returns both — so this is
	 * a predicate bug, not an access decision. Symptom in the product: the "has containers"
	 * badge disappears from every chapter node for ordinary users.
	 *
	 * The correct predicate has to reach the project through the chapter, e.g. a subquery
	 * on `chapters.id = container_instances.chapter_id`, mirroring the narrator path.
	 */
	it("returns live container rows for the project owner and a read-grant holder", async () => {
		const expected = [{ chapterId: CHAPTER.a }, { chapterId: CHAPTER.c }];
		const asAdmin = await adapter.getGraphAuxiliaryData(
			PROJECT.priv,
			PRIV_CHAPTER_IDS_ORDERED,
			principal(USER.admin, true),
		);
		// Proof the rows exist and that `removed` is the only exclusion.
		expect(asAdmin.containers).toEqual(expected);

		for (const who of [USER.owner, USER.read, USER.write, USER.manage]) {
			expect(
				await adapter
					.getGraphAuxiliaryData(PROJECT.priv, PRIV_CHAPTER_IDS_ORDERED, principal(who))
					.then((aux) => aux.containers),
			).toEqual(expected);
		}

		const inPublicProject = await adapter.getGraphAuxiliaryData(
			PROJECT.pub,
			[CHAPTER.pub],
			principal(USER.none),
		);
		expect(inPublicProject.containers).toEqual([{ chapterId: CHAPTER.pub }]);
	});

	it("returns empty auxiliary data for an unreadable project and for no chapter ids", async () => {
		expect(
			await adapter.getGraphAuxiliaryData(
				PROJECT.other,
				[CHAPTER.other1, CHAPTER.other2],
				principal(USER.read),
			),
		).toEqual({ narrators: [], containers: [], detachedPanels: [] });
		expect(await adapter.getGraphAuxiliaryData(PROJECT.priv, [], principal(USER.read))).toEqual({
			narrators: [],
			containers: [],
			detachedPanels: [],
		});
	});

	it("does not return auxiliary rows for chapters outside the requested project", async () => {
		// c_o1 belongs to p_other; asking for it under p_priv must not reach its rows.
		const aux = await adapter.getGraphAuxiliaryData(
			PROJECT.priv,
			[CHAPTER.a, CHAPTER.other1],
			principal(USER.admin, true),
		);
		expect(aux.detachedPanels.map((row) => row.id)).toEqual([CHAPTER.a]);
		// Admin path, so the container predicate is not in play here (see the RED case above).
		expect(aux.containers.map((row) => row.chapterId)).toEqual([CHAPTER.a]);
	});
});
