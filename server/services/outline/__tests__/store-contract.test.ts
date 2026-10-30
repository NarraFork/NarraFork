/**
 * The outline store contract and the read contract against SQLite, through the production SQLite
 * store and the write path. The same cases run against PostgreSQL in
 * `tests/server/services/outline/pg-outline-store.test.ts` (`PG_INTEGRATION=1`).
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own spaces.
 */
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../../../db";
import {
	narrators,
	outlineBlocks,
	outlineBlockVersions,
	outlineCommits,
	outlineLinks,
	outlineSpaces,
	outlineTaskClaims,
	projects,
	users,
} from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { chunked, type OutlineVersionRow } from "../store/port";
import { MAIN_THREAD_PAGE_ROWS } from "../store/sqlite-read";
import { sqliteOutlineStore } from "../store/sqlite-store";
import { OUTLINE_STORE_CONTRACT, type OutlineContractContext } from "./contract";
import { OUTLINE_READ_CONTRACT } from "./read-contract";
import { OUTLINE_TASK_CONTRACT } from "./task-contract";

const NOW = "2026-10-26T00:00:00.000Z";

const ctx: OutlineContractContext = {
	store: sqliteOutlineStore,
	randomTransactions: 80,
	async seedUser() {
		const id = generateId();
		await db.insert(users).values({
			id,
			username: `outline-${id}`,
			passwordHash: "x",
			role: "user",
			createdAt: NOW,
		});
		return id;
	},
	async seedProject() {
		const id = generateId();
		await db.insert(projects).values({ id, name: `outline-${id}`, createdAt: NOW, updatedAt: NOW });
		return id;
	},
	async seedNarrator(subagent) {
		const id = generateId();
		await db.insert(narrators).values({
			id,
			title: "outline",
			createdAt: NOW,
			updatedAt: NOW,
			...(subagent
				? {
						type: "subagent" as const,
						parentNarratorId: subagent.parentId,
						aclRootNarratorId: subagent.rootId,
					}
				: {}),
		});
		return id;
	},
	async dump(spaceId) {
		const space = await sqliteOutlineStore.getSpace(spaceId);
		if (!space) throw new Error(`no space ${spaceId}`);
		const blocks = (
			await db.select().from(outlineBlocks).where(eq(outlineBlocks.spaceId, spaceId))
		).map((b) => ({ ...b, taskJson: b.taskJson ?? null }));
		const versions: OutlineVersionRow[] = [];
		for (const ids of chunked(blocks.map((b) => b.id))) {
			const rows = await db
				.select()
				.from(outlineBlockVersions)
				.where(inArray(outlineBlockVersions.blockId, ids));
			for (const v of rows) versions.push({ ...v, taskJson: v.taskJson ?? null });
		}
		return {
			space,
			blocks,
			versions,
			links: await db.select().from(outlineLinks).where(eq(outlineLinks.spaceId, spaceId)),
			commits: await db
				.select()
				.from(outlineCommits)
				.where(eq(outlineCommits.spaceId, spaceId))
				.orderBy(outlineCommits.seq),
			claims: await sqliteOutlineStore.getTaskClaims(blocks.map((b) => b.id)),
		};
	},
	async resetInProcess(spaceId) {
		await db
			.update(outlineSpaces)
			.set({ inProcessReady: false })
			.where(eq(outlineSpaces.id, spaceId));
		await db
			.update(outlineBlocks)
			.set({ inProcess: false })
			.where(eq(outlineBlocks.spaceId, spaceId));
	},
	async forgetClaims(taskBlockIds) {
		await db
			.delete(outlineTaskClaims)
			.where(inArray(outlineTaskClaims.taskBlockId, [...taskBlockIds]));
	},
	async searchContent(needle) {
		const rows = sqlite
			.prepare(
				`SELECT b.id AS id FROM outline_blocks_fts f
				 JOIN outline_blocks b ON b.rowid = f.rowid
				 WHERE outline_blocks_fts MATCH ? ORDER BY b.id`,
			)
			.all(`"${needle.replaceAll('"', '""')}"`) as Array<{ id: string }>;
		return rows.map((r) => r.id);
	},
};

describe("outline store contract (SQLite)", () => {
	for (const contractCase of OUTLINE_STORE_CONTRACT) {
		test(contractCase.name, () => contractCase.run(ctx), 120_000);
	}
});

describe("outline task contract (SQLite)", () => {
	for (const contractCase of OUTLINE_TASK_CONTRACT) {
		test(contractCase.name, () => contractCase.run(ctx), 120_000);
	}
});

describe("outline read contract (SQLite)", () => {
	for (const contractCase of OUTLINE_READ_CONTRACT) {
		test(contractCase.name, () => contractCase.run(ctx), 300_000);
	}
});

describe("SQLite specifics", () => {
	test("alias lookups and page reads use their indexes", () => {
		const plan = (query: string) =>
			(sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>)
				.map((r) => r.detail)
				.join("\n");
		expect(
			plan(
				`SELECT id FROM outline_blocks WHERE space_id = 'x' AND alias IN ('a', 'b') AND "outline_blocks"."deleted" = 0`,
			),
		).toContain("uq_outline_blocks_space_alias");
		expect(
			plan(
				`SELECT alias FROM outline_blocks WHERE space_id = 'x' AND alias >= 'Q0' AND alias < 'Q:' AND "outline_blocks"."deleted" = 0 ORDER BY alias LIMIT 5`,
			),
		).toContain("uq_outline_blocks_space_alias");
		expect(
			plan(
				"SELECT block_id FROM outline_block_versions WHERE page_id = 'p' AND from_seq <= 5 AND (to_seq IS NULL OR to_seq > 5)",
			),
		).toContain("idx_outline_versions_page_range");
		expect(
			plan("SELECT id FROM outline_links WHERE from_block_id IN ('a', 'b') AND to_seq IS NULL"),
		).toContain("idx_outline_links_from");
	});

	test("task claims, open tasks and the in-process rebuild use their indexes", () => {
		const plan = (query: string) =>
			(sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>)
				.map((r) => r.detail)
				.join("\n");
		// The store's statements, as drizzle renders them.
		expect(
			plan(
				`SELECT "id" FROM "outline_blocks" WHERE ("outline_blocks"."space_id" = 's' AND json_extract("task_json", '$.status') IN ('todo', 'doing') AND "deleted" = 0) LIMIT 5`,
			),
		).toContain("idx_outline_blocks_open_tasks");
		expect(
			plan(
				`SELECT c.task_block_id FROM outline_task_claims c JOIN outline_blocks b ON b.id = c.task_block_id WHERE (c.holder_narrator_id = 'n' AND c.holder_narrator_id IS NOT NULL) ORDER BY c.claimed_at LIMIT 5`,
			),
		).toContain("idx_outline_task_claims_holder");
		expect(
			plan(
				`SELECT c.task_block_id FROM outline_task_claims c JOIN outline_blocks b ON b.id = c.task_block_id WHERE (c.expires_at IS NOT NULL AND c.expires_at <= 'x' AND c.holder_narrator_id IS NOT NULL) ORDER BY c.expires_at, c.task_block_id LIMIT 5`,
			),
		).toContain("idx_outline_task_claims_expiry");
		expect(
			plan(
				`SELECT id FROM outline_spaces WHERE ("in_process_ready" = 0 AND id > 'a') ORDER BY id LIMIT 5`,
			),
		).toContain("idx_outline_spaces_in_process_pending");
		expect(
			plan(
				`SELECT "id", "space_id" FROM "outline_blocks" WHERE (json_extract("task_json", '$.status') = 'doing' AND "deleted" = 0 AND "outline_blocks"."id" > 'a') ORDER BY "outline_blocks"."id" ASC LIMIT 5`,
			),
		).toContain("idx_outline_blocks_doing_tasks");
		expect(
			plan(`SELECT id, type, acl_root_narrator_id FROM narrators WHERE id IN ('a', 'b')`),
		).toMatch(/PRIMARY KEY|sqlite_autoindex_narrators/);
	});

	test("a page past the main-thread size is read on the workers, truncation exact", async () => {
		const space = await sqliteOutlineStore.ensureSpace(
			{ kind: "personal", ownerUserId: await ctx.seedUser() },
			NOW,
		);
		const { writeOutline } = await import("../write");
		const write = (ops: Parameters<typeof writeOutline>[0]["ops"]) =>
			writeOutline(
				{ spaceId: space.id, ops, actor: { kind: "human", id: "u" }, responsibleUserId: null },
				{ store: sqliteOutlineStore },
			);
		const page = (await write([{ op: "insert", parent: null, content: "big" }])).results[0]
			?.blockId as string;
		let made = 0;
		for (; made < MAIN_THREAD_PAGE_ROWS + 50; made += 200) {
			await write(
				Array.from({ length: 200 }, (_, i) => ({
					op: "insert" as const,
					parent: { id: page },
					content: `row ${made + i}`,
				})),
			);
		}
		const total = made + 1;
		for (const asOf of [null, made / 200 + 1]) {
			const read = (limit: number) => sqliteOutlineStore.listPageStructure(page, { asOf, limit });
			const all = await read(10_000);
			expect(all.rows).toHaveLength(total);
			expect(all.truncated).toBe(false);
			expect((await read(total)).truncated).toBe(false);
			const cut = await read(total - 1);
			expect(cut.rows).toHaveLength(total - 1);
			expect(cut.truncated).toBe(true);
			expect((await read(100)).truncated).toBe(true);
		}
		const { readOutline } = await import("../read");
		const rendered = await readOutline({ blockId: page, store: sqliteOutlineStore });
		expect(rendered?.blockIds).toHaveLength(80);
		expect(rendered?.truncated).toBe(true);
	}, 120_000);

	test("history, timeline and search statements use their indexes", () => {
		const plan = (query: string) =>
			(sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>)
				.map((r) => r.detail)
				.join("\n");
		expect(
			plan(
				"SELECT DISTINCT to_seq FROM outline_block_versions WHERE page_id = 'p' AND from_seq < 9 AND to_seq > 1 AND to_seq < 9 ORDER BY to_seq DESC LIMIT 5",
			),
		).toContain("idx_outline_versions_page_range");
		expect(plan("SELECT * FROM outline_block_versions WHERE commit_id = 'c' LIMIT 5")).toContain(
			"idx_outline_versions_commit",
		);
		expect(
			plan(
				"SELECT id FROM outline_links WHERE target_kind = 'block' AND target_ref = 'k/s' AND to_seq IS NULL",
			),
		).toContain("idx_outline_links_target");
		expect(
			plan(
				"SELECT b.id FROM outline_blocks_fts JOIN outline_blocks b ON b.rowid = outline_blocks_fts.rowid WHERE outline_blocks_fts MATCH 'abc' AND b.space_id IN ('s')",
			),
		).toContain("VIRTUAL TABLE INDEX");
	});

	test("deleting a space takes its blocks, history and links with it", async () => {
		const space = await sqliteOutlineStore.ensureSpace(
			{ kind: "personal", ownerUserId: await ctx.seedUser() },
			NOW,
		);
		const { writeOutline } = await import("../write");
		await writeOutline(
			{
				spaceId: space.id,
				ops: [{ op: "insert", parent: null, content: "x [[y]]" }],
				actor: { kind: "human", id: "u" },
				responsibleUserId: null,
			},
			{ store: sqliteOutlineStore },
		);
		await db.delete(outlineSpaces).where(eq(outlineSpaces.id, space.id));
		expect(
			await db.select().from(outlineBlocks).where(eq(outlineBlocks.spaceId, space.id)),
		).toEqual([]);
		expect(await db.select().from(outlineLinks).where(eq(outlineLinks.spaceId, space.id))).toEqual(
			[],
		);
		expect(
			await db.select().from(outlineCommits).where(eq(outlineCommits.spaceId, space.id)),
		).toEqual([]);
	});
});
