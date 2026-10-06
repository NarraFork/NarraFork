import { describe, expect, test } from "bun:test";
import { selectReadBackend } from "./read-selector";

describe("read backend selector", () => {
	test.each([
		{ value: undefined },
		{ value: "" },
		{ value: "sqlite" },
		{ value: "sqlite3" },
		{ value: "bun-sqlite" },
	])("defaults $value to SQLite", ({ value }) => {
		expect(selectReadBackend(value)).toEqual({ backend: "sqlite", readOnly: true });
	});

	test("selects PostgreSQL only for the exact explicit value", () => {
		expect(selectReadBackend("postgres")).toEqual({ backend: "postgres", readOnly: true });
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
		expect(selectReadBackend(value)).toEqual({ backend: "sqlite", readOnly: true });
	});

	test("does not connect or read configuration during selection", () => {
		expect(selectReadBackend("postgres")).toEqual({ backend: "postgres", readOnly: true });
	});

	test("reports unavailable PostgreSQL explicitly instead of falling back", () => {
		expect(() => selectReadBackend("postgres", { postgresAvailable: false })).toThrow(
			"PostgreSQL read backend is explicitly selected but unavailable",
		);
	});
});
