import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
	chatMessages,
	chatRooms,
	narratorPublicShares,
	narrators,
	users,
} from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

// Replays the real generated migrations in memory, never the running instance's DB.
const { db, sqlite } = getTestDb();
const now = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
	cleanDb(sqlite);
	db.insert(users)
		.values({ id: "owner", username: "owner", passwordHash: "x", createdAt: now })
		.run();
	db.insert(narrators)
		.values({
			id: "session",
			title: "Private",
			ownerUserId: "owner",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(chatRooms)
		.values({ id: "room", kind: "narrator", narratorId: "session", createdAt: now })
		.run();
	db.insert(narratorPublicShares)
		.values([
			{
				id: "a",
				narratorId: "session",
				tokenHash: "hash-a",
				guestName: "Guest A",
				createdByUserId: "owner",
				createdAt: now,
			},
			{
				id: "b",
				narratorId: "session",
				tokenHash: "hash-b",
				guestName: "Guest B",
				createdByUserId: "owner",
				createdAt: now,
			},
		])
		.run();
	db.insert(chatMessages)
		.values({
			id: "message",
			roomId: "room",
			seq: 1,
			senderShareId: "a",
			senderGuestName: "Guest A",
			contentText: "Discussion only",
			createdAt: now,
		})
		.run();
});
afterAll(() => sqlite.close());

describe("generated public share schema", () => {
	test("the generated FK rebuild preserves existing message bodies and references", () => {
		const before = db.select().from(chatMessages).all();
		const migration = readFileSync(
			new URL("../../../drizzle/0163_spooky_mad_thinker.sql", import.meta.url),
			"utf8",
		);
		for (const statement of migration.split("--> statement-breakpoint")) {
			if (statement.trim()) sqlite.run(statement);
		}
		expect(db.select().from(chatMessages).all()).toEqual(before);
		expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	test("allows multiple links for one session but never duplicate credentials", () => {
		expect(db.select().from(narratorPublicShares).all()).toHaveLength(2);
		expect(() =>
			db
				.insert(narratorPublicShares)
				.values({
					id: "c",
					narratorId: "session",
					tokenHash: "hash-a",
					guestName: "Other",
					createdAt: now,
				})
				.run(),
		).toThrow();
	});

	test("revocation preserves other links and the guest attribution", () => {
		db.update(narratorPublicShares)
			.set({ revokedAt: now })
			.where(eq(narratorPublicShares.id, "a"))
			.run();
		expect(
			db.select().from(narratorPublicShares).where(eq(narratorPublicShares.id, "b")).get()
				?.revokedAt,
		).toBeNull();
		expect(db.select().from(chatMessages).get()?.senderGuestName).toBe("Guest A");
		expect(db.select().from(narrators).get()?.visibility).toBe("private");
	});

	test("removing a link cannot erase or strand historical guest messages", () => {
		db.delete(narratorPublicShares).where(eq(narratorPublicShares.id, "a")).run();
		const message = db.select().from(chatMessages).get();
		expect(message?.senderShareId).toBeNull();
		expect(message?.senderGuestName).toBe("Guest A");
		expect(message?.contentText).toBe("Discussion only");
	});

	test("existing user messages retain their nullable guest defaults", () => {
		db.insert(chatMessages)
			.values({
				id: "internal",
				roomId: "room",
				seq: 2,
				senderUserId: "owner",
				contentText: "Internal reply",
				createdAt: now,
			})
			.run();
		const message = db.select().from(chatMessages).where(eq(chatMessages.id, "internal")).get();
		expect(message?.senderGuestName).toBeNull();
		expect(message?.senderShareId).toBeNull();
		expect(message?.replyToGuestName).toBeNull();
	});
});
