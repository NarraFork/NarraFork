/**
 * Unit coverage for the PostgreSQL runtime queue adapter that needs NO database:
 * the boundary behavior (whole-section retry + conflict vocabulary), the fail-closed
 * legacy surface, the schema probe, and the composition-root binding.
 *
 * The fake `db` rejects from `transaction()` BEFORE the section runs, so no drizzle
 * query-builder chain is exercised here — that is deliberate. Statement semantics
 * (SKIP LOCKED claim, idempotent enqueue, materialize, outbox transfer) are verified
 * against a real PostgreSQL in
 * `tests/server/services/agent-runtime/pg-runtime-queue-adapter.test.ts`; this file
 * pins everything that is true regardless of the engine answering.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { WriteConflictError } from "@server/db/backend/write-port";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { setChapterWriteStore } from "../chapter-write/store";
import { setKnowledgeWriteStore } from "../knowledge/store";
import { composePostgresStores } from "../postgres-composition";
import { setProjectArchiveMainStore } from "../project-archive/store";
import { setProjectReadAdapter } from "../read";
import { setRegistrationAccountStore } from "../registration/store";
import { unbindPostgresSearchClientForTests } from "../search/postgres-store";
import { requirePublicationTx } from "./postgres-runtime-publication";
import {
	createPostgresRuntimeQueue,
	getPostgresRuntimeQueue,
	LegacySourceChangedError,
	probeRuntimeQueueSchema,
	RuntimeQueueSchemaPendingError,
	requirePostgresRuntimeQueue,
	setPostgresRuntimeQueue,
} from "./postgres-runtime-queue";

/** Bun SQL shape: the server SQLSTATE rides on `errno` (see pg-errors.ts). */
function pgError(sqlstate: string, message = `pg ${sqlstate}`): Error {
	return Object.assign(new Error(message), { errno: sqlstate });
}

/** Minimal thenable standing in for an awaited drizzle select chain. */
function fakeSelect(rows: unknown[]) {
	const chain: Record<string, unknown> = {};
	for (const method of ["from", "where", "limit", "orderBy", "for"]) chain[method] = () => chain;
	// biome-ignore lint/suspicious/noThenProperty: intentional thenable — it stands in for drizzle's awaited query builder
	chain.then = (
		onFulfilled?: (value: unknown[]) => unknown,
		onRejected?: (reason: unknown) => unknown,
	) => Promise.resolve(rows).then(onFulfilled, onRejected);
	return chain;
}

function fakeDb(options: {
	/** Each call to `transaction` rejects with the next error (last one repeats). */
	errors: unknown[];
	selectRows?: unknown[];
	attempts: { count: number };
}): BunSQLDatabase {
	return {
		transaction: () => {
			options.attempts.count += 1;
			const error = options.errors[Math.min(options.attempts.count - 1, options.errors.length - 1)];
			return Promise.reject(error);
		},
		select: () => fakeSelect(options.selectRows ?? []),
	} as unknown as BunSQLDatabase;
}

describe("postgres runtime queue boundary: whole-section retry and error vocabulary", () => {
	test("retryable SQLSTATE (40001) replays the whole section, then rethrows the ORIGINAL error", async () => {
		const attempts = { count: 0 };
		const error = pgError("40001", "could not serialize access");
		const store = createPostgresRuntimeQueue(fakeDb({ errors: [error], attempts }));
		const claim = { id: "m1", narratorId: "n1", token: "t", epoch: "e" };
		const failure = await store.mailbox.failClaim(claim, "boom").then(
			() => null,
			(rejected: unknown) => rejected,
		);
		// Default maxRetries is 3 retries AFTER the first attempt (pg-retry.ts).
		expect(attempts.count).toBe(4);
		// Identity is diagnostic evidence: never wrapped, never translated.
		expect(failure).toBe(error);
	});

	test("unique violation (23505) is never retried and crosses as WriteConflictError", async () => {
		const attempts = { count: 0 };
		const store = createPostgresRuntimeQueue(
			fakeDb({ errors: [pgError("23505", "duplicate key")], attempts }),
		);
		const claim = { id: "m1", narratorId: "n1", token: "t", epoch: "e" };
		const failure = await store.mailbox.failClaim(claim, "boom").then(
			() => null,
			(rejected: unknown) => rejected,
		);
		expect(attempts.count).toBe(1);
		expect(failure).toBeInstanceOf(WriteConflictError);
	});

	test("non-retryable SQLSTATE (42883) and unrecognized errors pass through untouched, once", async () => {
		for (const error of [pgError("42883", "undefined function"), new Error("socket closed")]) {
			const attempts = { count: 0 };
			const store = createPostgresRuntimeQueue(fakeDb({ errors: [error], attempts }));
			const claim = { id: "m1", narratorId: "n1", token: "t", epoch: "e" };
			const failure = await store.mailbox.failClaim(claim, "boom").then(
				() => null,
				(rejected: unknown) => rejected,
			);
			expect(attempts.count).toBe(1);
			expect(failure).toBe(error);
		}
	});

	test("enqueue turns a lost dedupe race (23505) into the duplicate receipt it raced with", async () => {
		const attempts = { count: 0 };
		const delivery = { id: "m-existing", deliveryId: "dv-1" };
		const store = createPostgresRuntimeQueue(
			fakeDb({ errors: [pgError("23505", "duplicate key")], selectRows: [delivery], attempts }),
		);
		const result = await store.mailbox.enqueue({
			kind: "user_input",
			narratorId: "n1",
			requestKey: "rk-1",
			text: "hi",
			projectedByteSize: 2,
		});
		expect(attempts.count).toBe(1);
		expect(result.status).toBe("duplicate");
		if (result.status === "duplicate") expect(result.delivery as unknown).toBe(delivery);
	});

	test("enqueue conflict with NO existing row rethrows the conflict — never a fabricated receipt", async () => {
		const attempts = { count: 0 };
		const store = createPostgresRuntimeQueue(
			fakeDb({ errors: [pgError("23505", "duplicate key")], selectRows: [], attempts }),
		);
		const failure = await store.mailbox
			.enqueue({
				kind: "user_input",
				narratorId: "n1",
				requestKey: "rk-1",
				text: "hi",
				projectedByteSize: 2,
			})
			.then(
				() => null,
				(rejected: unknown) => rejected,
			);
		expect(failure).toBeInstanceOf(WriteConflictError);
	});
});

describe("postgres runtime queue: legacy admission activation (real capability gate)", () => {
	const pendingColumns = [
		"background_tasks.insert_seq",
		"narrators.insert_seq",
		"narrator_tool_continuations.insert_seq",
	];

	test("default-constructed store has verified NOTHING and blocks legacy admission (activation)", async () => {
		const store = createPostgresRuntimeQueue({} as BunSQLDatabase);
		expect(store.backendId).toBe("postgres");
		expect(store.schemaReadiness).toEqual({
			insertSeqOrdinal: "unknown",
			pendingSchema: pendingColumns,
			legacyAdmission: "blocked",
		});
		for (const invoke of [
			() =>
				store.legacy.registerLegacyRunningRunSlots(
					{ producerKind: "bash", taskId: "t", recipientId: "r" },
					{ kind: "persisted_task" },
				),
			() =>
				store.legacy.registerLegacyUnknownBashFailure({
					producerKind: "bash",
					taskId: "t",
					recipientId: "r",
				}),
			() =>
				store.legacy.registerLegacyCompletedRunSlots({
					producerKind: "agent",
					taskId: "t",
					recipientId: "r",
				}),
		]) {
			const failure = await invoke().then(
				() => null,
				(rejected: unknown) => rejected,
			);
			expect(failure).toBeInstanceOf(RuntimeQueueSchemaPendingError);
			// Not probed yet: the failure names ACTIVATION, not a schema verdict.
			expect((failure as RuntimeQueueSchemaPendingError).reason).toBe("activation");
		}
	});

	/** Fake handle for activation: db.execute answers the catalog probe; db.transaction runs the capture section. */
	function fakeActivationDb(options: {
		probeTables: string[];
		maxima?: Record<string, unknown>;
		probeCalls: { count: number };
	}): BunSQLDatabase {
		return {
			transaction: (cb: (tx: unknown) => Promise<unknown>) => {
				let txExecute = 0;
				const tx = {
					execute: () => {
						txExecute += 1;
						// Timeout statements, catalog probe, lock, then the maxima capture.
						if (txExecute === 3) {
							options.probeCalls.count += 1;
							return Promise.resolve(options.probeTables.map((table_name) => ({ table_name })));
						}
						if (txExecute !== 5) return Promise.resolve([]);
						return Promise.resolve([
							options.maxima ?? { background_top: 7, narrator_top: 3, checkpoint_top: null },
						]);
					},
				};
				return cb(tx);
			},
		} as unknown as BunSQLDatabase;
	}

	test("activation probes the live catalog, captures the boundary once, then unlocks", async () => {
		const probeCalls = { count: 0 };
		const store = createPostgresRuntimeQueue(
			fakeActivationDb({
				probeTables: ["background_tasks", "narrators", "narrator_tool_continuations"],
				probeCalls,
			}),
		);
		const readiness = await store.activateLegacyAdmission();
		expect(readiness).toEqual({
			insertSeqOrdinal: "available",
			pendingSchema: [],
			legacyAdmission: "available",
		});
		expect(store.schemaReadiness.legacyAdmission).toBe("available");
		// A null top (empty table) collapses to 0 without failing activation.
		// Idempotent: a second activation does NOT re-probe or re-capture.
		const again = await store.activateLegacyAdmission();
		expect(again.legacyAdmission).toBe("available");
		expect(probeCalls.count).toBe(1);
	});

	test("activation with a missing column stays blocked with the exact pending list — and is re-runnable", async () => {
		const probeCalls = { count: 0 };
		// First probe: narrators lacks insert_seq (i.e. only two tables report it).
		const handle = { probeTables: ["background_tasks", "narrator_tool_continuations"], probeCalls };
		const db = fakeActivationDb(handle);
		const store = createPostgresRuntimeQueue(db);
		const missing = await store.activateLegacyAdmission();
		expect(missing).toEqual({
			insertSeqOrdinal: "missing",
			pendingSchema: ["narrators.insert_seq"],
			legacyAdmission: "blocked",
		});
		const failure = await store.legacy
			.registerLegacyUnknownBashFailure({ producerKind: "bash", taskId: "t", recipientId: "r" })
			.then(
				() => null,
				(rejected: unknown) => rejected,
			);
		expect(failure).toBeInstanceOf(RuntimeQueueSchemaPendingError);
		expect((failure as RuntimeQueueSchemaPendingError).reason).toBe("schema");
		expect((failure as RuntimeQueueSchemaPendingError).pendingSchema).toEqual([
			"narrators.insert_seq",
		]);
		// The schema lands; activation is re-runnable and now succeeds.
		handle.probeTables = ["background_tasks", "narrators", "narrator_tool_continuations"];
		const activated = await store.activateLegacyAdmission();
		expect(activated.legacyAdmission).toBe("available");
		expect(probeCalls.count).toBe(2);
	});

	test("activation failure rethrows and leaves the store blocked — never partially applied", async () => {
		const db = {
			transaction: () => Promise.reject(new Error("connection reset")),
		} as unknown as BunSQLDatabase;
		const store = createPostgresRuntimeQueue(db);
		const failure = await store.activateLegacyAdmission().then(
			() => null,
			(rejected: unknown) => rejected,
		);
		expect((failure as Error).message).toBe("connection reset");
		expect(store.schemaReadiness.legacyAdmission).toBe("blocked");
		expect(store.schemaReadiness.insertSeqOrdinal).toBe("unknown");
	});

	test("probeRuntimeQueueSchema reports exactly which insert_seq columns are absent", async () => {
		const probe = (tables: string[]) => ({
			unsafe: () => Promise.resolve(tables.map((table_name) => ({ table_name }))),
		});
		const missing = await probeRuntimeQueueSchema(probe(["narrators"]));
		expect(missing.insertSeqOrdinal).toBe("missing");
		expect(missing.pendingSchema).toEqual([
			"background_tasks.insert_seq",
			"narrator_tool_continuations.insert_seq",
		]);
		expect(missing.legacyAdmission).toBe("blocked");
		const available = await probeRuntimeQueueSchema(
			probe(["background_tasks", "narrators", "narrator_tool_continuations"]),
		);
		expect(available.insertSeqOrdinal).toBe("available");
		expect(available.pendingSchema).toEqual([]);
	});
});

describe("postgres runtime queue: producer-half admission/read surface (P2)", () => {
	const agentInput = {
		kind: "agent_message" as const,
		narratorId: "n1",
		text: "hello",
		projectedByteSize: 4096 + 5,
		sourceNarratorId: "sender",
		sourceToolCallId: "tc-1",
		sourceAttempt: 1,
		sourceKey: "send",
	};
	const receipt = { toolCallId: "tc-1", attempt: 1, narratorId: "sender", toolUseId: "tu-1" };

	/** Captures BOTH a synchronous validation throw and an async rejection. */
	const captureInvoke = async (invoke: () => Promise<unknown>) => {
		try {
			return await invoke().then(
				() => null,
				(rejected: unknown) => rejected,
			);
		} catch (thrown) {
			return thrown;
		}
	};

	test("admitAgentMessage rejects an invalid receipt BEFORE touching the database", async () => {
		const attempts = { count: 0 };
		const store = createPostgresRuntimeQueue(fakeDb({ errors: [], attempts }));
		for (const bad of [
			{ ...receipt, toolCallId: "" },
			{ ...receipt, attempt: 0 },
			{ ...receipt, attempt: 1.5 },
			{ ...receipt, toolUseId: "" },
		]) {
			const failure = await captureInvoke(() => store.mailbox.admitAgentMessage(agentInput, bad));
			expect(failure).toBeInstanceOf(Error);
		}
		expect(attempts.count).toBe(0);
	});

	test("admitAgentMessage turns a lost dedupe race (23505) into the duplicate it raced with", async () => {
		const attempts = { count: 0 };
		const existing = { id: "m-existing", deliveryId: "dv-1" };
		const store = createPostgresRuntimeQueue(
			fakeDb({ errors: [pgError("23505", "duplicate key")], selectRows: [existing], attempts }),
		);
		const result = await store.mailbox.admitAgentMessage(agentInput, receipt);
		expect(attempts.count).toBe(1);
		expect(result.status).toBe("duplicate");
		if (result.status === "duplicate") expect(result.delivery as unknown).toBe(existing);
	});

	test("admitAgentMessage retries a retryable SQLSTATE as ONE whole section, then rethrows", async () => {
		const attempts = { count: 0 };
		const error = pgError("40001", "could not serialize access");
		const store = createPostgresRuntimeQueue(fakeDb({ errors: [error], attempts }));
		const failure = await store.mailbox.admitAgentMessage(agentInput, receipt).then(
			() => null,
			(rejected: unknown) => rejected,
		);
		expect(attempts.count).toBe(4);
		expect(failure).toBe(error);
	});

	test("admitUserBuffered shares the enqueue conflict vocabulary (23505 → duplicate)", async () => {
		const attempts = { count: 0 };
		const existing = { id: "m-existing", deliveryId: "dv-1" };
		const store = createPostgresRuntimeQueue(
			fakeDb({ errors: [pgError("23505", "duplicate key")], selectRows: [existing], attempts }),
		);
		const result = await store.mailbox.admitUserBuffered(
			{ kind: "user_input", narratorId: "n1", text: "hi", projectedByteSize: 2 },
			{ position: "front", frontOrder: "fifo" },
		);
		expect(result.status).toBe("duplicate");
		if (result.status === "duplicate") expect(result.delivery as unknown).toBe(existing);
	});

	test("updateUserBuffered validates revision and byte size BEFORE any query", async () => {
		const attempts = { count: 0 };
		const store = createPostgresRuntimeQueue(fakeDb({ errors: [], attempts }));
		const patch = {
			text: "body",
			byteSize: 4,
			payloadRefJson: null,
			imagesJson: null,
			textFilePathsJson: null,
			fileReferencesJson: null,
			metadataJson: "{}",
		};
		for (const invoke of [
			() => store.mailbox.updateUserBuffered("m1", "n1", patch, 0),
			() => store.mailbox.updateUserBuffered("m1", "n1", patch, 1.5),
			() => store.mailbox.updateUserBuffered("m1", "n1", { ...patch, byteSize: 1 }, 1),
		]) {
			const failure = await captureInvoke(invoke);
			expect(failure).toBeInstanceOf(Error);
		}
		expect(attempts.count).toBe(0);
	});

	test("updateUserBuffered/reorderUserPending/recordDeliveryConsumption retry as whole sections", async () => {
		for (const invoke of [
			(store: ReturnType<typeof createPostgresRuntimeQueue>) =>
				store.mailbox.updateUserBuffered(
					"m1",
					"n1",
					{
						text: "body",
						byteSize: 4,
						payloadRefJson: null,
						imagesJson: null,
						textFilePathsJson: null,
						fileReferencesJson: null,
						metadataJson: "{}",
					},
					1,
				),
			(store: ReturnType<typeof createPostgresRuntimeQueue>) =>
				store.mailbox.reorderUserPending("n1", ["a", "b"]),
			(store: ReturnType<typeof createPostgresRuntimeQueue>) =>
				store.mailbox.recordDeliveryConsumption(
					{ deliveryId: "d1", recipientNarratorId: "n1" },
					new Date(0).toISOString(),
				),
		]) {
			const attempts = { count: 0 };
			const error = pgError("55P03", "lock not available");
			const store = createPostgresRuntimeQueue(fakeDb({ errors: [error], attempts }));
			const failure = await invoke(store).then(
				() => null,
				(rejected: unknown) => rejected,
			);
			expect(attempts.count).toBe(4);
			expect(failure).toBe(error);
		}
	});

	test("reorderUserPending rejects invalid identity pointers BEFORE any query", async () => {
		const attempts = { count: 0 };
		const store = createPostgresRuntimeQueue(fakeDb({ errors: [], attempts }));
		const failure = await captureInvoke(() => store.mailbox.reorderUserPending("n1", ["ok", ""]));
		expect(failure).toBeInstanceOf(Error);
		expect(attempts.count).toBe(0);
	});

	test("recordDeliveryConsumption rejects an unparseable consumption time BEFORE any query", async () => {
		const attempts = { count: 0 };
		const store = createPostgresRuntimeQueue(fakeDb({ errors: [], attempts }));
		const failure = await captureInvoke(() =>
			store.mailbox.recordDeliveryConsumption(
				{ deliveryId: "d1", recipientNarratorId: "n1" },
				"not-a-date",
			),
		);
		expect(failure).toBeInstanceOf(Error);
		expect(attempts.count).toBe(0);
	});

	test("read-only probes answer directly from the handle and never open a transaction", async () => {
		const attempts = { count: 0 };
		const row = { state: "materialized", currentMessageId: "m9", recipientMessageId: "m0" };
		const store = createPostgresRuntimeQueue(fakeDb({ errors: [], selectRows: [row], attempts }));
		expect(await store.mailbox.getStateById("m1", "n1")).toBe(row);
		expect(await store.mailbox.hasQueuedKind("n1", [])).toBe(false);
		expect(await store.mailbox.hasQueuedKind("n1", ["agent_message"])).toBe(true);
		expect((await store.mailbox.getById("m1")) as unknown).toBe(row);
		expect((await store.mailbox.getByStagingId("n1", "stage-1")) as unknown).toBe(row);
		expect((await store.mailbox.readRecipientRoute("n1")) as unknown).toBe(row);
		expect(await store.mailbox.listMaterializedReceipts("n1", [])).toEqual([]);
		expect(attempts.count).toBe(0);
	});
});

describe("postgres runtime queue: composition-root binding (the P2 consumption point)", () => {
	afterAll(() => {
		// Restore environment-resolved defaults, mirroring postgres-composition.test.ts, so no
		// later test file in this process keeps stubbed stores.
		setPostgresRuntimeQueue(undefined);
		setRegistrationAccountStore(undefined);
		setKnowledgeWriteStore(undefined);
		setChapterWriteStore(undefined);
		setProjectArchiveMainStore(undefined);
		setProjectReadAdapter(undefined);
		unbindPostgresSearchClientForTests();
	});

	test("publicationTx exposes the queue-owned transaction primitives and preserves the exported legacy race error", () => {
		const db = {} as BunSQLDatabase;
		const store = createPostgresRuntimeQueue(db);
		const primitives = requirePublicationTx(store);
		expect(primitives.handle).toBe(db);
		for (const key of [
			"persistLogicalRun",
			"reserveRunSlots",
			"commitIntent",
			"registerLegacyRunningRunSlots",
			"registerLegacyUnknownBashFailure",
			"registerLegacyCompletedRunSlots",
			"freezeLegacyCompletionEvidence",
		] as const)
			expect(typeof primitives[key]).toBe("function");
		expect(new LegacySourceChangedError("race").name).toBe("LegacySourceChangedError");
	});

	test("unbound access fails closed; the seam injects a queue store whose readiness is honestly blocked", async () => {
		setPostgresRuntimeQueue(undefined);
		expect(getPostgresRuntimeQueue()).toBeUndefined();
		expect(() => requirePostgresRuntimeQueue()).toThrow(/not bound/);

		// The minimal composition seam: one stub runtime in, the queue store bound. The
		// stub's db is never queried at construction time (injection is lazy).
		composePostgresStores({
			backend: "postgres",
			client: {
				sql: { unsafe: () => Promise.resolve([]) },
				db: {},
				close: () => Promise.resolve(),
			},
			executor: { unsafe: () => Promise.resolve([]) },
			migration: { folder: "/stub" },
			probeFtsDrift: () => Promise.reject(new Error("stub")),
			readMigrationState: () => Promise.resolve([]),
			closed: false,
			close: () => Promise.resolve(),
			// biome-ignore lint/suspicious/noExplicitAny: stub runtime matches postgres-composition.test.ts
		} as any);

		const bound = getPostgresRuntimeQueue();
		expect(bound).toBeDefined();
		if (!bound) throw new Error("composition seam did not bind the queue store");
		expect(requirePostgresRuntimeQueue()).toBe(bound);
		// The interface P2 wires against: mailbox + outbox + legacy surfaces exist.
		for (const key of [
			"enqueue",
			"claimEligibleHead",
			"claimBatch",
			"materialize",
			"failClaim",
		] as const)
			expect(typeof bound?.mailbox[key]).toBe("function");
		for (const key of ["reserveRunSlots", "commitIntent", "transferNext", "listPending"] as const)
			expect(typeof bound?.outbox[key]).toBe("function");
		// Construction alone is NOT capability proof. Startup must explicitly activate;
		// that production caller wiring is intentionally outside this change.
		expect(bound?.schemaReadiness.insertSeqOrdinal).toBe("unknown");
		expect(bound?.schemaReadiness.legacyAdmission).toBe("blocked");
		const failure = await bound?.legacy
			.registerLegacyUnknownBashFailure({ producerKind: "bash", taskId: "t", recipientId: "r" })
			.then(
				() => null,
				(rejected: unknown) => rejected,
			);
		expect(failure).toBeInstanceOf(RuntimeQueueSchemaPendingError);
	});
});
