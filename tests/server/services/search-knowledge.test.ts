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
	knowledgeEntries,
	knowledgeLevels,
	users,
} from "../../../server/db/schema";
import { getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
mock.module("../../../server/db", () => ({ db, sqlite }));

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

describe("knowledge search input handling", () => {
	it("returns nothing for a query that sanitizes to empty", async () => {
		expect(await searchKnowledge(READER, "***")).toEqual([]);
	});
});
