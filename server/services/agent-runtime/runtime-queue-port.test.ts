/**
 * Unit coverage for the runtime queue port module: the bound selector's fail-closed
 * semantics and the backend-neutral shapes' compatibility with BOTH dialect rows.
 * No database is needed — the selector only parses configuration and holds a binding.
 */
import { afterEach, expect, test } from "bun:test";
import type { MailboxRow } from "./mailbox-types";
import type { PgMailboxRow, PostgresRuntimeQueue } from "./postgres-runtime-queue";
import {
	bindRuntimeQueue,
	getRuntimeQueuePort,
	type RuntimeMailboxRow,
	type RuntimeMailboxStagingLookup,
	requireRuntimeQueuePort,
	resolveRuntimeQueueBackend,
} from "./runtime-queue-port";

const previous = { write: process.env.NF_WRITE_BACKEND, read: process.env.NF_READ_BACKEND };
afterEach(() => {
	bindRuntimeQueue(undefined);
	if (previous.write === undefined) delete process.env.NF_WRITE_BACKEND;
	else process.env.NF_WRITE_BACKEND = previous.write;
	if (previous.read === undefined) delete process.env.NF_READ_BACKEND;
	else process.env.NF_READ_BACKEND = previous.read;
});

test("SQLite default has no bound port and resolves without opening anything", () => {
	delete process.env.NF_WRITE_BACKEND;
	delete process.env.NF_READ_BACKEND;
	expect(resolveRuntimeQueueBackend()).toBe("sqlite");
	expect(getRuntimeQueuePort()).toBeUndefined();
	// On the SQLite backend the fail-closed accessor must NOT pretend a PG queue exists.
	expect(() => requireRuntimeQueuePort()).toThrow(/not bound/);
});

test("explicit PostgreSQL without a binding fails closed", () => {
	process.env.NF_WRITE_BACKEND = "postgres";
	process.env.NF_READ_BACKEND = "postgres";
	expect(() => resolveRuntimeQueueBackend()).toThrow("unavailable");
	expect(() => getRuntimeQueuePort()).toThrow("unavailable");
	expect(() => requireRuntimeQueuePort()).toThrow("unavailable");
});

test("mismatched read/write configuration cannot silently select SQLite", () => {
	process.env.NF_WRITE_BACKEND = "sqlite";
	process.env.NF_READ_BACKEND = "postgres";
	expect(() => resolveRuntimeQueueBackend()).toThrow("does not match");
	expect(() => getRuntimeQueuePort()).toThrow("does not match");
});

test("a PostgreSQL binding wins over configuration and disposal restores fail-closed", () => {
	process.env.NF_WRITE_BACKEND = "postgres";
	process.env.NF_READ_BACKEND = "postgres";
	const queue = { backendId: "postgres" } as unknown as PostgresRuntimeQueue;
	bindRuntimeQueue({ backend: "postgres", queue });
	expect(resolveRuntimeQueueBackend()).toBe("postgres");
	expect(getRuntimeQueuePort()).toBe(queue);
	expect(requireRuntimeQueuePort()).toBe(queue);
	bindRuntimeQueue(undefined);
	expect(() => getRuntimeQueuePort()).toThrow("unavailable");
});

test("an explicit SQLite binding resolves to SQLite with no port, ignoring PG env", () => {
	process.env.NF_WRITE_BACKEND = "postgres";
	process.env.NF_READ_BACKEND = "postgres";
	bindRuntimeQueue({ backend: "sqlite" });
	expect(resolveRuntimeQueueBackend()).toBe("sqlite");
	expect(getRuntimeQueuePort()).toBeUndefined();
});

test("both dialect rows satisfy the neutral RuntimeMailboxRow shape", () => {
	// The assertion is the COMPILE step: this file fails type-checking if either the
	// SQLite `MailboxRow` or the PG `PgMailboxRow` stops being assignable to the
	// backend-neutral shape the facade speaks.
	const sqliteRow = null as unknown as MailboxRow;
	const pgRow = null as unknown as PgMailboxRow;
	const fromSqlite: RuntimeMailboxRow = sqliteRow;
	const fromPg: RuntimeMailboxRow = pgRow;
	expect(fromSqlite).toBe(fromPg);
});

test("staging ownership lookup is a required minimal adapter contract", async () => {
	const adapter = {
		getByStagingId: async (_narratorId: string, _stagingId: string) => undefined,
	} satisfies RuntimeMailboxStagingLookup;
	expect(await adapter.getByStagingId("n1", "stage-1")).toBeUndefined();
});
