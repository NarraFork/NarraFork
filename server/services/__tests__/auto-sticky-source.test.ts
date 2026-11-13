import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessageRefs, narratorMessages } from "../../db/schema";
import { lastServedProvider } from "../auto-sticky-source";
import type { NarratorMessageRefsPort } from "../narrator-refs/port";
import { bindNarratorMessageRefs } from "../narrator-refs/store";

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

afterEach(() => bindNarratorMessageRefs(undefined));

function bindPgSource(read: NarratorMessageRefsPort["lastServedProvider"]) {
	const unused = async (): Promise<never> => {
		throw new Error("unexpected port operation");
	};
	bindNarratorMessageRefs({
		backend: "postgres",
		port: {
			lastServedProvider: read,
			creator: unused,
			append: unused,
			insertBefore: unused,
			copyRefs: unused,
			page: unused,
		},
	});
}

describe("auto sticky source", () => {
	test("PostgreSQL binding reads affinity without touching the SQLite handle", async () => {
		const read = mock(async () => "nugjp");
		bindPgSource(read);
		const forbiddenSqlite = new Proxy(db, {
			get() {
				throw new Error("SQLite unavailable");
			},
		});
		expect(await lastServedProvider("n1", forbiddenSqlite)).toBe("nugjp");
		expect(read).toHaveBeenCalledWith("n1");
	});

	test("read failures cannot silently clear affinity and route to a recovered provider", async () => {
		bindPgSource(async () => {
			throw new Error("PG read failed");
		});
		await expect(lastServedProvider("n1", db)).rejects.toThrow("PG read failed");
		bindNarratorMessageRefs(undefined);
		const unavailable = new Proxy(db, {
			get() {
				throw new Error("SQLite read failed");
			},
		});
		await expect(lastServedProvider("n1", unavailable)).rejects.toThrow("SQLite read failed");
	});
	test("the provider of the latest reply, not of the user turn after it", async () => {
		seed("n1", "u1", 1, "user", null);
		seed("n1", "a1", 2, "assistant", "codex");
		seed("n1", "a2", 3, "assistant", "relay");
		seed("n1", "u2", 4, "user", null);
		expect(await lastServedProvider("n1", db)).toBe("relay");
	});

	test("nothing to keep before the first reply or right after a compact", async () => {
		expect(await lastServedProvider("n1", db)).toBeUndefined();
		seed("n1", "a1", 1, "assistant", "codex");
		seed("n1", "c1", 2, "system", null, { isCompact: true });
		expect(await lastServedProvider("n1", db)).toBeUndefined();
		seed("n1", "a2", 3, "assistant", "relay");
		expect(await lastServedProvider("n1", db)).toBe("relay");
	});

	test("a fork does not inherit the source of the shared prefix", async () => {
		seed("n1", "a1", 1, "assistant", "codex");
		// The fork's refs point at n1's message; the fork itself has not replied yet.
		db.insert(narratorMessageRefs)
			.values({ id: "ref-fork-a1", narratorId: "fork", messageId: "a1", seq: 1, isCompact: 0 })
			.run();
		expect(await lastServedProvider("fork", db)).toBeUndefined();
	});
});
