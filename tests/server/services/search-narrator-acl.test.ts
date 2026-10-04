/**
 * Narrator-visibility gate on message and narrator search results.
 *
 * The chapter gate has its own regression (`search-narrator-acl`'s sibling,
 * `search-chapter-acl.test.ts`) and knowledge has `search-knowledge.test.ts`, but the
 * narrator gate — the one that decides whether a stranger can read a private session's
 * TITLE and a snippet of its TRANSCRIPT — had no test of its own. That gap became load-bearing
 * when the gate moved from prepared statements inside `search-service.ts` into the search
 * backend: the move is only safe if something fails when the gate is dropped, and nothing did.
 *
 * Search is the worst place for such a gap. A hit exposes the content without the resource
 * ever being opened, so nothing 404s and nobody notices.
 *
 * Both query paths are covered because they are separate statements: three characters or more
 * use the FTS index, shorter queries fall back to a substring scan. A gate on only one of them
 * is one short query away from leaking.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	aclGrants,
	chapters,
	narratorMessages,
	narrators,
	projects,
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

const NOW = "2026-07-19T00:00:00.000Z";
const OWNER = "narr-owner";
const STRANGER = "narr-stranger";
const MEMBER = "narr-member";

function seedNarrator(
	id: string,
	title: string,
	visibility: "private" | "public" | "project",
	ownerUserId: string | null = OWNER,
) {
	db.insert(narrators)
		.values({
			id,
			chapterId: "chap-1",
			type: "primary",
			inheritMode: "fresh",
			title,
			visibility,
			ownerUserId,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedMessage(id: string, narratorId: string, text: string) {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId,
			role: "assistant",
			contentJson: [{ type: "text", text }],
			contentText: text,
			createdAt: NOW,
		})
		.run();
}

function grantNarratorRead(narratorId: string, userId: string) {
	db.insert(aclGrants)
		.values({
			id: `grant-${narratorId}-${userId}`,
			scopeType: "narrator",
			scopeId: narratorId,
			principalType: "user",
			principalId: userId,
			capability: "read",
			createdAt: NOW,
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

async function search(
	userId: string,
	query: string,
	entity: "messages" | "narrators",
	isAdmin = false,
) {
	return (
		await searchService.search({ query, entities: [entity], principal: { userId, isAdmin } })
	).map((r) => r.id);
}

beforeEach(() => {
	for (const id of [OWNER, STRANGER, MEMBER]) {
		db.insert(users)
			.values({ id, username: id, passwordHash: "x", role: "user", createdAt: NOW })
			.run();
	}
	db.insert(projects)
		.values({
			id: "proj-1",
			name: "Proj",
			gitPath: "/tmp/proj-1",
			ownerUserId: OWNER,
			visibility: "private",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(chapters)
		.values({
			id: "chap-1",
			projectId: "proj-1",
			title: "Chapter",
			branch: "chapter/chap-1",
			baseBranch: "main",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();

	// Long titles/bodies for the FTS path, plus a 2-character needle for the fallback.
	seedNarrator("narr-private", "Zephyr private session Qx", "private");
	seedNarrator("narr-public", "Zephyr public session Qx", "public");
	seedMessage("msg-private", "narr-private", "Zephyr confidential transcript Qx");
	seedMessage("msg-public", "narr-public", "Zephyr shared transcript Qx");
});

afterEach(() => {
	sqlite.run("PRAGMA foreign_keys = OFF");
	for (const table of [
		"acl_grants",
		"narrator_messages",
		"narrators",
		"chapters",
		"projects",
		"users",
	]) {
		sqlite.run(`DELETE FROM "${table}"`);
	}
	sqlite.run("PRAGMA foreign_keys = ON");
});

describe("message search narrator gate (index path)", () => {
	it("hides a private session's transcript from a stranger", async () => {
		expect(await search(STRANGER, "Zephyr", "messages")).toEqual(["msg-public"]);
	});

	it("shows it to the session owner", async () => {
		expect((await search(OWNER, "Zephyr", "messages")).sort()).toEqual([
			"msg-private",
			"msg-public",
		]);
	});

	it("shows it to a user granted read on both the session and its project", async () => {
		grantNarratorRead("narr-private", MEMBER);
		grantProjectRead("proj-1", MEMBER);
		expect((await search(MEMBER, "Zephyr", "messages")).sort()).toEqual([
			"msg-private",
			"msg-public",
		]);
	});

	/**
	 * The narrator grant branch sits INSIDE the project gate, so a session grant alone does
	 * not open a session that lives in a project the user cannot read. Pinned because the
	 * intuitive reading ("I was granted the session, so I can read it") is the wrong one, and
	 * a refactor that flattened the two branches into an OR would widen visibility while
	 * looking like a simplification.
	 */
	it("does not open a private project's session on a narrator grant alone", async () => {
		grantNarratorRead("narr-private", MEMBER);
		expect(await search(MEMBER, "Zephyr", "messages")).toEqual(["msg-public"]);
	});

	it("shows everything to an admin", async () => {
		expect((await search("an-admin", "Zephyr", "messages", true)).sort()).toEqual([
			"msg-private",
			"msg-public",
		]);
	});

	it("leaks nothing through a body-only term either", async () => {
		expect(await search(STRANGER, "confidential", "messages")).toEqual([]);
	});
});

describe("message search narrator gate (substring path)", () => {
	// Under three characters the trigram tokenizer cannot match, so a different statement
	// runs and needs its own gate.
	it("hides a private session's transcript from a stranger", async () => {
		expect(await search(STRANGER, "Qx", "messages")).toEqual(["msg-public"]);
	});

	it("shows it to the session owner", async () => {
		expect((await search(OWNER, "Qx", "messages")).sort()).toEqual(["msg-private", "msg-public"]);
	});
});

describe("narrator search gate (index path)", () => {
	it("hides a private session's title from a stranger", async () => {
		expect(await search(STRANGER, "Zephyr", "narrators")).toEqual(["narr-public"]);
	});

	it("shows it to the session owner", async () => {
		expect((await search(OWNER, "Zephyr", "narrators")).sort()).toEqual([
			"narr-private",
			"narr-public",
		]);
	});

	it("shows it to a user granted read on both the session and its project", async () => {
		grantNarratorRead("narr-private", MEMBER);
		grantProjectRead("proj-1", MEMBER);
		expect((await search(MEMBER, "Zephyr", "narrators")).sort()).toEqual([
			"narr-private",
			"narr-public",
		]);
	});

	it("does not open a private project's session on a narrator grant alone", async () => {
		grantNarratorRead("narr-private", MEMBER);
		expect(await search(MEMBER, "Zephyr", "narrators")).toEqual(["narr-public"]);
	});
});

describe("narrator search gate (substring path)", () => {
	it("hides a private session's title from a stranger", async () => {
		expect(await search(STRANGER, "Qx", "narrators")).toEqual(["narr-public"]);
	});

	it("shows it to the session owner", async () => {
		expect((await search(OWNER, "Qx", "narrators")).sort()).toEqual([
			"narr-private",
			"narr-public",
		]);
	});
});

/**
 * A knowledge clearance row shares `acl_grants` with capability rows and carries
 * `capability = 'read'` purely as an index placeholder. If the gate stopped filtering on
 * `domain_kind is null`, holding one low clearance would turn into "can read every private
 * session" — the escalation the two row shapes exist to avoid.
 */
describe("clearance rows are not narrator access", () => {
	beforeEach(() => {
		db.insert(aclGrants)
			.values({
				id: "clearance-narr-private-member",
				scopeType: "narrator",
				scopeId: "narr-private",
				principalType: "user",
				principalId: MEMBER,
				capability: "read",
				domainKind: "clearance",
				domainValue: "internal",
				createdAt: NOW,
			})
			.run();
	});

	it("does not expose the transcript", async () => {
		expect(await search(MEMBER, "Zephyr", "messages")).toEqual(["msg-public"]);
	});

	it("does not expose the title", async () => {
		expect(await search(MEMBER, "Zephyr", "narrators")).toEqual(["narr-public"]);
	});
});
