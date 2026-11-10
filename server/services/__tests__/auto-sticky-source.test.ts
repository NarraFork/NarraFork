import { beforeEach, describe, expect, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessageRefs, narratorMessages } from "../../db/schema";
import { lastServedProvider } from "../auto-sticky-source";

const { db, sqlite } = getTestDb();
const now = "2026-11-06T10:00:00.000Z";

function seedNarrator(id: string) {
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run(id, now, now);
}

function seed(
	narratorId: string,
	id: string,
	seq: number,
	role: "user" | "assistant" | "system",
	provider: string | null,
	options: { isCompact?: boolean; owner?: string } = {},
) {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId: options.owner ?? narratorId,
			role,
			contentJson: [{ type: "text", text: id }],
			provider,
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: `ref-${narratorId}-${id}`,
			narratorId,
			messageId: id,
			seq,
			isCompact: options.isCompact ? 1 : 0,
		})
		.run();
}

beforeEach(() => {
	cleanDb(sqlite);
	seedNarrator("n1");
	seedNarrator("fork");
});

describe("auto sticky source", () => {
	test("the provider of the latest reply, not of the user turn after it", () => {
		seed("n1", "u1", 1, "user", null);
		seed("n1", "a1", 2, "assistant", "codex");
		seed("n1", "a2", 3, "assistant", "relay");
		seed("n1", "u2", 4, "user", null);
		expect(lastServedProvider("n1", db)).toBe("relay");
	});

	test("nothing to keep before the first reply or right after a compact", () => {
		expect(lastServedProvider("n1", db)).toBeUndefined();
		seed("n1", "a1", 1, "assistant", "codex");
		seed("n1", "c1", 2, "system", null, { isCompact: true });
		expect(lastServedProvider("n1", db)).toBeUndefined();
		seed("n1", "a2", 3, "assistant", "relay");
		expect(lastServedProvider("n1", db)).toBe("relay");
	});

	test("a fork does not inherit the source of the shared prefix", () => {
		seed("n1", "a1", 1, "assistant", "codex");
		// The fork's refs point at n1's message; the fork itself has not replied yet.
		db.insert(narratorMessageRefs)
			.values({ id: "ref-fork-a1", narratorId: "fork", messageId: "a1", seq: 1, isCompact: 0 })
			.run();
		expect(lastServedProvider("fork", db)).toBeUndefined();
	});
});
