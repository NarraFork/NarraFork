import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
} from "../../../server/db/schema";
import { getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
mock.module("../../../server/db", () => ({ db, sqlite }));

// The FTS virtual table + sync triggers are created at runtime (not via
// migrations), so mirror production init here before exercising the FTS path.
const { ensureFts } = await import("../../../server/db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });

const { searchService } = await import("../../../server/services/search-service");

let tsCounter = 0;
function ts() {
	return new Date(Date.UTC(2025, 0, 1) + tsCounter++ * 1000).toISOString();
}

function seedNarrator(narratorId: string) {
	db.insert(narrators)
		.values({
			id: narratorId,
			chapterId: "ch1",
			type: "primary",
			inheritMode: "fresh",
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
}

function insertMessage(params: {
	id: string;
	narratorId: string;
	seq: number;
	role?: "user" | "assistant" | "system";
	contentText: string;
	segmentCompactId?: string | null;
}) {
	db.insert(narratorMessages)
		.values({
			id: params.id,
			narratorId: params.narratorId,
			role: params.role ?? "assistant",
			contentJson: [{ type: "text", text: params.contentText }],
			contentText: params.contentText,
			createdAt: ts(),
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: `ref-${params.narratorId}-${params.id}`,
			narratorId: params.narratorId,
			messageId: params.id,
			seq: params.seq,
			segmentCompactId: params.segmentCompactId ?? null,
		})
		.run();
}

beforeEach(() => {
	tsCounter = 0;
	db.insert(projects)
		.values({ id: "p1", name: "Proj", gitPath: "/tmp/repo", createdAt: ts(), updatedAt: ts() })
		.run();
	db.insert(chapters)
		.values({
			id: "ch1",
			projectId: "p1",
			title: "Chapter 1",
			branch: "chapter/ch1",
			baseBranch: "main",
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
});

afterEach(() => {
	// Clear only the base tables we touch (in FK-safe order). The FTS shadow
	// tables sync automatically via triggers and must not be DELETEd directly.
	sqlite.run("PRAGMA foreign_keys = OFF");
	for (const table of [
		"narrator_message_refs",
		"narrator_messages",
		"narrators",
		"chapters",
		"projects",
	]) {
		sqlite.run(`DELETE FROM "${table}"`);
	}
	sqlite.run("PRAGMA foreign_keys = ON");
});

describe("searchNarratorMessages", () => {
	it("returns only messages on the given narrator's timeline", () => {
		seedNarrator("n1");
		seedNarrator("n2");
		insertMessage({ id: "m1", narratorId: "n1", seq: 1, contentText: "alpha banana result" });
		insertMessage({ id: "m2", narratorId: "n2", seq: 1, contentText: "alpha banana elsewhere" });

		const results = searchService.searchNarratorMessages("n1", "banana");
		expect(results.map((r) => r.messageId)).toEqual(["m1"]);
		expect(results[0].seq).toBe(1);
	});

	it("orders results newest-first by seq and carries the jump seq", () => {
		seedNarrator("n1");
		insertMessage({ id: "m1", narratorId: "n1", seq: 1, contentText: "citrus early hit" });
		insertMessage({ id: "m2", narratorId: "n1", seq: 5, contentText: "citrus later hit" });
		insertMessage({ id: "m3", narratorId: "n1", seq: 3, contentText: "citrus middle hit" });

		const results = searchService.searchNarratorMessages("n1", "citrus");
		expect(results.map((r) => r.seq)).toEqual([5, 3, 1]);
		expect(results.map((r) => r.messageId)).toEqual(["m2", "m3", "m1"]);
	});

	it("excludes segment-compacted (hidden) refs", () => {
		seedNarrator("n1");
		insertMessage({ id: "m1", narratorId: "n1", seq: 1, contentText: "durian visible hit" });
		insertMessage({
			id: "m2",
			narratorId: "n1",
			seq: 2,
			contentText: "durian hidden hit",
			segmentCompactId: "compact-1",
		});

		const results = searchService.searchNarratorMessages("n1", "durian");
		expect(results.map((r) => r.messageId)).toEqual(["m1"]);
	});

	it("supports short (2-char) queries via the LIKE fallback path", () => {
		seedNarrator("n1");
		insertMessage({ id: "m1", narratorId: "n1", seq: 1, contentText: "the QA note" });
		insertMessage({ id: "m2", narratorId: "n1", seq: 2, contentText: "unrelated text" });

		const results = searchService.searchNarratorMessages("n1", "QA");
		expect(results.map((r) => r.messageId)).toEqual(["m1"]);
	});

	it("returns empty for a blank query", () => {
		seedNarrator("n1");
		insertMessage({ id: "m1", narratorId: "n1", seq: 1, contentText: "anything" });
		expect(searchService.searchNarratorMessages("n1", "   ")).toEqual([]);
	});

	it("caps the result count at the hard limit", () => {
		seedNarrator("n1");
		for (let i = 0; i < 10; i++) {
			insertMessage({ id: `m${i}`, narratorId: "n1", seq: i + 1, contentText: `elderberry ${i}` });
		}
		const results = searchService.searchNarratorMessages("n1", "elderberry", 3);
		expect(results.length).toBe(3);
		// Newest-first: seq 10, 9, 8.
		expect(results.map((r) => r.seq)).toEqual([10, 9, 8]);
	});
});

/**
 * A lazily-forked narrator only materializes the refs after its parent's last
 * compact; older history stays in the ancestor (see narrator-refs-backfill). The
 * ancestor must therefore be searchable through the child, but *only* up to the
 * seq the child inherited — anything the ancestor produced after the fork
 * diverged belongs to a different timeline.
 */
describe("searchNarratorMessages across a lazy fork's ancestry", () => {
	it("finds ancestor history the child has not materialized", () => {
		seedNarrator("parent");
		seedNarrator("child");
		insertMessage({
			id: "old",
			narratorId: "parent",
			seq: 1,
			contentText: "kumquat in old history",
		});
		// The child inherited from seq 5 onward; seq 1 lives only in the parent.
		insertMessage({ id: "new", narratorId: "child", seq: 5, contentText: "kumquat recent" });

		const withoutLineage = searchService.searchNarratorMessages("child", "kumquat");
		expect(withoutLineage.map((r) => r.messageId)).toEqual(["new"]);

		const withLineage = searchService.searchNarratorMessages("child", "kumquat", 60, [
			{ narratorId: "parent", upperBoundSeq: 5 },
		]);
		expect(withLineage.map((r) => r.messageId).sort()).toEqual(["new", "old"]);
	});

	it("excludes ancestor messages at or after the inherited bound", () => {
		seedNarrator("parent");
		seedNarrator("child");
		insertMessage({ id: "old", narratorId: "parent", seq: 1, contentText: "lychee before fork" });
		// The parent kept working after the fork: seq 9 is past the child's bound of 5.
		insertMessage({
			id: "divergent",
			narratorId: "parent",
			seq: 9,
			contentText: "lychee after fork",
		});
		insertMessage({ id: "own", narratorId: "child", seq: 5, contentText: "lychee own" });

		const results = searchService.searchNarratorMessages("child", "lychee", 60, [
			{ narratorId: "parent", upperBoundSeq: 5 },
		]);
		const ids = results.map((r) => r.messageId);
		expect(ids).toContain("old");
		expect(ids).toContain("own");
		expect(ids).not.toContain("divergent");
	});

	it("ignores a scope whose seq bound is not a finite number", () => {
		seedNarrator("parent");
		seedNarrator("child");
		insertMessage({ id: "old", narratorId: "parent", seq: 1, contentText: "papaya old" });
		insertMessage({ id: "own", narratorId: "child", seq: 5, contentText: "papaya own" });

		const results = searchService.searchNarratorMessages("child", "papaya", 60, [
			{ narratorId: "parent", upperBoundSeq: Number.POSITIVE_INFINITY },
		]);
		// A non-finite bound is dropped rather than interpolated, so the search can only
		// narrow to the child's own refs — never widen unboundedly.
		expect(results.map((r) => r.messageId)).toEqual(["own"]);
	});
});
