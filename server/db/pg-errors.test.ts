import { describe, expect, test } from "bun:test";
import { bunPgError, bunSqlError, drizzleWrap, nodePgError } from "./__tests__/pg-test-factories";
import {
	classifyPgError,
	extractSqlstate,
	isPgUniqueViolation,
	isRetryablePgError,
} from "./pg-errors";

/**
 * The factories stand in for the shapes the layers between PostgreSQL and this process
 * actually throw: node-pg / postgres.js (`code` = SQLSTATE), Bun SQL's `PostgresError`
 * (`errno` = SQLSTATE, `code` = Bun's own error identity — verified against Bun 1.4.2
 * throwing for a real PostgreSQL 17), and Drizzle's wrapping (`cause` on the instance).
 */

describe("extractSqlstate", () => {
	test("reads the SQLSTATE off a Bun SQL / postgres.js shape", () => {
		expect(extractSqlstate(bunPgError("40001", "could not serialize access"))).toBe("40001");
	});

	test("reads the SQLSTATE off a node-pg shape", () => {
		expect(extractSqlstate(nodePgError("40P01", "deadlock detected"))).toBe("40P01");
	});

	test("reads the SQLSTATE off the real Bun SQL shape (`errno`, not `code`)", () => {
		// Bun's own `code` (`ERR_POSTGRES_SERVER_ERROR`) must NOT be mistaken for a
		// SQLSTATE, and the server's verdict must still be found.
		expect(extractSqlstate(bunSqlError("23505", "duplicate key"))).toBe("23505");
		expect(extractSqlstate(drizzleWrap(bunSqlError("40001", "serialization")))).toBe("40001");
	});

	test("follows a Drizzle `cause` chain to the driver error", () => {
		expect(extractSqlstate(drizzleWrap(bunPgError("55P03", "lock not available")))).toBe("55P03");
	});

	test("follows a double-wrapped cause chain", () => {
		const doubleWrapped = new Error("transaction rolled back", {
			cause: drizzleWrap(nodePgError("40001", "serialization failure")),
		});
		expect(extractSqlstate(doubleWrapped)).toBe("40001");
	});

	test("accepts a thrown plain object carrying a code", () => {
		expect(extractSqlstate({ code: "23505" })).toBe("23505");
	});

	test("a cyclic cause chain terminates as unextractable instead of hanging", () => {
		const error = new Error("self-referencing") as Error & Record<string, unknown>;
		error.cause = error;
		expect(extractSqlstate(error)).toBeNull();
	});

	test.each([
		{ value: null, why: "null" },
		{ value: undefined, why: "undefined" },
		{ value: 42, why: "a number" },
		{ value: "40001", why: "a bare string — the message is never a source of truth" },
		{ value: new Error("deadlock detected"), why: "message text without a code" },
		{ value: { code: 40001 }, why: "a numeric code" },
		{ value: { code: "40001 " }, why: "a padded code" },
		{ value: { code: "400010" }, why: "a six-character code" },
		{ value: { code: "40p01" }, why: "a lowercase code — drivers report uppercase" },
		{ value: { code: "ECONNREFUSED" }, why: "a Node system error code" },
		{ value: {}, why: "an empty object" },
	])("extracts nothing from $why", ({ value }) => {
		expect(extractSqlstate(value)).toBeNull();
	});
});

describe("classifyPgError", () => {
	test.each([
		{ code: "40001", name: "serialization_failure" },
		{ code: "40P01", name: "deadlock_detected" },
		{ code: "55P03", name: "lock_not_available" },
	])("classifies $code ($name) as retryable", ({ code }) => {
		expect(classifyPgError(bunPgError(code, "transient"))).toEqual({
			kind: "retryable",
			sqlstate: code,
		});
		expect(isRetryablePgError(bunPgError(code, "transient"))).toBe(true);
	});

	test("classifies 23505 as a unique violation, NEVER as retryable", () => {
		const error = bunPgError("23505", "duplicate key value violates unique constraint");
		expect(classifyPgError(error)).toEqual({ kind: "unique-violation", sqlstate: "23505" });
		expect(isRetryablePgError(error)).toBe(false);
		expect(isPgUniqueViolation(error)).toBe(true);
		// …including when Drizzle wrapped it: the routing decision must survive wrapping.
		const wrapped = drizzleWrap(error);
		expect(classifyPgError(wrapped)).toEqual({ kind: "unique-violation", sqlstate: "23505" });
		expect(isRetryablePgError(wrapped)).toBe(false);
		// …and including the real Bun SQL shape, where the SQLSTATE is in `errno`.
		const bunShape = drizzleWrap(bunSqlError("23505", "duplicate key"));
		expect(classifyPgError(bunShape)).toEqual({ kind: "unique-violation", sqlstate: "23505" });
		expect(isPgUniqueViolation(bunShape)).toBe(true);
		expect(isRetryablePgError(bunShape)).toBe(false);
	});

	test("classifies the real Bun SQL retryable shapes as retryable", () => {
		for (const sqlstate of ["40001", "40P01", "55P03"]) {
			expect(classifyPgError(bunSqlError(sqlstate, "transient"))).toEqual({
				kind: "retryable",
				sqlstate,
			});
			expect(isRetryablePgError(drizzleWrap(bunSqlError(sqlstate, "transient")))).toBe(true);
		}
	});

	test.each([
		{ code: "23502", name: "not_null_violation" },
		{ code: "23503", name: "foreign_key_violation" },
		{ code: "23514", name: "check_violation" },
		{ code: "42601", name: "syntax_error" },
		{ code: "42P01", name: "undefined_table" },
		{ code: "08P01", name: "protocol_violation" },
		{ code: "53300", name: "too_many_connections" },
		{ code: "58030", name: "io_error" },
	])("classifies $code ($name) as non-retryable", ({ code }) => {
		expect(classifyPgError(nodePgError(code, "content fault"))).toEqual({
			kind: "non-retryable",
			sqlstate: code,
		});
		expect(isRetryablePgError(nodePgError(code, "content fault"))).toBe(false);
	});

	test("an error whose message SAYS deadlock but carries no SQLSTATE is not retried", () => {
		// This is the whole point of SQLSTATE-based classification: message matching would
		// retry this; the classifier must not.
		const messageOnly = new Error("deadlock detected");
		expect(classifyPgError(messageOnly)).toEqual({ kind: "unrecognized", sqlstate: null });
		expect(isRetryablePgError(messageOnly)).toBe(false);
	});

	test("a message containing a SQLSTATE-looking substring is still not a source of truth", () => {
		const error = new Error("driver said 40001 somewhere in this sentence");
		expect(isRetryablePgError(error)).toBe(false);
	});
});
