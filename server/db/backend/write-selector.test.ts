import { describe, expect, test } from "bun:test";
import { selectReadBackend } from "./read-selector";
import { assertWriteBackendMatchesRead, selectWriteBackend } from "./write-selector";

describe("write backend selector", () => {
	test.each([
		{ value: undefined },
		{ value: "" },
		{ value: "sqlite" },
		{ value: "sqlite3" },
		{ value: "bun-sqlite" },
	])("defaults $value to SQLite", ({ value }) => {
		expect(selectWriteBackend(value)).toEqual({ backend: "sqlite", write: true });
	});

	test("selects PostgreSQL only for the exact explicit value", () => {
		expect(selectWriteBackend("postgres")).toEqual({ backend: "postgres", write: true });
	});

	test.each([
		{ value: "Postgres" },
		{ value: "POSTGRES" },
		{ value: "postgres " },
		{ value: "mysql" },
		{ value: "postgres;drop table" },
		{ value: 42 },
		{ value: {} },
		{ value: [] },
	])("fails closed for $value", ({ value }) => {
		expect(selectWriteBackend(value)).toEqual({ backend: "sqlite", write: true });
	});

	test("does not connect or read configuration during selection", () => {
		expect(selectWriteBackend("postgres")).toEqual({ backend: "postgres", write: true });
	});

	test("reports unavailable PostgreSQL explicitly instead of falling back", () => {
		expect(() => selectWriteBackend("postgres", { postgresAvailable: false })).toThrow(
			"PostgreSQL write backend is explicitly selected but unavailable",
		);
	});
});

describe("read/write backend consistency", () => {
	test("accepts a matching SQLite pair, which is the unconfigured default", () => {
		// Neither knob set: the whole process stays on SQLite and PostgreSQL is never selected.
		expect(() =>
			assertWriteBackendMatchesRead(selectWriteBackend(undefined), selectReadBackend(undefined)),
		).not.toThrow();
	});

	test("accepts a matching PostgreSQL pair", () => {
		expect(() =>
			assertWriteBackendMatchesRead(selectWriteBackend("postgres"), selectReadBackend("postgres")),
		).not.toThrow();
	});

	test("rejects a PostgreSQL write path over a SQLite read adapter", () => {
		expect(() =>
			assertWriteBackendMatchesRead(selectWriteBackend("postgres"), selectReadBackend(undefined)),
		).toThrow('Write backend "postgres" does not match read backend "sqlite"');
	});

	test("rejects a SQLite write path over a PostgreSQL read adapter", () => {
		expect(() =>
			assertWriteBackendMatchesRead(selectWriteBackend("sqlite"), selectReadBackend("postgres")),
		).toThrow('Write backend "sqlite" does not match read backend "postgres"');
	});
});
