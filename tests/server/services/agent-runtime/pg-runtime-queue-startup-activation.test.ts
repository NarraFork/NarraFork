/**
 * Production-schema proof for the STARTUP activation wiring: against a disposable
 * PostgreSQL 17 carrying the complete committed drizzle-postgres journal, the
 * composition-level gate (`activatePostgresRuntimeQueue`) must turn a freshly
 * constructed, unprobed queue store into an activated one — and cancellation must
 * fail closed with no boundary published.
 *
 * Store-level legacy admission semantics (proofs, cutoff, retries, rollback) are
 * covered by pg-runtime-queue-legacy.test.ts; this suite pins the wiring phase 1 adds:
 * construction queries nothing, activation succeeds only after the full journal, and
 * the selector serves the bound queue to production accessors.
 */
import { expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import {
	createPostgresRuntimeQueue,
	requirePostgresRuntimeQueue,
} from "../../../../server/services/agent-runtime/postgres-runtime-queue";
import {
	bindRuntimeQueue,
	resolveRuntimeQueueBackend,
} from "../../../../server/services/agent-runtime/runtime-queue-port";
import { activatePostgresRuntimeQueue } from "../../../../server/services/postgres-composition";
import { withPostgres } from "../../../db/pg-test-harness";

test.skipIf(process.env.PG_INTEGRATION !== "1")(
	"startup activation over the full production journal: success, idempotence, cancellation fail-closed",
	async () => {
		const result = await withPostgres(async ({ port, credentials }) => {
			const client = createPostgresClient({
				driver: "bun-sql",
				url: `postgres://${credentials.user}:${credentials.password}@127.0.0.1:${port}/${credentials.database}`,
				max: 4,
				connectTimeout: 10,
			});
			try {
				const db = client.db;
				// The COMPLETE on-disk journal, applied by the real migrator — activation is
				// only meaningful against the schema production actually runs.
				await migrate(db, { migrationsFolder: "drizzle-postgres" });
				const journal = readMigrationFiles({ migrationsFolder: "drizzle-postgres" });
				const ledger = await client.sql.unsafe(
					"SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
				);
				expect(ledger.map((r: { hash: string }) => r.hash)).toEqual(
					journal.map((entry) => entry.hash),
				);
				const version = await client.sql.unsafe(
					"SELECT current_setting('server_version_num')::int AS version",
				);
				expect(Number(version[0].version)).toBeGreaterThanOrEqual(170000);

				// Construction bound nothing and probed nothing.
				const queue = createPostgresRuntimeQueue(db);
				expect(queue.schemaReadiness).toEqual({
					insertSeqOrdinal: "unknown",
					pendingSchema: [
						"background_tasks.insert_seq",
						"narrators.insert_seq",
						"narrator_tool_continuations.insert_seq",
					],
					legacyAdmission: "blocked",
				});

				bindRuntimeQueue({ backend: "postgres", queue });
				try {
					expect(resolveRuntimeQueueBackend()).toBe("postgres");
					expect(requirePostgresRuntimeQueue()).toBe(queue);

					// The startup gate: full journal present → probe + boundary capture succeed.
					const readiness = await activatePostgresRuntimeQueue();
					expect(readiness).toEqual({
						insertSeqOrdinal: "available",
						pendingSchema: [],
						legacyAdmission: "available",
					});
					expect(queue.schemaReadiness.legacyAdmission).toBe("available");

					// Idempotent: a second startup activation does not re-probe or re-capture.
					const again = await activatePostgresRuntimeQueue();
					expect(again.legacyAdmission).toBe("available");

					// The activated queue actually serves a legacy operation's gate (the
					// operation itself fails on fixture data, NOT on the activation gate).
					const failure = await queue.legacy
						.registerLegacyUnknownBashFailure({
							producerKind: "bash",
							taskId: "missing-task",
							recipientId: "missing-parent",
						})
						.then(
							() => null,
							(rejected: unknown) => rejected,
						);
					expect(failure).toBeInstanceOf(Error);
					expect((failure as Error).name).not.toBe("RuntimeQueueSchemaPendingError");
				} finally {
					bindRuntimeQueue(undefined);
				}

				// Cancellation before activation publishes nothing and stays fail-closed.
				const cancelled = createPostgresRuntimeQueue(db);
				const controller = new AbortController();
				controller.abort();
				const cancellation = await cancelled
					.activateLegacyAdmission({ signal: controller.signal })
					.then(
						() => null,
						(rejected: unknown) => rejected,
					);
				expect(cancellation).toBeInstanceOf(Error);
				expect(cancelled.schemaReadiness.legacyAdmission).toBe("blocked");
				expect(cancelled.schemaReadiness.insertSeqOrdinal).toBe("unknown");

				return "verified";
			} finally {
				await client.close();
			}
		});
		expect(result).toBe("verified");
	},
	120_000,
);
