/**
 * Multi-identity git commit attribution.
 *
 * Two properties carry the feature and are the reason this file exists:
 *   1. the identity tables are per-USER and the picks are per-(user × narrator),
 *      so two people driving one narrator never see or overwrite each other;
 *   2. resolution order is pick → default → nothing, where "nothing" means the
 *      commit inherits the host git config (the original behaviour).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators, userGitIdentities, users } from "../../db/schema";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));

const {
	createUserGitIdentity,
	deleteUserGitIdentity,
	getNarratorGitIdentityPick,
	listUserGitIdentities,
	setNarratorGitIdentityPick,
	updateUserGitIdentity,
} = await import("../git-identities");
const { invalidateGitIdentityCache, resolveGitIdentityForTurn, resolveGitIdentityForUser } =
	await import("../../lib/git-identity");

let alice: string;
let bob: string;
let narratorId: string;

async function makeUser(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${generateId(6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function makeNarrator(): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		title: `git-identity-${generateId(6)}`,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

beforeEach(async () => {
	cleanDb(sqlite);
	// The resolution cache is process-wide, so a leftover entry from the previous
	// case would make these assertions pass or fail for the wrong reason.
	invalidateGitIdentityCache();
	alice = await makeUser("alice");
	bob = await makeUser("bob");
	narratorId = await makeNarrator();
});

afterAll(() => {
	invalidateGitIdentityCache();
	sqlite.close();
});

describe("identity CRUD", () => {
	test("the first identity is the default without being asked", async () => {
		const first = await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		expect(first.isDefault).toBe(true);

		const second = await createUserGitIdentity(alice, { name: "Alice (work)", email: "aw@e.com" });
		expect(second.isDefault).toBe(false);
		expect((await listUserGitIdentities(alice)).map((row) => row.isDefault)).toEqual([true, false]);
	});

	test("promoting an identity demotes the previous default in the same step", async () => {
		const first = await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		const second = await createUserGitIdentity(alice, { name: "Alice (work)", email: "aw@e.com" });

		await updateUserGitIdentity(alice, second.id, { isDefault: true });

		const rows = await listUserGitIdentities(alice);
		expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual([second.id]);
		expect(rows.find((row) => row.id === first.id)?.isDefault).toBe(false);
	});

	test("clearing the default is refused: a user with identities always has one", async () => {
		const first = await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		await expect(updateUserGitIdentity(alice, first.id, { isDefault: false })).rejects.toThrow();
	});

	test("deleting the default promotes a survivor, never leaving the user without one", async () => {
		const first = await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		const second = await createUserGitIdentity(alice, {
			name: "Alice (work)",
			email: "aw@e.com",
		});
		const third = await createUserGitIdentity(alice, { name: "Alice (oss)", email: "ao@e.com" });

		await deleteUserGitIdentity(alice, first.id);

		const rows = await listUserGitIdentities(alice);
		expect(rows.map((row) => row.id).sort()).toEqual([second.id, third.id].sort());
		// Exactly the row the list shows first carries the flag: the list order and the
		// succession rule are the same ordering, so the UI never contradicts itself.
		expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual([rows[0].id]);
	});

	test("the successor is the oldest survivor", async () => {
		// Written directly with distinct timestamps: rows created through the service
		// land in the same millisecond often enough that "oldest" cannot be asserted.
		const doomed = generateId();
		const oldest = generateId();
		const newest = generateId();
		await db.insert(userGitIdentities).values([
			{
				id: doomed,
				userId: alice,
				name: "a",
				email: "a@e.com",
				isDefault: true,
				createdAt: "2024-01-01T00:00:00.000Z",
			},
			{
				id: oldest,
				userId: alice,
				name: "b",
				email: "b@e.com",
				isDefault: false,
				createdAt: "2024-01-02T00:00:00.000Z",
			},
			{
				id: newest,
				userId: alice,
				name: "c",
				email: "c@e.com",
				isDefault: false,
				createdAt: "2024-01-03T00:00:00.000Z",
			},
		]);

		await deleteUserGitIdentity(alice, doomed);

		const rows = await listUserGitIdentities(alice);
		expect(rows.find((row) => row.isDefault)?.id).toBe(oldest);
		expect(rows.find((row) => row.id === newest)?.isDefault).toBe(false);
	});

	test("deleting the last identity leaves the user with none, which is a legal state", async () => {
		const only = await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		await deleteUserGitIdentity(alice, only.id);
		expect(await listUserGitIdentities(alice)).toEqual([]);
	});

	test("one user's identities are never visible to another", async () => {
		await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		await createUserGitIdentity(bob, { name: "Bob", email: "b@e.com" });

		expect((await listUserGitIdentities(alice)).map((row) => row.name)).toEqual(["Alice"]);
		expect((await listUserGitIdentities(bob)).map((row) => row.name)).toEqual(["Bob"]);
	});

	test("another user's identity cannot be edited or deleted by id", async () => {
		const alices = await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		await expect(updateUserGitIdentity(bob, alices.id, { name: "Stolen" })).rejects.toThrow();
		await expect(deleteUserGitIdentity(bob, alices.id)).rejects.toThrow();
	});

	test("an ident-breaking name or email is refused before it is stored", async () => {
		await expect(
			createUserGitIdentity(alice, { name: "Al<ice", email: "a@e.com" }),
		).rejects.toThrow();
		await expect(
			createUserGitIdentity(alice, { name: "Alice", email: "a@e.com\nX" }),
		).rejects.toThrow();
		await expect(createUserGitIdentity(alice, { name: "   ", email: "a@e.com" })).rejects.toThrow();
	});
});

describe("per-narrator pick", () => {
	test("starts empty, which means the default applies", async () => {
		await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		expect(await getNarratorGitIdentityPick(alice, narratorId)).toBeNull();
	});

	test("stores and clears the pick", async () => {
		const identity = await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		await setNarratorGitIdentityPick(alice, narratorId, identity.id);
		expect(await getNarratorGitIdentityPick(alice, narratorId)).toBe(identity.id);

		await setNarratorGitIdentityPick(alice, narratorId, null);
		expect(await getNarratorGitIdentityPick(alice, narratorId)).toBeNull();
	});

	test("an identity that belongs to somebody else cannot be picked", async () => {
		const bobs = await createUserGitIdentity(bob, { name: "Bob", email: "b@e.com" });
		await expect(setNarratorGitIdentityPick(alice, narratorId, bobs.id)).rejects.toThrow();
	});

	test("two people pick independently on the same narrator", async () => {
		const aliceAlt = await createUserGitIdentity(alice, {
			name: "Alice (work)",
			email: "aw@e.com",
		});
		const bobAlt = await createUserGitIdentity(bob, { name: "Bob (oss)", email: "bo@e.com" });

		await setNarratorGitIdentityPick(alice, narratorId, aliceAlt.id);
		await setNarratorGitIdentityPick(bob, narratorId, bobAlt.id);

		// Each reads back their own pick; the second write did not overwrite the first.
		expect(await getNarratorGitIdentityPick(alice, narratorId)).toBe(aliceAlt.id);
		expect(await getNarratorGitIdentityPick(bob, narratorId)).toBe(bobAlt.id);
	});

	test("deleting the picked identity drops the pick instead of leaving it dangling", async () => {
		const identity = await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		await setNarratorGitIdentityPick(alice, narratorId, identity.id);

		await deleteUserGitIdentity(alice, identity.id);

		expect(await getNarratorGitIdentityPick(alice, narratorId)).toBeNull();
	});
});

describe("resolution order", () => {
	test("no identities at all resolves to null, which inherits the host config", async () => {
		expect(await resolveGitIdentityForUser(alice)).toBeNull();
		expect(await resolveGitIdentityForTurn(narratorId, alice)).toBeNull();
	});

	test("the default identity applies when no pick was made", async () => {
		const identity = await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		await createUserGitIdentity(alice, { name: "Alice (work)", email: "aw@e.com" });
		await updateUserGitIdentity(alice, identity.id, { isDefault: true });

		expect(await resolveGitIdentityForTurn(narratorId, alice)).toEqual({
			name: "Alice",
			email: "a@e.com",
		});
	});

	test("the pick beats the default", async () => {
		const main = await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		const alt = await createUserGitIdentity(alice, { name: "Alice (work)", email: "aw@e.com" });
		await updateUserGitIdentity(alice, main.id, { isDefault: true });
		await setNarratorGitIdentityPick(alice, narratorId, alt.id);

		expect(await resolveGitIdentityForTurn(narratorId, alice)).toEqual({
			name: "Alice (work)",
			email: "aw@e.com",
		});
	});

	test("clearing the pick falls back to the default", async () => {
		const main = await createUserGitIdentity(alice, { name: "Alice", email: "a@e.com" });
		const alt = await createUserGitIdentity(alice, { name: "Alice (work)", email: "aw@e.com" });
		await updateUserGitIdentity(alice, main.id, { isDefault: true });
		await setNarratorGitIdentityPick(alice, narratorId, alt.id);
		await setNarratorGitIdentityPick(alice, narratorId, null);

		expect(await resolveGitIdentityForTurn(narratorId, alice)).toEqual({
			name: "Alice",
			email: "a@e.com",
		});
	});

	test("each user's turn resolves to their own choice on the same narrator", async () => {
		const aliceAlt = await createUserGitIdentity(alice, {
			name: "Alice (work)",
			email: "aw@e.com",
		});
		const bobAlt = await createUserGitIdentity(bob, { name: "Bob (oss)", email: "bo@e.com" });
		await setNarratorGitIdentityPick(alice, narratorId, aliceAlt.id);
		await setNarratorGitIdentityPick(bob, narratorId, bobAlt.id);

		expect(await resolveGitIdentityForTurn(narratorId, alice)).toEqual({
			name: "Alice (work)",
			email: "aw@e.com",
		});
		expect(await resolveGitIdentityForTurn(narratorId, bob)).toEqual({
			name: "Bob (oss)",
			email: "bo@e.com",
		});
	});

	test("a narrator the other user picked on does not change this user's resolution", async () => {
		// Bob picks for the narrator; Alice has no identities at all, so her turns
		// still inherit the host config rather than borrowing Bob's row.
		const bobs = await createUserGitIdentity(bob, { name: "Bob", email: "b@e.com" });
		await setNarratorGitIdentityPick(bob, narratorId, bobs.id);

		expect(await resolveGitIdentityForTurn(narratorId, alice)).toBeNull();
	});

	test("oldest wins when no row is flagged, so a legacy database still resolves", async () => {
		// Written directly with distinct timestamps: rows created through the service
		// land in the same millisecond often enough that "oldest" cannot be asserted.
		// The flag is what the service maintains; a restored or seeded database may
		// have none set, and resolution must still be deterministic rather than empty.
		await db.insert(userGitIdentities).values([
			{
				id: generateId(),
				userId: alice,
				name: "Alice",
				email: "a@e.com",
				isDefault: false,
				createdAt: "2024-01-01T00:00:00.000Z",
			},
			{
				id: generateId(),
				userId: alice,
				name: "Alice (work)",
				email: "aw@e.com",
				isDefault: false,
				createdAt: "2024-01-02T00:00:00.000Z",
			},
		]);
		invalidateGitIdentityCache(alice);

		expect(await resolveGitIdentityForUser(alice)).toEqual({
			name: "Alice",
			email: "a@e.com",
		});
	});
});
