/**
 * Registering with an invitation code.
 *
 * The behaviour under test is the point of the feature: a code authorizes a signup
 * on its own, so an instance can keep public registration closed and still admit
 * specific people. It also pins the atomicity — a rejected code must not leave a
 * half-created account behind.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { registrationCodes, userPreferences, users } from "../../db/schema";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { registerUser } = await import("../auth");
const { registrationCodeService } = await import("../../services/registration-code-service");
const { settings } = await import("../settings");

let adminId: string;

/** An existing administrator, so registrations under test are never the bootstrap case. */
async function seedAdmin(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `reg-admin-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "admin",
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function issueCode(overrides: Parameters<typeof registrationCodeService.createCode>[0]) {
	return registrationCodeService.createCode(overrides);
}

beforeEach(async () => {
	cleanDb(sqlite);
	adminId = await seedAdmin();
	// Closed registration is the interesting configuration: it is what codes exist for.
	settings.auth.registrationOpen = false;
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

describe("registration with a code", () => {
	test("a valid code admits a user while registration is closed", async () => {
		const { code } = await issueCode({ createdByUserId: adminId });

		const { user } = await registerUser({
			username: "alice",
			password: "correct-horse-battery",
			code,
		});

		expect(user.username).toBe("alice");
		expect(user.role).toBe("user");
		// Registration stays closed: admitting one invited user is not reopening signup.
		expect(settings.auth.registrationOpen).toBe(false);
	});

	test("the code decides the new account's role", async () => {
		const { code } = await issueCode({ createdByUserId: adminId, role: "admin" });
		const { user } = await registerUser({
			username: "alice",
			password: "correct-horse-battery",
			code,
		});
		expect(user.role).toBe("admin");
	});

	test("registration without a code is still refused while closed", async () => {
		expect(registerUser({ username: "alice", password: "correct-horse-battery" })).rejects.toThrow(
			"Registration is closed",
		);
	});

	test("a code is consumed and cannot admit a second user", async () => {
		const { code, summary } = await issueCode({ createdByUserId: adminId });
		await registerUser({ username: "alice", password: "correct-horse-battery", code });

		const row = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.id, summary.id),
		});
		expect(row?.usedAt).toBeTruthy();
		const alice = await db.query.users.findFirst({ where: eq(users.username, "alice") });
		expect(row?.usedByUserId).toBe(alice?.id ?? "");

		expect(registerUser({ username: "bob", password: "another-passphrase", code })).rejects.toThrow(
			"already been used",
		);
	});

	test("a bound code rejects a different username and creates nothing", async () => {
		const { code } = await issueCode({ createdByUserId: adminId, boundUsername: "alice" });

		expect(registerUser({ username: "bob", password: "another-passphrase", code })).rejects.toThrow(
			"different username",
		);

		// Atomicity: the rejected attempt must not leave the account or its
		// preferences row behind, and the code must remain usable.
		await Bun.sleep(0);
		const bob = await db.query.users.findFirst({ where: eq(users.username, "bob") });
		expect(bob).toBeUndefined();
		const prefs = await db.select().from(userPreferences);
		expect(prefs).toHaveLength(0);

		const { user } = await registerUser({
			username: "alice",
			password: "correct-horse-battery",
			code,
		});
		expect(user.username).toBe("alice");
	});

	test("an unknown code creates no account", async () => {
		expect(
			registerUser({
				username: "alice",
				password: "correct-horse-battery",
				code: "nfrc_definitely-not-issued",
			}),
		).rejects.toThrow("Invalid registration code");

		await Bun.sleep(0);
		const alice = await db.query.users.findFirst({ where: eq(users.username, "alice") });
		expect(alice).toBeUndefined();
	});

	test("an open instance still accepts registration without a code", async () => {
		settings.auth.registrationOpen = true;
		const { user } = await registerUser({ username: "alice", password: "correct-horse-battery" });
		expect(user.role).toBe("user");
	});

	test("a taken username is rejected before the code is spent", async () => {
		const { code, summary } = await issueCode({ createdByUserId: adminId });
		await db.insert(users).values({
			id: generateId(),
			username: "alice",
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});

		expect(
			registerUser({ username: "alice", password: "correct-horse-battery", code }),
		).rejects.toThrow("Username already taken");

		await Bun.sleep(0);
		const row = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.id, summary.id),
		});
		expect(row?.usedAt).toBeNull();
	});
});
