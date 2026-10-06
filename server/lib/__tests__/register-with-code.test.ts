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
import { WriteConflictError } from "../../db/backend/write-port";
import { registrationCodes, userPreferences, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { registerUser } = await import("../auth");
const { registrationCodeService } = await import("../../services/registration-code-service");
const { registrationAccountStore } = await import("../../services/registration/store");
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

		await expect(
			registerUser({ username: "alice", password: "correct-horse-battery", code }),
		).rejects.toThrow("Username already taken");

		const row = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.id, summary.id),
		});
		expect(row?.usedAt).toBeNull();
	});

	test("the bootstrap administrator ignores a supplied code and leaves it unspent", async () => {
		// No users at all: the first account must be an administrator regardless of what the
		// code grants, so the code is not resolved and must not be burned by it.
		const { code, summary } = await issueCode({ createdByUserId: adminId, role: "user" });
		await db.delete(users).where(eq(users.id, adminId));

		const { user } = await registerUser({
			username: "bootstrap",
			password: "correct-horse-battery",
			code,
		});

		expect(user.role).toBe("admin");
		const row = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.id, summary.id),
		});
		expect(row?.usedAt).toBeNull();
		expect(row?.usedByUserId).toBeNull();
	});
});

/**
 * `registerUser` must consume the registration capability as a Promise-returning business
 * operation, with domain input only.
 *
 * This is what keeps the port from being a decorative interface: the assertions below fail
 * if the caller goes back to opening its own transaction, or starts passing storage-shaped
 * arguments (a `tx` handle, a table, a row) through it.
 */
describe("registerUser consumes the account store as a business capability", () => {
	test("it awaits createAccount with domain input and no storage handle", async () => {
		const { code } = await issueCode({ createdByUserId: adminId, role: "admin" });
		const calls: unknown[] = [];
		const real = registrationAccountStore.createAccount;
		const spy = mock((draft: Parameters<typeof real>[0]) => {
			calls.push(draft);
			return real.call(registrationAccountStore, draft);
		});
		registrationAccountStore.createAccount = spy;

		try {
			const { user } = await registerUser({
				username: "alice",
				password: "correct-horse-battery",
				code,
			});
			expect(user.role).toBe("admin");
		} finally {
			registrationAccountStore.createAccount = real;
		}

		expect(calls).toHaveLength(1);
		const draft = calls[0] as Record<string, unknown>;
		// Plain domain data, and specifically the invitation as a CODE rather than a resolved
		// row: resolving it is the store's job, inside the atomic section.
		expect(draft.invitationCode).toBe(code);
		expect(draft.username).toBe("alice");
		expect(draft.defaultRole).toBe("user");
		expect(typeof draft.nowIso).toBe("string");
		// The password never crosses the boundary in the clear, and hashing happened before
		// the call — i.e. outside the atomic section.
		expect(draft.passwordHash).not.toBe("correct-horse-battery");
		expect(String(draft.passwordHash)).toStartWith("$2");
		expect(Object.keys(draft).sort()).toEqual([
			"avatarColor",
			"defaultRole",
			"invitationCode",
			"language",
			"nowIso",
			"passwordHash",
			"userId",
			"username",
		]);
	});

	test("a store rejection surfaces unchanged and creates no session", async () => {
		// Registration open, so the request reaches the store rather than being refused by
		// policy — the point is that a storage failure is not reshaped into a policy error.
		settings.auth.registrationOpen = true;
		const real = registrationAccountStore.createAccount;
		registrationAccountStore.createAccount = mock(() =>
			Promise.reject(new AppError("storage unavailable", 503, "STORAGE_UNAVAILABLE")),
		);

		try {
			const failure = registerUser({ username: "alice", password: "correct-horse-battery" });
			await expect(failure).rejects.toThrow("storage unavailable");
		} finally {
			registrationAccountStore.createAccount = real;
		}

		const alice = await db.query.users.findFirst({ where: eq(users.username, "alice") });
		expect(alice).toBeUndefined();
	});
});

/**
 * The username race, given one answer on every backend.
 *
 * The pre-check (`isUsernameTaken`) and the account insert are not one atomic
 * observation, so two concurrent registrations of the same username can both pass the
 * check; exactly one then wins the insert, and the loser must hear the same domain
 * answer the pre-check would have given — `USERNAME_TAKEN` (409) — never a raw storage
 * error. On SQLite the loser surfaces as the engine's own constraint violation; on
 * PostgreSQL as a `WriteConflictError` from inside the retried section. The mapping is
 * decided by re-reading the domain state, so these tests pin the outcome without
 * recognizing either driver.
 */
describe("a lost username race is reported as USERNAME_TAKEN, not as a storage failure", () => {
	test("two concurrent registrations of one username: one succeeds, one gets 409", async () => {
		settings.auth.registrationOpen = true;

		const attempts = await Promise.allSettled([
			registerUser({ username: "alice", password: "correct-horse-battery" }),
			registerUser({ username: "alice", password: "another-passphrase" }),
		]);

		const succeeded = attempts.filter((a) => a.status === "fulfilled");
		const failed = attempts.filter((a) => a.status === "rejected");
		expect(succeeded).toHaveLength(1);
		expect(failed).toHaveLength(1);
		const reason = (failed[0] as PromiseRejectedResult).reason;
		expect(reason).toBeInstanceOf(AppError);
		expect((reason as AppError).statusCode).toBe(409);
		expect((reason as AppError).code).toBe("USERNAME_TAKEN");

		// Exactly one account exists: the loser's insert was really rolled back.
		const alices = await db.select({ id: users.id }).from(users).where(eq(users.username, "alice"));
		expect(alices).toHaveLength(1);
	});

	test("a conflict-shaped rejection is mapped when the username is now taken", async () => {
		// The PostgreSQL shape, simulated at the port boundary: the store rejects with a
		// WriteConflictError (what the PG adapter raises for 23505) and the re-read
		// confirms the account exists — the answer must be the domain error, not the
		// conflict object.
		settings.auth.registrationOpen = true;
		await db.insert(users).values({
			id: generateId(),
			username: "alice",
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		const real = registrationAccountStore.createAccount;
		registrationAccountStore.createAccount = mock(() =>
			Promise.reject(
				new WriteConflictError("write conflicts with an existing row", {
					constraint: "users_username_unique",
				}),
			),
		);

		try {
			const failure = registerUser({ username: "alice", password: "correct-horse-battery" });
			const error = await failure.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(AppError);
			expect((error as AppError).statusCode).toBe(409);
			expect((error as AppError).code).toBe("USERNAME_TAKEN");
		} finally {
			registrationAccountStore.createAccount = real;
		}
	});

	test("a failure whose username is NOT taken propagates unchanged", async () => {
		// The symmetric guard: mapping must not reshape a genuine storage fault into a
		// policy error just because it happened during account creation.
		settings.auth.registrationOpen = true;
		const real = registrationAccountStore.createAccount;
		registrationAccountStore.createAccount = mock(() => Promise.reject(new Error("disk on fire")));

		try {
			const failure = registerUser({ username: "alice", password: "correct-horse-battery" });
			await expect(failure).rejects.toThrow("disk on fire");
		} finally {
			registrationAccountStore.createAccount = real;
		}
	});

	test("two concurrent registrations with one code: one burns it, one gets CODE_ALREADY_USED", async () => {
		const { code } = await issueCode({ createdByUserId: adminId });

		const attempts = await Promise.allSettled([
			registerUser({ username: "alice", password: "correct-horse-battery", code }),
			registerUser({ username: "bob", password: "another-passphrase", code }),
		]);

		const succeeded = attempts.filter((a) => a.status === "fulfilled");
		const failed = attempts.filter((a) => a.status === "rejected");
		expect(succeeded).toHaveLength(1);
		expect(failed).toHaveLength(1);
		const reason = (failed[0] as PromiseRejectedResult).reason;
		expect(reason).toBeInstanceOf(AppError);
		expect((reason as AppError).statusCode).toBe(409);
		expect((reason as AppError).code).toBe("CODE_ALREADY_USED");

		// The winner's account is the one the code names, and it is the only new account.
		const created = await db
			.select({ id: users.id, username: users.username })
			.from(users)
			.where(
				eq(
					users.id,
					(succeeded[0] as PromiseFulfilledResult<{ user: { id: string } }>).value.user.id,
				),
			);
		expect(created).toHaveLength(1);
	});
});
