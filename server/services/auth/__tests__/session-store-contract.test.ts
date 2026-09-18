/**
 * The session-store contract, verified against real SQLite.
 *
 * WHAT IS BEING PINNED
 * --------------------
 * The session loop's five facts, on the store that serves them by default:
 *
 *   - a login lookup returns exactly the password-verification facts (and null for an
 *     unknown username, never a throw);
 *   - the session gate observes existence, the LIVE role and the current token
 *     generation from one read;
 *   - the profile read joins the account and its language preference, and tolerates a
 *     missing preferences row (language null);
 *   - `bumpTokenVersion` is a real increment: it returns the NEW value, two concurrent
 *     bumps both land, and the NEXT read through the same store sees the result —
 *     the write-after-read property the whole port exists to guarantee;
 *   - a bump for an unknown account answers 0 and changes nothing (the pre-port
 *     `?? 0` behaviour, preserved verbatim).
 *
 * ISOLATION: the store runs on `tests/setup`'s in-memory database, mocked over
 * `server/db`. No real NarraFork database is touched.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locale } from "@shared/i18n-locales";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { userPreferences, users } from "../../../db/schema";
import { generateId } from "../../../lib/id";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({ db, sqlite }));

const { sqliteAuthSessionStore: store } = await import("../sqlite-session-store");
const { authSessionStore } = await import("../store");

afterAll(() => {
	mock.module("../../../db", () => realDbModule);
	mock.restore();
});

beforeEach(() => {
	cleanDb(sqlite);
});

async function makeAccount(
	overrides: { username?: string; role?: "admin" | "user"; language?: Locale | null } = {},
): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: overrides.username ?? `user-${id.slice(0, 6)}`,
		passwordHash: `hash-${id.slice(0, 6)}`,
		role: overrides.role ?? "user",
		createdAt: new Date().toISOString(),
	});
	if (overrides.language !== null) {
		await db.insert(userPreferences).values({
			id: generateId(),
			userId: id,
			language: overrides.language ?? "en",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	}
	return id;
}

describe("AuthSessionStore — SQLite", () => {
	test("a login lookup returns the verification facts; an unknown username is null", async () => {
		const id = await makeAccount({ username: "alice" });
		expect(await store.findLoginCredential("alice")).toEqual({
			id,
			passwordHash: `hash-${id.slice(0, 6)}`,
			mfaEnabled: false,
		});
		expect(await store.findLoginCredential("nobody")).toBeNull();
	});

	test("the session gate reads existence, live role and generation together", async () => {
		const id = await makeAccount({ role: "admin" });
		expect(await store.findSessionState(id)).toEqual({ id, role: "admin", tokenVersion: 0 });
		expect(await store.findSessionState(generateId())).toBeNull();
	});

	test("the profile joins the language preference and tolerates its absence", async () => {
		const withPrefs = await makeAccount({ username: "bob", language: "zh-CN" });
		const profile = await store.findSessionProfile(withPrefs);
		expect(profile?.username).toBe("bob");
		expect(profile?.language).toBe("zh-CN");
		expect(profile?.tokenVersion).toBe(0);

		const withoutPrefs = await makeAccount({ username: "carol", language: null });
		expect((await store.findSessionProfile(withoutPrefs))?.language).toBeNull();
		expect(await store.findSessionProfile(generateId())).toBeNull();
	});

	test("profile writes and avatar references use the same store", async () => {
		const id = await makeAccount({ username: "profile-user" });
		await store.updateProfile(id, { gitUsername: "git-user", gitEmail: "git@example.test" });
		await store.setAvatarImage(id, "avatar-1");
		const profile = await store.findSessionProfile(id);
		expect(profile).toMatchObject({
			gitUsername: "git-user",
			gitEmail: "git@example.test",
			avatarImageId: "avatar-1",
		});
		await store.setAvatarImage(id, null);
		expect((await store.findSessionProfile(id))?.avatarImageId).toBeNull();
	});

	test("the password hash is readable for in-session re-verification", async () => {
		const id = await makeAccount({ username: "dave" });
		expect(await store.findPasswordHash(id)).toBe(`hash-${id.slice(0, 6)}`);
		expect(await store.findPasswordHash(generateId())).toBeNull();
	});

	test("a bump returns the new value and the next read sees it", async () => {
		const id = await makeAccount();
		expect(await store.bumpTokenVersion(id)).toBe(1);
		expect(await store.bumpTokenVersion(id)).toBe(2);
		expect((await store.findSessionState(id))?.tokenVersion).toBe(2);

		const row = await db.query.users.findFirst({
			where: eq(users.id, id),
			columns: { tokenVersion: true },
		});
		expect(row?.tokenVersion).toBe(2);
	});

	test("concurrent bumps both land — the increment is atomic, not read-modify-write", async () => {
		const id = await makeAccount();
		const results = await Promise.all([
			store.bumpTokenVersion(id),
			store.bumpTokenVersion(id),
			store.bumpTokenVersion(id),
		]);
		expect([...results].sort()).toEqual([1, 2, 3]);
		expect((await store.findSessionState(id))?.tokenVersion).toBe(3);
	});

	test("a bump for an unknown account answers 0 and changes nothing", async () => {
		const unknown = generateId();
		expect(await store.bumpTokenVersion(unknown)).toBe(0);
		expect(await store.findSessionState(unknown)).toBeNull();
	});

	test("the session store is wired to the SQLite implementation by default", () => {
		expect(authSessionStore).toBe(store);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The port and its adapters carry no cross-dialect dependency
// ─────────────────────────────────────────────────────────────────────────────

describe("the port and its adapters stay dialect-clean", () => {
	const SERVICE_DIR = join(import.meta.dir, "..");

	/** Import specifiers only — prose mentioning a dialect is documentation, not coupling. */
	function importSpecifiers(file: string): string[] {
		const source = readFileSync(join(SERVICE_DIR, file), "utf8");
		return [...source.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map(
			(m) => m[1] ?? m[2],
		);
	}

	test("session-store.ts imports nothing database-specific", () => {
		const specifiers = importSpecifiers("session-store.ts");
		expect(specifiers.length, "session-store.ts should have imports to inspect").toBeGreaterThan(0);
		for (const specifier of specifiers) {
			expect(specifier, `imports ${specifier}`).not.toBe("bun:sqlite");
			expect(specifier, `imports ${specifier}`).not.toStartWith("drizzle-orm");
			expect(specifier, `imports ${specifier}`).not.toMatch(/(?:^|\/)db(?:\/|$)|db\/schema$/);
			expect(specifier, `imports ${specifier}`).not.toMatch(/postgres/);
		}
	});

	test("the PostgreSQL adapter carries no SQLite dependency", () => {
		// The second implementation must not inherit the first engine: importing the SQLite
		// handle, the SQLite schema or the SQLite dialect modules would make the "second
		// backend" a caller of the first. PG-side modules are what it MAY import, and the
		// assertions below require them so the check is not vacuous.
		const specifiers = importSpecifiers("postgres-session-store.ts");
		expect(specifiers.length, "postgres-session-store.ts should have imports").toBeGreaterThan(0);
		for (const specifier of specifiers) {
			expect(specifier, `imports ${specifier}`).not.toBe("bun:sqlite");
			expect(specifier, `imports ${specifier}`).not.toStartWith("drizzle-orm/bun-sqlite");
			expect(specifier, `imports ${specifier}`).not.toStartWith("drizzle-orm/sqlite-core");
			expect(specifier, `imports ${specifier}`).not.toMatch(/^(?:@server\/db|(?:\.\.?\/)+db)$/);
			expect(specifier, `imports ${specifier}`).not.toMatch(/(?:^|\/)db\/schema$/);
			expect(specifier, `imports ${specifier}`).not.toMatch(/db\/connection$/);
		}
		expect(specifiers).toContain("@server/db/postgres-schema");
		expect(specifiers).toContain("@server/db/pg-retry");
	});

	test("the SQLite adapter never touches the raw handle", () => {
		// The adapter goes through Drizzle only: no `sqlite` handle import, no driver
		// import — the dialect inventory guard backs this up repo-wide.
		const specifiers = importSpecifiers("sqlite-session-store.ts");
		expect(specifiers).toContain("@server/db");
		expect(specifiers).toContain("@server/db/schema");
		expect(specifiers).not.toContain("bun:sqlite");
	});
});
