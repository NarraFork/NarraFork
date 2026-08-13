/**
 * The bootstrap `/auth/register` endpoint is unauthenticated and must stay open
 * while the instance has no users. These tests pin the behaviour that keeps it
 * from remaining an open signup hole afterwards: creating the first (admin)
 * account closes registration immediately and persists that to settings.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { registerUser } = await import("../auth");
const { settings } = await import("../settings");

beforeEach(() => {
	cleanDb(sqlite);
	settings.auth.registrationOpen = true;
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

describe("registration auto-close", () => {
	test("the first user becomes admin and closes registration", async () => {
		const { user } = await registerUser({
			username: "first-admin",
			password: "correct-horse-battery",
		});
		expect(user.role).toBe("admin");
		expect(settings.auth.registrationOpen).toBe(false);

		// The persisted file must agree, otherwise a restart would reopen signup.
		const { loadSettings } = await import("../settings");
		expect(loadSettings().auth.registrationOpen).toBe(false);
	});

	test("a second registration is rejected once registration auto-closed", async () => {
		await registerUser({ username: "first-admin", password: "correct-horse-battery" });
		expect(
			registerUser({ username: "second-user", password: "another-passphrase" }),
		).rejects.toThrow("Registration is closed");
	});

	test("an admin reopening registration lets further users in", async () => {
		await registerUser({ username: "first-admin", password: "correct-horse-battery" });
		settings.auth.registrationOpen = true;

		const { user } = await registerUser({
			username: "second-user",
			password: "another-passphrase",
		});
		expect(user.role).toBe("user");
		// Only the bootstrap account triggers the auto-close.
		expect(settings.auth.registrationOpen).toBe(true);
	});
});
