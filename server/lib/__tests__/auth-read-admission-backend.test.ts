import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { generateSessionToken } from "../session-token-hash";

const originalDatabase = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...originalDatabase, activeDatabaseBackend: "postgres" }));
const { verifyToken } = await import("../auth");
const { sqliteAuthSessionStore } = await import("../../services/auth/sqlite-session-store");
const { authReadAdmission } = await import("../auth-read-admission");

afterAll(() => {
	mock.module("../../db", () => originalDatabase);
	mock.restore();
});

test("the authoritative PostgreSQL descriptor preserves independent asynchronous read concurrency", async () => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const now = Math.floor(Date.now() / 1000);
	const find = spyOn(sqliteAuthSessionStore, "findSessionByTokenHash").mockImplementation(
		async () => {
			calls++;
			await pending;
			return {
				id: "backend-session",
				userId: "backend-user",
				role: "admin",
				userTokenVersion: 0,
				sessionTokenVersion: 0,
				sessionStart: now,
				createdAt: now,
				expiresAt: now + 604800,
				revokedAt: null,
			};
		},
	);
	const token = generateSessionToken();
	const requests = Array.from({ length: 70 }, () => verifyToken(token));
	try {
		expect(calls).toBe(70);
		release();
		expect((await Promise.all(requests)).length).toBe(70);
	} finally {
		release();
		await Promise.allSettled(requests);
		find.mockRestore();
	}
});

test("PostgreSQL read errors stay native and do not enter SQLite auth admission", async () => {
	const failure = new Error("async driver failure");
	const options = { signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 };
	const find = spyOn(sqliteAuthSessionStore, "findSessionByTokenHash").mockRejectedValue(failure);
	const admission = spyOn(authReadAdmission, "run");
	try {
		expect(
			await verifyToken(generateSessionToken(), options).catch((error: unknown) => error),
		).toBe(failure);
		expect(find.mock.calls[0]?.[1]).toBe(options);
		expect(admission).not.toHaveBeenCalled();
	} finally {
		find.mockRestore();
		admission.mockRestore();
	}
});
