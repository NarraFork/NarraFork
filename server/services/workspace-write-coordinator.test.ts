import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	workspaceWriteLeases as durableLeases,
	fileChangeScopes as scopes,
	workspaceExecutionOwners,
} from "@server/db/schema";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { FileChangeScopeIdentity } from "./file-change-identity";
import * as ownerAuthority from "./workspace-execution-owner";
import {
	createWorkspaceWriteCoordinatorState,
	WORKSPACE_WRITE_COORDINATOR_LIMITS,
	type WorkspaceRuntimeBinding,
	type WorkspaceWriteBatch,
	WorkspaceWriteCoordinator,
	type WorkspaceWriteCoordinatorErrorCode,
	type WorkspaceWriteCoordinatorOptions,
	type WorkspaceWriteCoordinatorState,
	type WorkspaceWriteLease,
	type WorkspaceWriteLeaseKind,
	type WorkspaceWriteLeaseToken,
	type WorkspaceWriteManyRequest,
	type WorkspaceWriteRequest,
} from "./workspace-write-coordinator";
import { WORKSPACE_WRITE_LEASE_TEST_DDL } from "./workspace-write-lease-store";

// No application DB import, production FS, execution backend, Bash, or real locks.
const DDL = `
CREATE TABLE file_change_scopes (
 id TEXT PRIMARY KEY NOT NULL, source_instance_id TEXT NOT NULL, device_id TEXT NOT NULL,
 workspace_instance_id TEXT NOT NULL, canonical_root TEXT NOT NULL, display_root TEXT NOT NULL,
 path_flavor TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'needs_verification', root_identity_json TEXT,
 revision INTEGER NOT NULL DEFAULT 0, fencing_token INTEGER NOT NULL DEFAULT 0,
 active_lease_id TEXT, active_lease_epoch TEXT, active_lease_started_at TEXT,
 active_mutation_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_fc_scope_instance ON file_change_scopes
 (source_instance_id, device_id, workspace_instance_id);
CREATE INDEX idx_fc_scope_root ON file_change_scopes (source_instance_id, device_id, canonical_root);
CREATE INDEX idx_fc_scope_status ON file_change_scopes (status, updated_at);
CREATE INDEX idx_fc_scope_active_lease ON file_change_scopes (device_id, active_lease_id, canonical_root);
`;
const runtime: WorkspaceRuntimeBinding = {
	runtimeEpoch: "authoritative-epoch",
	runtimeGeneration: 7,
};
let sqlite: Database;
let db: ReturnType<typeof drizzle>;
let state: WorkspaceWriteCoordinatorState;
let coordinator: WorkspaceWriteCoordinator;
let scope: FileChangeScopeIdentity;
let runtimes: Map<string, WorkspaceRuntimeBinding>;
let queries: string[];
let serial = 0;
let gates: Array<() => void>;
let jobs: Promise<unknown>[];

beforeEach(() => {
	sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA busy_timeout = 0;");
	sqlite.exec(DDL);
	sqlite.exec(WORKSPACE_WRITE_LEASE_TEST_DDL);
	queries = [];
	db = drizzle(sqlite, { logger: { logQuery: (query) => queries.push(query) } });
	state = createWorkspaceWriteCoordinatorState();
	runtimes = new Map();
	gates = [];
	jobs = [];
	coordinator = makeCoordinator();
	scope = addScope();
});

afterEach(async () => {
	for (const open of gates) open();
	await Promise.all(jobs);
	expect(state.waiters).toHaveLength(0);
	expect(state.leases.size).toBe(0);
	expect(state.activities.size).toBe(0);
	sqlite.close();
});

function makeCoordinator(options: Partial<WorkspaceWriteCoordinatorOptions> = {}) {
	return new WorkspaceWriteCoordinator({
		db,
		state,
		readRuntime: (deviceId) => runtimes.get(deviceId) ?? null,
		...options,
	});
}

function addScope(overrides: Partial<typeof scopes.$inferInsert> = {}): FileChangeScopeIdentity {
	const id = `scope-${++serial}`;
	const row = db
		.insert(scopes)
		.values({
			id,
			sourceInstanceId: "evidence-source",
			deviceId: "real-device-a",
			workspaceInstanceId: `workspace-${id}`,
			canonicalRoot: "/workspace/repo",
			displayRoot: "presentation only",
			pathFlavor: "posix",
			status: "active",
			createdAt: "2026-09-07T00:00:00.000Z",
			updatedAt: "2026-09-07T00:00:00.000Z",
			...overrides,
		})
		.returning()
		.get();
	if (!runtimes.has(row.deviceId)) runtimes.set(row.deviceId, { ...runtime });
	return {
		id: row.id,
		sourceInstanceId: row.sourceInstanceId,
		deviceId: row.deviceId,
		workspaceInstanceId: row.workspaceInstanceId,
		canonicalRoot: row.canonicalRoot,
		pathFlavor: row.pathFlavor,
	};
}

function request(
	target = scope,
	options: Partial<WorkspaceWriteRequest> = {},
): WorkspaceWriteRequest {
	return { scope: target, runtime: { ...runtime }, ...options };
}

function row(target = scope) {
	return db.select().from(scopes).where(eq(scopes.id, target.id)).get();
}

function quarantined(target = scope) {
	return db
		.select()
		.from(durableLeases)
		.where(eq(durableLeases.scopeId, target.id))
		.all()
		.filter((lease) => lease.status === "quarantined");
}

function expectQuarantined(target = scope) {
	expect(row(target)).toMatchObject({
		status: "active",
		activeLeaseId: null,
		activeMutationCount: 0,
	});
	expect(quarantined(target)).toHaveLength(1);
	expect(quarantined(target)[0].executionEndedAt).toBeString();
}

function update(values: Partial<typeof scopes.$inferInsert>, target = scope): void {
	db.update(scopes).set(values).where(eq(scopes.id, target.id)).run();
}

function gate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	gates.push(open);
	return { promise, open };
}

function track<T>(promise: Promise<T>): Promise<T> {
	jobs.push(promise.catch(() => undefined));
	return promise;
}

async function hold(
	target = scope,
	kind: WorkspaceWriteLeaseKind = "write",
	owner = coordinator,
	options: Partial<WorkspaceWriteRequest> = {},
) {
	const entered = gate();
	const finish = gate();
	let lease!: WorkspaceWriteLease;
	const body = async (value: WorkspaceWriteLease) => {
		lease = value;
		entered.open();
		await finish.promise;
	};
	const done = track(
		kind === "write"
			? owner.withWrite(request(target, options), body)
			: owner.withRollback(request(target, options), body),
	);
	await entered.promise;
	return { lease, done, release: finish.open };
}

function errorCode(code: WorkspaceWriteCoordinatorErrorCode) {
	return expect.objectContaining({ name: "WorkspaceWriteCoordinatorError", code });
}

function expectCode(body: () => unknown, code: WorkspaceWriteCoordinatorErrorCode) {
	expect(body).toThrow(errorCode(code));
}

describe("scope admission and execution fencing", () => {
	test("increments the fence in short transactions and preserves the authoritative epoch", async () => {
		const transactions = spyOn(db, "transaction");
		queries.length = 0;
		let previous!: WorkspaceWriteLease;
		const binding = await coordinator.withWrite(request(), (lease) => {
			previous = lease;
			expect(sqlite.inTransaction).toBe(false);
			lease.assertCurrent();
			expect(coordinator.capture(scope).active.writes).toBe(1);
			return lease.executionBinding;
		});
		expect(binding).toEqual({ deviceId: scope.deviceId, ...runtime, fencingToken: 1 });
		expect(row()).toMatchObject({
			fencingToken: 1,
			revision: 2,
			status: "active",
			activeLeaseId: null,
		});
		await coordinator.withRollback(request(), (lease) => {
			expect(lease.executionBinding.fencingToken).toBe(2);
			expectCode(() => lease.assertCurrent(binding), "stale_lease");
			expectCode(() => previous.assertCurrent(), "stale_lease");
			expectCode(() => previous.registerMutation("late"), "stale_lease");
		});
		expect(transactions.mock.calls).toHaveLength(4);
		expect(transactions.mock.calls.every(([, config]) => config?.behavior === "immediate")).toBe(
			true,
		);
		transactions.mockRestore();
		queries.length = 0;
		coordinator.capture(scope);
		expect(queries.some((query) => /select.*root_identity_json/i.test(query))).toBe(false);
	});

	test("unknown, retired and unverified scopes cannot grant or consume a fence", async () => {
		const unknown = { ...scope, id: "never-registered" };
		await expect(coordinator.withWrite(request(unknown), () => undefined)).rejects.toThrow(
			errorCode("scope_not_found"),
		);
		expectCode(() => coordinator.capture(unknown), "scope_not_found");
		expectCode(() => coordinator.registerActivity(request(unknown)), "scope_not_found");
		for (const status of ["retired", "needs_verification"] as const) {
			update({ status });
			await expect(coordinator.withRollback(request(), () => undefined)).rejects.toThrow(
				errorCode(status === "retired" ? "scope_inactive" : "needs_verification"),
			);
		}
		expect(row()?.fencingToken).toBe(0);
	});

	test("requires explicit target grammar and fully qualified roots", async () => {
		for (const target of [
			{ ...scope, canonicalRoot: "relative/path" },
			{ ...scope, canonicalRoot: "spec://task", pathFlavor: "spec" },
			{ ...scope, canonicalRoot: "C:relative", pathFlavor: "windows" },
			{ ...scope, canonicalRoot: "\\drive-relative", pathFlavor: "windows" },
		]) {
			await expect(
				coordinator.withWrite(request(target as FileChangeScopeIdentity), () => undefined),
			).rejects.toThrow(errorCode("invalid_input"));
		}
		for (const mismatch of [
			{ sourceInstanceId: "other-source" },
			{ deviceId: "other-device" },
			{ workspaceInstanceId: "other-workspace" },
			{ canonicalRoot: "/different-root" },
		]) {
			await expect(
				coordinator.withWrite(request({ ...scope, ...mismatch }), () => undefined),
			).rejects.toThrow(errorCode("scope_identity_mismatch"));
		}
		expect(row()?.fencingToken).toBe(0);
	});

	test("generation is not an epoch, and missing authority is never guessed", async () => {
		for (const invalid of [
			{ runtimeEpoch: "7", runtimeGeneration: 7 },
			{ runtimeEpoch: runtime.runtimeEpoch, runtimeGeneration: 8 },
		]) {
			await expect(
				coordinator.withWrite(request(scope, { runtime: invalid }), () => undefined),
			).rejects.toThrow(errorCode("runtime_mismatch"));
		}
		await expect(
			coordinator.withWrite(
				request(scope, { runtime: { runtimeGeneration: 7 } as WorkspaceRuntimeBinding }),
				() => undefined,
			),
		).rejects.toThrow(errorCode("invalid_input"));
		runtimes.delete(scope.deviceId);
		await expect(coordinator.withWrite(request(), () => undefined)).rejects.toThrow(
			errorCode("runtime_mismatch"),
		);
		expect(row()?.fencingToken).toBe(0);
	});

	for (const change of ["epoch", "generation", "identity", "status"] as const) {
		test(`queued grant rechecks ${change} after its predecessor ends`, async () => {
			const first = await hold();
			const waitingScope = addScope();
			const next = track(coordinator.withWrite(request(waitingScope), () => "must not run"));
			if (change === "epoch")
				runtimes.set(scope.deviceId, { ...runtime, runtimeEpoch: "new-epoch" });
			if (change === "generation") {
				runtimes.set(scope.deviceId, { ...runtime, runtimeGeneration: 8 });
			}
			if (change === "identity")
				update({ workspaceInstanceId: "replacement-instance" }, waitingScope);
			if (change === "status") update({ status: "retired" }, waitingScope);
			first.release();
			await first.done;
			await expect(next).rejects.toThrow(
				errorCode(
					change === "identity"
						? "scope_identity_mismatch"
						: change === "status"
							? "scope_inactive"
							: "runtime_mismatch",
				),
			);
			expect(row()?.fencingToken).toBe(1);
		});
	}

	test("copies admission descriptors instead of trusting caller mutation while queued", async () => {
		const first = await hold();
		const mutable = request({ ...scope }, { runtime: { ...runtime } });
		const next = track(coordinator.withWrite(mutable, (lease) => lease.scope.canonicalRoot));
		(mutable.scope as FileChangeScopeIdentity).canonicalRoot = "/redirected";
		(mutable.runtime as { runtimeEpoch: string }).runtimeEpoch = "redirected";
		first.release();
		await first.done;
		expect(await next).toBe(scope.canonicalRoot);
	});

	test("a live lease rejects changed durable fences even after a runtime reconnect", async () => {
		const first = await hold();
		first.lease.registerMutation("before-disconnect");
		update({ fencingToken: 10 });
		expectCode(() => first.lease.assertCurrent(), "stale_lease");
		expectCode(() => first.lease.settle("before-disconnect", "applied"), "stale_lease");
		runtimes.set(scope.deviceId, { ...runtime, runtimeGeneration: 8 });
		expectCode(() => first.lease.settle("before-disconnect", "not_applied"), "stale_lease");
		first.release();
		await expect(first.done).rejects.toThrow(errorCode("persistence_failed"));
		expect(state.leases.size).toBe(1);
		expect(row()?.fencingToken).toBe(10);
		// Explicitly repair injected corruption, then persist the retained ended hold.
		update({ fencingToken: first.lease.executionBinding.fencingToken });
		coordinator.retryUncertainPersistence(first.lease.token);
		expectQuarantined();
	});
});

describe("physical range exclusion, independent of evidence identity", () => {
	for (const [name, left, right] of [
		["same path across source/workspace/scope IDs", "/repo", "/repo"],
		["parent then child", "/repo", "/repo/child"],
		["child then parent", "/repo/child", "/repo"],
		["canonical spelling variants", "/repo/./child/..", "/repo/"],
		["POSIX ..cache is a child, not an escape", "/repo", "/repo/..cache"],
		["POSIX backslash remains filename data", "/repo/dir\\name", "/repo/dir\\name/sub"],
	] as const) {
		test(name, async () => {
			const a = addScope({ canonicalRoot: left });
			const b = addScope({ canonicalRoot: right, sourceInstanceId: "different-evidence-source" });
			const first = await hold(a);
			let entered = false;
			const next = track(
				coordinator.withWrite(request(b), () => {
					entered = true;
				}),
			);
			expect(state.waiters).toHaveLength(1);
			expect(coordinator.capture(b).active.writes).toBe(1);
			expect(row(b)?.fencingToken).toBe(0);
			expect(entered).toBe(false);
			first.release();
			await Promise.all([first.done, next]);
			expect(entered).toBe(true);
		});
	}

	for (const [aPath, bPath] of [
		["C:\\REPO", "c:/repo/child"],
		["C:\\REPO\\..cache", "c:\\repo"],
		["\\\\SERVER\\SHARE\\Repo", "\\\\server\\share\\repo\\child"],
	] as const) {
		test(`Windows identity folds case on the target: ${aPath}`, async () => {
			const a = addScope({ canonicalRoot: aPath, pathFlavor: "windows" });
			const b = addScope({ canonicalRoot: bPath, pathFlavor: "windows" });
			const first = await hold(a, "rollback");
			await expect(
				coordinator.withWrite(request(b, { waitTimeoutMs: 0 }), () => undefined),
			).rejects.toThrow(errorCode("wait_timeout"));
			first.release();
			await first.done;
		});
	}

	for (const [name, aInput, bInput] of [
		[
			"different devices",
			{ canonicalRoot: "/repo" },
			{ canonicalRoot: "/repo", deviceId: "device-b" },
		],
		["POSIX case-sensitive", { canonicalRoot: "/REPO" }, { canonicalRoot: "/repo" }],
		["POSIX backslash not slash", { canonicalRoot: "/repo/a\\b" }, { canonicalRoot: "/repo/a/b" }],
		["component boundaries", { canonicalRoot: "/repo/a" }, { canonicalRoot: "/repo/ab" }],
		["..cache sibling", { canonicalRoot: "/repo/a" }, { canonicalRoot: "/repo/..cache" }],
		[
			"Windows volumes",
			{ canonicalRoot: "C:\\repo", pathFlavor: "windows" },
			{ canonicalRoot: "D:\\repo", pathFlavor: "windows" },
		],
		[
			"explicit path flavors",
			{ canonicalRoot: "/C:/repo" },
			{ canonicalRoot: "C:/repo", pathFlavor: "windows" },
		],
	] satisfies Array<
		[string, Partial<typeof scopes.$inferInsert>, Partial<typeof scopes.$inferInsert>]
	>) {
		test(`${name} can run concurrently`, async () => {
			const a = addScope(aInput);
			const b = addScope(bInput);
			const first = await hold(a);
			const second = await hold(b, "rollback");
			expect(state.leases.size).toBe(2);
			expect(coordinator.capture(a).active).toMatchObject({ writes: 1, rollbacks: 0 });
			expect(coordinator.capture(b).active).toMatchObject({ writes: 0, rollbacks: 1 });
			first.release();
			second.release();
			await Promise.all([first.done, second.done]);
		});
	}

	for (const [firstKind, secondKind] of [
		["write", "write"],
		["write", "rollback"],
		["rollback", "write"],
		["rollback", "rollback"],
	] as const) {
		test(`${firstKind} excludes ${secondKind}`, async () => {
			const first = await hold(scope, firstKind);
			const run =
				secondKind === "write"
					? coordinator.withWrite.bind(coordinator)
					: coordinator.withRollback.bind(coordinator);
			await expect(run(request(scope, { waitTimeoutMs: 0 }), () => undefined)).rejects.toThrow(
				errorCode("wait_timeout"),
			);
			first.release();
			await first.done;
		});
	}

	test("overlapping queue is FIFO without blocking another device", async () => {
		const child = addScope({ canonicalRoot: `${scope.canonicalRoot}/child` });
		const remote = addScope({ deviceId: "device-b" });
		const first = await hold(child);
		const order: number[] = [];
		const parentWaiter = track(coordinator.withRollback(request(), () => order.push(1)));
		const childWaiter = track(coordinator.withWrite(request(child), () => order.push(2)));
		await coordinator.withWrite(request(remote), () => order.push(0));
		expect(order).toEqual([0]);
		first.release();
		await Promise.all([first.done, parentWaiter, childWaiter]);
		expect(order).toEqual([0, 1, 2]);
	});

	test("default service instances share hot-safe state; explicit test states are independent", async () => {
		const one = makeCoordinator({ state: undefined });
		const two = makeCoordinator({ state: undefined, db: drizzle(sqlite) });
		const shared = addScope({ deviceId: `hot-safe-device-${serial}` });
		const first = await hold(shared, "write", one);
		await expect(
			two.withWrite(request(shared, { waitTimeoutMs: 0 }), () => undefined),
		).rejects.toThrow(errorCode("wait_timeout"));
		first.release();
		await first.done;
		await two.withWrite(request(shared), () => undefined);
		await one.withWrite(request(shared), async (lease) => {
			const activity = one.registerActivity(request(shared));
			two.endActivity(activity);
			await two.withWrite(request(shared, { leaseToken: lease.token }), (nested) => {
				expect(nested).toBe(lease);
				expect(nested.overlappedUncoordinatedActivity).toBe(true);
			});
		});
		const independentState = createWorkspaceWriteCoordinatorState();
		const isolated = makeCoordinator({ state: independentState });
		const held = await hold();
		expect(independentState.leases.size).toBe(0);
		await expect(isolated.withWrite(request(), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
		// Memory is isolated; the same DB still forbids bypassing its durable lease.
		held.release();
		await held.done;
		await isolated.withWrite(request(), () => undefined);
	});
});

describe("bounded admission, cancellation and explicit nesting", () => {
	test("canceling a waiter cannot release the holder to a later writer", async () => {
		const first = await hold();
		const controller = new AbortController();
		const cancelled = track(
			coordinator.withWrite(request(scope, { signal: controller.signal }), () => undefined),
		);
		let entered = false;
		const third = track(
			coordinator.withWrite(request(), () => {
				entered = true;
			}),
		);
		controller.abort();
		await expect(cancelled).rejects.toThrow(errorCode("aborted"));
		expect(entered).toBe(false);
		expect(row()?.fencingToken).toBe(1);
		expect(state.waiters).toHaveLength(1);
		first.release();
		await Promise.all([first.done, third]);
		expect(entered).toBe(true);
	});

	test("wait timeout only removes its waiter, not the running predecessor", async () => {
		const first = await hold();
		const timeout = track(
			coordinator.withWrite(request(scope, { waitTimeoutMs: 5 }), () => undefined),
		);
		let entered = false;
		const third = track(
			coordinator.withWrite(request(), () => {
				entered = true;
			}),
		);
		await expect(timeout).rejects.toThrow(errorCode("wait_timeout"));
		expect(entered).toBe(false);
		expect(row()?.fencingToken).toBe(1);
		first.release();
		await Promise.all([first.done, third]);
	});

	test("abort or expired admission budget cannot end an already running mutation", async () => {
		const controller = new AbortController();
		const first = await hold(scope, "write", coordinator, {
			signal: controller.signal,
			waitTimeoutMs: 1,
		});
		first.lease.registerMutation("in-flight");
		controller.abort();
		await expect(
			coordinator.withWrite(request(scope, { waitTimeoutMs: 5 }), () => undefined),
		).rejects.toThrow(errorCode("wait_timeout"));
		expect(coordinator.capture(scope).active.writes).toBe(1);
		let entered = false;
		const next = track(
			coordinator.withWrite(request(), () => {
				entered = true;
			}),
		);
		first.lease.settle("in-flight", "applied");
		expect(entered).toBe(false); // even settlement alone cannot release the executing body
		first.release();
		await Promise.all([first.done, next]);
		expect(entered).toBe(true);
	});

	test("already aborted callers consume no fence, even on a free range", async () => {
		await expect(
			coordinator.withWrite(request(scope, { signal: AbortSignal.abort() }), () => undefined),
		).rejects.toThrow(errorCode("aborted"));
		expect(row()?.fencingToken).toBe(0);
	});

	test("default admission queue has exactly 64 waiting slots", async () => {
		expect(WORKSPACE_WRITE_COORDINATOR_LIMITS.waitTimeoutMs).toBe(2_000);
		const first = await hold();
		const controllers = Array.from({ length: 64 }, () => new AbortController());
		const waiting = controllers.map((controller) =>
			track(coordinator.withWrite(request(scope, { signal: controller.signal }), () => undefined)),
		);
		expect(state.waiters).toHaveLength(64);
		await expect(coordinator.withWrite(request(), () => undefined)).rejects.toThrow(
			errorCode("queue_full"),
		);
		for (const controller of controllers) controller.abort();
		await Promise.allSettled(waiting);
		expect(row()?.fencingToken).toBe(1);
		first.release();
		await first.done;
	});

	test("nesting needs a live explicit token, never implicit reentry or expansion", async () => {
		const alias = addScope();
		let expired!: WorkspaceWriteLease;
		await coordinator.withWrite(request(), async (lease) => {
			expired = lease;
			await expect(
				coordinator.withWrite(request(scope, { waitTimeoutMs: 0 }), () => undefined),
			).rejects.toThrow(errorCode("invalid_nesting"));
			await coordinator.withWrite(request(scope, { leaseToken: lease.token }), (nested) => {
				expect(nested).toBe(lease);
				expect(nested.executionBinding.fencingToken).toBe(1);
			});
			await expect(
				coordinator.withRollback(request(scope, { leaseToken: lease.token }), () => undefined),
			).rejects.toThrow(errorCode("invalid_nesting"));
			await expect(
				coordinator.withWrite(request(alias, { leaseToken: lease.token }), () => undefined),
			).rejects.toThrow(errorCode("invalid_nesting"));
		});
		await expect(
			coordinator.withWrite(request(scope, { leaseToken: expired.token }), () => undefined),
		).rejects.toThrow(errorCode("invalid_nesting"));
		await coordinator.withRollback(request(), async (lease) => {
			await coordinator.withWrite(request(scope, { leaseToken: lease.token }), (nested) => {
				expect(nested.kind).toBe("rollback");
			});
		});
		expect(row()?.fencingToken).toBe(2);
	});

	test("unawaited nested execution still keeps the physical range held", async () => {
		const childEntered = gate();
		const finishChild = gate();
		let parentEnded = false;
		const parent = track(
			coordinator
				.withWrite(request(), (lease) => {
					track(
						coordinator.withWrite(request(scope, { leaseToken: lease.token }), async (nested) => {
							nested.registerMutation("nested");
							childEntered.open();
							await finishChild.promise;
							nested.settle("nested", "applied");
						}),
					);
				})
				.then(() => {
					parentEnded = true;
				}),
		);
		await childEntered.promise;
		let nextEntered = false;
		const next = track(
			coordinator.withWrite(request(), () => {
				nextEntered = true;
			}),
		);
		expect(parentEnded).toBe(false);
		expect(nextEntered).toBe(false);
		finishChild.open();
		await Promise.all([parent, next]);
		expect(parentEnded).toBe(true);
		expect(nextEntered).toBe(true);
	});
});

describe("uncoordinated activity windows and conservative capture", () => {
	test("long activity does not own a write lock, but refuses overlapping rollback", async () => {
		const child = addScope({ canonicalRoot: `${scope.canonicalRoot}/child` });
		const activity = coordinator.registerActivity(request(child));
		await expect(coordinator.withRollback(request(), () => undefined)).rejects.toThrow(
			errorCode("uncoordinated_activity"),
		);
		await coordinator.withWrite(request(), (lease) => {
			expect(lease.overlappedUncoordinatedActivity).toBe(true);
			lease.registerMutation("short-write");
			lease.settle("short-write", "applied");
		});
		coordinator.endActivity(activity);
		await coordinator.withRollback(request(), () => undefined);
	});

	test("activity starting and ending inside a lease irreversibly taints that lease", async () => {
		const alias = addScope({ sourceInstanceId: "different-source" });
		let previous!: WorkspaceWriteLease;
		await coordinator.withWrite(request(), (lease) => {
			previous = lease;
			expect(lease.overlappedUncoordinatedActivity).toBe(false);
			const activity = coordinator.registerActivity(request(alias));
			expect(lease.overlappedUncoordinatedActivity).toBe(true);
			coordinator.endActivity(activity);
			expect(coordinator.capture(scope).active.uncoordinatedActivities).toBe(0);
			expect(lease.overlappedUncoordinatedActivity).toBe(true);
		});
		expect(previous.overlappedUncoordinatedActivity).toBe(true);
		await coordinator.withWrite(request(), (lease) => {
			expect(lease.overlappedUncoordinatedActivity).toBe(false);
		});
	});

	test("a queued rollback remembers that an activity appeared even when it promptly ends", async () => {
		const first = await hold();
		const rollback = track(coordinator.withRollback(request(), () => undefined));
		const activity = coordinator.registerActivity(request());
		coordinator.endActivity(activity);
		await expect(rollback).rejects.toThrow(errorCode("uncoordinated_activity"));
		expect(first.lease.overlappedUncoordinatedActivity).toBe(true);
		first.release();
		await first.done;
	});

	test("a running rollback excludes overlapping activity, not another device", async () => {
		const first = await hold(scope, "rollback");
		const alias = addScope();
		expectCode(() => coordinator.registerActivity(request(alias)), "rollback_active");
		const remote = addScope({ deviceId: "separate-device" });
		const activity = coordinator.registerActivity(request(remote));
		expect(first.lease.overlappedUncoordinatedActivity).toBe(false);
		coordinator.endActivity(activity);
		first.release();
		await first.done;
	});

	test("capture reports revisions and bounded active counts, never external quiescence", async () => {
		const before = coordinator.capture(scope);
		const activity = coordinator.registerActivity(request());
		const during = coordinator.capture(scope);
		coordinator.endActivity(activity);
		const after = coordinator.capture(scope);
		expect(during.active.uncoordinatedActivities).toBe(1);
		expect(after.active.uncoordinatedActivities).toBe(0);
		expect(after.coordinationRevision).toBeGreaterThan(during.coordinationRevision);
		expect(during.coordinationRevision).toBeGreaterThan(before.coordinationRevision);
		expect(after.externalFilesystemQuiescence).toBe("unknown");
		await coordinator.withWrite(request(), () => undefined);
		expect(coordinator.capture(scope).scopeRevision).toBeGreaterThan(before.scopeRevision);
		expectCode(() => coordinator.endActivity(activity), "activity_not_found");
	});

	test("failed unknown-activity persistence cannot be downgraded to finished or allow new writes", async () => {
		const activity = coordinator.registerActivity(request());
		sqlite.exec(`CREATE TRIGGER reject_activity_guard BEFORE UPDATE OF status ON file_change_scopes
			WHEN NEW.status = 'needs_verification' BEGIN SELECT RAISE(ABORT, 'activity-guard-failure'); END;`);
		expect(() => coordinator.endActivity(activity, "unknown")).toThrow("activity-guard-failure");
		expect(() => coordinator.endActivity(activity, "finished")).toThrow("activity-guard-failure");
		await expect(coordinator.withWrite(request(), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
		sqlite.exec("DROP TRIGGER reject_activity_guard;");
		coordinator.endActivity(activity, "finished");
		expect(row()?.status).toBe("needs_verification");
	});

	test("an unknown activity cannot be forgiven by settling a simultaneous controlled mutation", async () => {
		const first = await hold();
		first.lease.registerMutation("controlled");
		const activity = coordinator.registerActivity(request());
		coordinator.endActivity(activity, "unknown");
		first.lease.settle("controlled", "applied");
		expectCode(() => first.lease.assertCurrent(), "needs_verification");
		first.release();
		await first.done;
		expect(row()?.status).toBe("needs_verification");
	});
});

describe("explicit rollback activity observation", () => {
	test("strict stays the default while observe admits existing known activity", async () => {
		const activity = coordinator.registerActivity(request());
		await expect(coordinator.withRollback(request(), () => undefined)).rejects.toThrow(
			errorCode("uncoordinated_activity"),
		);
		await coordinator.withRollback(request(scope, { activityPolicy: "observe" }), (lease) => {
			expect(lease.activityPolicy).toBe("observe");
			expect(Object.isFrozen(lease)).toBe(true);
			expect(lease.overlappedUncoordinatedActivity).toBe(true);
			lease.assertCurrent();
			lease.registerMutation("guarded-restore");
			lease.settle("guarded-restore", "applied");
		});
		coordinator.endActivity(activity);
		await coordinator.withRollback(request(), (lease) => {
			expect(lease.activityPolicy).toBe("strict");
		});
	});

	test("observe admits new known activity without erasing the sticky observation", async () => {
		await coordinator.withRollback(request(scope, { activityPolicy: "observe" }), (lease) => {
			expect(lease.overlappedUncoordinatedActivity).toBe(false);
			const activity = coordinator.registerActivity(request());
			expect(lease.overlappedUncoordinatedActivity).toBe(true);
			lease.assertCurrent();
			coordinator.endActivity(activity);
			expect(lease.overlappedUncoordinatedActivity).toBe(true);
			lease.assertCurrent();
		});
	});

	test("a queued observe request survives brief activity and freezes its caller policy", async () => {
		const first = await hold();
		const input = request(scope, { activityPolicy: "observe" });
		const rollback = track(
			coordinator.withRollback(input, (lease) => {
				expect(lease.activityPolicy).toBe("observe");
				const activity = coordinator.registerActivity(request());
				coordinator.endActivity(activity);
				lease.assertCurrent();
			}),
		);
		input.activityPolicy = "strict";
		const activity = coordinator.registerActivity(request());
		coordinator.endActivity(activity);
		first.release();
		await first.done;
		await rollback;
	});

	test("write cannot select observe and nested requests cannot upgrade a strict lease", async () => {
		await expect(
			coordinator.withWrite(request(scope, { activityPolicy: "observe" }), () => undefined),
		).rejects.toThrow(errorCode("invalid_input"));
		expect(row()?.fencingToken).toBe(0);
		await coordinator.withRollback(request(), async (lease) => {
			await expect(
				coordinator.withRollback(
					request(scope, {
						leaseToken: lease.token,
						activityPolicy: "observe",
					}),
					() => undefined,
				),
			).rejects.toThrow(errorCode("invalid_nesting"));
			expect(lease.activityPolicy).toBe("strict");
			expectCode(() => coordinator.registerActivity(request()), "rollback_active");
		});
	});

	test("nested restore inherits the real observe lease, never a request policy", async () => {
		await coordinator.withRollback(request(scope, { activityPolicy: "observe" }), async (lease) => {
			await coordinator.withRollback(request(scope, { leaseToken: lease.token }), (nested) => {
				expect(nested).toBe(lease);
				expect(nested.activityPolicy).toBe("observe");
			});
			await coordinator.withRollback(
				request(scope, {
					leaseToken: lease.token,
					activityPolicy: "strict",
				}),
				(nested) => {
					expect(nested.activityPolicy).toBe("observe");
				},
			);
		});
	});

	test("batch copying keeps each policy and member helpers inherit it", async () => {
		const other = addScope({ canonicalRoot: "/workspace/other" });
		const activity = coordinator.registerActivity(request());
		await coordinator.withRollbackMany(
			{ scopes: [request(other), request(scope, { activityPolicy: "observe" })] },
			async (batch) => {
				const observed = batch.leases.find((lease) => lease.scope.id === scope.id);
				const strict = batch.leases.find((lease) => lease.scope.id === other.id);
				if (!observed || !strict) throw new Error("Missing admitted batch member");
				expect(strict.activityPolicy).toBe("strict");
				await batch.runInScope(observed.token, async (lease) => {
					expect(lease.activityPolicy).toBe("observe");
					await coordinator.withRollback(request(scope, { leaseToken: lease.token }), (nested) => {
						expect(nested).toBe(lease);
					});
					const added = coordinator.registerActivity(request());
					coordinator.endActivity(added);
				});
				expectCode(() => coordinator.registerActivity(request(other)), "rollback_active");
			},
		);
		coordinator.endActivity(activity);
	});

	test("conflicting duplicate policies or an invalid policy never grant a batch", async () => {
		await expect(
			coordinator.withRollbackMany(
				{ scopes: [request(), request(scope, { activityPolicy: "observe" })] },
				() => undefined,
			),
		).rejects.toThrow(errorCode("invalid_input"));
		const invalid = "ignore" as WorkspaceWriteRequest["activityPolicy"];
		await expect(
			coordinator.withRollback(request(scope, { activityPolicy: invalid }), () => undefined),
		).rejects.toThrow(errorCode("invalid_input"));
		await expect(
			coordinator.withRollbackMany(
				{ scopes: [request(scope, { activityPolicy: invalid })] },
				() => undefined,
			),
		).rejects.toThrow(errorCode("invalid_input"));
		expect(row()?.fencingToken).toBe(0);
	});

	test("observe never bypasses uncertain activity retained after failed persistence", async () => {
		const activity = coordinator.registerActivity(request());
		sqlite.exec(`CREATE TRIGGER reject_observed_unknown BEFORE UPDATE OF status ON file_change_scopes
			WHEN NEW.status = 'needs_verification' BEGIN SELECT RAISE(ABORT, 'observed-unknown'); END;`);
		expect(() => coordinator.endActivity(activity, "unknown")).toThrow("observed-unknown");
		await expect(
			coordinator.withRollback(request(scope, { activityPolicy: "observe" }), () => undefined),
		).rejects.toThrow(errorCode("needs_verification"));
		sqlite.exec("DROP TRIGGER reject_observed_unknown;");
		coordinator.endActivity(activity);
		expect(row()?.status).toBe("needs_verification");
		await expect(
			coordinator.withRollback(request(scope, { activityPolicy: "observe" }), () => undefined),
		).rejects.toThrow(errorCode("needs_verification"));
	});

	test("unknown intersecting activity taints observe and retains the durable quarantine", async () => {
		const first = await hold(scope, "rollback", coordinator, { activityPolicy: "observe" });
		first.lease.registerMutation("restore");
		const activity = coordinator.registerActivity(request());
		coordinator.endActivity(activity, "unknown");
		first.lease.settle("restore", "applied");
		expectCode(() => first.lease.assertCurrent(), "needs_verification");
		expectCode(() => coordinator.registerActivity(request()), "rollback_active");
		first.release();
		await first.done;
		expect(row()?.status).toBe("needs_verification");
		expect(quarantined()).toHaveLength(1);
	});

	test("observe does not clear an existing uncertain mutation barrier", async () => {
		await coordinator.withWrite(request(), (lease) => {
			lease.registerMutation("unknown-write");
			lease.settle("unknown-write", "unknown");
		});
		await expect(
			coordinator.withRollback(request(scope, { activityPolicy: "observe" }), () => undefined),
		).rejects.toThrow(errorCode("needs_verification"));
		expect(quarantined()).toHaveLength(1);
	});
});

describe("activity observation follows actual file ranges", () => {
	function ranges() {
		return [{ kind: "file" as const, canonicalPath: `${scope.canonicalRoot}/target/file` }];
	}

	test("an existing sibling subtree activity neither denies strict rollback nor taints its lease", async () => {
		const sibling = addScope({ canonicalRoot: `${scope.canonicalRoot}/sibling` });
		const activity = coordinator.registerActivity(request(sibling));
		await coordinator.withRollback(request(scope, { ranges: ranges() }), (lease) => {
			expect(lease.activityPolicy).toBe("strict");
			expect(lease.overlappedUncoordinatedActivity).toBe(false);
			lease.assertCurrent();
		});
		coordinator.endActivity(activity);
	});

	test.each([
		"write",
		"rollback",
	] as const)("new sibling activity does not taint %s or its unknown outcome", async (kind) => {
		const sibling = addScope({ canonicalRoot: `${scope.canonicalRoot}/sibling` });
		const first = await hold(scope, kind, coordinator, { ranges: ranges() });
		const activity = coordinator.registerActivity(request(sibling));
		expect(first.lease.overlappedUncoordinatedActivity).toBe(false);
		coordinator.endActivity(activity, "unknown");
		expect(row(sibling)?.status).toBe("needs_verification");
		first.lease.assertCurrent();
		first.release();
		await first.done;
		expect(quarantined()).toHaveLength(0);
		await coordinator.withRollback(request(scope, { ranges: ranges() }), () => undefined);
	});

	test("strict excludes activity on the target subtree and its ancestor", async () => {
		const target = addScope({ canonicalRoot: `${scope.canonicalRoot}/target` });
		const first = await hold(scope, "rollback", coordinator, { ranges: ranges() });
		expectCode(() => coordinator.registerActivity(request(target)), "rollback_active");
		expectCode(() => coordinator.registerActivity(request()), "rollback_active");
		first.release();
		await first.done;
	});
});

function observation(target = scope) {
	const captured = coordinator.capture(target);
	return {
		scope: target,
		runtime: { ...runtime },
		scopeRevision: captured.scopeRevision,
		fencingToken: captured.fencingToken,
	};
}

describe("read-only observation guards", () => {
	test("checks a stable scope without allocating a lease, changing a version or claiming external quiescence", () => {
		const input = observation();
		const previous = row();
		const revision = state.revision;
		const transactions = spyOn(db, "transaction");
		queries.length = 0;
		const result = coordinator.assertObservationCurrent(input);
		expect(result.externalFilesystemQuiescence).toBe("unknown");
		expect(result.scopeRevision).toBe(input.scopeRevision);
		expect(row()).toEqual(previous);
		expect(state.revision).toBe(revision);
		expect(state.leases.size).toBe(0);
		expect(state.waiters).toHaveLength(0);
		expect(transactions).not.toHaveBeenCalled();
		expect(queries.some((query) => /^\s*(INSERT|UPDATE|DELETE|BEGIN)/i.test(query))).toBe(false);
		transactions.mockRestore();
	});

	for (const kind of ["quarantine", "crashed lease"] as const) {
		test(`sees another source's ${kind} at a parent path after coordinator state is recreated`, () => {
			addScope({
				sourceInstanceId: "another-source",
				canonicalRoot: "/workspace",
				...(kind === "quarantine"
					? { status: "needs_verification" as const }
					: {
							activeLeaseId: "crashed-lease",
							activeLeaseEpoch: "dead-process",
							activeLeaseStartedAt: "2026-09-07",
						}),
			});
			const fresh = makeCoordinator({ state: createWorkspaceWriteCoordinatorState() });
			expect(fresh.capture(scope).durableLeasePresent).toBe(false);
			expectCode(() => fresh.assertObservationCurrent(observation()), "needs_verification");
			expect(row()?.fencingToken).toBe(0);
		});
	}

	test("ignores non-overlapping and other-device recovery records", () => {
		addScope({ canonicalRoot: "/unrelated", status: "needs_verification" });
		addScope({ deviceId: "another-device", status: "needs_verification" });
		expect(coordinator.assertObservationCurrent(observation()).status).toBe("active");
	});

	test("cannot observe through a live activity or lease and does not cancel them", async () => {
		const activity = coordinator.registerActivity(request());
		expectCode(() => coordinator.assertObservationCurrent(observation()), "uncoordinated_activity");
		expect(state.activities.size).toBe(1);
		coordinator.endActivity(activity);
		const running = await hold();
		expectCode(() => coordinator.assertObservationCurrent(observation()), "needs_verification");
		expect(state.leases.size).toBe(1);
		running.release();
		await running.done;
		expect(coordinator.assertObservationCurrent(observation()).active.writes).toBe(0);
	});

	test("revalidates the captured revision, fence and authoritative runtime", () => {
		const input = observation();
		update({ revision: 1 });
		expectCode(() => coordinator.assertObservationCurrent(input), "stale_lease");
		update({ revision: 0, fencingToken: 1 });
		expectCode(() => coordinator.assertObservationCurrent(input), "stale_lease");
		update({ fencingToken: 0 });
		runtimes.set(scope.deviceId, { ...runtime, runtimeEpoch: "new-process" });
		expectCode(() => coordinator.assertObservationCurrent(input), "runtime_mismatch");
	});

	test("incomplete own lease metadata and retired scope cannot look ready", () => {
		const input = observation();
		update({ activeLeaseEpoch: "orphaned-owner" });
		expectCode(() => coordinator.assertObservationCurrent(input), "needs_verification");
		update({ activeLeaseEpoch: null, status: "retired" });
		expectCode(() => coordinator.assertObservationCurrent(input), "scope_inactive");
	});

	test("aborted or invalid observation has no side effects", () => {
		const input = observation();
		expectCode(
			() => coordinator.assertObservationCurrent({ ...input, signal: AbortSignal.abort() }),
			"aborted",
		);
		expectCode(
			() => coordinator.assertObservationCurrent({ ...input, scopeRevision: -1 }),
			"invalid_input",
		);
		expect(row()?.fencingToken).toBe(0);
	});

	test("a bounded recovery scan cannot advertise a complete observation over its limit", () => {
		for (let index = 0; index <= WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes; index++) {
			addScope({ canonicalRoot: `/unrelated/${index}`, status: "needs_verification" });
		}
		expectCode(() => coordinator.assertObservationCurrent(observation()), "verification_backlog");
		expect(state.leases.size).toBe(0);
	});
});

describe("durable mutation guards and fail-closed settlement", () => {
	test("registers pending guards without invalidating other effects prepared at the lease revision", async () => {
		await coordinator.withWrite(request(), (lease) => {
			const revision = lease.scopeRevision;
			expect(revision).toBe(coordinator.capture(scope).scopeRevision);
			lease.registerMutation("one");
			lease.registerMutation("two");
			expect(row()).toMatchObject({ status: "active", activeMutationCount: 2 });
			expect(row()?.activeLeaseEpoch).toBe(state.ownerEpoch);
			expect(row()?.activeLeaseId).toBeString();
			expect(lease.pendingMutationCount).toBe(2);
			lease.assertCurrent();
			expect(coordinator.capture(scope).scopeRevision).toBe(revision);
			lease.settle("one", "applied");
			expect(row()).toMatchObject({ status: "active", activeMutationCount: 1 });
			expect(coordinator.capture(scope).scopeRevision).toBe(revision);
			lease.settle("two", "not_applied");
			expect(row()).toMatchObject({ status: "active", activeMutationCount: 0 });
			expect(lease.pendingMutationCount).toBe(0);
			expectCode(() => lease.registerMutation("one"), "mutation_conflict");
			expectCode(() => lease.settle("two", "applied"), "mutation_conflict");
		});
		expect(row()).toMatchObject({
			revision: 2,
			fencingToken: 1,
			status: "active",
			activeLeaseId: null,
			activeLeaseEpoch: null,
			activeLeaseStartedAt: null,
			activeMutationCount: 0,
		});
	});

	for (const outcome of ["unsettled", "unknown", "explicit-uncertainty"] as const) {
		test(`${outcome} survives lock release and a fresh process-state instance`, async () => {
			await coordinator.withWrite(request(), (lease) => {
				lease.registerMutation("may-have-written");
				if (outcome === "unknown") lease.settle("may-have-written", "unknown");
				if (outcome === "explicit-uncertainty") {
					lease.markUncertain();
					lease.settle("may-have-written", "not_applied");
				}
			});
			expect(state.leases.size).toBe(0);
			expectQuarantined();
			const restarted = makeCoordinator({ state: createWorkspaceWriteCoordinatorState() });
			const alias = addScope({
				sourceInstanceId: "new-source",
				canonicalRoot: `${scope.canonicalRoot}/child`,
			});
			await expect(restarted.withWrite(request(alias), () => undefined)).rejects.toThrow(
				errorCode("needs_verification"),
			);
			await expect(restarted.withRollback(request(), () => undefined)).rejects.toThrow(
				errorCode("needs_verification"),
			);
			expect(row(alias)?.fencingToken).toBe(0);
		});
	}

	test("a durable lease survives restart and has no TTL, even with zero mutations", async () => {
		update({
			activeLeaseId: "previous-process-lease",
			activeLeaseEpoch: "old-process-epoch",
			activeLeaseStartedAt: "2000-01-01T00:00:00.000Z",
			activeMutationCount: 0,
		});
		const alias = addScope({ sourceInstanceId: "fresh-evidence-instance" });
		const restarted = makeCoordinator({ state: createWorkspaceWriteCoordinatorState() });
		await expect(restarted.withWrite(request(), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
		await expect(restarted.withRollback(request(alias), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
		expect(row()).toMatchObject({ status: "active", fencingToken: 0 });
		expect(restarted.capture(scope)).toMatchObject({
			durableLeasePresent: true,
			activeMutationCount: 0,
			active: { writes: 0, rollbacks: 0 },
			externalFilesystemQuiescence: "unknown",
		});
	});

	test("pending metadata survives crash independently of scope root verification", async () => {
		const first = await hold();
		first.lease.registerMutation("in-flight");
		expect(row()).toMatchObject({ status: "active", activeMutationCount: 1 });
		const alias = addScope({ canonicalRoot: `${scope.canonicalRoot}/child` });
		const restarted = makeCoordinator({ state: createWorkspaceWriteCoordinatorState() });
		await expect(restarted.withWrite(request(alias), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
		first.release();
		await first.done;
		expectQuarantined();
		expect(quarantined()[0].mutationManifestJson.mutations[0]).toMatchObject({
			mutationId: "in-flight",
			outcome: "pending",
		});
		// Re-verifying just the root is not enough to forgive unfinished execution.
		update({ status: "active" });
		await expect(restarted.withWrite(request(), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
	});

	test("a waiter cannot pass a failed, unfinished mutation", async () => {
		const entered = gate();
		const finish = gate();
		const writer = track(
			coordinator.withWrite(request(), async (lease) => {
				lease.registerMutation("before-failure");
				entered.open();
				await finish.promise;
				throw new Error("writer failed");
			}),
		);
		await entered.promise;
		const next = track(coordinator.withWrite(request(), () => undefined));
		finish.open();
		await expect(writer).rejects.toThrow("writer failed");
		await expect(next).rejects.toThrow(errorCode("needs_verification"));
		expect(row()?.fencingToken).toBe(1);
		expectQuarantined();
	});

	test("preparation/read-only failures and definitely not-applied mutations do not seal a scope", async () => {
		await expect(
			coordinator.withWrite(request(), () => {
				throw new Error("preparation failed");
			}),
		).rejects.toThrow("preparation failed");
		await expect(
			coordinator.withWrite(request(), (lease) => {
				lease.registerMutation("not-written");
				lease.settle("not-written", "not_applied");
				throw new Error("encoding rejected");
			}),
		).rejects.toThrow("encoding rejected");
		expect(row()?.status).toBe("active");
		await coordinator.withRollback(request(), () => undefined);
	});

	test("a failed guard transaction must not permit dispatch or invent a pending mutation", async () => {
		sqlite.exec(`CREATE TRIGGER reject_guard BEFORE UPDATE OF active_mutation_count ON file_change_scopes
			WHEN NEW.active_mutation_count > OLD.active_mutation_count
			BEGIN SELECT RAISE(ABORT, 'guard-failure'); END;`);
		await coordinator.withWrite(request(), (lease) => {
			expect(() => lease.registerMutation("never-dispatched")).toThrow("guard-failure");
			expect(lease.pendingMutationCount).toBe(0);
		});
		expect(row()?.status).toBe("active");
	});

	test("failed uncertainty persistence retains its range until an explicit successful retry", async () => {
		sqlite.exec(`CREATE TRIGGER reject_guard BEFORE UPDATE OF status ON workspace_write_leases
			WHEN NEW.status = 'quarantined' BEGIN SELECT RAISE(ABORT, 'guard-failure'); END;`);
		let lease!: WorkspaceWriteLease;
		await expect(
			coordinator.withWrite(request(), (value) => {
				lease = value;
				value.markUncertain();
			}),
		).rejects.toThrow(errorCode("persistence_failed"));
		expect(coordinator.capture(scope).active).toMatchObject({
			writes: 1,
			retainedRecoveryHolds: 1,
		});
		const alias = addScope();
		await expect(
			coordinator.withWrite(request(alias, { waitTimeoutMs: 0 }), () => undefined),
		).rejects.toThrow(errorCode("wait_timeout"));
		expectCode(() => lease.registerMutation("stale"), "stale_lease");
		sqlite.exec("DROP TRIGGER reject_guard;");
		coordinator.retryUncertainPersistence(lease.token);
		expect(state.leases.size).toBe(0);
		expectQuarantined();
		await expect(coordinator.withWrite(request(alias), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
		expectCode(() => coordinator.retryUncertainPersistence(lease.token), "stale_lease");
	});

	test("quarantine inventory is bounded and cannot hide a blocker past the budget", async () => {
		for (let index = 0; index <= WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes; index++) {
			addScope({ canonicalRoot: `/unrelated/${index}`, status: "needs_verification" });
		}
		await expect(coordinator.withWrite(request(), () => undefined)).rejects.toThrow(
			errorCode("verification_backlog"),
		);
		expect(row()?.fencingToken).toBe(0);
		expect(queries.some((query) => /where .*status.*limit \?/i.test(query))).toBe(true);
	});

	test("rejects unsafe SQLite waits and overflowing fences without mutation", async () => {
		sqlite.exec("PRAGMA busy_timeout = 1000;");
		expectCode(() => makeCoordinator(), "invalid_input");
		sqlite.exec("PRAGMA busy_timeout = 0;");
		update({ fencingToken: Number.MAX_SAFE_INTEGER });
		await expect(coordinator.withWrite(request(), () => undefined)).rejects.toThrow(
			errorCode("invalid_input"),
		);
		expect(row()?.fencingToken).toBe(Number.MAX_SAFE_INTEGER);
	});
});

function batchRequest(
	targets: readonly FileChangeScopeIdentity[],
	options: Omit<WorkspaceWriteManyRequest, "scopes"> = {},
): WorkspaceWriteManyRequest {
	return { scopes: targets.map((target) => request(target)), ...options };
}

async function holdBatch(
	targets: readonly FileChangeScopeIdentity[],
	options: Omit<WorkspaceWriteManyRequest, "scopes"> = {},
	owner = coordinator,
) {
	const entered = gate();
	const finish = gate();
	let batch!: WorkspaceWriteBatch;
	const done = track(
		owner.withRollbackMany(batchRequest(targets, options), async (value) => {
			batch = value;
			entered.open();
			await finish.promise;
		}),
	);
	await entered.promise;
	return { batch, done, release: finish.open };
}

function batchPair() {
	return [
		addScope({ canonicalRoot: "/batch/a" }),
		addScope({ canonicalRoot: "/batch/b" }),
	] as const;
}

describe("batch atomic admission and exact physical ranges", () => {
	test("grants real per-scope fences in one short transaction with stable effect revisions", async () => {
		const [a, b] = batchPair();
		update({ fencingToken: 3, revision: 5 }, b);
		const transactions = spyOn(db, "transaction");
		queries.length = 0;
		let expired: readonly WorkspaceWriteLease[] = [];
		const value = await coordinator.withRollbackMany(batchRequest([b, a]), async (batch) => {
			expired = batch.leases;
			expect(sqlite.inTransaction).toBe(false);
			expect(transactions.mock.calls).toHaveLength(1);
			expect(
				queries.filter((query) =>
					/from "file_change_scopes" where .*"status" = .*limit/i.test(query),
				),
			).toHaveLength(1);
			expect(batch.leases.map((lease) => lease.scope.id)).toEqual([a.id, b.id]);
			expect(new Set(batch.leases.map((lease) => lease.token)).size).toBe(2);
			expect(new Set([row(a)?.activeLeaseId, row(b)?.activeLeaseId]).size).toBe(2);
			expect(batch.leases.map((lease) => lease.executionBinding.fencingToken)).toEqual([1, 4]);
			expect(Object.isFrozen(batch)).toBe(true);
			expect(Object.isFrozen(batch.leases)).toBe(true);
			for (const lease of batch.leases) {
				const revision = lease.scopeRevision;
				lease.assertCurrent();
				lease.registerMutation("same-file-effect-one");
				lease.registerMutation("same-file-effect-two");
				lease.settle("same-file-effect-one", "applied");
				lease.settle("same-file-effect-two", "not_applied");
				expect(lease.scopeRevision).toBe(revision);
				expect(coordinator.capture(lease.scope).scopeRevision).toBe(revision);
				lease.assertCurrent();
			}
			await batch.runInScope(batch.leases[1].token, (lease) =>
				coordinator.withWrite(request(b, { leaseToken: lease.token }), (nested) => {
					expect(nested).toBe(lease);
					expect(nested.kind).toBe("rollback");
				}),
			);
			return "complete, not OS-atomic";
		});
		expect(value).toBe("complete, not OS-atomic");
		expect(row(a)).toMatchObject({ fencingToken: 1, revision: 2, activeLeaseId: null });
		expect(row(b)).toMatchObject({ fencingToken: 4, revision: 7, activeLeaseId: null });
		for (const lease of expired) expectCode(() => lease.assertCurrent(), "stale_lease");
		expect(transactions.mock.calls.every(([, config]) => config?.behavior === "immediate")).toBe(
			true,
		);
		transactions.mockRestore();
	});

	test("simultaneous A+B and B+A serialize without deadlock or half a grant", async () => {
		const [a, b] = batchPair();
		const entered = gate();
		const finish = gate();
		const order: string[] = [];
		const first = track(
			coordinator.withRollbackMany(batchRequest([a, b]), async () => {
				order.push("first");
				entered.open();
				await finish.promise;
			}),
		);
		const second = track(
			coordinator.withRollbackMany(batchRequest([b, a]), (batch) => {
				order.push("second");
				expect(batch.leases.map((lease) => lease.executionBinding.fencingToken)).toEqual([2, 2]);
			}),
		);
		await entered.promise;
		expect(state.waiters).toHaveLength(1);
		expect(state.leases.size).toBe(2);
		expect(order).toEqual(["first"]);
		finish.open();
		await Promise.all([first, second]);
		expect(order).toEqual(["first", "second"]);
	});

	test("a busy second member reserves no first member and cannot block an independent sibling C", async () => {
		const [a, b] = batchPair();
		const c = addScope({ canonicalRoot: "/batch/c" });
		const first = await hold(b);
		const waiting = track(coordinator.withRollbackMany(batchRequest([a, b]), () => undefined));
		expect(row(a)).toMatchObject({ activeLeaseId: null, fencingToken: 0 });
		expect(coordinator.capture(a).active.rollbacks).toBe(0);
		expect(state.leases.size).toBe(1);
		await coordinator.withWrite(request(c, { waitTimeoutMs: 0 }), (lease) => lease.assertCurrent());
		expect(row(a)?.fencingToken).toBe(0);
		first.release();
		await Promise.all([first.done, waiting]);
	});

	test("intersecting batch FIFO does not head-of-line block unrelated devices", async () => {
		const [a, b] = batchPair();
		const c = addScope({ canonicalRoot: "/batch/c" });
		const remote = addScope({ canonicalRoot: "/batch/a", deviceId: "remote-batch-device" });
		const first = await hold(b);
		const order: string[] = [];
		const ab = track(coordinator.withRollbackMany(batchRequest([a, b]), () => order.push("ab")));
		const bc = track(coordinator.withRollbackMany(batchRequest([b, c]), () => order.push("bc")));
		const single = track(coordinator.withWrite(request(c), () => order.push("c")));
		await coordinator.withWrite(request(remote), () => order.push("remote"));
		expect(order).toEqual(["remote"]);
		first.release();
		await Promise.all([first.done, ab, bc, single]);
		expect(order).toEqual(["remote", "ab", "bc", "c"]);
	});

	for (const pathFlavor of ["posix", "windows"] as const) {
		test(`overlapping ${pathFlavor} parent/child/source aliases own real guards without self-blocking`, async () => {
			const root = pathFlavor === "windows" ? "C:\\Batch" : "/batch";
			const parent = addScope({ canonicalRoot: root, pathFlavor });
			const child = addScope({ canonicalRoot: `${root}/child`, pathFlavor });
			const alias = addScope({ canonicalRoot: root, pathFlavor, sourceInstanceId: "other-source" });
			const running = await holdBatch([child, alias, parent]);
			for (const lease of running.batch.leases) {
				lease.registerMutation("effect");
				lease.assertCurrent();
				lease.settle("effect", "applied");
				lease.assertCurrent();
			}
			expect(coordinator.capture(child).active.rollbacks).toBe(3);
			const outsider = addScope({ canonicalRoot: `${root}/child/deeper`, pathFlavor });
			await expect(
				coordinator.withWrite(request(outsider, { waitTimeoutMs: 0 }), () => undefined),
			).rejects.toThrow(errorCode("wait_timeout"));
			expectCode(() => coordinator.registerActivity(request(parent)), "rollback_active");
			running.release();
			await running.done;
			await coordinator.withWrite(request(outsider), () => undefined);
		});
	}

	test("cross-device targets never become a Cartesian product of devices and roots", async () => {
		const a = addScope({ canonicalRoot: "/a", deviceId: "one" });
		const b = addScope({ canonicalRoot: "/b", deviceId: "two" });
		const ab = addScope({ canonicalRoot: "/b", deviceId: "one" });
		const ba = addScope({ canonicalRoot: "/a", deviceId: "two" });
		const running = await holdBatch([a, b]);
		await coordinator.withWrite(request(ab, { waitTimeoutMs: 0 }), () => undefined);
		await coordinator.withWrite(request(ba, { waitTimeoutMs: 0 }), () => undefined);
		running.release();
		await running.done;
	});
});

describe("batch descriptors, snapshots and ordering", () => {
	test("deduplicates equal identities regardless of property order and canonical spelling", async () => {
		const [a, b] = batchPair();
		const reversed = Object.fromEntries(
			Object.entries(a).reverse(),
		) as unknown as FileChangeScopeIdentity;
		const alternate = { ...reversed, canonicalRoot: `${a.canonicalRoot}/./` };
		await coordinator.withRollbackMany(
			{
				scopes: [
					request(b),
					{
						runtime: {
							runtimeGeneration: runtime.runtimeGeneration,
							runtimeEpoch: runtime.runtimeEpoch,
						},
						scope: alternate,
					},
					request(a),
				],
			},
			(batch) => {
				expect(batch.leases).toHaveLength(2);
				expect(batch.leases.map((lease) => lease.scope.id)).toEqual([a.id, b.id]);
				for (const lease of batch.leases) lease.assertCurrent();
			},
		);
		expect(row(a)?.fencingToken).toBe(1);
	});

	test("conflicting duplicate identity or device runtime rejects the complete input before queueing", async () => {
		const [a, b] = batchPair();
		const held = await hold(b);
		for (const mismatch of [
			{ canonicalRoot: "/elsewhere" },
			{ sourceInstanceId: "other" },
			{ workspaceInstanceId: "other" },
			{ deviceId: "other" },
		]) {
			await expect(
				coordinator.withRollbackMany(batchRequest([b, a, { ...a, ...mismatch }]), () => undefined),
			).rejects.toThrow(errorCode("scope_identity_mismatch"));
		}
		await expect(
			coordinator.withRollbackMany(
				{
					scopes: [
						request(a),
						request(b),
						request(a, {
							runtime: { ...runtime, runtimeGeneration: 8 },
						}),
					],
				},
				() => undefined,
			),
		).rejects.toThrow(errorCode("runtime_mismatch"));
		expect(state.waiters).toHaveLength(0);
		expect(row(a)?.fencingToken).toBe(0);
		held.release();
		await held.done;
	});

	test("freezes every target and runtime before the first await, not just the first scope", async () => {
		const [a, b] = batchPair();
		const held = await hold(b);
		const mutable = [request({ ...a }), request({ ...b })];
		const waiting = track(
			coordinator.withRollbackMany({ scopes: mutable }, (batch) => {
				expect(batch.leases.map((lease) => lease.scope.id)).toEqual([a.id, b.id]);
				for (const lease of batch.leases) {
					expect(lease.executionBinding.runtimeEpoch).toBe(runtime.runtimeEpoch);
					lease.assertCurrent();
				}
			}),
		);
		(mutable[1].scope as FileChangeScopeIdentity).canonicalRoot = "/redirected";
		(mutable[1].runtime as { runtimeEpoch: string }).runtimeEpoch = "redirected";
		mutable.splice(0, 2, request(addScope({ canonicalRoot: "/new-target" })));
		held.release();
		await Promise.all([held.done, waiting]);
	});

	test("all permutations and property insertion orders produce the same acquisition order", async () => {
		const targets = [
			addScope({ canonicalRoot: "/c", deviceId: "two" }),
			addScope({ canonicalRoot: "/b", deviceId: "one" }),
			addScope({ canonicalRoot: "/a", deviceId: "one" }),
		];
		const permutations = [
			[0, 1, 2],
			[0, 2, 1],
			[1, 0, 2],
			[1, 2, 0],
			[2, 0, 1],
			[2, 1, 0],
		];
		for (const permutation of permutations) {
			const permuted = permutation.map(
				(index) =>
					Object.fromEntries(
						Object.entries(targets[index]).reverse(),
					) as unknown as FileChangeScopeIdentity,
			);
			await coordinator.withRollbackMany(batchRequest(permuted), (batch) => {
				expect(batch.leases.map((lease) => lease.scope.id)).toEqual([
					targets[2].id,
					targets[1].id,
					targets[0].id,
				]);
			});
		}
	});

	test("collection getters and custom iterators cannot expand the fixed target budget", async () => {
		const [a, b] = batchPair();
		let runtimeReads = 0;
		const targets: WorkspaceWriteRequest[] = [
			{
				get scope() {
					targets.push(request(b));
					return a;
				},
				get runtime() {
					runtimeReads++;
					return runtime;
				},
			},
		];
		Object.defineProperty(targets, Symbol.iterator, {
			value: () => {
				throw new Error("Caller iterator must not control target enumeration");
			},
		});
		await coordinator.withRollbackMany({ scopes: targets }, (batch) => {
			expect(batch.leases.map((lease) => lease.scope.id)).toEqual([a.id]);
		});
		expect(targets).toHaveLength(2);
		expect(runtimeReads).toBe(1);
		expect(row(b)?.fencingToken).toBe(0);
	});

	test("invalid final target, empty collection and malformed runtime never partially grant", async () => {
		const [a, b] = batchPair();
		for (const invalid of [
			{ scopes: [] },
			{ scopes: [request(a), request({ ...b, canonicalRoot: "relative" })] },
			{ scopes: [request(a), { scope: b, runtime: null }] },
			{ scopes: [request(a), { scope: null, runtime }] },
			{ scopes: [request(a), null] },
		]) {
			await expect(
				coordinator.withRollbackMany(
					invalid as unknown as WorkspaceWriteManyRequest,
					() => undefined,
				),
			).rejects.toThrow(errorCode("invalid_input"));
		}
		expect(row(a)).toMatchObject({ fencingToken: 0, activeLeaseId: null });
		expect(row(b)).toMatchObject({ fencingToken: 0, activeLeaseId: null });
	});
});

describe("batch hard budgets", () => {
	test("one real lease admits 1000 apply IDs plus 1000 compensation IDs without releasing cancelled work", async () => {
		const [a, b] = batchPair();
		const controller = new AbortController();
		// Avoid retaining thousands of SQL strings in the fixture logger. The DB
		// and real coordinator remain the same bounded in-memory test environment.
		const owner = makeCoordinator({ db: drizzle(sqlite) });
		const held = await holdBatch([a, b], { signal: controller.signal }, owner);
		const lease = held.batch.leases[0];
		const revision = lease.scopeRevision;
		const guardId = row(a)?.activeLeaseId;
		const mutationId = (phase: string, index: number) => `${phase}-${index}`.padEnd(64, "a");
		// The real executor awaits IO per file. This metadata-only stress fixture
		// yields explicitly so 4,000 short transactions never monopolize one turn.
		const yieldIo = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(FILE_CHANGE_LIMITS.revertFiles).toBe(1_000);
		for (const phase of ["apply", "compensate"] as const) {
			for (let index = 0; index < FILE_CHANGE_LIMITS.revertFiles; index++) {
				lease.registerMutation(mutationId(phase, index), {
					operationId: "o".repeat(21),
					effectId: `${phase}-${index}`.padEnd(21, "e"),
				});
				if (index % 32 === 31) await yieldIo();
			}
			expect(lease.pendingMutationCount).toBe(1_000);
			expect(row(a)).toMatchObject({
				activeMutationCount: 1_000,
				activeLeaseId: guardId,
				revision,
			});
			expect(lease.scopeRevision).toBe(revision);
			lease.assertMutationPending(mutationId(phase, 999));
			for (let index = 0; index < FILE_CHANGE_LIMITS.revertFiles; index++) {
				lease.settle(mutationId(phase, index), "applied");
				if (index % 32 === 31) await yieldIo();
			}
			expect(lease.pendingMutationCount).toBe(0);
			expect(row(a)).toMatchObject({ activeMutationCount: 0, revision });
			expect(lease.scopeRevision).toBe(revision);
			lease.assertCurrent();
			// Cancellation only controlled admission. Compensation still uses fresh
			// IDs on the SAME lease, while BOTH group ranges remain exclusively held.
			controller.abort();
			for (const target of [a, b]) {
				await expect(
					coordinator.withWrite(request(target, { waitTimeoutMs: 0 }), () => undefined),
				).rejects.toThrow(errorCode("wait_timeout"));
			}
		}
		expect(WORKSPACE_WRITE_COORDINATOR_LIMITS.mutationsPerLease).toBe(2_000);
		const beforeRejected = row(a);
		const stamp = state.revision;
		expectCode(() => lease.registerMutation("mutation-2001"), "capacity_exceeded");
		expectCode(() => lease.registerMutation(mutationId("apply", 0)), "mutation_conflict");
		expect(row(a)).toEqual(beforeRejected);
		expect(state.revision).toBe(stamp);
		expect(state.leases.size).toBe(2);
		let nextEntered = false;
		const next = track(
			coordinator.withWrite(request(b), () => {
				nextEntered = true;
			}),
		);
		expect(nextEntered).toBe(false);
		held.release();
		await Promise.all([held.done, next]);
		expect(nextEntered).toBe(true);
		expect(row(a)).toMatchObject({
			status: "active",
			activeLeaseId: null,
			activeMutationCount: 0,
			revision: revision + 1,
		});
	}, 15_000); // Realistic manifests + 4,000 durable transactions, not an IO deadline.

	test("32 distinct scopes are admitted together; 33 inputs are rejected, never chunked", async () => {
		const targets = Array.from(
			{ length: WORKSPACE_WRITE_COORDINATOR_LIMITS.batchScopes },
			(_, index) => addScope({ canonicalRoot: `/budget/${index}` }),
		);
		let called = false;
		await expect(
			coordinator.withRollbackMany(batchRequest([...targets, scope]), () => {
				called = true;
			}),
		).rejects.toThrow(errorCode("capacity_exceeded"));
		await expect(
			coordinator.withRollbackMany(
				batchRequest(Array.from({ length: 33 }, () => scope)),
				() => undefined,
			),
		).rejects.toThrow(errorCode("capacity_exceeded"));
		expect(called).toBe(false);
		for (const target of targets) expect(row(target)?.fencingToken).toBe(0);
		await coordinator.withRollbackMany(batchRequest(targets), (batch) => {
			expect(batch.leases).toHaveLength(32);
			expect(state.leases.size).toBe(32);
			for (const lease of batch.leases) lease.assertCurrent();
		});
	});

	test("active slots count every member and an insufficient remainder grants none", async () => {
		const groups: Awaited<ReturnType<typeof holdBatch>>[] = [];
		for (let group = 0; group < 8; group++) {
			groups.push(
				await holdBatch(
					Array.from({ length: group === 7 ? 31 : 32 }, (_, index) =>
						addScope({ canonicalRoot: `/active/${group}/${index}` }),
					),
				),
			);
		}
		expect(state.leases.size).toBe(255);
		const [a, b] = batchPair();
		const entered = gate();
		const finish = gate();
		const next = track(
			coordinator.withRollbackMany(batchRequest([a, b]), async () => {
				entered.open();
				await finish.promise;
			}),
		);
		expect(state.waiters).toHaveLength(1);
		expect(row(a)?.fencingToken).toBe(0);
		expect(row(b)?.fencingToken).toBe(0);
		const single = await hold(scope);
		expect(state.leases.size).toBe(WORKSPACE_WRITE_COORDINATOR_LIMITS.activeLeases);
		groups[7].release();
		await entered.promise;
		expect(state.leases.size).toBe(227);
		finish.open();
		single.release();
		for (const group of groups) group.release();
		await Promise.all([next, single.done, ...groups.map((group) => group.done)]);
	});

	test("queued batches are bounded by both actual member count and item count", async () => {
		const first = await hold();
		const targets = [
			scope,
			...Array.from({ length: 31 }, (_, index) => addScope({ canonicalRoot: `/queued/${index}` })),
		];
		const controllers = Array.from({ length: 8 }, () => new AbortController());
		const waiting = controllers.map((controller) =>
			track(
				coordinator.withRollbackMany(
					batchRequest(targets, { signal: controller.signal }),
					() => undefined,
				),
			),
		);
		expect(state.waiters).toHaveLength(8);
		await expect(coordinator.withWrite(request(), () => undefined)).rejects.toThrow(
			errorCode("queue_full"),
		);
		const remote = addScope({ deviceId: "not-queued-device" });
		await coordinator.withWrite(request(remote), () => undefined);
		for (const controller of controllers) controller.abort();
		await Promise.allSettled(waiting);
		const itemControllers = Array.from({ length: 64 }, () => new AbortController());
		const items = itemControllers.map((controller) =>
			track(
				coordinator.withRollbackMany(
					batchRequest([scope], { signal: controller.signal }),
					() => undefined,
				),
			),
		);
		expect(state.waiters).toHaveLength(64);
		await expect(
			coordinator.withRollbackMany(batchRequest([scope]), () => undefined),
		).rejects.toThrow(errorCode("queue_full"));
		for (const controller of itemControllers) controller.abort();
		await Promise.allSettled(items);
		first.release();
		await first.done;
	});

	test("admission cannot create a durable inventory over its own verification budget", async () => {
		for (let index = 0; index < 255; index++) {
			addScope({
				canonicalRoot: `/crashed/${index}`,
				activeLeaseId: `old-${index}`,
				activeLeaseEpoch: "dead",
			});
		}
		const [a, b] = batchPair();
		await expect(
			coordinator.withRollbackMany(batchRequest([a, b]), () => undefined),
		).rejects.toThrow(errorCode("verification_backlog"));
		expect(row(a)?.fencingToken).toBe(0);
		expect(row(b)?.fencingToken).toBe(0);
	});

	test("quarantine inventory is checked globally once and is never truncated into approval", async () => {
		for (let index = 0; index <= WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes; index++) {
			addScope({ canonicalRoot: `/unrelated-batch/${index}`, status: "needs_verification" });
		}
		const [a, b] = batchPair();
		await expect(
			coordinator.withRollbackMany(batchRequest([a, b]), () => undefined),
		).rejects.toThrow(errorCode("verification_backlog"));
		expect(row(a)?.fencingToken).toBe(0);
		expect(row(b)?.fencingToken).toBe(0);
	});
});

describe("batch cancellation and authoritative revalidation", () => {
	for (const reason of ["abort", "timeout"] as const) {
		test(`${reason} removes the whole waiter without affecting its holder`, async () => {
			const [a, b] = batchPair();
			const held = await hold(b);
			const controller = new AbortController();
			const waiting = track(
				coordinator.withRollbackMany(
					batchRequest([a, b], {
						signal: controller.signal,
						waitTimeoutMs: reason === "timeout" ? 5 : 2_000,
					}),
					() => undefined,
				),
			);
			if (reason === "abort") controller.abort();
			await expect(waiting).rejects.toThrow(
				errorCode(reason === "abort" ? "aborted" : "wait_timeout"),
			);
			expect(state.leases.size).toBe(1);
			expect(state.waiters).toHaveLength(0);
			expect(row(a)?.activeLeaseId).toBeNull();
			await coordinator.withWrite(request(a, { waitTimeoutMs: 0 }), () => undefined);
			held.release();
			await held.done;
		});
	}

	test("already aborted batch consumes no fence and cancellation after grant releases no member", async () => {
		const [a, b] = batchPair();
		await expect(
			coordinator.withRollbackMany(
				batchRequest([a, b], { signal: AbortSignal.abort() }),
				() => undefined,
			),
		).rejects.toThrow(errorCode("aborted"));
		expect(row(a)?.fencingToken).toBe(0);
		const controller = new AbortController();
		const held = await holdBatch([a, b], { signal: controller.signal, waitTimeoutMs: 1 });
		const lease = held.batch.leases[1];
		lease.registerMutation("in-flight");
		controller.abort();
		for (const target of [a, b]) {
			await expect(
				coordinator.withWrite(request(target, { waitTimeoutMs: 5 }), () => undefined),
			).rejects.toThrow(errorCode("wait_timeout"));
		}
		lease.settle("in-flight", "applied");
		expect(state.leases.size).toBe(2);
		held.release();
		await held.done;
	});

	for (const change of ["epoch", "generation", "missing", "identity", "inactive"] as const) {
		test(`queued second-scope ${change} is revalidated before any member grant`, async () => {
			const [a, b] = batchPair();
			const held = await hold(b);
			const alias = addScope({ canonicalRoot: b.canonicalRoot });
			const waiting = track(
				coordinator.withRollbackMany(batchRequest([a, alias]), () => undefined),
			);
			if (change === "epoch") runtimes.set(b.deviceId, { ...runtime, runtimeEpoch: "new" });
			if (change === "generation") runtimes.set(b.deviceId, { ...runtime, runtimeGeneration: 8 });
			if (change === "missing") runtimes.delete(b.deviceId);
			if (change === "identity") update({ workspaceInstanceId: "replaced" }, alias);
			if (change === "inactive") update({ status: "retired" }, alias);
			held.release();
			await held.done;
			await expect(waiting).rejects.toThrow(
				errorCode(
					change === "identity"
						? "scope_identity_mismatch"
						: change === "inactive"
							? "scope_inactive"
							: "runtime_mismatch",
				),
			);
			expect(row(a)?.fencingToken).toBe(0);
			expect(row(alias)?.fencingToken).toBe(0);
		});
	}

	test("activity at any member denies batch admission, including a briefly active queued scope", async () => {
		const [a, b] = batchPair();
		const activity = coordinator.registerActivity(request(b));
		await expect(
			coordinator.withRollbackMany(batchRequest([a, b]), () => undefined),
		).rejects.toThrow(errorCode("uncoordinated_activity"));
		coordinator.endActivity(activity);
		const held = await hold(b);
		const waiting = track(coordinator.withRollbackMany(batchRequest([a, b]), () => undefined));
		const brief = coordinator.registerActivity(request(a));
		coordinator.endActivity(brief);
		await expect(waiting).rejects.toThrow(errorCode("uncoordinated_activity"));
		expect(row(a)?.fencingToken).toBe(0);
		held.release();
		await held.done;
	});
});

describe("batch persistence and fail-closed group recovery", () => {
	test("SQL failure on the second grant rolls back the first fence/revision/guard and never runs body", async () => {
		const [a, b] = batchPair();
		const before = [row(a), row(b)];
		sqlite.exec(`CREATE TRIGGER reject_batch_grant BEFORE UPDATE OF active_lease_id ON file_change_scopes
			WHEN NEW.id = '${b.id}' AND NEW.active_lease_id IS NOT NULL
			BEGIN SELECT RAISE(ABORT, 'second-grant-failed'); END;`);
		let called = false;
		await expect(
			coordinator.withRollbackMany(batchRequest([b, a]), () => {
				called = true;
			}),
		).rejects.toThrow("second-grant-failed");
		expect(called).toBe(false);
		expect([row(a), row(b)]).toEqual(before);
		expect(state.leases.size).toBe(0);
		sqlite.exec("DROP TRIGGER reject_batch_grant;");
		await coordinator.withWrite(request(a), () => undefined);
	});

	test("unknown only quarantines its own scope, but every live group range remains held", async () => {
		const [a, b] = batchPair();
		const held = await holdBatch([a, b]);
		const [first, second] = held.batch.leases;
		first.registerMutation("unknown");
		first.settle("unknown", "unknown");
		expectCode(() => first.assertCurrent(), "needs_verification");
		second.registerMutation("known");
		second.settle("known", "applied");
		second.assertCurrent();
		await expect(
			coordinator.withWrite(request(b, { waitTimeoutMs: 0 }), () => undefined),
		).rejects.toThrow(errorCode("wait_timeout"));
		held.release();
		await held.done;
		expectQuarantined(a);
		expect(row(b)).toMatchObject({ status: "active", activeLeaseId: null });
		await coordinator.withWrite(request(b), () => undefined);
		await expect(coordinator.withWrite(request(a), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
	});

	test("same-group ownership never exempts a genuinely uncertain overlapping sibling", async () => {
		const a = addScope({ canonicalRoot: "/overlap" });
		const b = addScope({ canonicalRoot: "/overlap/child", sourceInstanceId: "other" });
		await coordinator.withRollbackMany(batchRequest([a, b]), (batch) => {
			batch.leases[0].markUncertain();
			expectCode(() => batch.leases[1].assertCurrent(), "needs_verification");
			expectCode(() => batch.leases[1].registerMutation("no-dispatch"), "needs_verification");
		});
		expectQuarantined(a);
		expect(row(b)?.activeLeaseId).toBeNull();
		await expect(coordinator.withWrite(request(b), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
	});

	for (const outcome of ["pending", "unknown", "explicit"] as const) {
		test(`${outcome} leaves every affected member's durable crash barrier in fresh process state`, async () => {
			const targets = batchPair();
			await coordinator.withRollbackMany(batchRequest(targets), (batch) => {
				for (const lease of batch.leases) {
					lease.registerMutation("may-have-written");
					if (outcome === "unknown") lease.settle("may-have-written", "unknown");
					if (outcome === "explicit") {
						lease.markUncertain();
						lease.settle("may-have-written", "not_applied");
					}
				}
			});
			const fresh = makeCoordinator({ state: createWorkspaceWriteCoordinatorState() });
			for (const target of targets) {
				expect(fresh.capture(target)).toMatchObject({
					status: "needs_verification",
					durableLeasePresent: true,
					active: { writes: 0, rollbacks: 0 },
				});
				const alias = addScope({
					canonicalRoot: `${target.canonicalRoot}/child`,
					sourceInstanceId: "new-source",
				});
				await expect(fresh.withWrite(request(alias), () => undefined)).rejects.toThrow(
					errorCode("needs_verification"),
				);
				expectCode(() => fresh.assertObservationCurrent(observation(alias)), "needs_verification");
			}
		});
	}

	test("fresh process state sees every active zero-mutation barrier and cannot adopt member IDs or tokens", async () => {
		const targets = batchPair();
		const held = await holdBatch(targets);
		const fresh = makeCoordinator({ state: createWorkspaceWriteCoordinatorState() });
		for (const lease of held.batch.leases) {
			expect(fresh.capture(lease.scope)).toMatchObject({
				durableLeasePresent: true,
				activeMutationCount: 0,
			});
			const alias = addScope({ canonicalRoot: `${lease.scope.canonicalRoot}/child` });
			await expect(fresh.withRollbackMany(batchRequest([alias]), () => undefined)).rejects.toThrow(
				errorCode("needs_verification"),
			);
			await expect(
				fresh.withWrite(request(lease.scope, { leaseToken: lease.token }), () => undefined),
			).rejects.toThrow(errorCode("invalid_nesting"));
		}
		await expect(fresh.withRollbackMany(batchRequest(targets), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
		held.release();
		await held.done;
	});

	test("listing an external crash scope in the target set never creates an owned-guard exemption", async () => {
		const [a, b] = batchPair();
		update(
			{
				activeLeaseId: "foreign-lease",
				activeLeaseEpoch: "dead-process",
				activeLeaseStartedAt: "2000-01-01",
			},
			b,
		);
		await expect(
			coordinator.withRollbackMany(batchRequest([a, b]), () => undefined),
		).rejects.toThrow(errorCode("needs_verification"));
		expect(row(a)?.fencingToken).toBe(0);
		expect(row(b)?.activeLeaseId).toBe("foreign-lease");
	});

	test("changed sibling durable ownership cannot be disguised by the same group object", async () => {
		const a = addScope({ canonicalRoot: "/guards" });
		const b = addScope({ canonicalRoot: "/guards/child" });
		await coordinator.withRollbackMany(batchRequest([a, b]), (batch) => {
			const previous = row(b)?.activeLeaseId;
			update({ activeLeaseId: "foreign-replacement" }, b);
			expectCode(() => batch.leases[0].assertCurrent(), "needs_verification");
			update({ activeLeaseId: previous }, b);
			batch.leases[0].assertCurrent();
		});
	});

	test("second finalization SQL failure retains ALL ranges; any real member retries the complete group", async () => {
		const [a, b] = batchPair();
		const held = await holdBatch([a, b]);
		sqlite.exec(`CREATE TRIGGER reject_batch_finish BEFORE UPDATE OF active_lease_id ON file_change_scopes
			WHEN NEW.id = '${b.id}' AND NEW.active_lease_id IS NULL
			BEGIN SELECT RAISE(ABORT, 'second-finish-failed'); END;`);
		held.release();
		await expect(held.done).rejects.toThrow(errorCode("persistence_failed"));
		for (const target of [a, b]) {
			expect(row(target)).toMatchObject({ revision: 1, status: "active" });
			expect(row(target)?.activeLeaseId).toBeString();
			expect(coordinator.capture(target).active).toMatchObject({
				rollbacks: 1,
				retainedRecoveryHolds: 1,
			});
			await expect(
				coordinator.withWrite(request(target, { waitTimeoutMs: 0 }), () => undefined),
			).rejects.toThrow(errorCode("wait_timeout"));
		}
		expectCode(() => held.batch.leases[0].registerMutation("too-late"), "stale_lease");
		await expect(
			held.batch.runInScope(held.batch.leases[1].token, () => undefined),
		).rejects.toThrow(errorCode("invalid_nesting"));
		const firstWaiting = track(coordinator.withWrite(request(a), () => undefined));
		const secondWaiting = track(coordinator.withWrite(request(b), () => undefined));
		sqlite.exec(`DROP TRIGGER reject_batch_finish;
			CREATE TRIGGER reject_batch_retry BEFORE UPDATE OF status ON workspace_write_leases
			WHEN NEW.scope_id = '${b.id}' AND NEW.status = 'quarantined'
			BEGIN SELECT RAISE(ABORT, 'second-retry-failed'); END;`);
		expect(() => coordinator.retryUncertainPersistence(held.batch.leases[0].token)).toThrow(
			"second-retry-failed",
		);
		expect(state.leases.size).toBe(2);
		expect(row(a)?.status).toBe("active");
		expect(row(b)?.status).toBe("active");
		sqlite.exec("DROP TRIGGER reject_batch_retry;");
		makeCoordinator({ db: drizzle(sqlite) }).retryUncertainPersistence(held.batch.leases[1].token);
		expect(state.leases.size).toBe(0);
		for (const target of [a, b]) {
			expectQuarantined(target);
		}
		await expect(firstWaiting).rejects.toThrow(errorCode("needs_verification"));
		await expect(secondWaiting).rejects.toThrow(errorCode("needs_verification"));
		expectCode(
			() => coordinator.retryUncertainPersistence(held.batch.leases[0].token),
			"stale_lease",
		);
	});

	test("failed uncertainty persistence retains clean siblings and runtime drift never permits stale dispatch", async () => {
		const [a, b] = batchPair();
		let lease!: WorkspaceWriteLease;
		sqlite.exec(`CREATE TRIGGER reject_batch_uncertain BEFORE UPDATE OF status ON workspace_write_leases
			WHEN NEW.scope_id = '${b.id}' AND NEW.status = 'quarantined'
			BEGIN SELECT RAISE(ABORT, 'uncertain-write-failed'); END;`);
		await expect(
			coordinator.withRollbackMany(batchRequest([a, b]), (batch) => {
				lease = batch.leases[1];
				lease.registerMutation("pending");
				runtimes.set(b.deviceId, { ...runtime, runtimeGeneration: 8 });
				expectCode(() => lease.assertCurrent(), "runtime_mismatch");
				// Settling old IO is metadata, not permission for a new dispatch.
				lease.settle("pending", "applied");
				expect(lease.pendingMutationCount).toBe(0);
				expectCode(() => lease.registerMutation("new-stale-dispatch"), "runtime_mismatch");
				lease.markUncertain();
			}),
		).rejects.toThrow(errorCode("persistence_failed"));
		expect(row(a)?.activeLeaseId).toBeString();
		expect(row(a)?.revision).toBe(1);
		expect(state.leases.size).toBe(2);
		sqlite.exec("DROP TRIGGER reject_batch_uncertain;");
		coordinator.retryUncertainPersistence(lease.token);
		expectQuarantined(a);
		expectQuarantined(b);
	});
});

describe("batch explicit helpers and whole-group lifetime", () => {
	test("batch is top-level only; implicit reuse, expansion and foreign or forged tokens are rejected", async () => {
		const [a, b] = batchPair();
		const outside = addScope({ canonicalRoot: "/outside" });
		const alias = addScope({ canonicalRoot: a.canonicalRoot });
		let expired!: WorkspaceWriteBatch;
		for (const kind of ["write", "rollback"] as const) {
			const run =
				kind === "write"
					? coordinator.withWrite.bind(coordinator)
					: coordinator.withRollback.bind(coordinator);
			await run(request(outside), async () => {
				await expect(
					coordinator.withRollbackMany(batchRequest([a, b]), () => undefined),
				).rejects.toThrow(errorCode("invalid_nesting"));
			});
		}
		await coordinator.withRollbackMany(batchRequest([a, b]), async (batch) => {
			expired = batch;
			const [first, second] = batch.leases;
			await expect(coordinator.withWrite(request(a), () => undefined)).rejects.toThrow(
				errorCode("invalid_nesting"),
			);
			await expect(
				coordinator.withWrite(request(a, { leaseToken: first.token }), () => undefined),
			).rejects.toThrow(errorCode("invalid_nesting"));
			await expect(batch.runInScope({ id: first.token.id }, () => undefined)).rejects.toThrow(
				errorCode("invalid_nesting"),
			);
			await expect(
				batch.runInScope(alias.id as unknown as WorkspaceWriteLeaseToken, () => undefined),
			).rejects.toThrow(errorCode("invalid_nesting"));
			await batch.runInScope(first.token, async (lease) => {
				await expect(
					coordinator.withWrite(request(alias, { leaseToken: lease.token }), () => undefined),
				).rejects.toThrow(errorCode("invalid_nesting"));
				await expect(
					coordinator.withWrite(request(b, { leaseToken: second.token }), () => undefined),
				).rejects.toThrow(errorCode("invalid_nesting"));
				await expect(
					coordinator.withRollbackMany(batchRequest([outside]), () => undefined),
				).rejects.toThrow(errorCode("invalid_nesting"));
				await batch.runInScope(second.token, (other) => other.assertCurrent());
			});
		});
		await expect(expired.runInScope(expired.leases[0].token, () => undefined)).rejects.toThrow(
			errorCode("invalid_nesting"),
		);
		const held = await holdBatch([a, b]);
		await coordinator.withWrite(request(outside), async () => {
			await expect(
				held.batch.runInScope(held.batch.leases[0].token, () => undefined),
			).rejects.toThrow(errorCode("invalid_nesting"));
		});
		held.release();
		await held.done;
	});

	test("omitting await at both batch helper and single helper levels holds every member until the grandchild ends", async () => {
		const [a, b] = batchPair();
		const entered = gate();
		const finish = gate();
		let ended = false;
		const parent = track(
			coordinator
				.withRollbackMany(batchRequest([a, b]), (batch) => {
					track(
						batch.runInScope(batch.leases[1].token, (lease) => {
							track(
								coordinator.withWrite(request(b, { leaseToken: lease.token }), async (nested) => {
									nested.registerMutation("child");
									entered.open();
									await finish.promise;
									nested.settle("child", "applied");
								}),
							);
						}),
					);
				})
				.then(() => {
					ended = true;
				}),
		);
		await entered.promise;
		let nextEntered = false;
		const next = track(
			coordinator.withWrite(request(a), () => {
				nextEntered = true;
			}),
		);
		expect(ended).toBe(false);
		expect(nextEntered).toBe(false);
		expect(state.leases.size).toBe(2);
		await expect(
			coordinator.withWrite(request(b, { waitTimeoutMs: 5 }), () => undefined),
		).rejects.toThrow(errorCode("wait_timeout"));
		finish.open();
		await Promise.all([parent, next]);
		expect(ended).toBe(true);
		expect(nextEntered).toBe(true);
		expect(row(b)?.activeMutationCount).toBe(0);
	});

	test("body failure still drains an unawaited child and reports its uncertainty durably", async () => {
		const [a, b] = batchPair();
		const entered = gate();
		const finish = gate();
		const parent = track(
			coordinator.withRollbackMany(batchRequest([a, b]), (batch) => {
				track(
					batch.runInScope(batch.leases[1].token, async (lease) => {
						lease.registerMutation("pending-after-parent-error");
						entered.open();
						await finish.promise;
						lease.settle("pending-after-parent-error", "unknown");
					}),
				);
				throw new Error("parent-failed");
			}),
		);
		await entered.promise;
		await expect(
			coordinator.withWrite(request(a, { waitTimeoutMs: 5 }), () => undefined),
		).rejects.toThrow(errorCode("wait_timeout"));
		finish.open();
		await expect(parent).rejects.toThrow("parent-failed");
		expect(row(a)?.activeLeaseId).toBeNull();
		expectQuarantined(b);
	});

	test("a still-running failed child is surfaced after every member finishes", async () => {
		const targets = batchPair();
		const entered = gate();
		const finish = gate();
		const parent = track(
			coordinator.withRollbackMany(batchRequest(targets), (batch) => {
				track(
					batch.runInScope(batch.leases[0].token, async () => {
						entered.open();
						await finish.promise;
						throw new Error("child-failed");
					}),
				);
			}),
		);
		await entered.promise;
		expect(state.leases.size).toBe(2);
		finish.open();
		await expect(parent).rejects.toThrow("child-failed");
		for (const target of targets) expect(row(target)?.activeLeaseId).toBeNull();
	});

	test("nested execution budget is shared by the complete group, not multiplied by scopes", async () => {
		const [a, b] = batchPair();
		const finish = gate();
		await coordinator.withRollbackMany(batchRequest([a, b]), async (batch) => {
			const children = Array.from(
				{ length: WORKSPACE_WRITE_COORDINATOR_LIMITS.nestedExecutions },
				(_, index) => track(batch.runInScope(batch.leases[index % 2].token, () => finish.promise)),
			);
			await expect(batch.runInScope(batch.leases[0].token, () => undefined)).rejects.toThrow(
				errorCode("capacity_exceeded"),
			);
			finish.open();
			await Promise.all(children);
		});
	});
});

describe("hot-safe scheduler migration", () => {
	test("bridges resumed v1 owners without replacing their live lease, activity, waiter, ALS or epoch", async () => {
		const [a, b] = batchPair();
		const held = await hold(b);
		const order: string[] = [];
		const legacyWaiter = track(coordinator.withWrite(request(b), () => order.push("legacy")));
		const activityScope = addScope({ canonicalRoot: "/unrelated-activity" });
		const activity = coordinator.registerActivity(request(activityScope));
		const before = {
			epoch: state.ownerEpoch,
			revision: state.revision,
			leases: state.leases,
			activities: state.activities,
			waiters: state.waiters,
			waiter: state.waiters[0],
			als: state.executionContext,
			record: state.leases.get(held.lease.token),
		};
		const legacy = coordinator as unknown as {
			pump(): void;
			canStart(): boolean;
			acquire(): Promise<unknown>;
		};
		// These sentinels model old scheduler methods which cannot inspect a batch.
		legacy.pump = () => {
			throw new Error("v1 pump must be bridged before release resumes");
		};
		legacy.canStart = () => {
			throw new Error("v1 canStart sees only a single range");
		};
		legacy.acquire = () => {
			throw new Error("v1 acquire misses the queue range budget");
		};
		const upgraded = makeCoordinator({ db: drizzle(sqlite) });
		expect(state.ownerEpoch).toBe(before.epoch);
		expect(state.revision).toBe(before.revision);
		expect(state.leases).toBe(before.leases);
		expect(state.activities).toBe(before.activities);
		expect(state.waiters).toBe(before.waiters);
		expect(state.waiters[0]).toBe(before.waiter);
		expect(state.executionContext).toBe(before.als);
		expect(state.leases.get(held.lease.token)).toBe(before.record);
		held.lease.assertCurrent();
		const next = track(upgraded.withRollbackMany(batchRequest([a, b]), () => order.push("batch")));
		const c = addScope({ canonicalRoot: "/batch/c" });
		await coordinator.withWrite(request(c, { waitTimeoutMs: 0 }), () => undefined);
		coordinator.endActivity(activity);
		held.release();
		await Promise.all([held.done, legacyWaiter, next]);
		expect(order).toEqual(["legacy", "batch"]);
		expect(state.ownerEpoch).toBe(before.epoch);
	});

	test("another hot-safe wrapper preserves a live batch, its helpers, waiting writer and observation epoch", async () => {
		const [a, b] = batchPair();
		const held = await holdBatch([a, b]);
		const before = coordinator.capture(a);
		const waiting = track(coordinator.withWrite(request(a), () => undefined));
		const waiter = state.waiters[0];
		const upgraded = makeCoordinator({ db: drizzle(sqlite) });
		expect(state.waiters[0]).toBe(waiter);
		expect(upgraded.capture(a).coordinationEpoch).toBe(before.coordinationEpoch);
		await held.batch.runInScope(held.batch.leases[0].token, (lease) =>
			upgraded.withWrite(request(a, { leaseToken: lease.token }), (nested) =>
				expect(nested).toBe(lease),
			),
		);
		expect(state.leases.size).toBe(2);
		held.release();
		await Promise.all([held.done, waiting]);
	});
});

describe("exact pending mutation capability", () => {
	test("requires this precise pending ID, not just a positive count or another member's mutation", async () => {
		const [a, b] = batchPair();
		let expired!: WorkspaceWriteLease;
		await coordinator.withRollbackMany(batchRequest([a, b]), (batch) => {
			const [first, second] = batch.leases;
			expired = first;
			first.registerMutation("first");
			second.registerMutation("second");
			first.assertMutationPending("first");
			expectCode(() => first.assertMutationPending("second"), "mutation_conflict");
			first.settle("first", "applied");
			expectCode(() => first.assertMutationPending("first"), "mutation_conflict");
			second.settle("second", "not_applied");
		});
		expectCode(() => expired.assertMutationPending("first"), "stale_lease");
	});

	test("rechecks durable pending count, fence, ownership and authoritative runtime", async () => {
		await coordinator.withWrite(request(), (lease) => {
			lease.registerMutation("pending");
			const guard = row();
			for (const changed of [
				{ activeMutationCount: 2 },
				{ fencingToken: 20 },
				{ activeLeaseId: "other-owner" },
				{ revision: 20 },
			]) {
				update(changed);
				expectCode(() => lease.assertMutationPending("pending"), "stale_lease");
				update({
					activeMutationCount: 1,
					fencingToken: guard?.fencingToken,
					activeLeaseId: guard?.activeLeaseId,
					revision: guard?.revision,
				});
			}
			runtimes.set(scope.deviceId, { ...runtime, runtimeEpoch: "reconnected" });
			expectCode(() => lease.assertMutationPending("pending"), "runtime_mismatch");
			runtimes.set(scope.deviceId, runtime);
			lease.settle("pending", "unknown");
			expectCode(() => lease.assertMutationPending("pending"), "needs_verification");
		});
	});
});

describe("recovery barrier directionality", () => {
	function addTree() {
		const parent = addScope({ canonicalRoot: "/workspace" });
		const child = addScope({ canonicalRoot: "/workspace/repo" });
		const grandchild = addScope({ canonicalRoot: "/workspace/repo/sub" });
		return { parent, child, grandchild };
	}

	test("bidirectional barriers block ancestor writes unless actual file ranges are disjoint", async () => {
		const { parent, child } = addTree();
		update({ status: "needs_verification" }, child);
		await expect(coordinator.withWrite(request(parent), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
		await coordinator.withWrite(
			request(parent, { ranges: [{ kind: "file", canonicalPath: "/workspace/sibling.txt" }] }),
			() => undefined,
		);
		expect(row(parent)?.status).toBe("active");
		// Rollback rewrites whole subtrees and stays bidirectional.
		await expect(coordinator.withRollback(request(parent), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
		// Writes inside (or equal to) the quarantined root stay blocked.
		const { grandchild } = { grandchild: addScope({ canonicalRoot: "/workspace/repo/sub" }) };
		await expect(coordinator.withWrite(request(grandchild), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
		await expect(coordinator.withWrite(request(child), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
	});

	test("observation stays bidirectional even for an ancestor scope", async () => {
		const { parent, child } = addTree();
		update({ status: "needs_verification" }, child);
		expectCode(
			() => coordinator.assertObservationCurrent(observation(parent)),
			"needs_verification",
		);
	});

	test("legacy descendant unfinished lease blocks ancestor write without exact disjoint ranges", async () => {
		const { parent, child } = addTree();
		update(
			{
				activeLeaseId: "dead-lease",
				activeLeaseEpoch: "dead-epoch",
				activeLeaseStartedAt: "2026-09-07T00:00:00.000Z",
				activeMutationCount: 1,
			},
			child,
		);
		await expect(coordinator.withWrite(request(parent), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
		await coordinator.withWrite(
			request(parent, { ranges: [{ kind: "file", canonicalPath: "/workspace/sibling.txt" }] }),
			() => undefined,
		);
		await expect(coordinator.withRollback(request(parent), () => undefined)).rejects.toThrow(
			errorCode("needs_verification"),
		);
	});

	test("quarantine error names the blocking scope root", async () => {
		const { parent, child } = addTree();
		update({ status: "needs_verification" }, child);
		await expect(coordinator.withRollback(request(parent), () => undefined)).rejects.toThrow(
			/\/workspace\/repo.*Settings → Storage/s,
		);
	});
});

describe("external scope barrier recovery", () => {
	test("clears an ended same-epoch legacy lease, bumping fence and revision", () => {
		update({
			status: "needs_verification",
			activeLeaseId: "dead-lease",
			activeLeaseEpoch: coordinator.ownerEpoch(),
			activeLeaseStartedAt: "2026-09-07T00:00:00.000Z",
			activeMutationCount: 1,
		});
		const before = row();
		const cleared = coordinator.recoverScopeBarrier(scope);
		expect(cleared).toEqual({
			revision: (before?.revision ?? 0) + 1,
			fencingToken: (before?.fencingToken ?? 0) + 1,
		});
		expect(row()).toMatchObject({
			status: "active",
			activeLeaseId: null,
			activeLeaseEpoch: null,
			activeLeaseStartedAt: null,
			activeMutationCount: 0,
		});
	});

	test("does not infer foreign-epoch execution end even when the status is active", () => {
		update({
			activeLeaseId: "dead-lease",
			activeLeaseEpoch: "dead-epoch",
			activeLeaseStartedAt: "2026-09-07T00:00:00.000Z",
			activeMutationCount: 1,
		});
		expectCode(() => coordinator.recoverScopeBarrier(scope), "recovery_conflict");
		expect(row()).toMatchObject({ status: "active", activeLeaseId: "dead-lease" });
	});

	test("refuses an absent barrier but permits ended same-epoch legacy execution", () => {
		expectCode(() => coordinator.recoverScopeBarrier(scope), "invalid_input");
		update({
			activeLeaseId: "live-lease",
			activeLeaseEpoch: coordinator.ownerEpoch(),
			activeLeaseStartedAt: "2026-09-07T00:00:00.000Z",
			activeMutationCount: 1,
		});
		coordinator.recoverScopeBarrier(scope);
		expect(row()?.activeLeaseId).toBeNull();
	});

	test("refuses while an in-memory lease or activity covers the scope", async () => {
		const held = await hold();
		expectCode(() => coordinator.recoverScopeBarrier(scope), "recovery_conflict");
		held.release();
		await held.done;
		const activity = coordinator.registerActivity(request());
		expectCode(() => coordinator.recoverScopeBarrier(scope), "recovery_conflict");
		coordinator.endActivity(activity);
	});

	test("a waiting writer is admitted after recovery clears the barrier", async () => {
		update({
			status: "needs_verification",
			activeLeaseId: "dead-lease",
			activeLeaseEpoch: coordinator.ownerEpoch(),
			activeLeaseStartedAt: "2026-09-07T00:00:00.000Z",
			activeMutationCount: 1,
		});
		coordinator.recoverScopeBarrier(scope);
		await coordinator.withWrite(request(), () => undefined);
		expect(row()?.status).toBe("active");
	});
});

describe("persistent exact-range leases", () => {
	const fileRanges = (path: string) => [{ kind: "file" as const, canonicalPath: path }];
	const aRanges = () => fileRanges(`${scope.canonicalRoot}/A.txt`);
	const bRanges = () => fileRanges(`${scope.canonicalRoot}/B.txt`);
	async function quarantineA() {
		let id = "";
		await coordinator.withWrite(request(scope, { ranges: aRanges() }), (lease) => {
			id = lease.leaseId;
			lease.registerMutation("mutation-A", { effectId: "effect-A", operationId: "operation-A" });
			lease.settle("mutation-A", "unknown");
		});
		return id;
	}

	test("unknown A detaches only after execution end and B remains writable across restart", async () => {
		const id = await quarantineA();
		expectQuarantined();
		expect(quarantined()[0]).toMatchObject({
			leaseId: id,
			rangesJson: { version: 1, ranges: aRanges() },
			mutationManifestJson: {
				version: 1,
				mutations: [
					{
						mutationId: "mutation-A",
						effectId: "effect-A",
						operationId: "operation-A",
						outcome: "unknown",
					},
				],
			},
		});
		for (const owner of [
			coordinator,
			makeCoordinator({ state: createWorkspaceWriteCoordinatorState() }),
		]) {
			await owner.withWrite(request(scope, { ranges: bRanges() }), (lease) => {
				lease.assertCurrent();
				lease.registerMutation("B");
				lease.settle("B", "applied");
			});
			await expect(
				owner.withWrite(request(scope, { ranges: aRanges() }), () => undefined),
			).rejects.toThrow(errorCode("needs_verification"));
			await expect(owner.withRollback(request(), () => undefined)).rejects.toThrow(
				errorCode("needs_verification"),
			);
			expect(owner.capture(scope).quarantinedLeaseCount).toBe(1);
		}
	});

	test("live same-scope files remain serialized and cannot recover before children finish", async () => {
		const held = await hold(scope, "write", coordinator, { ranges: aRanges() });
		held.lease.registerMutation("A");
		held.lease.settle("A", "unknown");
		expectCode(
			() => coordinator.inspectRecovery({ scope, leaseId: held.lease.leaseId }),
			"recovery_conflict",
		);
		await expect(
			coordinator.withWrite(
				request(scope, { ranges: bRanges(), waitTimeoutMs: 0 }),
				() => undefined,
			),
		).rejects.toThrow(errorCode("wait_timeout"));
		expect(
			db.select().from(durableLeases).where(eq(durableLeases.leaseId, held.lease.leaseId)).get(),
		).toMatchObject({ status: "executing", executionEndedAt: null });
		held.release();
		await held.done;
		expect(coordinator.inspectRecovery({ scope, leaseId: held.lease.leaseId }).executionEnded).toBe(
			true,
		);
	});

	test("recovering A while B executes leaves B lease, fence, revision and pending count untouched", async () => {
		const id = await quarantineA();
		const held = await hold(scope, "write", coordinator, { ranges: bRanges() });
		held.lease.registerMutation("B");
		const before = row();
		const reservation = coordinator.reserveRecovery({ scope, leaseId: id });
		const value = reservation.complete((tx) => {
			expect(sqlite.inTransaction).toBe(true);
			expect(
				tx.select().from(durableLeases).where(eq(durableLeases.leaseId, id)).get()?.status,
			).toBe("quarantined");
			return "audited";
		});
		expect(value).toBe("audited");
		expect(row()).toEqual(before);
		held.lease.assertCurrent();
		held.lease.settle("B", "applied");
		held.release();
		await held.done;
		expect(db.select().from(durableLeases).where(eq(durableLeases.leaseId, id)).get()?.status).toBe(
			"recovered",
		);
		await coordinator.withWrite(request(scope, { ranges: aRanges() }), () => undefined);
	});

	test("recovery callback and barrier CAS fail atomically and never pump before commit", async () => {
		const id = await quarantineA();
		const reservation = coordinator.reserveRecovery({ scope, leaseId: id });
		let ran = false;
		const waiting = track(
			coordinator.withWrite(request(scope, { ranges: aRanges() }), () => {
				ran = true;
				expect(sqlite.inTransaction).toBe(false);
			}),
		);
		const previous = row()?.displayRoot;
		expect(() =>
			reservation.complete((tx) => {
				tx.update(scopes)
					.set({ displayRoot: "must-roll-back" })
					.where(eq(scopes.id, scope.id))
					.run();
				throw new Error("audit-failure");
			}),
		).toThrow("audit-failure");
		expect(row()?.displayRoot).toBe(previous);
		expect(ran).toBe(false);
		expect(quarantined()).toHaveLength(1);
		sqlite.exec(
			"CREATE TRIGGER reject_recovery BEFORE UPDATE OF status ON workspace_write_leases WHEN NEW.status = 'recovered' BEGIN SELECT RAISE(ABORT, 'clear-failure'); END;",
		);
		expect(() =>
			reservation.complete((tx) => {
				tx.update(scopes)
					.set({ displayRoot: "must-roll-back" })
					.where(eq(scopes.id, scope.id))
					.run();
			}),
		).toThrow("clear-failure");
		expect(row()?.displayRoot).toBe(previous);
		expect(ran).toBe(false);
		sqlite.exec("DROP TRIGGER reject_recovery;");
		reservation.complete(() => {
			expect(ran).toBe(false);
		});
		await waiting;
		expect(ran).toBe(true);
	});

	test("an ambient outer transaction cannot release recovery at a savepoint", async () => {
		const id = await quarantineA();
		const reservation = coordinator.reserveRecovery({ scope, leaseId: id });
		db.transaction(() => {
			expect(() => reservation.complete(() => undefined)).toThrow(errorCode("recovery_conflict"));
			expect(state.recoveries?.size).toBe(1);
			expect(quarantined()).toHaveLength(1);
		});
		reservation.complete(() => undefined);
		expect(state.recoveries?.size).toBe(0);
	});

	test("recovery reservation only excludes actual A and never admits new activity on A", async () => {
		const id = await quarantineA();
		const reservation = coordinator.reserveRecovery({ scope, leaseId: id });
		await coordinator.withWrite(request(scope, { ranges: bRanges() }), (lease) =>
			lease.assertCurrent(),
		);
		await expect(
			coordinator.withWrite(
				request(scope, { ranges: aRanges(), waitTimeoutMs: 0 }),
				() => undefined,
			),
		).rejects.toThrow(errorCode("wait_timeout"));
		expectCode(() => coordinator.registerActivity(request()), "recovery_conflict");
		reservation.release();
		expectCode(() => reservation.complete(() => undefined), "recovery_conflict");
	});

	test("frozen admission ranges cannot be changed or expanded by nested execution", async () => {
		const ranges = aRanges();
		const entered = gate();
		const finish = gate();
		const execution = track(
			coordinator.withWrite(request(scope, { ranges }), async (lease) => {
				entered.open();
				await finish.promise;
				expect(lease.ranges).toEqual(aRanges());
				await expect(
					coordinator.withWrite(
						request(scope, { leaseToken: lease.token, ranges: bRanges() }),
						() => undefined,
					),
				).rejects.toThrow(errorCode("invalid_nesting"));
				await expect(
					coordinator.withWrite(request(scope, { leaseToken: lease.token }), () => undefined),
				).rejects.toThrow(errorCode("invalid_nesting"));
				await coordinator.withWrite(
					request(scope, { leaseToken: lease.token, ranges: aRanges() }),
					() => undefined,
				);
			}),
		);
		await entered.promise;
		ranges[0].canonicalPath = `${scope.canonicalRoot}/B.txt`;
		finish.open();
		await execution;
		for (const invalid of [
			[],
			fileRanges("/outside"),
			fileRanges("relative"),
			Array.from({ length: 257 }, () => aRanges()[0]),
		]) {
			await expect(
				coordinator.withWrite(request(scope, { ranges: invalid }), () => undefined),
			).rejects.toThrow(errorCode("invalid_input"));
		}
	});

	test("immutable mutation manifest is persisted before dispatch and rolls back on counter failure", async () => {
		await coordinator.withWrite(request(scope, { ranges: aRanges() }), (lease) => {
			sqlite.exec(
				"CREATE TRIGGER reject_manifest_count BEFORE UPDATE OF active_mutation_count ON file_change_scopes WHEN NEW.active_mutation_count > OLD.active_mutation_count BEGIN SELECT RAISE(ABORT, 'counter-failure'); END;",
			);
			expect(() =>
				lease.registerMutation("never-dispatched", { effectId: "E", operationId: "O" }),
			).toThrow("counter-failure");
			expect(
				db.select().from(durableLeases).where(eq(durableLeases.leaseId, lease.leaseId)).get()
					?.mutationManifestJson.mutations,
			).toHaveLength(0);
			expect(lease.pendingMutationCount).toBe(0);
			sqlite.exec("DROP TRIGGER reject_manifest_count;");
			lease.registerMutation("persisted", { effectId: "E", operationId: "O" });
			expect(
				db.select().from(durableLeases).where(eq(durableLeases.leaseId, lease.leaseId)).get()
					?.mutationManifestJson.mutations,
			).toEqual([{ mutationId: "persisted", effectId: "E", operationId: "O", outcome: "pending" }]);
			lease.settle("persisted", "not_applied");
		});
	});

	test("indexed settlement checks exact durable ID/outcome and never reads manifest bodies into JS", async () => {
		await coordinator.withWrite(request(scope, { ranges: aRanges() }), (lease) => {
			queries.length = 0;
			lease.registerMutation("first", { effectId: "e1" });
			lease.registerMutation("second", { effectId: "e2" });
			lease.settle("second", "not_applied");
			expect(queries.some((query) => /^select "mutation_manifest_json" /i.test(query))).toBe(false);
			const original = db
				.select()
				.from(durableLeases)
				.where(eq(durableLeases.leaseId, lease.leaseId))
				.get()?.mutationManifestJson;
			if (!original) throw new Error("Missing test manifest");
			db.update(durableLeases)
				.set({ mutationManifestJson: { version: 1, mutations: [...original.mutations].reverse() } })
				.where(eq(durableLeases.leaseId, lease.leaseId))
				.run();
			expect(() => lease.settle("first", "applied")).toThrow("Pending durable mutation missing");
			expect(lease.pendingMutationCount).toBe(1);
			db.update(durableLeases)
				.set({ mutationManifestJson: original })
				.where(eq(durableLeases.leaseId, lease.leaseId))
				.run();
			lease.settle("first", "applied");
		});
	});

	test("quarantine/recovery does not wash away unrelated root or unknown activity uncertainty", async () => {
		const held = await hold(scope, "write", coordinator, { ranges: aRanges() });
		const activity = coordinator.registerActivity(request());
		held.lease.registerMutation("A");
		coordinator.endActivity(activity, "unknown");
		held.release();
		await held.done;
		expect(row()?.status).toBe("needs_verification");
		const reservation = coordinator.reserveRecovery({ scope, leaseId: held.lease.leaseId });
		reservation.complete(() => undefined);
		expect(row()?.status).toBe("needs_verification");
		await expect(
			coordinator.withWrite(request(scope, { ranges: bRanges() }), () => undefined),
		).rejects.toThrow(errorCode("needs_verification"));
	});

	test("terminal cleanup is bounded and never prunes quarantined evidence", async () => {
		const id = await quarantineA();
		const template = quarantined()[0];
		db.insert(durableLeases)
			.values(
				Array.from({ length: 540 }, (_, index) => ({
					...template,
					leaseId: `terminal-${index}`,
					status: "settled" as const,
					createdAt: "2000-01-01",
					updatedAt: "2000-01-01",
				})),
			)
			.run();
		await coordinator.withWrite(request(scope, { ranges: bRanges() }), () => undefined);
		expect(
			db.select().from(durableLeases).where(eq(durableLeases.status, "settled")).all(),
		).toHaveLength(525);
		await coordinator.withWrite(request(scope, { ranges: bRanges() }), () => undefined);
		expect(
			db.select().from(durableLeases).where(eq(durableLeases.status, "settled")).all(),
		).toHaveLength(513);
		expect(quarantined()[0].leaseId).toBe(id);
	});

	test("malformed and over-byte-budget inventories fail closed before decoding arbitrary JSON", async () => {
		await quarantineA();
		const template = quarantined()[0];
		const hugeRanges = {
			version: 1 as const,
			ranges: Array.from({ length: 6 }, (_, index) => ({
				kind: "file" as const,
				canonicalPath: `${scope.canonicalRoot}/${"x".repeat(15000)}${index}`,
			})),
		};
		db.insert(durableLeases)
			.values(
				Array.from({ length: 6 }, (_, index) => ({
					...template,
					leaseId: `large-${index}`,
					rangesJson: hugeRanges,
				})),
			)
			.run();
		await expect(
			coordinator.withWrite(request(scope, { ranges: bRanges() }), () => undefined),
		).rejects.toThrow(errorCode("verification_backlog"));
		expectCode(() => coordinator.capture(scope), "verification_backlog");
	});

	test("first root verification requires empty durable history and explicit root proof in the atomic callback", () => {
		update({ status: "needs_verification", rootIdentityJson: null });
		const info = coordinator.inspectRecovery({ scope });
		expect(info.initialRootVerification).toBe(true);
		const reservation = coordinator.reserveRecovery({ scope });
		expect(() => reservation.complete(() => undefined)).toThrow(errorCode("recovery_conflict"));
		expect(row()?.status).toBe("needs_verification");
		reservation.complete((tx) => {
			tx.update(scopes)
				.set({ status: "active", rootIdentityJson: { device: "verified" } })
				.where(eq(scopes.id, scope.id))
				.run();
		});
		expect(row()?.status).toBe("active");
		update({ status: "needs_verification" });
		expectCode(() => coordinator.inspectRecovery({ scope }), "recovery_conflict");
	});

	test("first root exception cannot erase a detached exact-range quarantine", async () => {
		await quarantineA();
		update({ status: "needs_verification", rootIdentityJson: null });
		expectCode(() => coordinator.inspectRecovery({ scope }), "recovery_conflict");
	});

	test("old process state requires cold maintenance upgrade and rejects known owners without changing epoch", async () => {
		const held = await hold();
		const originalEpoch = state.ownerEpoch;
		delete (state as { persistentLeaseVersion?: 1 }).persistentLeaseVersion;
		expect(() => makeCoordinator()).toThrow(/maintenance restart/);
		expect(state.ownerEpoch).toBe(originalEpoch);
		expect(state.upgradeBlocked).toBe(true);
		await expect(coordinator.withWrite(request(), () => undefined)).rejects.toThrow(
			errorCode("recovery_conflict"),
		);
		expectCode(() => coordinator.registerActivity(request()), "recovery_conflict");
		held.release();
		await held.done;
		expect(state.leases.size).toBe(0);
	});

	test("range barrier identity survives root ancestry aliases and deleted-directory spellings", async () => {
		const id = await quarantineA();
		const ancestor = addScope({ canonicalRoot: "/workspace" });
		await expect(
			coordinator.withWrite(request(ancestor, { ranges: aRanges() }), () => undefined),
		).rejects.toThrow(errorCode("needs_verification"));
		await coordinator.withWrite(request(ancestor, { ranges: bRanges() }), () => undefined);
		const fresh = makeCoordinator({ state: createWorkspaceWriteCoordinatorState() });
		expect(fresh.inspectRecovery({ scope, leaseId: id }).executionEnded).toBe(true);
		fresh.reserveRecovery({ scope, leaseId: id }).complete(() => undefined);
	});
});

test("trusted native batch classification survives copying without classifying arbitrary rollbacks", async () => {
	const a = addScope({ deviceId: "local", canonicalRoot: "/native-a" });
	const b = addScope({ deviceId: "local", canonicalRoot: "/native-b" });
	await coordinator.withRollbackMany(
		{
			scopes: [a, b].map((scope) => ({
				...request(scope),
				executionClass: "local_file_io" as const,
			})),
		},
		(batch) => {
			for (const lease of batch.leases) {
				expect(
					db.select().from(durableLeases).where(eq(durableLeases.leaseId, lease.leaseId)).get()
						?.executionClass,
				).toBe("local_file_io");
			}
		},
	);
	await coordinator.withRollback(request(a), (lease) => {
		expect(
			db.select().from(durableLeases).where(eq(durableLeases.leaseId, lease.leaseId)).get()
				?.executionClass,
		).toBe("unknown");
	});
});

describe("atomic settlement and retained maintenance", () => {
	test("evidence rollback leaves the mutation pending and permits metadata-only retry", async () => {
		await coordinator.withWrite(request(), (lease) => {
			lease.registerMutation("atomic");
			expect(() =>
				lease.settleWith("atomic", (tx) => {
					tx.update(scopes)
						.set({ displayRoot: "rolled back" })
						.where(eq(scopes.id, scope.id))
						.run();
					throw new Error("journal failure");
				}),
			).toThrow("journal failure");
			expect(row()?.displayRoot).toBe("presentation only");
			expect(lease.pendingMutationCount).toBe(1);
			lease.assertCurrent();
			expect(
				lease.settleWith("atomic", (tx) => {
					tx.update(scopes).set({ displayRoot: "committed" }).where(eq(scopes.id, scope.id)).run();
					return { outcome: "applied", value: 42 };
				}),
			).toBe(42);
			expect(lease.pendingMutationCount).toBe(0);
		});
		expect(row()?.displayRoot).toBe("committed");
		expect(quarantined()).toHaveLength(0);
	});

	test("outer transaction ownership prevents rollback from desynchronizing memory", async () => {
		await coordinator.withWrite(request(), (lease) => {
			lease.registerMutation("nested-settle");
			expect(() =>
				db.transaction(() =>
					lease.settleWith("nested-settle", () => ({ outcome: "applied", value: 1 })),
				),
			).toThrow("outermost transaction");
			expect(lease.pendingMutationCount).toBe(1);
			lease.settle("nested-settle", "not_applied");
		});
	});

	test("legacy maintenance holds the whole root across requests without inventing termination", async () => {
		const target = addScope({
			deviceId: "local",
			status: "needs_verification",
			rootIdentityJson: { object: "verified" },
			activeLeaseId: "legacy",
			activeLeaseEpoch: "previous-owner",
		});
		expect(() => coordinator.inspectRecovery({ scope: target })).toThrow(
			expect.objectContaining({ recoveryReason: "owner_unknown" }),
		);
		let authorized = true;
		const reservation = coordinator.reserveMaintenance({ scope: target }, () => {
			if (!authorized) throw new Error("authority revoked");
		});
		try {
			expect(reservation.executionEnded).toBe(false);
			expect(reservation.ranges).toEqual([
				{ kind: "subtree", canonicalPath: target.canonicalRoot },
			]);
			reservation.assertCurrent();
			expectCode(() => coordinator.registerActivity(request(target)), "recovery_conflict");
			await expect(
				coordinator.withWrite(request(target, { waitTimeoutMs: 0 }), () => undefined),
			).rejects.toThrow(errorCode("wait_timeout"));
			authorized = false;
			expect(() => reservation.assertCurrent()).toThrow("authority revoked");
			expect(() => reservation.complete(() => undefined)).toThrow("authority revoked");
			expect(row(target)?.status).toBe("needs_verification");
			authorized = true;
			reservation.complete(() => undefined);
			expect(row(target)?.status).toBe("active");
			expect(row(target)?.activeLeaseId).toBeNull();
		} finally {
			reservation.release();
		}
		await coordinator.withWrite(request(target), () => undefined);
	});

	test("maintenance never overrides a live execution or an unpersisted completion hold", async () => {
		const target = addScope({ deviceId: "local" });
		const held = await hold(target);
		expectCode(
			() => coordinator.reserveMaintenance({ scope: target }, () => undefined),
			"recovery_conflict",
		);
		held.release();
		await held.done;
		sqlite.exec(
			"CREATE TRIGGER reject_completion BEFORE UPDATE OF status ON workspace_write_leases WHEN NEW.status = 'settled' BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END;",
		);
		await expect(coordinator.withWrite(request(target), () => undefined)).rejects.toThrow(
			errorCode("persistence_failed"),
		);
		expect(coordinator.capture(target).active.retainedRecoveryHolds).toBe(1);
		expectCode(
			() => coordinator.reserveMaintenance({ scope: target }, () => undefined),
			"recovery_conflict",
		);
		sqlite.exec("DROP TRIGGER reject_completion");
		expect(await coordinator.retryFinishedPersistence(target)).toEqual({
			retried: 1,
			remaining: 0,
		});
		expect(quarantined(target)).toHaveLength(0);
		await coordinator.withWrite(request(target), () => undefined);
	});
});

test("native owner termination consumes authentic proof, rejects activities and preserves independent root uncertainty", async () => {
	sqlite.exec(
		"CREATE TABLE workspace_execution_owners(owner_epoch TEXT PRIMARY KEY,identity_json TEXT,created_at TEXT NOT NULL)",
	);
	const target = addScope({ deviceId: "local" });
	let leaseId = "";
	await coordinator.withWrite(request(target, { executionClass: "local_file_io" }), (lease) => {
		leaseId = lease.leaseId;
		lease.registerMutation("dispatched-before-crash");
	});
	const identity = {
		version: 1,
		pid: 123,
		birth: "old-kernel-instance",
		domain: {
			platform: "linux",
			machine: "fixture-machine",
			boot: "fixture-boot",
			pidNamespace: "fixture-pid",
			timeNamespace: "fixture-time",
		},
	};
	db.insert(workspaceExecutionOwners)
		.values({
			ownerEpoch: "dead-owner",
			identityJson: identity as typeof workspaceExecutionOwners.$inferInsert.identityJson,
			createdAt: "2026-09-18",
		})
		.run();
	db.update(durableLeases)
		.set({ ownerEpoch: "dead-owner", status: "executing", executionEndedAt: null })
		.where(eq(durableLeases.leaseId, leaseId))
		.run();
	update(
		{
			status: "needs_verification",
			activeLeaseId: leaseId,
			activeLeaseEpoch: "dead-owner",
			activeMutationCount: 1,
		},
		target,
	);
	const proof = {
		ownerEpoch: "dead-owner",
		identity,
		reason: "pid_absent",
		observedAt: "2026-09-23",
	} as unknown as ownerAuthority.WorkspaceOwnerEndedEvidence;
	const authority = spyOn(ownerAuthority, "assertWorkspaceMaintenanceAuthority").mockImplementation(
		() => undefined,
	);
	let acceptProof: ReturnType<typeof spyOn> | undefined;
	try {
		expect(() => coordinator.recordLocalOwnerTermination(leaseId, proof)).toThrow(
			"authentic matching",
		);
		acceptProof = spyOn(ownerAuthority, "assertWorkspaceOwnerEndedEvidence").mockImplementation(
			(_proof, epoch) => {
				if (_proof !== proof || epoch !== "dead-owner") throw new Error("wrong proof");
			},
		);
		const activity = coordinator.registerActivity(request(target));
		try {
			expectCode(
				() => coordinator.recordLocalOwnerTermination(leaseId, proof),
				"recovery_conflict",
			);
		} finally {
			coordinator.endActivity(activity);
		}
		expect(coordinator.recordLocalOwnerTermination(leaseId, proof)).toBe(true);
		expect(row(target)?.status).toBe("needs_verification");
		expect(row(target)?.activeLeaseId).toBeNull();
		const persisted = db
			.select()
			.from(durableLeases)
			.where(eq(durableLeases.leaseId, leaseId))
			.get();
		expect(persisted?.executionEndedAt).toBeString();
		expect(persisted?.terminationEvidenceJson).toMatchObject({
			kind: "owner_ended",
			ownerEpoch: "dead-owner",
		});
		expect(coordinator.recordLocalOwnerTermination(leaseId, proof)).toBe(false);
	} finally {
		acceptProof?.mockRestore();
		authority.mockRestore();
	}
});
