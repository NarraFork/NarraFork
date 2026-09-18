/**
 * The Recall tool's message search, end to end through the search port.
 *
 * Recall had no test of its own before this: its FTS statements were a second copy of the
 * ones in `search-service.ts`, and nothing exercised them. Moving them behind the port made
 * that gap load-bearing — three properties of Recall are behaviour a model reads and would
 * not fail loudly if they changed:
 *
 *   - SCOPE. Self-scoped search must resolve through the narrator's own refs, so a fork still
 *     finds the history it inherited. `all_narrators` resolves through each message's owning
 *     narrator instead, which reports a shared message once, against its origin.
 *   - TIME FILTERING. `from`/`to` narrow by `created_at`; a bug here silently returns more
 *     than asked for.
 *   - SNIPPET MARKUP. `>>>`/`<<<` is how the model sees which part matched.
 *
 * Recall is deliberately NOT viewer-gated — its authorization happens in the tool's permission
 * flow, before execution — so this file asserts scope, not ACL. That distinction is the reason
 * `all_narrators` requires approval in the first place.
 */
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

const { ensureFts } = await import("../../../server/db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });

const { recallTool } = await import("../../../server/lib/agent/tools/recall");

const EARLY = "2026-07-01T00:00:00.000Z";
const LATE = "2026-07-20T00:00:00.000Z";

function seedNarrator(id: string, title: string) {
	db.insert(narrators)
		.values({
			id,
			chapterId: "chap-recall",
			type: "primary",
			inheritMode: "fresh",
			title,
			createdAt: EARLY,
			updatedAt: EARLY,
		})
		.run();
}

/** A message OWNED by `ownerId`, with a ref on each narrator in `refFor`. */
function seedMessage(params: {
	id: string;
	ownerId: string;
	refFor: string[];
	text: string;
	createdAt: string;
	seq?: number;
}) {
	db.insert(narratorMessages)
		.values({
			id: params.id,
			narratorId: params.ownerId,
			role: "assistant",
			contentJson: [{ type: "text", text: params.text }],
			contentText: params.text,
			createdAt: params.createdAt,
		})
		.run();
	for (const narratorId of params.refFor) {
		db.insert(narratorMessageRefs)
			.values({
				id: `ref-${narratorId}-${params.id}`,
				narratorId,
				messageId: params.id,
				seq: params.seq ?? 1,
			})
			.run();
	}
}

/** Run the tool the way the agent loop does, and return the structured hit ids. */
async function recallSearch(
	narratorId: string,
	args: Record<string, unknown>,
): Promise<{ ids: string[]; snippets: string[]; isError: boolean }> {
	const result = await recallTool.execute(
		{ action: "search", ...args },
		// The loop supplies far more context; the search path reads only `narratorId`.
		{ narratorId } as never,
	);
	const meta = result.metadata as { results?: Array<{ id: string; snippet: string }> } | undefined;
	return {
		ids: (meta?.results ?? []).map((r) => r.id),
		snippets: (meta?.results ?? []).map((r) => r.snippet),
		isError: result.isError === true,
	};
}

beforeEach(() => {
	db.insert(projects)
		.values({
			id: "proj-recall",
			name: "Recall",
			gitPath: "/tmp/proj-recall",
			createdAt: EARLY,
			updatedAt: EARLY,
		})
		.run();
	db.insert(chapters)
		.values({
			id: "chap-recall",
			projectId: "proj-recall",
			title: "Chapter",
			branch: "chapter/chap-recall",
			baseBranch: "main",
			createdAt: EARLY,
			updatedAt: EARLY,
		})
		.run();
	seedNarrator("narr-self", "Self");
	seedNarrator("narr-other", "Other");
});

afterEach(() => {
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

describe("Recall search scope", () => {
	beforeEach(() => {
		seedMessage({
			id: "msg-mine",
			ownerId: "narr-self",
			refFor: ["narr-self"],
			text: "pomegranate in my own history",
			createdAt: EARLY,
		});
		seedMessage({
			id: "msg-theirs",
			ownerId: "narr-other",
			refFor: ["narr-other"],
			text: "pomegranate in another session",
			createdAt: EARLY,
		});
	});

	it("returns only this narrator's messages by default", async () => {
		const { ids } = await recallSearch("narr-self", { query: "pomegranate" });
		expect(ids).toEqual(["msg-mine"]);
	});

	it("returns every narrator's messages when all_narrators is set", async () => {
		const { ids } = await recallSearch("narr-self", {
			query: "pomegranate",
			all_narrators: true,
		});
		expect(ids.sort()).toEqual(["msg-mine", "msg-theirs"]);
	});

	/**
	 * A fork-shared message has a ref on both narrators but one owner.
	 *
	 * Scoped search must find it through the ref (otherwise a fork appears to have lost the
	 * history it inherited), while global search must report it ONCE, against its owner — the
	 * ref join would otherwise return the same message per narrator that shares it.
	 */
	it("finds inherited history when scoped, and reports it once when global", async () => {
		seedMessage({
			id: "msg-shared",
			ownerId: "narr-other",
			refFor: ["narr-other", "narr-self"],
			text: "quince shared across a fork",
			createdAt: EARLY,
			seq: 2,
		});

		const scoped = await recallSearch("narr-self", { query: "quince" });
		expect(scoped.ids).toEqual(["msg-shared"]);

		const global = await recallSearch("narr-self", { query: "quince", all_narrators: true });
		expect(global.ids).toEqual(["msg-shared"]);
	});
});

describe("Recall time filtering", () => {
	beforeEach(() => {
		seedMessage({
			id: "msg-early",
			ownerId: "narr-self",
			refFor: ["narr-self"],
			text: "rambutan early note",
			createdAt: EARLY,
			seq: 1,
		});
		seedMessage({
			id: "msg-late",
			ownerId: "narr-self",
			refFor: ["narr-self"],
			text: "rambutan late note",
			createdAt: LATE,
			seq: 2,
		});
	});

	it("honours an absolute lower bound", async () => {
		const { ids } = await recallSearch("narr-self", {
			query: "rambutan",
			from: "2026-07-10",
		});
		expect(ids).toEqual(["msg-late"]);
	});

	it("honours an absolute upper bound", async () => {
		const { ids } = await recallSearch("narr-self", { query: "rambutan", to: "2026-07-10" });
		expect(ids).toEqual(["msg-early"]);
	});

	it("honours both bounds together", async () => {
		const { ids } = await recallSearch("narr-self", {
			query: "rambutan",
			from: "2026-06-01",
			to: "2026-07-10",
		});
		expect(ids).toEqual(["msg-early"]);
	});

	it("rejects an unparseable bound rather than searching unbounded", async () => {
		const { isError } = await recallSearch("narr-self", {
			query: "rambutan",
			from: "not-a-date",
		});
		expect(isError).toBe(true);
	});
});

describe("Recall result presentation", () => {
	beforeEach(() => {
		seedMessage({
			id: "msg-mark",
			ownerId: "narr-self",
			refFor: ["narr-self"],
			text: "starfruit appears in this transcript line",
			createdAt: EARLY,
		});
	});

	it("marks the matched term so the model can see it", async () => {
		const { snippets } = await recallSearch("narr-self", { query: "starfruit" });
		expect(snippets).toHaveLength(1);
		expect(snippets[0]).toContain(">>>starfruit<<<");
	});

	// Two characters cannot form a trigram token, so this exercises the substring path, whose
	// excerpt is leading body text rather than a marked snippet.
	it("still finds a short query through the substring path", async () => {
		seedMessage({
			id: "msg-short",
			ownerId: "narr-self",
			refFor: ["narr-self"],
			text: "an XY marker",
			createdAt: EARLY,
			seq: 2,
		});
		const { ids } = await recallSearch("narr-self", { query: "XY" });
		expect(ids).toEqual(["msg-short"]);
	});

	it("reports an empty result for a query that sanitizes away", async () => {
		const { ids, isError } = await recallSearch("narr-self", { query: "***" });
		expect(ids).toEqual([]);
		expect(isError).toBe(true);
	});
});
