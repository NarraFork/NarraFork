/**
 * Recall-shape regressions for the search store, against a real FTS index.
 *
 * The four search paths do NOT agree on how a query becomes a match, and moving them behind
 * one port made "harmonize them" a one-line temptation. The differences are behaviour users
 * and models already depend on, so each one is pinned here against a real database — the
 * expression-level tests in `search.test.ts` pin the strings, these pin what the strings
 * actually retrieve.
 *
 * Every case below would still pass if the port were correct but a shape were "tidied":
 * that is why they exist.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	chapters,
	knowledgeCollections,
	knowledgeEntries,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
} from "../../../server/db/schema";
import { getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
mock.module("../../../server/db", () => ({ db, sqlite }));

const { ensureFts } = await import("../../../server/db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });

const { searchStore } = await import("../../../server/services/search/backend");
const { knowledgeService } = await import("../../../server/services/knowledge-service");

const NOW = "2026-07-19T00:00:00.000Z";
const ADMIN = { userId: "shape-admin", isAdmin: true };

function seedChapter(id: string, title: string, description: string) {
	db.insert(chapters)
		.values({
			id,
			projectId: "proj-shape",
			title,
			description,
			branch: `chapter/${id}`,
			baseBranch: "main",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedMessage(id: string, seq: number, text: string) {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId: "narr-shape",
			role: "assistant",
			contentJson: [{ type: "text", text }],
			contentText: text,
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId: "narr-shape", messageId: id, seq })
		.run();
}

beforeEach(() => {
	db.insert(projects)
		.values({
			id: "proj-shape",
			name: "Shapes",
			gitPath: "/tmp/proj-shape",
			visibility: "public",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	seedChapter("chap-shape", "Zephyr calibration harness", "描述充电流程与电池温度监控");
	db.insert(narrators)
		.values({
			id: "narr-shape",
			chapterId: "chap-shape",
			type: "primary",
			inheritMode: "fresh",
			visibility: "public",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	seedMessage("msg-shape", 1, "Zephyr calibration harness notes 充电流程说明");
});

afterEach(() => {
	sqlite.run("PRAGMA foreign_keys = OFF");
	for (const table of [
		"narrator_message_refs",
		"narrator_messages",
		"narrators",
		"chapters",
		"projects",
		"knowledge_entries",
		"knowledge_collections",
	]) {
		sqlite.run(`DELETE FROM "${table}"`);
	}
	sqlite.run("PRAGMA foreign_keys = ON");
});

describe("global search matches a phrase, the timeline matches prefixes", () => {
	/**
	 * The asymmetry itself, demonstrated on one corpus with one query.
	 *
	 * "calibration harness" is contiguous in both rows, so both find it. "calibr harn" is
	 * contiguous in neither as full words — the timeline's prefix expansion still matches it,
	 * global search's phrase does not. If someone unified the two shapes, exactly one of these
	 * two assertions would flip, which is the signal this pair exists to produce.
	 */
	it("both find a contiguous phrase", async () => {
		const global = await searchStore.searchMessages({
			text: "calibration harness",
			strategy: "index",
			limit: 10,
			viewer: ADMIN,
		});
		expect(global.map((r) => r.id)).toEqual(["msg-shape"]);

		const timeline = await searchStore.searchTimeline({
			narratorId: "narr-shape",
			text: "calibration harness",
			strategy: "index",
			limit: 10,
			inheritedScopes: [],
		});
		expect(timeline.map((r) => r.messageId)).toEqual(["msg-shape"]);
	});

	it("only the timeline matches truncated terms, because only it expands prefixes", async () => {
		const global = await searchStore.searchMessages({
			text: "calibr harn",
			strategy: "index",
			limit: 10,
			viewer: ADMIN,
		});
		expect(global).toEqual([]);

		const timeline = await searchStore.searchTimeline({
			narratorId: "narr-shape",
			text: "calibr harn",
			strategy: "index",
			limit: 10,
			inheritedScopes: [],
		});
		expect(timeline.map((r) => r.messageId)).toEqual(["msg-shape"]);
	});
});

describe("CJK queries", () => {
	// Three Han characters form a trigram token, so the index path works on them.
	it("finds a 3-character CJK term through the index", async () => {
		const rows = await searchStore.searchMessages({
			text: "充电流",
			strategy: "index",
			limit: 10,
			viewer: ADMIN,
		});
		expect(rows.map((r) => r.id)).toEqual(["msg-shape"]);
	});

	// Two Han characters cannot, which is why the caller must pick the substring path for
	// them. Asserting both halves: the index genuinely finds nothing, the substring path does.
	it("needs the substring path for a 2-character CJK term", async () => {
		const viaIndex = await searchStore.searchMessages({
			text: "充电",
			strategy: "index",
			limit: 10,
			viewer: ADMIN,
		});
		expect(viaIndex).toEqual([]);

		const viaSubstring = await searchStore.searchMessages({
			text: "充电",
			strategy: "substring",
			limit: 10,
			viewer: ADMIN,
		});
		expect(viaSubstring.map((r) => r.id)).toEqual(["msg-shape"]);
	});

	it("matches a CJK chapter description on the substring path", async () => {
		const rows = await searchStore.searchChapters({
			text: "电池",
			strategy: "substring",
			limit: 10,
			viewer: ADMIN,
		});
		expect(rows.map((r) => r.id)).toEqual(["chap-shape"]);
	});
});

describe("snippets carry each path's own markup", () => {
	it("marks Recall hits so the model can see the match", async () => {
		const rows = await searchStore.searchRecallMessages({
			text: "calibration",
			strategy: "index",
			limit: 10,
			narratorId: "narr-shape",
			previewChars: 300,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].snippet).toContain(">>>");
		expect(rows[0].snippet).toContain("<<<");
	});

	it("leaves global-search snippets unmarked", async () => {
		const rows = await searchStore.searchMessages({
			text: "calibration",
			strategy: "index",
			limit: 10,
			viewer: ADMIN,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].snippet).not.toContain(">>>");
	});
});

describe("knowledge substring matching escapes user-typed wildcards", () => {
	/**
	 * Knowledge is the one path that escapes `%`/`_`, so a user searching for a literal `%`
	 * gets rows containing `%` — not every row. The other three paths deliberately do not
	 * escape; that difference is pinned at the expression level in `search.test.ts`, and its
	 * consequence for knowledge is pinned here.
	 */
	beforeEach(() => {
		db.insert(knowledgeCollections)
			.values({
				id: "col-shape",
				name: "Shapes",
				slug: "col-shape",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		for (const [id, title, content] of [
			["kb-pct", "Discount rules", "apply a 50% cut"],
			["kb-plain", "Plain rules", "apply a flat cut"],
		]) {
			db.insert(knowledgeEntries)
				.values({
					id,
					collectionId: "col-shape",
					title,
					slug: id,
					currentContent: content,
					tagsJson: [],
					status: "active",
					createdAt: NOW,
					updatedAt: NOW,
				})
				.run();
		}
	});

	it("treats a typed % as a literal, not a wildcard", async () => {
		// Two characters, so this takes the substring path. An unescaped `%` here would match
		// both rows; escaped, it matches only the row that literally contains one.
		const ids = (await knowledgeService.search({ q: "0%", collectionId: "col-shape" })).map(
			(r) => r.id,
		);
		expect(ids).toEqual(["kb-pct"]);
	});
});

describe("the short-query cap bounds the unindexed scan", () => {
	/**
	 * The substring path is unindexed and runs on the main thread, so it takes a TIGHTER limit
	 * than the caller asked for. Previously each branch computed that cap itself; it is now
	 * derived once, which is cheaper to read and easier to drop by accident — hence this test.
	 *
	 * Asserted through the public service (both branches share the derivation) with a limit
	 * above the cap, and paired with the index path to show the cap is specific to the
	 * unindexed one rather than a blanket ceiling.
	 */
	const SHORT_QUERY_FALLBACK_LIMIT = 50;

	beforeEach(() => {
		db.insert(knowledgeCollections)
			.values({
				id: "col-cap",
				name: "Caps",
				slug: "col-cap",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		// More rows than the fallback cap, all matching both a 2-char and a 3-char needle.
		for (let i = 0; i < SHORT_QUERY_FALLBACK_LIMIT + 15; i++) {
			db.insert(knowledgeEntries)
				.values({
					id: `kb-cap-${i}`,
					collectionId: "col-cap",
					title: `Entry ${i}`,
					slug: `kb-cap-${i}`,
					currentContent: "zq zqx padding text",
					tagsJson: [],
					status: "active",
					createdAt: NOW,
					updatedAt: NOW,
				})
				.run();
		}
	});

	it("caps a short query below the caller's limit", async () => {
		const rows = await knowledgeService.search({ q: "zq", collectionId: "col-cap", limit: 100 });
		expect(rows.length).toBe(SHORT_QUERY_FALLBACK_LIMIT);
	});

	it("does not apply that cap to an indexed query", async () => {
		const rows = await knowledgeService.search({ q: "zqx", collectionId: "col-cap", limit: 100 });
		expect(rows.length).toBeGreaterThan(SHORT_QUERY_FALLBACK_LIMIT);
	});
});

describe("knowledge field restriction", () => {
	/**
	 * The field name reaches an FTS5 column filter and a LIKE column reference, so it is an
	 * allow-list rather than a passthrough. An unrecognized name must be REJECTED: silently
	 * searching everything is the failure mode the restriction exists to prevent, since its
	 * only user is passive injection, which must fire on author-declared keywords and never on
	 * body text.
	 */
	it("accepts the keyword column", async () => {
		await expect(
			searchStore.searchKnowledgeEntries({
				indexText: "anything",
				substringText: "anything",
				strategy: "index",
				limit: 5,
				match: "or",
				field: "current_keywords",
			}),
		).resolves.toBeDefined();
	});

	it("rejects an unknown field instead of interpolating it", async () => {
		// The port is async, so the allow-list rejection surfaces as a REJECTED promise
		// rather than a synchronous throw — the same ValidationError, one await away.
		await expect(
			searchStore.searchKnowledgeEntries({
				indexText: "anything",
				substringText: "anything",
				strategy: "index",
				limit: 5,
				match: "and",
				field: "current_content} : (x) OR title:(",
			}),
		).rejects.toThrow(/Unsupported knowledge search field/);
	});
});
