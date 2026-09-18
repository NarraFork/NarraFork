/**
 * The registration write-backend selection rules, exercised as a pure function.
 *
 * `resolveRegistrationAccountStore` is the composition decision — which backend serves
 * registration writes — stated without module side effects, so each rule is asserted
 * directly instead of by re-importing modules under mutated environments:
 *
 *   - absent, empty, aliased, non-string and unknown values all resolve to the SQLite
 *     implementation (fail-closed: no knob steers registration by accident);
 *   - only the exact `postgres` selects PostgreSQL, and only when an adapter was
 *     injected — an explicit selection with nothing to serve it throws rather than
 *     falling back;
 *   - a write/read mismatch throws: one process must read and write the same database.
 *
 * The `postgres` cases use an in-memory stand-in for the injected adapter; what is
 * being pinned is the SELECTION, not the adapter (which the contract and the
 * PostgreSQL integration suite cover).
 */
import { describe, expect, test } from "bun:test";
import type { RegistrationAccountStore } from "../account-store";
import { sqliteRegistrationAccountStore } from "../sqlite-account-store";
import { resolveRegistrationAccountStore } from "../store";

/** Minimal stand-in for "a PostgreSQL adapter was injected". Only identity matters. */
const injectedPgStore: RegistrationAccountStore = {
	countAccounts: () => Promise.resolve(0),
	isUsernameTaken: () => Promise.resolve(false),
	createAccount: () => Promise.reject(new Error("stand-in: not callable")),
};

describe("registration write-backend selection", () => {
	test("an absent selector resolves to SQLite", () => {
		expect(resolveRegistrationAccountStore({}, undefined)).toBe(sqliteRegistrationAccountStore);
		expect(resolveRegistrationAccountStore({ writeBackend: undefined }, undefined)).toBe(
			sqliteRegistrationAccountStore,
		);
		expect(resolveRegistrationAccountStore({ writeBackend: "" }, undefined)).toBe(
			sqliteRegistrationAccountStore,
		);
	});

	test("SQLite aliases resolve to SQLite", () => {
		for (const value of ["sqlite", "sqlite3", "bun-sqlite"]) {
			expect(resolveRegistrationAccountStore({ writeBackend: value }, undefined)).toBe(
				sqliteRegistrationAccountStore,
			);
		}
	});

	test("unknown, mixed-case and non-string values fail closed to SQLite", () => {
		// The hazard is ACCIDENTAL selection: a typo or an ambient variable must never
		// steer writes to a second store. Only the exact string "postgres" does.
		for (const value of ["postgresql", "POSTGRES", "Postgres", "pg", "mysql", " postgres"]) {
			expect(
				resolveRegistrationAccountStore({ writeBackend: value }, injectedPgStore),
				`writeBackend=${JSON.stringify(value)}`,
			).toBe(sqliteRegistrationAccountStore);
		}
		for (const value of [42, true, {}, ["postgres"], null]) {
			expect(resolveRegistrationAccountStore({ writeBackend: value }, injectedPgStore)).toBe(
				sqliteRegistrationAccountStore,
			);
		}
	});

	test("an explicit postgres selection resolves to the injected adapter", () => {
		expect(
			resolveRegistrationAccountStore(
				{ writeBackend: "postgres", readBackend: "postgres" },
				injectedPgStore,
			),
		).toBe(injectedPgStore);
	});

	test("an explicit postgres selection with no adapter is an error, never a fallback", () => {
		expect(() =>
			resolveRegistrationAccountStore(
				{ writeBackend: "postgres", readBackend: "postgres" },
				undefined,
			),
		).toThrow(/unavailable|no store is available/);
	});

	test("a write/read mismatch is an error in both directions", () => {
		// PostgreSQL writes with SQLite reads: the process would read back nothing of what
		// it wrote.
		expect(() =>
			resolveRegistrationAccountStore({ writeBackend: "postgres" }, injectedPgStore),
		).toThrow(/does not match read backend/);
		// SQLite writes with PostgreSQL reads: the mirror image.
		expect(() =>
			resolveRegistrationAccountStore({ readBackend: "postgres" }, injectedPgStore),
		).toThrow(/does not match read backend/);
	});

	test("the read selection is fail-closed too: unknown read values do not break the match", () => {
		expect(
			resolveRegistrationAccountStore(
				{ writeBackend: "sqlite", readBackend: "nonsense" },
				undefined,
			),
		).toBe(sqliteRegistrationAccountStore);
	});
});
