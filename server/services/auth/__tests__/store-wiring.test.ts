/**
 * The auth write-backend selection rules, exercised as a pure function.
 *
 * `resolveAuthStores` is the composition decision — which backend serves the
 * session/MFA loop — stated without module side effects, so each rule is asserted
 * directly instead of by re-importing modules under mutated environments. The rules
 * are the registration store's rules, because the two are one deployment decision:
 *
 *   - absent, empty, aliased, non-string and unknown values all resolve to the SQLite
 *     implementations (fail-closed: no knob steers the auth loop by accident);
 *   - only the exact `postgres` selects PostgreSQL, and only when adapters were
 *     injected — an explicit selection with nothing to serve it throws rather than
 *     falling back;
 *   - a write/read mismatch throws: one process must read and write the same database;
 *   - both stores resolve TOGETHER — half a swap would split the login loop in two.
 *
 * The `postgres` cases use in-memory stand-ins for the injected adapters; what is
 * being pinned is the SELECTION, not the adapters (which the contracts and the
 * PostgreSQL integration suite cover).
 */
import { describe, expect, test } from "bun:test";
import type { AuthMfaStore } from "../mfa-store";
import type { AuthSessionStore } from "../session-store";
import { sqliteAuthMfaStore } from "../sqlite-mfa-store";
import { sqliteAuthSessionStore } from "../sqlite-session-store";
import { resolveAuthStores } from "../store";

/** Minimal stand-ins for "PostgreSQL adapters were injected". Only identity matters. */
const injectedSession: AuthSessionStore = {
	findLoginCredential: () => Promise.resolve(null),
	updateProfile: () => Promise.resolve(),
	setAvatarImage: () => Promise.resolve(),
	findSessionState: () => Promise.resolve(null),
	findSessionProfile: () => Promise.resolve(null),
	findPasswordHash: () => Promise.resolve(null),
	bumpTokenVersion: () => Promise.resolve(0),
};
const injectedMfa: AuthMfaStore = {
	findTotp: () => Promise.resolve(null),
	findMfaEnabled: () => Promise.resolve(false),
	setMfaEnabled: () => Promise.resolve(),
	hasAnyPasskey: () => Promise.resolve(false),
	savePendingTotp: () => Promise.resolve("saved"),
	activateTotp: () => Promise.resolve(),
	countUnusedBackupCodes: () => Promise.resolve(0),
	findUnusedBackupCodes: () => Promise.resolve([]),
	markBackupCodeUsed: () => Promise.resolve(false),
	replaceBackupCodes: () => Promise.resolve(),
	clearFactors: () => Promise.resolve(),
};
const injected = { session: injectedSession, mfa: injectedMfa };

describe("auth write-backend selection", () => {
	test("an absent selector resolves to SQLite, for both stores", () => {
		for (const config of [{}, { writeBackend: undefined }, { writeBackend: "" }]) {
			const resolved = resolveAuthStores(config, undefined);
			expect(resolved.session).toBe(sqliteAuthSessionStore);
			expect(resolved.mfa).toBe(sqliteAuthMfaStore);
		}
	});

	test("SQLite aliases resolve to SQLite", () => {
		for (const value of ["sqlite", "sqlite3", "bun-sqlite"]) {
			const resolved = resolveAuthStores({ writeBackend: value }, undefined);
			expect(resolved.session).toBe(sqliteAuthSessionStore);
			expect(resolved.mfa).toBe(sqliteAuthMfaStore);
		}
	});

	test("unknown, mixed-case and non-string values fail closed to SQLite", () => {
		// The hazard is ACCIDENTAL selection: a typo or an ambient variable must never
		// steer the session gate to a second store. Only the exact string "postgres" does.
		for (const value of ["postgresql", "POSTGRES", "Postgres", "pg", "mysql", " postgres"]) {
			const resolved = resolveAuthStores({ writeBackend: value }, injected);
			expect(resolved.session, `writeBackend=${JSON.stringify(value)}`).toBe(
				sqliteAuthSessionStore,
			);
			expect(resolved.mfa, `writeBackend=${JSON.stringify(value)}`).toBe(sqliteAuthMfaStore);
		}
		for (const value of [42, true, {}, ["postgres"], null]) {
			const resolved = resolveAuthStores({ writeBackend: value }, injected);
			expect(resolved.session).toBe(sqliteAuthSessionStore);
			expect(resolved.mfa).toBe(sqliteAuthMfaStore);
		}
	});

	test("an explicit postgres selection resolves to the injected adapters, both of them", () => {
		const resolved = resolveAuthStores(
			{ writeBackend: "postgres", readBackend: "postgres" },
			injected,
		);
		expect(resolved.session).toBe(injectedSession);
		expect(resolved.mfa).toBe(injectedMfa);
	});

	test("an explicit postgres selection with no adapters is an error, never a fallback", () => {
		expect(() =>
			resolveAuthStores({ writeBackend: "postgres", readBackend: "postgres" }, undefined),
		).toThrow(/unavailable|no stores are available/);
	});

	test("a write/read mismatch is an error in both directions", () => {
		// PostgreSQL writes with SQLite reads: the session gate would read back nothing
		// of what login wrote.
		expect(() => resolveAuthStores({ writeBackend: "postgres" }, injected)).toThrow(
			/does not match read backend/,
		);
		// SQLite writes with PostgreSQL reads: the mirror image.
		expect(() => resolveAuthStores({ readBackend: "postgres" }, injected)).toThrow(
			/does not match read backend/,
		);
	});

	test("the read selection is fail-closed too: unknown read values do not break the match", () => {
		const resolved = resolveAuthStores(
			{ writeBackend: "sqlite", readBackend: "nonsense" },
			undefined,
		);
		expect(resolved.session).toBe(sqliteAuthSessionStore);
		expect(resolved.mfa).toBe(sqliteAuthMfaStore);
	});
});
