/**
 * Project gate on chapter search results.
 *
 * This was a real leak: narrator and message hits were filtered by visibility, but
 * the chapter branch queried every chapter unconditionally, so any signed-in user
 * could enumerate the titles, description snippets and project names of chapters
 * inside projects they cannot open. Search is the worst place for such a gap —
 * a hit exposes the content without the resource ever being opened, so nothing
 * 404s and nobody notices.
 *
 * Both query paths are covered because they are separate prepared statements:
 * queries of three characters or more use FTS5, shorter ones fall back to LIKE.
 * The FTS variant is the one that regressed, but a gate on only one of them is
 * merely a longer search query away from leaking again.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { aclGrants, chapters, projects, users } from "../../../server/db/schema";
import { getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
mock.module("../../../server/db", () => ({ db, sqlite }));

const { createSqliteSearchStore } = await import("../../../server/services/search/sqlite-store");
const searchStore = createSqliteSearchStore(async (sql, params) =>
	sqlite.prepare<Record<string, unknown>, Array<string | number | null>>(sql).all(...params),
);
mock.module("../../../server/services/search/backend", () => ({ searchStore }));

// The FTS virtual table + sync triggers are created at runtime rather than by a
// migration, so mirror production init before exercising the FTS path.
const { ensureFts } = await import("../../../server/db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });

const { searchService } = await import("../../../server/services/search-service");

const NOW = "2026-07-19T00:00:00.000Z";
const OWNER = "search-owner";
const STRANGER = "search-stranger";
const MEMBER = "search-member";

function seedProject(id: string, visibility: "private" | "public") {
	db.insert(projects)
		.values({
			id,
			name: `Project ${id}`,
			gitPath: `/tmp/${id}`,
			ownerUserId: OWNER,
			visibility,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedChapter(id: string, projectId: string, title: string) {
	db.insert(chapters)
		.values({
			id,
			projectId,
			title,
			description: `${title} description`,
			branch: `chapter/${id}`,
			baseBranch: "main",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function grantProjectRead(projectId: string, userId: string) {
	db.insert(aclGrants)
		.values({
			id: `grant-${projectId}-${userId}`,
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: userId,
			capability: "read",
			createdAt: NOW,
		})
		.run();
}

/**
 * A knowledge clearance row, which shares `acl_grants` with capability rows and
 * carries `capability = 'read'` purely as an index placeholder. If the gate ever
 * stopped filtering on `domain_kind is null`, holding one low clearance would turn
 * into "can read every project" — the escalation the two row shapes exist to avoid.
 */
function grantClearance(projectId: string, userId: string) {
	db.insert(aclGrants)
		.values({
			id: `clearance-${projectId}-${userId}`,
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: userId,
			capability: "read",
			domainKind: "clearance",
			domainValue: "internal",
			createdAt: NOW,
		})
		.run();
}

async function search(userId: string, query: string, isAdmin = false) {
	return searchService.search({
		query,
		entities: ["chapters"],
		principal: { userId, isAdmin },
	});
}

beforeEach(() => {
	for (const id of [OWNER, STRANGER, MEMBER]) {
		db.insert(users)
			.values({ id, username: id, passwordHash: "x", role: "user", createdAt: NOW })
			.run();
	}
	seedProject("proj-private", "private");
	seedProject("proj-public", "public");
	seedChapter("chap-private", "proj-private", "Zephyr secret refactor");
	seedChapter("chap-public", "proj-public", "Zephyr open refactor");
});

afterEach(() => {
	// Only the base tables: the FTS shadow tables sync through triggers and must
	// never be DELETEd directly.
	sqlite.run("PRAGMA foreign_keys = OFF");
	for (const table of ["acl_grants", "chapters", "projects", "users"]) {
		sqlite.run(`DELETE FROM "${table}"`);
	}
	sqlite.run("PRAGMA foreign_keys = ON");
});

describe("chapter search project gate (FTS path)", () => {
	it("hides chapters of a private project from a stranger", async () => {
		const ids = (await search(STRANGER, "Zephyr")).map((r) => r.id);
		expect(ids).toEqual(["chap-public"]);
	});

	it("shows them to the project owner", async () => {
		const ids = (await search(OWNER, "Zephyr")).map((r) => r.id);
		expect(ids.sort()).toEqual(["chap-private", "chap-public"]);
	});

	it("shows them to a user holding a project read grant", async () => {
		grantProjectRead("proj-private", MEMBER);
		const ids = (await search(MEMBER, "Zephyr")).map((r) => r.id);
		expect(ids.sort()).toEqual(["chap-private", "chap-public"]);
	});

	it("does not treat a knowledge clearance row as project access", async () => {
		grantClearance("proj-private", MEMBER);
		const ids = (await search(MEMBER, "Zephyr")).map((r) => r.id);
		expect(ids).toEqual(["chap-public"]);
	});

	it("shows everything to an admin", async () => {
		const ids = (await search("some-admin", "Zephyr", true)).map((r) => r.id);
		expect(ids.sort()).toEqual(["chap-private", "chap-public"]);
	});

	it("leaks nothing through the description snippet either", async () => {
		const results = await search(STRANGER, "secret");
		expect(results).toEqual([]);
	});
});

describe("chapter search project gate (LIKE fallback path)", () => {
	// Under three characters the FTS trigram tokenizer cannot match, so the service
	// switches to a different prepared statement that needs its own gate.
	beforeEach(() => {
		seedChapter("chap-private-short", "proj-private", "Qx private");
		seedChapter("chap-public-short", "proj-public", "Qx public");
	});

	it("hides chapters of a private project from a stranger", async () => {
		const ids = (await search(STRANGER, "Qx")).map((r) => r.id);
		expect(ids).toEqual(["chap-public-short"]);
	});

	it("shows them to the project owner", async () => {
		const ids = (await search(OWNER, "Qx")).map((r) => r.id);
		expect(ids.sort()).toEqual(["chap-private-short", "chap-public-short"]);
	});

	it("does not treat a knowledge clearance row as project access", async () => {
		grantClearance("proj-private", MEMBER);
		const ids = (await search(MEMBER, "Qx")).map((r) => r.id);
		expect(ids).toEqual(["chap-public-short"]);
	});
});
