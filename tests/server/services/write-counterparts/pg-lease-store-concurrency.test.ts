/**
 * Deterministic PostgreSQL concurrency verification for
 * `PostgresWorkspaceLeaseStore` — the real production store, driven through two
 * or more independent connections against a real PostgreSQL 17 container.
 *
 * WHY THESE TESTS EXIST
 * ---------------------
 * The pre-fix store read the scope row, checked it in memory, and wrote it
 * unconditionally. Two independent connections could pass the same in-memory
 * admission check concurrently and both install a lease with the same fence —
 * an overlap the SQLite immediate transaction cannot produce. Every race below
 * is staged with a device advisory lock held by the TEST (the same key the
 * store computes), so each contender's blocking point and release order are
 * observed through `pg_locks`/`pg_stat_activity` rather than left to
 * `Promise.all` scheduling luck. All calls go through the production store and
 * its production retry wrapper; no production source is modified or wrapped to
 * create these interleavings.
 *
 * THE LOCK DOMAIN, PROVEN BEHAVIORALLY
 * ------------------------------------
 * Overlapping canonical roots (parent/child, or a root whose row does not yet
 * exist) share the physical device. Test 2 proves the serialization boundary is
 * the device, not the scope row: while the test holds the device's advisory
 * lock, admission of a CHILD scope — a different row — cannot proceed, and the
 * surviving lease on the parent still blocks the child with the same durable
 * `needs_verification` code the SQLite coordinator produces.
 *
 * Gates: PG_INTEGRATION=1 is mandatory for the races (a blocked harness is a
 * test failure, never a quiet pass). Migrations are applied exactly as
 * committed. `bun test` serializes files in one process; the module mock below
 * is the same isolation the other PG suites use.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { PostgresClient } from "../../../../server/db/postgres-client";
import { createPostgresClient } from "../../../../server/db/postgres-client";
import {
	fileChangeScopeRecoveries,
	fileChangeScopes,
	users,
	workspaceWriteLeases,
} from "../../../../server/db/postgres-schema";
import { logger } from "../../../../server/lib/logger";
import {
	createFileChangeIdentity,
	type FileChangeScopeIdentity,
} from "../../../../server/services/file-change-identity";
import { createPostgresFileChangeBlobCatalog } from "../../../../server/services/postgres-file-change-blob-catalog";
import { createPostgresFileChangeEvidenceStore } from "../../../../server/services/postgres-file-change-evidence-store";
import { withPostgres } from "../../../db/pg-test-harness";
import { getTestDb } from "../../../setup";
import { migrationSql } from "../read/pg-parity-matrix";

const PG_ENABLED = process.env.PG_INTEGRATION === "1";
const TEST_TIMEOUT_MS = 90_000;

// The lease store's SQLite sibling imports `server/db`; mock it to the isolated
// in-memory database exactly as the other PG suites do — the PG path under test
// never touches it.
const { db: sqliteDb, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../../server/db")) };
mock.module("../../../../server/db", () => ({ db: sqliteDb, sqlite }));

const leaseStoreModule = await import("../../../../server/services/postgres-workspace-lease-store");
const { createPostgresWorkspaceLeaseStore } = leaseStoreModule;
type LeaseStore = InstanceType<(typeof leaseStoreModule)["PostgresWorkspaceLeaseStore"]>;
type DurableLease = Parameters<LeaseStore["registerMutation"]>[0];

const RUNTIME = { runtimeEpoch: "pg-conc-runtime", runtimeGeneration: 3 } as const;

function urlFor(port: number, credentials: { user: string; password: string }): string {
	return `postgres://${encodeURIComponent(credentials.user)}:${encodeURIComponent(
		credentials.password,
	)}@127.0.0.1:${port}/nf_harness`;
}

/** The device advisory key, computed exactly as the store's `lockScopes` does. */
function deviceKey(deviceId: string): bigint {
	return createHash("sha256")
		.update(JSON.stringify(["narrafork.workspace-lease.device.v1", deviceId]))
		.digest()
		.readBigInt64BE();
}

function makeScope(
	tag: string,
	overrides: Partial<FileChangeScopeIdentity> = {},
): FileChangeScopeIdentity {
	return {
		id: `conc-scope-${tag}`,
		sourceInstanceId: `conc-source-${tag}`,
		deviceId: `conc-device-${tag}`,
		workspaceInstanceId: `conc-workspace-${tag}`,
		pathFlavor: "posix",
		canonicalRoot: `/conc/${tag}`,
		...overrides,
	};
}

async function seedScope(pgDb: BunSQLDatabase, scope: FileChangeScopeIdentity): Promise<void> {
	const now = new Date().toISOString();
	await pgDb.insert(fileChangeScopes).values({
		id: scope.id,
		sourceInstanceId: scope.sourceInstanceId,
		deviceId: scope.deviceId,
		workspaceInstanceId: scope.workspaceInstanceId,
		canonicalRoot: scope.canonicalRoot,
		displayRoot: scope.canonicalRoot,
		pathFlavor: scope.pathFlavor,
		status: "active",
		createdAt: now,
		updatedAt: now,
	});
}

async function readRow(pgDb: BunSQLDatabase, scope: FileChangeScopeIdentity) {
	const rows = await pgDb.select().from(fileChangeScopes).where(eq(fileChangeScopes.id, scope.id));
	const row = rows[0];
	if (!row) throw new Error(`scope ${scope.id} vanished`);
	return row;
}

function makeStore(pgDb: BunSQLDatabase, ownerEpoch: string): LeaseStore {
	return createPostgresWorkspaceLeaseStore(pgDb, {
		ownerEpoch,
		readRuntime: () => RUNTIME,
	});
}

function claimOf(
	scope: FileChangeScopeIdentity,
	leaseId: string,
	kind: "write" | "rollback" = "write",
) {
	return { scope, runtime: RUNTIME, leaseId, kind };
}

function leaseOf(
	scope: FileChangeScopeIdentity,
	grant: { fencingToken: number; revision: number },
	leaseId: string,
	pendingMutations: number,
): DurableLease {
	return {
		scope,
		binding: {
			deviceId: scope.deviceId,
			runtimeEpoch: RUNTIME.runtimeEpoch,
			runtimeGeneration: RUNTIME.runtimeGeneration,
			fencingToken: grant.fencingToken,
		},
		leaseId,
		revision: grant.revision,
		pendingMutations,
	};
}

async function seedApplyingEffect(pgDb: BunSQLDatabase, lease: DurableLease, name: string) {
	const evidence = createPostgresFileChangeEvidenceStore(pgDb);
	const requestDigest = createHash("sha256").update(name).digest("hex");
	const operation = await evidence.beginOperation({
		sourceInstanceId: lease.scope.sourceInstanceId,
		sourceKind: "tool",
		sourceId: name,
		attempt: 1,
		requestDigest,
		expectedEffectCount: 1,
		actor: {
			kind: "primary",
			subjectKey: `narrator:${name}`,
			narratorId: null,
			userId: null,
			label: null,
			deleted: false,
			parentSubjectKey: null,
		},
		executionBinding: lease.binding,
		toolCallId: null,
		toolUseId: null,
		narratorId: null,
		projectId: null,
		ownerUserId: null,
		initiatorSubjectKey: null,
		parentOperationId: null,
		executionSegmentId: null,
	});
	const canonicalPath = `${lease.scope.canonicalRoot}/${name}.txt`;
	const identity = createFileChangeIdentity(lease.scope, {
		deviceId: lease.scope.deviceId,
		pathFlavor: lease.scope.pathFlavor,
		lexicalPath: canonicalPath,
		canonicalPath,
		objectRole: "entry",
	});
	const [effect] = await evidence.prepareEffects(operation.id, [
		{
			identity,
			scopeRevision: lease.revision,
			requestDigest,
			before: { kind: "absent" },
			intendedAfter: { kind: "absent" },
		},
	]);
	if (!effect) throw new Error("effect not created");
	await evidence.finalizePreparation(operation.id);
	await evidence.markApplying({
		operationId: operation.id,
		mutationId: effect.mutationId,
		requestDigest,
		executionBinding: lease.binding,
	});
	return { evidence, operation, effect, canonicalPath, requestDigest };
}

function codeOf(error: unknown): string {
	if (error && typeof error === "object" && "code" in error) return String(error.code);
	return String(error);
}

async function settle(
	promise: Promise<unknown>,
): Promise<{ ok: boolean; value?: unknown; code?: string }> {
	try {
		return { ok: true, value: await promise };
	} catch (error) {
		return { ok: false, code: codeOf(error) };
	}
}

/**
 * The staging primitive: hold the device's advisory lock on a DEDICATED
 * connection until `release`. The waiter's blocking is observed through
 * `pg_locks` keyed on the waiter's OWN backend pid (captured from its
 * application_name) — not on a wall-clock guess, and immune to a contender's
 * first attempt finishing inside its retry backoff between polls. The lock is
 * transaction-scoped, so even a crashed release cannot leak it.
 */
async function holdDevice(client: PostgresClient, deviceId: string) {
	const keyText = deviceKey(deviceId).toString();
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const done = (async () => {
		try {
			await client.sql`BEGIN`;
			await client.sql`SELECT pg_advisory_xact_lock(${keyText}::bigint)`;
			await released;
			await client.sql`COMMIT`;
		} catch {
			await client.sql`ROLLBACK`.catch(() => {});
		}
	})();
	return { release, done };
}

/**
 * Stage a contender for a race: label a fresh connection with a unique
 * application_name, run `op` against the PRODUCTION store built on that same
 * labeled client (so the store's own connection is the one observed in
 * `pg_locks`), and resolve with the settled outcome. The label changes nothing
 * the store executes; it only names the backend whose blocking we then wait
 * for. Each staged race uses its OWN client, never a pooled alias.
 */
async function stageRace(
	port: number,
	credentials: { user: string; password: string },
	tag: string,
	op: (db: BunSQLDatabase) => Promise<unknown>,
): Promise<{ outcome: Promise<{ ok: boolean; value?: unknown; code?: string }>; pid: number }> {
	const client = createPostgresClient({
		driver: "bun-sql",
		url: urlFor(port, credentials),
		max: 1,
		connectTimeout: 10,
	});
	const appName = `conc-contender-${tag}`;
	await client.sql`SELECT set_config('application_name', ${appName}, false)`;
	const rows = (await client.sql`
		SELECT a.pid::text AS pid
		FROM pg_stat_activity a
		WHERE a.application_name = ${appName}
		ORDER BY a.backend_start DESC
	`) as unknown as { pid: string }[];
	const pid = Number(rows[0]?.pid);
	if (!Number.isInteger(pid) || pid <= 0) {
		throw new Error(`contender ${tag} pid not visible`);
	}
	const outcome = (async () => {
		try {
			return await settle(op(client.db));
		} finally {
			await client.close().catch(() => {});
		}
	})();
	return { outcome, pid };
}

/** Wait until the tagged contender is blocked on ANY of the devices' advisory locks (bounded). */
async function waitForWaiter(
	pgDb: BunSQLDatabase,
	deviceIds: string | string[],
	contender: { pid: number },
): Promise<void> {
	const ids = Array.isArray(deviceIds) ? deviceIds : [deviceIds];
	const keyCondition = ids
		.map((deviceId) => {
			const classid = (BigInt.asUintN(64, deviceKey(deviceId)) >> 32n).toString();
			const objid = (deviceKey(deviceId) & 0xffffffffn).toString();
			return `(l.classid = ${classid} AND l.objid = ${objid})`;
		})
		.join(" OR ");
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const rows = (await pgDb.execute(
			`SELECT count(*)::text AS n
			 FROM pg_locks l
			 WHERE l.locktype = 'advisory'
			   AND l.mode = 'ExclusiveLock'
			   AND NOT l.granted
			   AND l.pid = ${contender.pid}
			   AND (${keyCondition})`,
		)) as unknown as { n: string }[];
		if (Number(rows[0]?.n ?? 0) > 0) return;
		await Bun.sleep(25);
	}
	throw new Error(`no advisory waiter observed for ${ids.join(",")} on pid ${contender.pid}`);
}

let harnessPort = 0;
let harnessCredentials: { user: string; password: string; database: string } | null = null;

/**
 * One throwaway container per test, exactly like the other PG suites: the
 * harness owns start/cleanup of its own random name. Returning the clients
 * would drop them before the test uses them, so `withPg` wraps the whole test.
 */
async function withPg(
	fn: (ctx: {
		pgDb: BunSQLDatabase;
		barrierClient: PostgresClient;
		race: (
			tag: string,
			op: (db: BunSQLDatabase) => Promise<unknown>,
		) => Promise<{
			outcome: Promise<{ ok: boolean; value?: unknown; code?: string }>;
			pid: number;
		}>;
	}) => Promise<void>,
): Promise<void> {
	const sqls = await migrationSql();
	let thrown: unknown;
	const outcome = await withPostgres(async ({ exec, port, credentials }) => {
		for (const statement of sqls) {
			const applied = await exec(statement);
			if (applied.code !== 0) {
				throw new Error(`PostgreSQL migration failed: ${applied.stderr.slice(0, 400)}`);
			}
		}
		harnessPort = port;
		harnessCredentials = credentials;
		const client = createPostgresClient({
			driver: "bun-sql",
			url: urlFor(port, credentials),
			max: 6,
			connectTimeout: 10,
		});
		const barrier = createPostgresClient({
			driver: "bun-sql",
			url: urlFor(port, credentials),
			max: 1,
			connectTimeout: 10,
		});
		try {
			await fn({
				pgDb: client.db,
				barrierClient: barrier,
				race: (tag, op) => stageRace(port, credentials, tag, op),
			});
		} catch (error) {
			thrown = error;
			throw error;
		} finally {
			await client.close();
			await barrier.close();
		}
	});
	if (thrown !== undefined) throw thrown;
	if (outcome && typeof outcome === "object" && "status" in outcome) {
		const problem = outcome as { status: string; reason?: string };
		throw new Error(
			`PostgreSQL harness ${problem.status}: ${problem.reason ?? "unknown"} (PG_INTEGRATION=1 requires the real database)`,
		);
	}
}

beforeAll(() => {
	// Nothing to warm up; each race owns its throwaway container via `withPg`.
});

afterAll(() => {
	mock.module("../../../../server/db", () => realDbModule);
	mock.restore();
	sqlite.close();
});

describe("PostgresWorkspaceLeaseStore concurrency (real PostgreSQL 17)", () => {
	if (!PG_ENABLED) {
		it("skipped: set PG_INTEGRATION=1 to run the real PostgreSQL races", () => {
			expect(process.env.PG_INTEGRATION).not.toBe("1");
		});
		return;
	}

	it(
		"reverse-order two-device batches both commit without a deadlock replay",
		() =>
			withPg(async ({ pgDb, barrierClient, race }) => {
				const devX = "conc-device-batch-x";
				const devY = "conc-device-batch-y";
				const sx = makeScope("batch-x", { deviceId: devX });
				const sy = makeScope("batch-y", { deviceId: devY });
				await seedScope(pgDb, sx);
				await seedScope(pgDb, sy);
				// Two INDEPENDENT coordinator epochs, each batching over both devices in
				// opposite member order. Between two live groups on the same scopes the
				// durable barrier (like the SQLite coordinator's in-memory ranges) keeps
				// exactly one group; the claim here is narrower and sharper: fixed key
				// order must make a DEADLOCK cycle impossible even at maximal overlap.
				const originalWarn = logger.warn;
				const deadlockRetries: string[] = [];
				logger.warn = ((msg: string, data?: Record<string, unknown>) => {
					if (data?.sqlstate === "40P01") deadlockRetries.push(msg);
					originalWarn(msg, data);
				}) as typeof logger.warn;
				let outcomeA: { ok: boolean; code?: string; value?: unknown } | undefined;
				let outcomeB: { ok: boolean; code?: string; value?: unknown } | undefined;
				try {
					const barrierX = await holdDevice(barrierClient, devX);
					const credentials = harnessCredentials as { user: string; password: string };
					const barrierYClient = createPostgresClient({
						driver: "bun-sql",
						url: urlFor(harnessPort, credentials),
						max: 1,
						connectTimeout: 10,
					});
					try {
						const barrierY = await holdDevice(barrierYClient, devY);
						const batchA = await race("batch-a", (db) =>
							makeStore(db, "conc-A").admitLeaseBatch({
								targets: [
									{ scope: sx, runtime: RUNTIME },
									{ scope: sy, runtime: RUNTIME },
								],
								leaseIds: ["batch-a-x", "batch-a-y"],
								kind: "write",
							}),
						);
						const batchB = await race("batch-b", (db) =>
							makeStore(db, "conc-B").admitLeaseBatch({
								targets: [
									{ scope: sy, runtime: RUNTIME },
									{ scope: sx, runtime: RUNTIME },
								],
								leaseIds: ["batch-b-y", "batch-b-x"],
								kind: "write",
							}),
						);
						await waitForWaiter(pgDb, [devX, devY], batchA);
						await waitForWaiter(pgDb, [devX, devY], batchB);
						barrierX.release();
						barrierY.release();
						[outcomeA, outcomeB] = await Promise.all([batchA.outcome, batchB.outcome]);
						await Promise.all([barrierX.done, barrierY.done]);
					} finally {
						await barrierYClient.close();
					}
				} finally {
					logger.warn = originalWarn;
				}
				// A 40P01 replay would mean the retry wrapper rescued a deadlock the
				// ordering should have excluded; none may occur.
				expect(deadlockRetries).toEqual([]);
				const winner = outcomeA?.ok ? outcomeA : outcomeB?.ok ? outcomeB : undefined;
				const loser = outcomeA?.ok ? outcomeB : outcomeA;
				expect(winner?.ok).toBe(true);
				expect((winner?.value as unknown[] | undefined)?.length).toBe(2);
				expect(loser?.ok).toBe(false);
				expect(loser?.code).toBe("needs_verification");
				// Exactly one group owns the pair; every member carries its fence.
				const rowX = await readRow(pgDb, sx);
				const rowY = await readRow(pgDb, sy);
				expect(rowX.fencingToken).toBe(1);
				expect(rowY.fencingToken).toBe(1);
				expect(rowX.activeLeaseId === "batch-a-x" || rowX.activeLeaseId === "batch-b-x").toBe(true);
				expect(rowY.activeLeaseId === "batch-a-y" || rowY.activeLeaseId === "batch-b-y").toBe(true);
			}),
		TEST_TIMEOUT_MS,
	);

	it(
		"overlapping child scope serializes on the device, not on its own row",
		() =>
			withPg(async ({ pgDb, barrierClient, race }) => {
				const tag = "overlap";
				const deviceId = `conc-device-${tag}`;
				const parent = makeScope(`${tag}-parent`, { deviceId, canonicalRoot: `/conc/${tag}` });
				const child = makeScope(`${tag}-child`, {
					deviceId,
					workspaceInstanceId: `conc-workspace-${tag}-child`,
					canonicalRoot: `/conc/${tag}/child`,
				});
				await seedScope(pgDb, parent);
				await seedScope(pgDb, child);

				// Hold the device: admission of the CHILD row (untouched, status active,
				// never locked) cannot proceed — the serialization boundary is the
				// device, not the scope row. On the pre-fix store there was no device
				// lock at all, so no waiter could ever be observed here.
				const barrier = await holdDevice(barrierClient, deviceId);
				const childAttempt = await race("overlap-child", (db) =>
					makeStore(db, "conc-B").admitLease(claimOf(child, "lease-child")),
				);
				await waitForWaiter(pgDb, deviceId, childAttempt);
				barrier.release();
				const childResult = await childAttempt.outcome;
				await barrier.done;

				// Released, the free child admits normally: the barrier held it without
				// touching its row, proving the lock — not row state — did the holding.
				expect(childResult.ok).toBe(true);
				expect(childResult.value).toEqual({ fencingToken: 1, revision: 1 });
				await makeStore(pgDb, "conc-B").clearLease(
					leaseOf(
						child,
						childResult.value as { fencingToken: number; revision: number },
						"lease-child",
						0,
					),
				);

				// The parent leases the WHOLE tree (rollback = strict barrier mode);
				// the child scope's next admission must see the overlap post-lock and
				// be refused with the durable barrier code.
				const storeA = makeStore(pgDb, "conc-A");
				const parentGrant = await storeA.admitLease(claimOf(parent, "lease-parent", "rollback"));
				expect(parentGrant).toEqual({ fencingToken: 1, revision: 1 });
				const blocked = await settle(
					makeStore(pgDb, "conc-B").admitLease(claimOf(child, "lease-child-2")),
				);
				expect(blocked.ok).toBe(false);
				expect(blocked.code).toBe("needs_verification");
				const childRow = await readRow(pgDb, child);
				expect(childRow.activeLeaseId).toBeNull();
				expect(childRow.fencingToken).toBe(1);
				expect(childRow.revision).toBe(2);
			}),
		TEST_TIMEOUT_MS,
	);

	it(
		"same-scope race on two connections admits exactly one lease at fence 1",
		() =>
			withPg(async ({ pgDb, barrierClient, race }) => {
				const scope = makeScope("same");
				await seedScope(pgDb, scope);

				const barrier = await holdDevice(barrierClient, scope.deviceId);
				const first = await race("same-1", (db) =>
					makeStore(db, "conc-A").admitLease(claimOf(scope, "lease-first")),
				);
				const second = await race("same-2", (db) =>
					makeStore(db, "conc-B").admitLease(claimOf(scope, "lease-second")),
				);
				await waitForWaiter(pgDb, scope.deviceId, first);
				await waitForWaiter(pgDb, scope.deviceId, second);
				barrier.release();
				const outcomes = await Promise.all([first.outcome, second.outcome, barrier.done]);

				const results = outcomes.slice(0, 2) as {
					ok: boolean;
					code?: string;
					value?: unknown;
				}[];
				expect(results.filter((r) => r.ok)).toHaveLength(1);
				expect(results.filter((r) => !r.ok)).toHaveLength(1);
				expect(results.find((r) => !r.ok)?.code).toBe("needs_verification");
				const winner = results.find((r) => r.ok)?.value as
					| { fencingToken: number; revision: number }
					| undefined;
				expect(winner).toEqual({ fencingToken: 1, revision: 1 });
				const row = await readRow(pgDb, scope);
				expect(row.fencingToken).toBe(1);
				expect(row.revision).toBe(1);
				expect(row.activeMutationCount).toBe(0);
				expect(["lease-first", "lease-second"]).toContain(row.activeLeaseId ?? "");
			}),
		TEST_TIMEOUT_MS,
	);

	it(
		"old release then new admission fences the previous lease out",
		() =>
			withPg(async ({ pgDb, barrierClient, race }) => {
				const scope = makeScope("handover");
				await seedScope(pgDb, scope);
				const storeA = makeStore(pgDb, "conc-A");
				const storeB = makeStore(pgDb, "conc-B");

				const grantA = await storeA.admitLease(claimOf(scope, "lease-old"));
				expect(grantA).toEqual({ fencingToken: 1, revision: 1 });

				// The release AND the new admission race on the same staged boundary:
				// both blocked behind the test-held device lock, both released together.
				const barrier = await holdDevice(barrierClient, scope.deviceId);
				const releaseRace = await race("handover-clear", (db) =>
					makeStore(db, "conc-A").clearLease(leaseOf(scope, grantA, "lease-old", 0)),
				);
				const admissionRace = await race("handover-admit", (db) =>
					makeStore(db, "conc-B").admitLease(claimOf(scope, "lease-new")),
				);
				await waitForWaiter(pgDb, scope.deviceId, releaseRace);
				await waitForWaiter(pgDb, scope.deviceId, admissionRace);
				barrier.release();
				const [released, admitted] = await Promise.all([
					releaseRace.outcome,
					admissionRace.outcome,
				]);
				await barrier.done;

				expect(released.ok).toBe(true);
				let resultB = admitted;
				if (!resultB.ok) {
					// The admission won the lock first and saw the old lease's barrier —
					// the correct durable verdict. Retried after the committed release,
					// it must succeed on the new fence.
					expect(resultB.code).toBe("needs_verification");
					const retried = await settle(storeB.admitLease(claimOf(scope, "lease-new")));
					expect(retried.ok).toBe(true);
					resultB = retried;
				}
				expect(resultB.value).toEqual({ fencingToken: 2, revision: 3 });
				// The old generation is fenced out by BOTH the stale fence and the
				// cleared owner — no mutation may land on the new lease's row.
				const oldMutation = await settle(
					storeA.registerMutation(leaseOf(scope, grantA, "lease-old", 0), "old-mutation"),
				);
				expect(oldMutation.ok).toBe(false);
				expect(oldMutation.code).toBe("stale_lease");
				const row = await readRow(pgDb, scope);
				expect(row.activeLeaseId).toBe("lease-new");
				expect(row.activeMutationCount).toBe(0);
			}),
		TEST_TIMEOUT_MS,
	);

	it(
		"range intersection is symmetric, path-aware, and independent of scope roots",
		() =>
			withPg(async ({ pgDb }) => {
				const parent = makeScope("range-parent", {
					canonicalRoot: "/range",
					deviceId: "range-device",
				});
				const child = makeScope("range-child", {
					canonicalRoot: "/range/child",
					deviceId: parent.deviceId,
				});
				await seedScope(pgDb, parent);
				await seedScope(pgDb, child);
				const store = makeStore(pgDb, "range-owner");
				const grant = await store.admitLease({
					...claimOf(child, "range-A"),
					ranges: [{ kind: "file", canonicalPath: "/range/child/A.txt" }],
				});
				await store.quarantineLease(leaseOf(child, grant, "range-A", 0));
				// Child quarantine blocks a parent subtree (the historical asymmetric hole).
				expect((await settle(store.admitLease(claimOf(parent, "parent-blocked")))).code).toBe(
					"needs_verification",
				);
				const sibling = await store.admitLease({
					...claimOf(parent, "sibling-B"),
					ranges: [{ kind: "file", canonicalPath: "/range/child/B.txt" }],
				});
				await store.clearLease(leaseOf(parent, sibling, "sibling-B", 0));
				expect(
					(
						await settle(
							store.admitLease({
								...claimOf(parent, "file-blocked"),
								ranges: [{ kind: "file", canonicalPath: "/range/child/A.txt" }],
							}),
						)
					).code,
				).toBe("needs_verification");
				// Segment boundaries: child2 is not a child of child; root defaults remain conservative.
				const separate = await store.admitLease({
					...claimOf(parent, "sibling-tree"),
					ranges: [{ kind: "subtree", canonicalPath: "/range/child2" }],
				});
				await store.clearLease(leaseOf(parent, separate, "sibling-tree", 0));
				const win = makeScope("range-windows", {
					canonicalRoot: "C:\\Work",
					pathFlavor: "windows",
					deviceId: "win-device",
				});
				await seedScope(pgDb, win);
				const winGrant = await store.admitLease({
					...claimOf(win, "win-A"),
					ranges: [{ kind: "file", canonicalPath: "C:\\Work\\A.txt" }],
				});
				await store.quarantineLease(leaseOf(win, winGrant, "win-A", 0));
				expect(
					(
						await settle(
							store.admitLease({
								...claimOf(win, "win-blocked"),
								ranges: [{ kind: "file", canonicalPath: "c:/work/a.TXT" }],
							}),
						)
					).code,
				).toBe("needs_verification");
			}),
		TEST_TIMEOUT_MS,
	);

	it(
		"atomic A recovery preserves live B and rolls effects back when audit insertion fails",
		() =>
			withPg(async ({ pgDb, barrierClient, race }) => {
				const scope = makeScope("atomic-recovery");
				await seedScope(pgDb, scope);
				const catalog = createPostgresFileChangeBlobCatalog({
					db: pgDb,
					namespaceKey: "atomic-recovery",
				});
				await catalog.initializeNamespace({ expectedGeneration: null, quotaBytes: 1_000_000 });
				await catalog.beginReconciliation({ expectedGeneration: 0 });
				await catalog.completeReconciliation({
					expectedGeneration: 1,
					verifiedUsedBytes: 0,
					verification: {
						namespaceIdentityVerified: true,
						writersQuiescent: true,
						physicalInventoryComplete: true,
						catalogMatchesInventory: true,
					},
				});
				const store = makeStore(pgDb, "atomic-owner");
				const grantA = await store.admitLease({
					...claimOf(scope, "atomic-A"),
					ranges: [{ kind: "file", canonicalPath: `${scope.canonicalRoot}/A.txt` }],
				});
				const leaseA = leaseOf(scope, grantA, "atomic-A", 0);
				const a = await seedApplyingEffect(pgDb, leaseA, "A");
				await store.registerMutation(leaseA, a.effect.mutationId, {
					operationId: a.operation.id,
					effectId: a.effect.id,
				});
				const receipt = {
					receiptId: "uncertain-A",
					mutationId: a.effect.mutationId,
					requestDigest: a.requestDigest,
					executionBinding: leaseA.binding,
					confirmed: false,
					observedAfter: { kind: "absent" as const },
					outcome: "unknown" as const,
					localIo: {
						version: 1 as const,
						outcome: "target_mutation_unknown" as const,
						createdParentCount: 0,
						uncertainParentCount: 0,
					},
				};
				await a.evidence.settleEffect({
					operationId: a.operation.id,
					mutationId: a.effect.mutationId,
					requestDigest: a.requestDigest,
					receipt,
				});
				await a.evidence.finishOperation(a.operation.id, "failed");
				await store.settleMutation(
					{ ...leaseA, pendingMutations: 1 },
					a.effect.mutationId,
					"unknown",
				);
				await store.clearLease(leaseA);
				const [endedA] = await pgDb
					.select()
					.from(workspaceWriteLeases)
					.where(eq(workspaceWriteLeases.leaseId, "atomic-A"));
				expect(endedA?.status).toBe("quarantined");
				expect(endedA?.executionEndedAt).not.toBeNull();
				const grantB = await store.admitLease({
					...claimOf(scope, "atomic-B"),
					ranges: [{ kind: "file", canonicalPath: `${scope.canonicalRoot}/B.txt` }],
				});
				const leaseB = leaseOf(scope, grantB, "atomic-B", 0);
				const b = await seedApplyingEffect(pgDb, leaseB, "B");
				await store.registerMutation(leaseB, b.effect.mutationId, {
					operationId: b.operation.id,
					effectId: b.effect.id,
				});
				const scopeBefore = await readRow(pgDb, scope);
				const [durableBBefore] = await pgDb
					.select()
					.from(workspaceWriteLeases)
					.where(eq(workspaceWriteLeases.leaseId, "atomic-B"));
				const beforeA = await a.evidence.getEffect(a.operation.id, a.effect.mutationId);
				const beforeB = await b.evidence.getEffect(b.operation.id, b.effect.mutationId);
				expect(beforeA?.executionReceiptJson).toEqual(receipt);
				const input = {
					scopeId: scope.id,
					workspaceLeaseId: "atomic-A",
					recoveredByUserId: "recovery-user",
					decisions: [
						{
							effectId: a.effect.id,
							canonicalPath: a.canonicalPath,
							verdict: "not_applied" as const,
							observedDigest: null,
							observedSizeBytes: null,
						},
					],
				};
				// Missing actor FK fails at audit insertion AFTER effects were updated.
				expect((await settle(a.evidence.closeBooksForRecovery(input))).ok).toBe(false);
				expect(await a.evidence.getEffect(a.operation.id, a.effect.mutationId)).toEqual(beforeA);
				expect(await readRow(pgDb, scope)).toEqual(scopeBefore);
				expect(
					(
						await pgDb
							.select()
							.from(workspaceWriteLeases)
							.where(eq(workspaceWriteLeases.leaseId, "atomic-A"))
					)[0]?.status,
				).toBe("quarantined");
				expect(await pgDb.select().from(fileChangeScopeRecoveries)).toHaveLength(0);
				await pgDb.insert(users).values({
					id: "recovery-user",
					username: "recovery-user",
					passwordHash: "test-only",
					createdAt: new Date().toISOString(),
				});
				// A caller cannot substitute B's effects or a scope-wide manifest.
				expect(
					(await settle(a.evidence.closeBooksForRecovery({ ...input, effectIds: [b.effect.id] })))
						.ok,
				).toBe(false);
				const barrier = await holdDevice(barrierClient, scope.deviceId);
				const first = await race("recover-A-first", (db) =>
					createPostgresFileChangeEvidenceStore(db).closeBooksForRecovery(input),
				);
				const second = await race("recover-A-second", (db) =>
					createPostgresFileChangeEvidenceStore(db).closeBooksForRecovery(input),
				);
				await waitForWaiter(pgDb, scope.deviceId, first);
				await waitForWaiter(pgDb, scope.deviceId, second);
				barrier.release();
				const recovered = await Promise.all([first.outcome, second.outcome]);
				await barrier.done;
				expect(recovered.filter((result) => result.ok)).toHaveLength(1);
				expect(recovered.find((result) => result.ok)?.value).toEqual({ settledEffectCount: 1 });
				expect(await readRow(pgDb, scope)).toEqual(scopeBefore);
				expect(await b.evidence.getEffect(b.operation.id, b.effect.mutationId)).toEqual(beforeB);
				expect(
					(
						await pgDb
							.select()
							.from(workspaceWriteLeases)
							.where(eq(workspaceWriteLeases.leaseId, "atomic-B"))
					)[0],
				).toEqual(durableBBefore);
				const afterA = await a.evidence.getEffect(a.operation.id, a.effect.mutationId);
				expect(afterA?.settlement).toBe("settled");
				expect(afterA?.executionReceiptJson).toEqual(beforeA?.executionReceiptJson);
				expect(afterA?.executionReceiptDigest).toBe(beforeA?.executionReceiptDigest);
				expect((await a.evidence.getOperation(a.operation.id))?.executionOutcome).toBe("failed");
				expect(
					(
						await pgDb
							.select()
							.from(workspaceWriteLeases)
							.where(eq(workspaceWriteLeases.leaseId, "atomic-A"))
					)[0]?.status,
				).toBe("recovered");
				const audits = await pgDb.select().from(fileChangeScopeRecoveries);
				expect(audits).toHaveLength(1);
				expect(audits[0]?.workspaceLeaseId).toBe("atomic-A");
				expect(audits[0]?.effectDecisionsJson).toEqual(input.decisions);
				await store.settleMutation(
					{ ...leaseB, pendingMutations: 1 },
					b.effect.mutationId,
					"not_applied",
				);
				await store.clearLease(leaseB);
				// Runtime's bootstrap registration may use operation.id before effect ids exist.
				const grantC = await store.admitLease({
					...claimOf(scope, "atomic-C"),
					ranges: [{ kind: "file", canonicalPath: `${scope.canonicalRoot}/C.txt` }],
				});
				const leaseC = leaseOf(scope, grantC, "atomic-C", 0);
				const c = await seedApplyingEffect(pgDb, leaseC, "C");
				await store.registerMutation(leaseC, c.operation.id, { operationId: c.operation.id });
				await store.quarantineLease({ ...leaseC, pendingMutations: 1 });
				expect(
					await c.evidence.closeBooksForRecovery({
						scopeId: scope.id,
						workspaceLeaseId: "atomic-C",
						effectIds: [c.effect.id],
						operationIds: [c.operation.id],
						recoveredByUserId: "recovery-user",
						decisions: [
							{
								effectId: c.effect.id,
								canonicalPath: c.canonicalPath,
								verdict: "not_applied",
								observedDigest: null,
								observedSizeBytes: null,
							},
						],
					}),
				).toEqual({ settledEffectCount: 1 });
				expect((await c.evidence.getOperation(c.operation.id))?.settlement).toBe("settled");
			}),
		TEST_TIMEOUT_MS,
	);

	it(
		"legacy foreign epoch never proves an executor dead",
		() =>
			withPg(async ({ pgDb }) => {
				const scope = makeScope("legacy-owner");
				await seedScope(pgDb, scope);
				await pgDb
					.update(fileChangeScopes)
					.set({
						activeLeaseId: "legacy-lease",
						activeLeaseEpoch: "foreign-old",
						activeLeaseStartedAt: "2000-01-01T00:00:00Z",
						activeMutationCount: 1,
						status: "needs_verification",
					})
					.where(eq(fileChangeScopes.id, scope.id));
				const before = await readRow(pgDb, scope);
				expect((await settle(makeStore(pgDb, "fresh-owner").recoverScopeBarrier(scope))).code).toBe(
					"recovery_conflict",
				);
				expect(
					(
						await settle(
							createPostgresFileChangeEvidenceStore(pgDb).closeBooksForRecovery({
								scopeId: scope.id,
								recoveredByUserId: "irrelevant",
								decisions: [],
							}),
						)
					).ok,
				).toBe(false);
				expect(await readRow(pgDb, scope)).toEqual(before);
			}),
		TEST_TIMEOUT_MS,
	);

	it(
		"foreign recovery cannot steal an executing lease racing with settlement",
		() =>
			withPg(async ({ pgDb, barrierClient, race }) => {
				const scope = makeScope("settle-recover");
				await seedScope(pgDb, scope);
				const storeA = makeStore(pgDb, "conc-A");

				const grantA = await storeA.admitLease(claimOf(scope, "lease-live"));
				await storeA.registerMutation(leaseOf(scope, grantA, "lease-live", 0), "live-mutation");
				expect((await readRow(pgDb, scope)).activeMutationCount).toBe(1);

				const barrier = await holdDevice(barrierClient, scope.deviceId);
				const settleRace = await race("settle", (db) =>
					makeStore(db, "conc-A").settleMutation(
						leaseOf(scope, grantA, "lease-live", 1),
						"live-mutation",
					),
				);
				const recoverRace = await race("recover", (db) =>
					makeStore(db, "conc-recoverer").recoverScopeBarrier(scope),
				);
				await waitForWaiter(pgDb, scope.deviceId, settleRace);
				await waitForWaiter(pgDb, scope.deviceId, recoverRace);
				barrier.release();
				const [settled, recovered] = await Promise.all([settleRace.outcome, recoverRace.outcome]);
				await barrier.done;

				expect(settled.ok).toBe(true);
				// Neither the foreign epoch nor zero pending mutations proves that the
				// executor ended. Only its finalizer can detach its current guard.
				expect(recovered.ok).toBe(false);
				expect(recovered.code).toBe("recovery_conflict");
				const row = await readRow(pgDb, scope);
				expect(row.status).toBe("active");
				expect(row.activeLeaseId).toBe("lease-live");
				expect(row.fencingToken).toBe(1);
				expect(row.revision).toBe(1);
				expect(row.activeMutationCount).toBe(0);
				// A stale counter still prevents duplicate settlement.
				const lateSettle = await settle(
					storeA.settleMutation(leaseOf(scope, grantA, "lease-live", 1), "live-mutation"),
				);
				expect(lateSettle.ok).toBe(false);
				expect(lateSettle.code).toBe("stale_lease");
			}),
		TEST_TIMEOUT_MS,
	);
});
