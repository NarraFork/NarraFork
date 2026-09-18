/**
 * The knowledge write-backend selection rules, exercised as a pure function.
 *
 * `resolveKnowledgeWriteStore` is the composition decision — which backend serves
 * knowledge writes — stated without module side effects, so each rule is asserted
 * directly instead of by re-importing modules under mutated environments:
 *
 *   - absent, empty, aliased, non-string and unknown values all resolve to the SQLite
 *     implementation (fail-closed: no knob steers knowledge writes by accident);
 *   - only the exact `postgres` selects PostgreSQL, and only when an adapter was
 *     injected — an explicit selection with nothing to serve it throws rather than
 *     falling back;
 *   - a write/read mismatch throws: one process must read and write the same database.
 *
 * The `postgres` cases use an in-memory stand-in for the injected adapter; what is
 * being pinned is the SELECTION, not the adapter (which the contract suite and the
 * PostgreSQL integration suite cover).
 */
import { describe, expect, test } from "bun:test";
import { sqliteKnowledgeWriteStore } from "../sqlite-write-store";
import { resolveKnowledgeWriteStore } from "../store";
import type { KnowledgeWriteStore } from "../write-store";

/** Minimal stand-in for "a PostgreSQL adapter was injected". Only identity matters. */
const injectedPgStore = new Proxy({} as KnowledgeWriteStore, {
	get: () => () => Promise.reject(new Error("stand-in: not callable")),
});

describe("knowledge write-backend selection", () => {
	test("an absent selector resolves to SQLite", () => {
		expect(resolveKnowledgeWriteStore({}, undefined)).toBe(sqliteKnowledgeWriteStore);
		expect(resolveKnowledgeWriteStore({ writeBackend: undefined }, undefined)).toBe(
			sqliteKnowledgeWriteStore,
		);
		expect(resolveKnowledgeWriteStore({ writeBackend: "" }, undefined)).toBe(
			sqliteKnowledgeWriteStore,
		);
	});

	test("SQLite aliases resolve to SQLite", () => {
		for (const value of ["sqlite", "sqlite3", "bun-sqlite"]) {
			expect(resolveKnowledgeWriteStore({ writeBackend: value }, undefined)).toBe(
				sqliteKnowledgeWriteStore,
			);
		}
	});

	test("unknown, mixed-case and non-string values fail closed to SQLite", () => {
		// The hazard is ACCIDENTAL selection: a typo or an ambient variable must never
		// steer writes to a second store. Only the exact string "postgres" does.
		for (const value of ["postgresql", "POSTGRES", "Postgres", "pg", "mysql", " postgres"]) {
			expect(
				resolveKnowledgeWriteStore({ writeBackend: value }, injectedPgStore),
				`writeBackend=${JSON.stringify(value)}`,
			).toBe(sqliteKnowledgeWriteStore);
		}
		for (const value of [42, true, {}, ["postgres"], null]) {
			expect(resolveKnowledgeWriteStore({ writeBackend: value }, injectedPgStore)).toBe(
				sqliteKnowledgeWriteStore,
			);
		}
	});

	test("an explicit postgres selection resolves to the injected adapter", () => {
		expect(
			resolveKnowledgeWriteStore(
				{ writeBackend: "postgres", readBackend: "postgres" },
				injectedPgStore,
			),
		).toBe(injectedPgStore);
	});

	test("an explicit postgres selection with no adapter is an error, never a fallback", () => {
		expect(() =>
			resolveKnowledgeWriteStore({ writeBackend: "postgres", readBackend: "postgres" }, undefined),
		).toThrow(/unavailable|no store/);
	});

	test("a write/read mismatch throws: one process, one database", () => {
		expect(() =>
			resolveKnowledgeWriteStore(
				{ writeBackend: "postgres", readBackend: "sqlite" },
				injectedPgStore,
			),
		).toThrow(/does not match/);
		expect(() =>
			resolveKnowledgeWriteStore({ writeBackend: "sqlite", readBackend: "postgres" }, undefined),
		).toThrow(/does not match/);
	});

	test("the environment-resolved default IS the SQLite implementation", async () => {
		const { knowledgeWriteStore } = await import("../store");
		expect(knowledgeWriteStore).toBe(sqliteKnowledgeWriteStore);
	});
});
