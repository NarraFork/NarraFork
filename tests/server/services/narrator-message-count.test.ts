/**
 * `narrators.message_count` used to be a turn counter dressed up as a message
 * counter: `updateStats` ran once per finished agent loop and did `+1`, so a
 * conversation with hundreds of stored messages displayed a single-digit number.
 *
 * These tests pin the corrected contract: the count comes from
 * `narrator_message_refs`, and the "is this the first turn" question that used to
 * piggyback on the old semantics is answered from user messages instead.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
} from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));

// narrator-service must be imported before narrator-persistence: the two form a
// pre-existing import cycle, and pulling in the persistence module first leaves
// narrator-service evaluating against an uninitialized binding.
const { narratorService } = await import("../../../server/services/narrator-service");
const { countNarratorMessageRefs, countNarratorMessageRefsBatch, isFirstUserTurn } = await import(
	"../../../server/services/narrator-message-count"
);

const BASE_TIME = new Date("2025-01-01T00:00:00.000Z").getTime();
let tsOffset = 0;
const ts = () => new Date(BASE_TIME + tsOffset++ * 1000).toISOString();

function seed(narratorId = "n1") {
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

/** Append one message plus its ref, mirroring how a real turn accumulates rows. */
function addMessage(id: string, seq: number, role: "user" | "assistant" | "sys" = "assistant") {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId: "n1",
			role,
			contentJson: [{ type: "text", text: id }],
			contentText: id,
			createdAt: ts(),
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId: "n1", messageId: id, seq })
		.run();
}

/** A second narrator in the same chapter, optionally a subagent of n1. */
function seedExtraNarrator(
	id: string,
	opts: { type?: "primary" | "subagent"; parentNarratorId?: string } = {},
) {
	db.insert(narrators)
		.values({
			id,
			chapterId: "ch1",
			type: opts.type ?? "primary",
			parentNarratorId: opts.parentNarratorId ?? null,
			inheritMode: "fresh",
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
}

/** Append a message + ref for an arbitrary narrator. */
function addMessageFor(narratorId: string, id: string, seq: number) {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId,
			role: "assistant",
			contentJson: [{ type: "text", text: id }],
			contentText: id,
			createdAt: ts(),
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId, messageId: id, seq })
		.run();
}

/** A turn: one user message followed by several assistant messages. */
function addTurn(index: number, assistantMessages: number) {
	const base = index * 100;
	addMessage(`u${index}`, base, "user");
	for (let i = 0; i < assistantMessages; i++) {
		addMessage(`a${index}-${i}`, base + 1 + i, "assistant");
	}
}

const storedCount = async () =>
	(
		await db.query.narrators.findFirst({
			where: (n, { eq }) => eq(n.id, "n1"),
			columns: { messageCount: true },
		})
	)?.messageCount;

beforeEach(() => {
	tsOffset = 0;
	seed();
});
afterEach(() => cleanDb(sqlite));
afterAll(() => mock.module("../../../server/db", () => realDbModule));

describe("countNarratorMessageRefs", () => {
	it("counts every message ref, not turns", async () => {
		addTurn(1, 9);
		addTurn(2, 14);
		expect(await countNarratorMessageRefs("n1")).toBe(25);
	});

	it("returns 0 for a narrator with no messages", async () => {
		expect(await countNarratorMessageRefs("n1")).toBe(0);
	});

	it("ignores refs belonging to other narrators", async () => {
		addTurn(1, 2);
		seedExtraNarrator("n2");
		addMessageFor("n2", "other", 0);

		expect(await countNarratorMessageRefs("n1")).toBe(3);
	});
});

describe("stored message_count column", () => {
	it("advances per persisted message, not per finished turn", async () => {
		await narratorService.persistUserMessage("n1", "first");
		expect(await storedCount()).toBe(1);

		await narratorService.persistUserMessage("n1", "second");
		await narratorService.persistUserMessage("n1", "third");
		expect(await storedCount()).toBe(3);
	});

	it("is not touched by updateStats — that is what made it a turn counter", async () => {
		await narratorService.persistUserMessage("n1", "hello");
		const before = await storedCount();
		await narratorService.updateStats("n1", 0);
		await narratorService.updateStats("n1", 0);
		expect(await storedCount()).toBe(before);
	});

	it("still lets updateStats accumulate cost", async () => {
		await narratorService.updateStats("n1", 0.5);
		await narratorService.updateStats("n1", 0.25);
		const row = await db.query.narrators.findFirst({
			where: (n, { eq }) => eq(n.id, "n1"),
			columns: { totalCostUsd: true },
		});
		expect(row?.totalCostUsd).toBeCloseTo(0.75, 6);
	});

	it("is an upper bound after deletion, while the counted value stays exact", async () => {
		await narratorService.persistUserMessage("n1", "a");
		await narratorService.persistUserMessage("n1", "b");
		await narratorService.persistUserMessage("n1", "c");
		expect(await storedCount()).toBe(3);

		// Stand in for any of the ~30 ref-removing call sites (rollback, compact, …).
		const [victim] = await db
			.select({ id: narratorMessageRefs.id })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, "n1"))
			.limit(1);
		db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.id, victim.id)).run();

		// The column keeps its high-water mark; no display path reads it.
		expect(await storedCount()).toBe(3);
		expect(await countNarratorMessageRefs("n1")).toBe(2);
	});
});

describe("countNarratorMessageRefsBatch", () => {
	it("counts each narrator on the page independently", async () => {
		addTurn(1, 4);
		seedExtraNarrator("n2");
		addMessageFor("n2", "n2-a", 0);
		addMessageFor("n2", "n2-b", 1);

		const counts = await countNarratorMessageRefsBatch(["n1", "n2"]);
		expect(counts.get("n1")).toBe(5);
		expect(counts.get("n2")).toBe(2);
	});

	it("omits narrators with no messages instead of reporting a wrong number", async () => {
		seedExtraNarrator("n2");
		addTurn(1, 1);

		const counts = await countNarratorMessageRefsBatch(["n1", "n2"]);
		expect(counts.get("n1")).toBe(2);
		expect(counts.has("n2")).toBe(false);
	});

	it("returns an empty map for an empty page without querying", async () => {
		expect((await countNarratorMessageRefsBatch([])).size).toBe(0);
	});

	// Subagents never ran updateStats, so under the old turn-counting scheme they
	// were stuck at 0 no matter how much work they did. Counting refs is
	// type-agnostic, which is the point.
	it("counts subagent messages the same as a primary narrator's", async () => {
		seedExtraNarrator("sub1", { type: "subagent", parentNarratorId: "n1" });
		addMessageFor("sub1", "s-a", 0);
		addMessageFor("sub1", "s-b", 1);
		addMessageFor("sub1", "s-c", 2);

		expect(await countNarratorMessageRefs("sub1")).toBe(3);
		expect((await countNarratorMessageRefsBatch(["sub1"])).get("sub1")).toBe(3);
	});
});

describe("isFirstUserTurn", () => {
	it("is true mid-first-turn even after many assistant messages", async () => {
		addTurn(1, 30);
		expect(await isFirstUserTurn("n1")).toBe(true);
	});

	it("is true for a narrator that has no messages yet", async () => {
		expect(await isFirstUserTurn("n1")).toBe(true);
	});

	it("becomes false once a second user message exists", async () => {
		addTurn(1, 3);
		addTurn(2, 1);
		expect(await isFirstUserTurn("n1")).toBe(false);
	});

	it("does not count injected sys messages as user turns", async () => {
		addMessage("u1", 0, "user");
		addMessage("s1", 1, "sys");
		addMessage("s2", 2, "sys");
		expect(await isFirstUserTurn("n1")).toBe(true);
	});

	/** Share n1's messages with `forkId` via refs, mirroring a fork's copied prefix. */
	function inheritPrefixInto(forkId: string, seqs: number[]) {
		const parentRefs = db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, "n1"))
			.all();
		for (const [i, ref] of parentRefs.entries()) {
			db.insert(narratorMessageRefs)
				.values({
					id: `ref-${forkId}-${i}`,
					narratorId: forkId,
					messageId: ref.messageId,
					seq: seqs[i] ?? ref.seq,
				})
				.run();
		}
	}

	it("treats a fork's first own user message as the first turn", async () => {
		// Parent has a long history with several user turns.
		addTurn(1, 3);
		addTurn(2, 2);
		expect(await isFirstUserTurn("n1")).toBe(false);

		// Full fork: refs are shared, message rows still belong to the parent.
		seedExtraNarrator("fork1");
		inheritPrefixInto("fork1", []);
		expect(await isFirstUserTurn("fork1")).toBe(true);

		// The fork's own first user message keeps it on the first turn…
		db.insert(narratorMessages)
			.values({
				id: "fork-u1",
				narratorId: "fork1",
				role: "user",
				contentJson: [{ type: "text", text: "fork-u1" }],
				contentText: "fork-u1",
				createdAt: ts(),
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "ref-fork-u1", narratorId: "fork1", messageId: "fork-u1", seq: 1000 })
			.run();
		expect(await isFirstUserTurn("fork1")).toBe(true);

		// …and the second one ends it.
		db.insert(narratorMessages)
			.values({
				id: "fork-u2",
				narratorId: "fork1",
				role: "user",
				contentJson: [{ type: "text", text: "fork-u2" }],
				contentText: "fork-u2",
				createdAt: ts(),
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "ref-fork-u2", narratorId: "fork1", messageId: "fork-u2", seq: 1001 })
			.run();
		expect(await isFirstUserTurn("fork1")).toBe(false);
	});
});
