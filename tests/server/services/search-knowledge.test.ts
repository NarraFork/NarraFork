/**
 * Knowledge-base entries as global-search results.
 *
 * The global search used to cover chapters, messages and narrators only, so knowledge
 * was reachable exclusively through the knowledge UI or the agent's KnowledgeSearch
 * tool. Wiring it into `/api/search` means a search hit can now expose an entry's
 * title and a body snippet, which is precisely the shape of leak that never 404s and
 * therefore never gets noticed — so the clearance gate is asserted here, not assumed.
 *
 * Both query paths matter because they are different SQL: three characters or more
 * use the trigram FTS index, shorter queries fall back to LIKE.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	aclGrants,
	knowledgeCollections,
	knowledgeDrafts,
	knowledgeEntries,
	knowledgeLevels,
	users,
} from "../../../server/db/schema";
import { getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
mock.module("../../../server/db", () => ({ db, sqlite }));

const { createSqliteSearchStore } = await import("../../../server/services/search/sqlite-store");
const searchStore = createSqliteSearchStore(async (sql, params) =>
	sqlite.prepare<Record<string, unknown>, Array<string | number | null>>(sql).all(...params),
);
mock.module("../../../server/services/search/backend", () => ({ searchStore }));

// FTS virtual tables + sync triggers are created at runtime, not by a migration.
const { ensureFts } = await import("../../../server/db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });

const { searchService } = await import("../../../server/services/search-service");
const { invalidateLevelCache } = await import("../../../server/services/knowledge-acl");

const NOW = "2026-07-19T00:00:00.000Z";
const LATER = "2026-07-20T00:00:00.000Z";
const READER = "kb-reader";
const STRANGER = "kb-stranger";

function seedCollection(id: string, name: string, defaultLevel: string) {
	db.insert(knowledgeCollections)
		.values({
			id,
			name,
			slug: id,
			defaultLevel,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedEntry(id: string, collectionId: string, title: string, content: string) {
	db.insert(knowledgeEntries)
		.values({
			id,
			collectionId,
			title,
			slug: id,
			currentContent: content,
			tagsJson: ["ops"],
			status: "active",
			createdAt: NOW,
			updatedAt: LATER,
		})
		.run();
}

function searchKnowledge(userId: string, query: string, isAdmin = false) {
	return searchService.searchKnowledge({ query, principal: { userId, isAdmin } });
}

beforeEach(() => {
	for (const id of [READER, STRANGER]) {
		db.insert(users)
			.values({ id, username: id, passwordHash: "x", role: "user", createdAt: NOW })
			.run();
	}
	db.insert(knowledgeLevels)
		.values([
			{ id: "lvl-public", name: "public", rank: 0, createdAt: NOW },
			{ id: "lvl-internal", name: "internal", rank: 10, createdAt: NOW },
		])
		.run();
	invalidateLevelCache();

	seedCollection("col-open", "Open Handbook", "public");
	seedCollection("col-secret", "Restricted Handbook", "internal");
	seedEntry("kb-open", "col-open", "Zephyr calibration guide", "Zephyr calibration steps");
	seedEntry("kb-secret", "col-secret", "Zephyr incident postmortem", "Zephyr internal notes");

	// READER holds an `internal` clearance; STRANGER holds nothing. Knowledge grants live
	// in the unified `acl_grants` table (scope `global`, domain `clearance`) — the legacy
	// `knowledge_grants` table is no longer read.
	db.insert(aclGrants)
		.values({
			id: "grant-reader-internal",
			scopeType: "global",
			principalType: "user",
			principalId: READER,
			capability: "read",
			domainKind: "clearance",
			domainValue: "internal",
			createdAt: NOW,
		})
		.run();
});

afterEach(() => {
	sqlite.run("PRAGMA foreign_keys = OFF");
	for (const table of [
		"acl_grants",
		"knowledge_drafts",
		"knowledge_entries",
		"knowledge_collections",
		"knowledge_levels",
		"users",
	]) {
		sqlite.run(`DELETE FROM "${table}"`);
	}
	sqlite.run("PRAGMA foreign_keys = ON");
	invalidateLevelCache();
});

describe("knowledge search in global search (FTS path)", () => {
	it("returns knowledge hits shaped like other search results", async () => {
		const results = await searchKnowledge(READER, "calibration");
		const hit = results.find((r) => r.id === "kb-open");
		expect(hit).toBeDefined();
		expect(hit?.type).toBe("knowledge");
		expect(hit?.title).toBe("Zephyr calibration guide");
		// The collection name is resolved so the UI can badge the hit's origin.
		expect(hit?.collectionName).toBe("Open Handbook");
		// `updatedAt` is what the "newest" sort orders on; without it a knowledge hit
		// would silently sink to the bottom of a recency-sorted page.
		expect(hit?.updatedAt).toBe(LATER);
		expect(hit?.snippet.length).toBeGreaterThan(0);
	});

	it("hides a classified entry from a user without the clearance", async () => {
		const ids = (await searchKnowledge(STRANGER, "Zephyr")).map((r) => r.id);
		expect(ids).toEqual(["kb-open"]);
	});

	it("shows it to a user holding the clearance", async () => {
		const ids = (await searchKnowledge(READER, "Zephyr")).map((r) => r.id).sort();
		expect(ids).toEqual(["kb-open", "kb-secret"]);
	});

	it("shows everything to an admin", async () => {
		const ids = (await searchKnowledge("kb-admin", "Zephyr", true)).map((r) => r.id).sort();
		expect(ids).toEqual(["kb-open", "kb-secret"]);
	});
});

describe("knowledge search in global search (LIKE fallback path)", () => {
	// A 2-character query cannot be tokenized by the trigram index, so this exercises
	// the unindexed fallback. A gate on only the FTS branch is one short query away
	// from leaking again.
	it("hides a classified entry from a user without the clearance", async () => {
		const ids = (await searchKnowledge(STRANGER, "Ze")).map((r) => r.id);
		expect(ids).toEqual(["kb-open"]);
	});

	it("shows it to a user holding the clearance", async () => {
		const ids = (await searchKnowledge(READER, "Ze")).map((r) => r.id).sort();
		expect(ids).toEqual(["kb-open", "kb-secret"]);
	});
});

describe("knowledge search time ordering", () => {
	for (const query of ["recentneedle", "新近"]) {
		it(`selects newest matches before LIMIT for ${query}`, async () => {
			for (let i = 0; i < 4; i++) {
				seedEntry(`recent-${i}`, "col-open", "Recency fixture", query.repeat(4 - i));
				sqlite
					.prepare("UPDATE knowledge_entries SET updated_at = ? WHERE id = ?")
					.run(`2026-08-0${i + 1}T00:00:00.000Z`, `recent-${i}`);
			}
			const options = { query, limit: 2, principal: { userId: READER, isAdmin: false } };
			const recent = await searchService.searchKnowledge({ ...options, sort: "time" });
			expect(recent.map((row) => row.id)).toEqual(["recent-3", "recent-2"]);
			expect(await searchService.searchKnowledge(options)).toEqual(
				await searchService.searchKnowledge({ ...options, sort: "relevance" }),
			);
		});

		it(`merges personal and main matches by version time before LIMIT for ${query}`, async () => {
			const dates = ["2026-08-01", "2026-08-03", "2026-08-04"];
			for (let i = 0; i < dates.length; i++) {
				const id = `personal-${i}`;
				seedEntry(id, "col-open", "Personal fixture", "committed body");
				// Main metadata is deliberately older than the personal version.
				db.insert(knowledgeDrafts)
					.values({
						id: `draft-${i}`,
						entryId: id,
						authorUserId: READER,
						content: query.repeat(4 - i),
						contentHash: "fixture",
						createdAt: NOW,
						updatedAt: `${dates[i]}T00:00:00.000Z`,
					})
					.run();
			}
			seedEntry("newest-main", "col-open", "Main fixture", query);
			sqlite
				.prepare("UPDATE knowledge_entries SET updated_at = ? WHERE id = ?")
				.run("2026-08-05T00:00:00.000Z", "newest-main");
			// A newer main hit removed by the author's personal version must stay shadowed.
			seedEntry("shadowed-main", "col-open", "Shadowed fixture", query);
			sqlite
				.prepare("UPDATE knowledge_entries SET updated_at = ? WHERE id = ?")
				.run("2026-08-06T00:00:00.000Z", "shadowed-main");
			db.insert(knowledgeDrafts)
				.values({
					id: "shadowed-draft",
					entryId: "shadowed-main",
					authorUserId: READER,
					content: "term removed",
					contentHash: "fixture",
					createdAt: NOW,
					updatedAt: LATER,
				})
				.run();
			const results = await searchService.searchKnowledge({
				query,
				limit: 2,
				sort: "time",
				principal: { userId: READER, isAdmin: false },
			});
			expect(results.map((row) => row.id)).toEqual(["newest-main", "personal-2"]);
			expect(results[1]?.updatedAt).toBe("2026-08-04T00:00:00.000Z");
		});
	}

	it("uses stable entry IDs to break timestamp ties across personal and main versions", async () => {
		seedEntry("tie-b", "col-open", "tiequery", "main version");
		seedEntry("tie-a", "col-open", "tiequery", "main version");
		db.insert(knowledgeDrafts)
			.values({
				id: "tie-draft",
				entryId: "tie-b",
				authorUserId: READER,
				content: "tiequery",
				contentHash: "fixture",
				createdAt: NOW,
				updatedAt: LATER,
			})
			.run();
		const results = await searchService.searchKnowledge({
			query: "tiequery",
			limit: 2,
			sort: "time",
			principal: { userId: READER, isAdmin: false },
		});
		expect(results.map((row) => row.id)).toEqual(["tie-a", "tie-b"]);
	});

	it("keeps the clearance gate active in time mode", async () => {
		const results = await searchService.searchKnowledge({
			query: "Zephyr",
			sort: "time",
			principal: { userId: STRANGER, isAdmin: false },
		});
		expect(results.map((row) => row.id)).toEqual(["kb-open"]);
	});
});

describe("knowledge search input handling", () => {
	it("returns nothing for a query that sanitizes to empty", async () => {
		expect(await searchKnowledge(READER, "***")).toEqual([]);
	});
});
