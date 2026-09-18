import { AsyncLocalStorage } from "node:async_hooks";
import { posix, win32 } from "node:path";

export {
	acquireFileHistoryCapture,
	type FileHistoryTarget,
	withFileHistoryCapture,
	withFileHistoryWrite,
} from "./file-history-locks";

import { fileChangeScopes as scopes } from "@server/db/schema";
import { hotSafe } from "@server/lib/hot-safe";
import { generateId } from "@server/lib/id";
import { FILE_CHANGE_LIMITS, type FileChangeExecutionBinding } from "@shared/file-change-protocol";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { SQLiteTransactionConfig } from "drizzle-orm/sqlite-core";
import {
	type FileChangeScopeIdentity,
	fileChangeExecutionBindingMatches,
} from "./file-change-identity";

export const WORKSPACE_WRITE_COORDINATOR_LIMITS = Object.freeze({
	waitTimeoutMs: 2_000,
	maxWaitTimeoutMs: 30_000,
	queueItems: 64,
	queueScopes: 256,
	batchScopes: 32,
	activeLeases: 256,
	activities: 256,
	verificationScopes: 256,
	// Distinct apply + compensation IDs across two phases, NOT a larger file/raw/scope budget.
	mutationsPerLease: 2 * FILE_CHANGE_LIMITS.revertFiles,
	nestedExecutions: 64,
});

type QueryDb = Pick<BunSQLiteDatabase, "select" | "update" | "get">;
export type WorkspaceWriteCoordinatorDb = QueryDb & {
	transaction<T>(work: (tx: QueryDb) => T, config?: SQLiteTransactionConfig): T;
};
export type WorkspaceRuntimeBinding = Readonly<
	Pick<FileChangeExecutionBinding, "runtimeEpoch" | "runtimeGeneration">
>;
export type WorkspaceWriteLeaseKind = "write" | "rollback";
export type WorkspaceWriteLeaseToken = Readonly<{ id: symbol }>;
export type WorkspaceActivityToken = Readonly<{ id: symbol }>;
export type WorkspaceMutationOutcome = "applied" | "not_applied" | "unknown";

export type WorkspaceWriteCoordinatorErrorCode =
	| "invalid_input"
	| "scope_not_found"
	| "scope_identity_mismatch"
	| "scope_inactive"
	| "needs_verification"
	| "verification_backlog"
	| "runtime_mismatch"
	| "stale_lease"
	| "invalid_nesting"
	| "mutation_conflict"
	| "uncoordinated_activity"
	| "rollback_active"
	| "activity_not_found"
	| "queue_full"
	| "capacity_exceeded"
	| "wait_timeout"
	| "aborted"
	| "persistence_failed"
	| "recovery_conflict";

export class WorkspaceWriteCoordinatorError extends Error {
	constructor(
		readonly code: WorkspaceWriteCoordinatorErrorCode,
		message: string,
		cause?: unknown,
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "WorkspaceWriteCoordinatorError";
	}
}

export interface WorkspaceWriteRequest {
	/** Authorized/canonicalized by the execution backend, NOT by this coordinator. */
	scope: Readonly<FileChangeScopeIdentity>;
	/** Expected authoritative runtime; epoch and generation are independent values. */
	runtime: WorkspaceRuntimeBinding;
	/** Admission only. Once granted, cancellation NEVER releases a running body. */
	signal?: AbortSignal;
	waitTimeoutMs?: number;
	/** Explicit reuse only: same scope, no write -> rollback upgrade or lock expansion. */
	leaseToken?: WorkspaceWriteLeaseToken;
}

export type WorkspaceWriteTarget = Readonly<Pick<WorkspaceWriteRequest, "scope" | "runtime">>;

export interface WorkspaceWriteManyRequest {
	/** Fixed before admission; 1..batchScopes entries, including duplicates. */
	readonly scopes: readonly WorkspaceWriteTarget[];
	/** Admission only, never an execution deadline. */
	readonly signal?: AbortSignal;
	readonly waitTimeoutMs?: number;
}

export interface WorkspaceWriteBatch {
	/** Distinct real scope leases in deterministic device/path/identity order. */
	readonly leases: readonly WorkspaceWriteLease[];
	/**
	 * Explicitly enter a member's context. Helpers must still pass its leaseToken.
	 * Only a real member token is accepted, never an arbitrary scope ID. Forgotten
	 * awaits are joined before ANY member range is released.
	 */
	runInScope<T>(
		token: WorkspaceWriteLeaseToken,
		body: (lease: WorkspaceWriteLease) => T | Promise<T>,
	): Promise<T>;
}

export interface WorkspaceWriteLease {
	readonly token: WorkspaceWriteLeaseToken;
	readonly kind: WorkspaceWriteLeaseKind;
	readonly scope: Readonly<FileChangeScopeIdentity>;
	/** Stable across normal mutation registration/settlement within this lease. */
	readonly scopeRevision: number;
	readonly executionBinding: Readonly<FileChangeExecutionBinding>;
	/** Sticky for the WHOLE lease window, even after every activity has ended. */
	readonly overlappedUncoordinatedActivity: boolean;
	readonly pendingMutationCount: number;
	/** Recheck immediately before dispatch, including the backend's expected fence. */
	assertCurrent(expectedBinding?: FileChangeExecutionBinding): void;
	/** MUST complete successfully before dispatching any mutation. Persists its guard. */
	registerMutation(mutationId: string): void;
	/** Exact pending ID plus live durable ownership; a positive total alone is insufficient. */
	assertMutationPending(mutationId: string): void;
	/** Caller supplies an authoritative outcome, not an inference from current bytes. */
	settle(mutationId: string, outcome: WorkspaceMutationOutcome): void;
	/** Irreversible within this lease. Only external recovery may clear the quarantine. */
	markUncertain(): void;
}

export interface WorkspaceObservationRequest
	extends Pick<WorkspaceWriteRequest, "scope" | "runtime" | "signal"> {
	/** Previously observed durable version, not a new lease or a requested fence. */
	scopeRevision: number;
	fencingToken: number;
}

export interface WorkspaceCaptureSummary {
	readonly scopeRevision: number;
	readonly fencingToken: number;
	readonly status: typeof scopes.$inferSelect.status;
	readonly durableLeasePresent: boolean;
	readonly activeMutationCount: number;
	readonly coordinationEpoch: string;
	/** Process-wide monotonic observation stamp; unrelated scopes may also advance it. */
	readonly coordinationRevision: number;
	readonly active: Readonly<{
		writes: number;
		rollbacks: number;
		uncoordinatedActivities: number;
		retainedRecoveryHolds: number;
	}>;
	/** An empty registry never proves that editors/daemons/other processes are idle. */
	readonly externalFilesystemQuiescence: "unknown";
}

interface LeaseRecord {
	owner: WorkspaceWriteCoordinator;
	scope: Readonly<FileChangeScopeIdentity>;
	kind: WorkspaceWriteLeaseKind;
	token: WorkspaceWriteLeaseToken;
	binding: Readonly<FileChangeExecutionBinding>;
	revision: number;
	leaseId: string;
	uncertain: boolean;
	hadActivity: boolean;
	mutations: Map<string, "pending" | WorkspaceMutationOutcome>;
	children: Set<Promise<unknown>>;
	closing: boolean;
	executionEnded: boolean;
	persistencePending: boolean;
	lease: WorkspaceWriteLease;
	/** Optional for records still executing from the pre-batch hot-safe scheduler. */
	group?: LeaseGroup;
}
interface LeaseGroup {
	owner: WorkspaceWriteCoordinator;
	/** ALS boundary only, NOT a scope lease and never inserted in state.leases. */
	contextToken: WorkspaceWriteLeaseToken;
	records: readonly LeaseRecord[];
}
interface ActivityRecord {
	owner: WorkspaceWriteCoordinator;
	scope: Readonly<FileChangeScopeIdentity>;
	uncertain: boolean;
}
interface Waiter {
	owner: WorkspaceWriteCoordinator;
	request: WorkspaceWriteRequest;
	/** Absent on legacy/single waiters. One queue item, all exact physical ranges. */
	targets?: readonly WorkspaceWriteTarget[];
	kind: WorkspaceWriteLeaseKind;
	deadline: number;
	resolve: (record: LeaseRecord) => void;
	reject: (error: unknown) => void;
	cleanup: () => void;
}

/** Treat as opaque. Inject a fresh factory result in tests, never a production reset. */
export interface WorkspaceWriteCoordinatorState {
	/** Process ownership epoch, independent of every device's execution runtime. */
	readonly ownerEpoch: string;
	readonly executionContext: AsyncLocalStorage<WorkspaceWriteLeaseToken>;
	readonly leases: Map<WorkspaceWriteLeaseToken, LeaseRecord>;
	readonly activities: Map<WorkspaceActivityToken, ActivityRecord>;
	readonly waiters: Waiter[];
	revision: number;
	pumping: boolean;
}

export function createWorkspaceWriteCoordinatorState(): WorkspaceWriteCoordinatorState {
	return {
		ownerEpoch: generateId(),
		executionContext: new AsyncLocalStorage(),
		leases: new Map(),
		activities: new Map(),
		waiters: [],
		revision: 0,
		pumping: false,
	};
}

export interface WorkspaceWriteCoordinatorOptions {
	/** Root connection only. No ambient transaction spanning the execution body. */
	db: WorkspaceWriteCoordinatorDb;
	/** Synchronous, side-effect-free runtime authority; MUST NOT guess an epoch. */
	readRuntime: (deviceId: string) => WorkspaceRuntimeBinding | null;
	/** Omit for process-wide, hot-reload-safe coordination across service instances. */
	state?: WorkspaceWriteCoordinatorState;
	waitTimeoutMs?: number;
	queueLimit?: number;
}

/**
 * Single-process range scheduler, not an OS lock, ACL, filesystem resolver, or
 * multi-file atomicity layer. Existing service locks and real IO are NOT wired in.
 *
 * Fixed order: reserve ALL exact physical ranges -> one short synchronous scope
 * transaction -> caller body. No DB transaction spans an await; ranges are never
 * broadened to a common ancestor or a device/path Cartesian product. A batch is
 * one admission/execution window, NOT an OS cross-file atomicity promise.
 * Never acquire another range inside a body; helpers must explicitly reuse its
 * token (via batch.runInScope for a batch). A write cannot upgrade to rollback.
 *
 * All participating writers must use the same state and authoritative device IDs.
 * Source/workspace/scope IDs distinguish evidence, NOT physical exclusion. A
 * fence lets a cooperating backend reject stale dispatches; it cannot stop IO
 * already dispatched or an unregistered external writer.
 *
 * Admission persists an active lease; registration increments its durable pending
 * mutation count BEFORE dispatch. Normal work keeps scope.status active for backend
 * identity verification. A crash leaves a durable admission barrier, not a TTL.
 * Only fully settled execution may clear its matching lease. Unknown/unsettled work
 * first persists needs_verification, retaining the lease for external recovery.
 * Activity registration survives hot reload, not process death: startup recovery
 * must separately account for surviving external processes. No automatic recovery.
 */

export class WorkspaceWriteCoordinator {
	private readonly db: WorkspaceWriteCoordinatorDb;
	private readonly readRuntime: WorkspaceWriteCoordinatorOptions["readRuntime"];
	private readonly state: WorkspaceWriteCoordinatorState;
	private readonly waitTimeoutMs: number;
	private readonly queueLimit: number;

	constructor(options: WorkspaceWriteCoordinatorOptions) {
		this.db = options.db;
		this.readRuntime = options.readRuntime;
		this.state =
			options.state ??
			hotSafe("narrafork.workspace-write-coordinator.v1", createWorkspaceWriteCoordinatorState);
		this.waitTimeoutMs = options.waitTimeoutMs ?? WORKSPACE_WRITE_COORDINATOR_LIMITS.waitTimeoutMs;
		this.queueLimit = options.queueLimit ?? WORKSPACE_WRITE_COORDINATOR_LIMITS.queueItems;
		assertWaitTimeout(this.waitTimeoutMs);
		assertInteger(this.queueLimit, "queueLimit", WORKSPACE_WRITE_COORDINATOR_LIMITS.queueItems);
		// Reject blocking connection settings; never mutate the injected connection.
		const busyTimeout = this.db.get<[number]>(sql`PRAGMA busy_timeout`)?.[0];
		if (busyTimeout === undefined || busyTimeout < 0 || busyTimeout > 250) {
			throw fail("invalid_input", "Coordinator requires SQLite busy_timeout between 0 and 250ms");
		}
		// Preserve v1's maps, ALS, timers, waiter objects, revision and owner epoch.
		// Suspended old run()/removeWaiter()/endActivity() methods call these methods
		// dynamically on resume. Bridge ONLY scheduling/recovery, keeping each old
		// owner's DB/runtime authority and its in-flight body/finalization intact.
		// Otherwise an old release()->pump() could grant only a batch's first range.
		const owners = new Set([
			...Array.from(this.state.leases.values(), (record) => record.owner),
			...Array.from(this.state.activities.values(), (record) => record.owner),
			...this.state.waiters.map((waiter) => waiter.owner),
		]);
		for (const owner of owners) {
			owner.acquire = WorkspaceWriteCoordinator.prototype.acquire;
			owner.canStart = WorkspaceWriteCoordinator.prototype.canStart;
			owner.pump = WorkspaceWriteCoordinator.prototype.pump;
			owner.retryUncertainPersistence =
				WorkspaceWriteCoordinator.prototype.retryUncertainPersistence;
		}
	}

	withWrite<T>(
		request: WorkspaceWriteRequest,
		body: (lease: WorkspaceWriteLease) => T | Promise<T>,
	) {
		return this.run("write", request, body);
	}

	withRollback<T>(
		request: WorkspaceWriteRequest,
		body: (lease: WorkspaceWriteLease) => T | Promise<T>,
	) {
		return this.run("rollback", request, body);
	}

	/** Top-level only. A batch is indivisible admission, not indivisible filesystem IO. */
	async withRollbackMany<T>(
		input: WorkspaceWriteManyRequest,
		body: (batch: WorkspaceWriteBatch) => T | Promise<T>,
	): Promise<T> {
		// ALL copying, validation, deduplication and ordering precede the first await.
		const targets = copyBatchTargets(input.scopes);
		const request: WorkspaceWriteRequest = {
			...targets[0],
			signal: input.signal,
			waitTimeoutMs: input.waitTimeoutMs,
		};
		assertWaitTimeout(request.waitTimeoutMs ?? this.waitTimeoutMs);
		if (request.signal?.aborted) throw fail("aborted", "Workspace admission was cancelled");
		if (this.state.executionContext.getStore()) {
			throw fail("invalid_nesting", "Batch admission is top-level only; use its existing tokens");
		}
		const first = await this.acquire("rollback", request, targets);
		const group = first.group;
		if (!group) throw fail("stale_lease", "Batch admission did not produce a lease group");
		const batch: WorkspaceWriteBatch = Object.freeze({
			leases: Object.freeze(group.records.map((record) => record.lease)),
			runInScope: <V>(
				token: WorkspaceWriteLeaseToken,
				scopeBody: (lease: WorkspaceWriteLease) => V | Promise<V>,
			) => this.runInGroup(group, token, scopeBody),
		});
		const result = await Promise.resolve()
			.then(() => this.state.executionContext.run(group.contextToken, () => body(batch)))
			.then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({ ok: false as const, error }),
			);
		for (const record of group.records) record.closing = true;
		// Closing every member first prevents new descendants after this snapshot.
		const children = await Promise.allSettled(
			group.records.flatMap((record) => [...record.children]),
		);
		try {
			// All durable settlement commits, or every range remains a recovery hold.
			this.transaction((tx) => {
				for (const record of group.records) {
					if (record.uncertain || pendingCount(record) > 0) {
						this.persistUncertainScopeInTransaction(tx, record.scope);
					} else {
						this.clearLeaseInTransaction(tx, record);
					}
				}
			});
		} catch (cause) {
			for (const record of group.records) {
				record.executionEnded = true;
				record.persistencePending = true;
			}
			this.changed();
			throw fail(
				"persistence_failed",
				"Durable batch finalization failed; ALL physical ranges remain held",
				result.ok ? cause : new AggregateError([result.error, cause]),
			);
		}
		for (const record of group.records) record.executionEnded = true;
		this.releaseGroup(group);
		if (!result.ok) throw result.error;
		const failedChild = children.find((child) => child.status === "rejected");
		if (failedChild?.status === "rejected") throw failedChild.reason;
		return result.value;
	}

	private async runInGroup<T>(
		group: LeaseGroup,
		token: WorkspaceWriteLeaseToken,
		body: (lease: WorkspaceWriteLease) => T | Promise<T>,
	): Promise<T> {
		const inherited = this.state.executionContext.getStore();
		if (
			inherited &&
			inherited !== group.contextToken &&
			!group.records.some((record) => record.token === inherited)
		) {
			throw fail("invalid_nesting", "Cannot enter a batch from an unrelated execution");
		}
		const record = group.records.find((candidate) => candidate.token === token);
		if (!record || record.closing || record.executionEnded) {
			throw fail("invalid_nesting", "Batch helper requires a live member lease token");
		}
		if (
			group.records.reduce((count, member) => count + member.children.size, 0) >=
			WORKSPACE_WRITE_COORDINATOR_LIMITS.nestedExecutions
		) {
			throw fail("capacity_exceeded", "Too many nested batch executions");
		}
		return this.state.executionContext.run(token, () =>
			this.run(
				record.kind,
				{ scope: record.scope, runtime: record.binding, leaseToken: token },
				body,
			),
		);
	}

	/**
	 * Register BEFORE starting a long Bash/unknown writer; end only when it has
	 * really stopped (including delegated work). This is observation, not a write
	 * permission or a long-held write lock. A running rollback rejects registration.
	 */
	registerActivity(
		input: Pick<WorkspaceWriteRequest, "scope" | "runtime">,
	): WorkspaceActivityToken {
		const scope = copyScope(input.scope);
		this.requireRuntime(scope.deviceId, input.runtime);
		const row = this.requireScope(this.db, scope);
		if (row.status === "retired") throw fail("scope_inactive", "Scope is retired");
		if (this.state.activities.size >= WORKSPACE_WRITE_COORDINATOR_LIMITS.activities) {
			throw fail("capacity_exceeded", "Too many registered workspace activities");
		}
		for (const record of this.state.leases.values()) {
			if (record.kind === "rollback" && overlaps(scope, record.scope)) {
				throw fail("rollback_active", "An overlapping rollback is still executing");
			}
		}
		const token = Object.freeze({ id: Symbol("workspace-activity") });
		this.state.activities.set(token, { owner: this, scope, uncertain: false });
		for (const record of this.state.leases.values()) {
			if (overlaps(scope, record.scope)) record.hadActivity = true;
		}
		this.changed();
		// Reject an already queued rollback too; ending this activity cannot erase it.
		this.pump();
		return token;
	}

	endActivity(token: WorkspaceActivityToken, outcome: "finished" | "unknown" = "finished"): void {
		const record = this.state.activities.get(token);
		if (!record) {
			throw fail(
				"activity_not_found",
				"Activity is no longer registered in this coordinator state",
			);
		}
		if (outcome !== "finished" && outcome !== "unknown") {
			throw fail("invalid_input", "Invalid activity outcome");
		}
		if (outcome === "unknown") record.uncertain = true;
		// An unknown activity must not be cleared by a concurrent lease settling its
		// OWN mutation guard. Failed persistence cannot be retried as "finished".
		if (record.uncertain) {
			for (const lease of this.state.leases.values()) {
				if (overlaps(record.scope, lease.scope)) lease.uncertain = true;
			}
			// On a persistence failure retain the activity, continuing to deny rollback.
			const revision = record.owner.persistUncertainScope(record.scope);
			for (const lease of this.state.leases.values()) {
				if (sameScope(lease.scope, record.scope)) lease.revision = revision;
			}
		}
		this.state.activities.delete(token);
		this.changed();
		this.pump();
	}

	/** Read-only, bounded metadata. This is not a capture lock or an external-FS claim. */
	capture(scopeInput: Readonly<FileChangeScopeIdentity>): WorkspaceCaptureSummary {
		const scope = copyScope(scopeInput);
		const row = this.requireScope(this.db, scope);
		const active = {
			writes: 0,
			rollbacks: 0,
			uncoordinatedActivities: 0,
			retainedRecoveryHolds: 0,
		};
		for (const record of this.state.leases.values()) {
			if (!overlaps(scope, record.scope)) continue;
			if (record.kind === "write") active.writes++;
			else active.rollbacks++;
			if (record.persistencePending) active.retainedRecoveryHolds++;
		}
		for (const record of this.state.activities.values()) {
			if (overlaps(scope, record.scope)) active.uncoordinatedActivities++;
		}
		return Object.freeze({
			scopeRevision: row.revision,
			fencingToken: row.fencingToken,
			status: row.status,
			durableLeasePresent: row.activeLeaseId !== null,
			activeMutationCount: row.activeMutationCount,
			coordinationEpoch: this.state.ownerEpoch,
			coordinationRevision: this.state.revision,
			active: Object.freeze(active),
			externalFilesystemQuiescence: "unknown",
		});
	}

	/**
	 * Read-only preview guard. Unlike capture(), includes durable barriers from
	 * OTHER evidence scopes covering the same physical path. Never grants a lease,
	 * consumes a fence, mutates a revision, or proves arbitrary external FS quiescence.
	 * Callers still recheck after IO; actual mutations MUST acquire a fresh lease.
	 */
	assertObservationCurrent(input: WorkspaceObservationRequest): WorkspaceCaptureSummary {
		if (input.signal?.aborted) throw fail("aborted", "Workspace observation was cancelled");
		const scope = copyScope(input.scope);
		assertInteger(input.scopeRevision, "scope revision");
		assertInteger(input.fencingToken, "scope fencing token");
		this.requireRuntime(scope.deviceId, input.runtime);
		const row = this.requireScope(this.db, scope);
		if (row.status !== "active") throw scopeStatusError(row.status);
		if (row.revision !== input.scopeRevision || row.fencingToken !== input.fencingToken)
			throw fail("stale_lease", "Observed scope revision or fence has changed");
		if (
			row.activeLeaseId !== null ||
			row.activeLeaseEpoch !== null ||
			row.activeLeaseStartedAt !== null ||
			row.activeMutationCount !== 0
		)
			throw fail(
				"needs_verification",
				"Workspace observation overlaps an unfinished durable lease",
			);
		this.rejectActivityOverlap("rollback", scope);
		const summary = this.capture(scope);
		if (
			summary.scopeRevision !== input.scopeRevision ||
			summary.fencingToken !== input.fencingToken
		)
			throw fail("stale_lease", "Observed scope changed during metadata verification");
		if (summary.active.writes || summary.active.rollbacks || summary.active.retainedRecoveryHolds)
			throw fail("wait_timeout", "Workspace observation overlaps a live execution");
		this.requireNoQuarantine(this.db, scope);
		return summary;
	}

	/** The live coordination epoch; recovery decisions compare durable lease epochs against it. */
	ownerEpoch(): string {
		return this.state.ownerEpoch;
	}

	/**
	 * External recovery entry point: a human has re-observed the physical state
	 * (see workspace-scope-recovery) and already closed the evidence books. This
	 * clears ONLY the durable barrier. It never settles evidence itself, never
	 * resumes IO, and refuses a lease owned by the current live epoch. Bumping
	 * the fence keeps every stale backend of the old generation fenced out.
	 */
	recoverScopeBarrier(scopeInput: Readonly<FileChangeScopeIdentity>): {
		revision: number;
		fencingToken: number;
	} {
		const scope = copyScope(scopeInput);
		for (const record of this.state.leases.values()) {
			if (sameScope(record.scope, scope)) {
				throw fail("recovery_conflict", "A live in-memory lease still owns this scope");
			}
		}
		for (const record of this.state.activities.values()) {
			if (sameScope(record.scope, scope)) {
				throw fail("recovery_conflict", "A live in-memory activity still covers this scope");
			}
		}
		const row = this.transaction((tx) => {
			const current = this.requireScope(tx, scope);
			const leaseBarrier = current.activeLeaseId !== null;
			if (current.status !== "needs_verification" && !leaseBarrier) {
				throw fail("invalid_input", "Scope has no durable recovery barrier");
			}
			if (leaseBarrier && current.activeLeaseEpoch === this.state.ownerEpoch) {
				// A lease owned by THIS live process may still be running; never clear it.
				throw fail("recovery_conflict", "The durable lease belongs to the live coordination epoch");
			}
			return tx
				.update(scopes)
				.set({
					status: "active",
					activeLeaseId: null,
					activeLeaseEpoch: null,
					activeLeaseStartedAt: null,
					activeMutationCount: 0,
					revision: next(current.revision),
					fencingToken: next(current.fencingToken),
					updatedAt: now(),
				})
				.where(eq(scopes.id, scope.id))
				.returning({ revision: scopes.revision, fencingToken: scopes.fencingToken })
				.get();
		});
		this.changed();
		this.pump();
		return row;
	}

	/**
	 * Retry ONLY a failed quarantine write after the execution body has ended.
	 * This cannot resume IO, clear needs_verification, or reuse an old fence.
	 */
	retryUncertainPersistence(token: WorkspaceWriteLeaseToken): void {
		const record = this.state.leases.get(token);
		if (!record?.executionEnded || !record.persistencePending) {
			throw fail("stale_lease", "No finished lease has a pending quarantine write");
		}
		if (record.group) {
			// Any real member token retries the ENTIRE group, never a partial release.
			record.group.owner.retryGroupPersistence(record.group);
			return;
		}
		const row = this.requireScope(this.db, record.scope);
		if (row.activeLeaseId !== record.leaseId || row.activeLeaseEpoch !== this.state.ownerEpoch) {
			throw fail("stale_lease", "Durable lease ownership no longer matches this recovery hold");
		}
		this.persistUncertainScope(record.scope);
		this.release(record);
	}

	private retryGroupPersistence(group: LeaseGroup): void {
		this.transaction((tx) => {
			// Check ALL real token/row owners before persisting any recovery status.
			for (const record of group.records) {
				if (
					this.state.leases.get(record.token) !== record ||
					!record.executionEnded ||
					!record.persistencePending
				) {
					throw fail("stale_lease", "Batch does not have a complete finished recovery hold");
				}
				const row = this.requireScope(tx, record.scope);
				if (
					row.activeLeaseId !== record.leaseId ||
					row.activeLeaseEpoch !== this.state.ownerEpoch
				) {
					throw fail("stale_lease", "Durable batch ownership no longer matches its recovery hold");
				}
			}
			// Conservative explicit retry ONLY quarantines; it cannot resume execution
			// or certify the clean members. A failed second write rolls back the first.
			for (const record of group.records) {
				this.persistUncertainScopeInTransaction(tx, record.scope);
			}
		});
		this.releaseGroup(group);
	}

	private async run<T>(
		kind: WorkspaceWriteLeaseKind,
		input: WorkspaceWriteRequest,
		body: (lease: WorkspaceWriteLease) => T | Promise<T>,
	): Promise<T> {
		const request: WorkspaceWriteRequest = {
			...input,
			scope: copyScope(input.scope),
			runtime: Object.freeze({ ...input.runtime }),
		};
		assertWaitTimeout(request.waitTimeoutMs ?? this.waitTimeoutMs);
		if (request.signal?.aborted) throw fail("aborted", "Workspace admission was cancelled");
		const inherited = this.state.executionContext.getStore();
		if (inherited && request.leaseToken !== inherited) {
			throw fail(
				"invalid_nesting",
				"Nested execution must explicitly reuse its current lease token",
			);
		}
		if (request.leaseToken) {
			const record = this.state.leases.get(request.leaseToken);
			if (
				!record ||
				record.closing ||
				!sameScope(record.scope, request.scope) ||
				(kind === "rollback" && record.kind !== "rollback")
			) {
				throw fail(
					"invalid_nesting",
					"Reuse requires a live matching lease without lock expansion",
				);
			}
			this.requireRuntime(request.scope.deviceId, request.runtime);
			if (!sameRuntime(record.binding, request.runtime)) {
				throw fail("runtime_mismatch", "Nested execution changed runtime binding");
			}
			// A hot reload may construct a new Drizzle wrapper over the same database.
			// Check durable ownership, not JS wrapper identity, before reusing a token.
			this.requireLeaseRow(this.db, record);
			record.lease.assertCurrent();
			const childrenCount = record.group
				? record.group.records.reduce((count, member) => count + member.children.size, 0)
				: record.children.size;
			if (childrenCount >= WORKSPACE_WRITE_COORDINATOR_LIMITS.nestedExecutions) {
				throw fail("capacity_exceeded", "Too many nested executions");
			}
			const child = Promise.resolve().then(() =>
				this.state.executionContext.run(record.token, () => body(record.lease)),
			);
			record.children.add(child);
			try {
				return await child;
			} finally {
				record.children.delete(child);
			}
		}

		const record = await this.acquire(kind, request);
		const result = await Promise.resolve()
			.then(() => this.state.executionContext.run(record.token, () => body(record.lease)))
			.then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({ ok: false as const, error }),
			);
		record.closing = true;
		// A forgotten await by a nested caller still cannot release executing work.
		const children = await Promise.allSettled([...record.children]);
		try {
			if (record.uncertain || pendingCount(record) > 0) {
				this.persistUncertainScope(record.scope);
			} else {
				this.transaction((tx) => {
					// A runtime reconnect cannot prevent releasing finished read-only work.
					this.requireLeaseRow(tx, record, false);
					tx.update(scopes)
						.set({
							activeLeaseId: null,
							activeLeaseEpoch: null,
							activeLeaseStartedAt: null,
							activeMutationCount: 0,
							revision: next(record.revision),
							updatedAt: now(),
						})
						.where(eq(scopes.id, record.scope.id))
						.run();
				});
			}
		} catch (cause) {
			record.executionEnded = true;
			record.persistencePending = true;
			this.changed();
			throw fail(
				"persistence_failed",
				"Durable finalization failed; physical range remains held",
				result.ok ? cause : new AggregateError([result.error, cause]),
			);
		}
		record.executionEnded = true;
		this.release(record);
		if (!result.ok) throw result.error;
		const failedChild = children.find((child) => child.status === "rejected");
		if (failedChild?.status === "rejected") throw failedChild.reason;
		return result.value;
	}

	private acquire(
		kind: WorkspaceWriteLeaseKind,
		request: WorkspaceWriteRequest,
		targets?: readonly WorkspaceWriteTarget[],
	): Promise<LeaseRecord> {
		// A waiter may observe its current holder's durable mutation guard. Status is
		// checked again at grant, AFTER that holder has actually finished/settled.
		const requested = targets ?? [request];
		for (const target of requested) {
			this.requireScope(this.db, target.scope);
			this.requireRuntime(target.scope.deviceId, target.runtime);
			this.rejectActivityOverlap(kind, target.scope);
		}
		if (
			targets
				? canStartRanges(this.state, targets, this.state.waiters)
				: this.canStart(request.scope, this.state.waiters)
		) {
			return Promise.resolve(
				targets ? this.grantMany(kind, request, targets) : this.grant(kind, request),
			);
		}
		const waitTimeoutMs = request.waitTimeoutMs ?? this.waitTimeoutMs;
		if (waitTimeoutMs === 0) return Promise.reject(fail("wait_timeout", "Workspace range is busy"));
		if (
			this.state.waiters.length >= this.queueLimit ||
			this.state.waiters.reduce((count, waiter) => count + waiterTargets(waiter).length, 0) +
				requested.length >
				WORKSPACE_WRITE_COORDINATOR_LIMITS.queueScopes
		) {
			return Promise.reject(fail("queue_full", "Workspace admission item/range budget is full"));
		}
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			const cancel = () =>
				this.removeWaiter(waiter, fail("aborted", "Workspace admission cancelled"));
			const waiter: Waiter = {
				owner: this,
				request,
				targets,
				kind,
				deadline: performance.now() + waitTimeoutMs,
				resolve,
				reject,
				cleanup: () => {
					clearTimeout(timer);
					request.signal?.removeEventListener("abort", cancel);
				},
			};
			this.state.waiters.push(waiter);
			timer = setTimeout(
				() => this.removeWaiter(waiter, fail("wait_timeout", "Workspace admission timed out")),
				waitTimeoutMs,
			);
			request.signal?.addEventListener("abort", cancel, { once: true });
			if (request.signal?.aborted) cancel();
		});
	}

	private canStart(scope: Readonly<FileChangeScopeIdentity>, earlier: readonly Waiter[]): boolean {
		return canStartRanges(this.state, [{ scope }], earlier);
	}

	private pump(): void {
		if (this.state.pumping) return;
		this.state.pumping = true;
		try {
			for (let index = 0; index < this.state.waiters.length; ) {
				const waiter = this.state.waiters[index];
				try {
					if (waiter.request.signal?.aborted)
						throw fail("aborted", "Workspace admission cancelled");
					if (performance.now() >= waiter.deadline) {
						throw fail("wait_timeout", "Workspace admission timed out");
					}
					const targets = waiterTargets(waiter);
					for (const target of targets) {
						waiter.owner.rejectActivityOverlap(waiter.kind, target.scope);
					}
					if (!canStartRanges(this.state, targets, this.state.waiters.slice(0, index))) {
						index++;
						continue;
					}
					const record = waiter.targets
						? waiter.owner.grantMany(waiter.kind, waiter.request, waiter.targets)
						: waiter.owner.grant(waiter.kind, waiter.request);
					this.state.waiters.splice(index, 1);
					waiter.cleanup();
					waiter.resolve(record);
				} catch (error) {
					this.state.waiters.splice(index, 1);
					waiter.cleanup();
					waiter.reject(error);
				}
			}
		} finally {
			this.state.pumping = false;
		}
	}

	private removeWaiter(waiter: Waiter, error: WorkspaceWriteCoordinatorError): void {
		const index = this.state.waiters.indexOf(waiter);
		if (index === -1) return; // Already granted: never cancel/release its execution.
		this.state.waiters.splice(index, 1);
		waiter.cleanup();
		waiter.reject(error);
		this.pump();
	}

	private grant(kind: WorkspaceWriteLeaseKind, request: WorkspaceWriteRequest): LeaseRecord {
		this.rejectActivityOverlap(kind, request.scope);
		const leaseId = generateId();
		// Synchronous range check + transaction + insertion: no await/interleaving.
		const row = this.transaction((tx) => {
			const current = this.requireScope(tx, request.scope);
			this.requireRuntime(request.scope.deviceId, request.runtime);
			if (request.signal?.aborted) throw fail("aborted", "Workspace admission cancelled");
			if (current.status !== "active") throw scopeStatusError(current.status);
			if (
				current.activeLeaseId !== null ||
				current.activeLeaseEpoch !== null ||
				current.activeLeaseStartedAt !== null ||
				current.activeMutationCount !== 0
			) {
				throw fail(
					"needs_verification",
					`Scope "${current.canonicalRoot}" has an unfinished durable lease from a previous ` +
						"run. An admin can recover it in Settings → Storage → Workspace write barriers.",
				);
			}
			this.requireNoQuarantine(tx, request.scope, undefined, kind === "write" ? "write" : "strict");
			return tx
				.update(scopes)
				.set({
					fencingToken: next(current.fencingToken),
					revision: next(current.revision),
					activeLeaseId: leaseId,
					activeLeaseEpoch: this.state.ownerEpoch,
					activeLeaseStartedAt: now(),
					activeMutationCount: 0,
					updatedAt: now(),
				})
				.where(eq(scopes.id, request.scope.id))
				.returning({ fencingToken: scopes.fencingToken, revision: scopes.revision })
				.get();
		});
		const record = this.createLeaseRecord(kind, request, leaseId, row);
		this.state.leases.set(record.token, record);
		this.changed();
		return record;
	}

	private grantMany(
		kind: WorkspaceWriteLeaseKind,
		request: WorkspaceWriteRequest,
		targets: readonly WorkspaceWriteTarget[],
	): LeaseRecord {
		for (const target of targets) this.rejectActivityOverlap(kind, target.scope);
		const records = this.transaction((tx) => {
			const current = targets.map((target) => {
				const row = this.requireScope(tx, target.scope);
				this.requireRuntime(target.scope.deviceId, target.runtime);
				if (request.signal?.aborted) throw fail("aborted", "Workspace admission cancelled");
				if (row.status !== "active") throw scopeStatusError(row.status);
				if (
					row.activeLeaseId !== null ||
					row.activeLeaseEpoch !== null ||
					row.activeLeaseStartedAt !== null ||
					row.activeMutationCount !== 0
				) {
					throw fail(
						"needs_verification",
						`Scope "${row.canonicalRoot}" has an unfinished durable lease from a previous ` +
							"run. An admin can recover it in Settings → Storage → Workspace write barriers.",
					);
				}
				return row;
			});
			// Check the complete inventory BEFORE writing the first guard. An ID list
			// is never an exemption for an existing/crashed lease, even within targets.
			this.requireNoQuarantineMany(
				tx,
				targets.map((target) => target.scope),
				undefined,
				true,
				kind === "write" ? "write" : "strict",
			);
			return targets.map((target, index) => {
				const leaseId = generateId();
				const row = tx
					.update(scopes)
					.set({
						fencingToken: next(current[index].fencingToken),
						revision: next(current[index].revision),
						activeLeaseId: leaseId,
						activeLeaseEpoch: this.state.ownerEpoch,
						activeLeaseStartedAt: now(),
						activeMutationCount: 0,
						updatedAt: now(),
					})
					.where(eq(scopes.id, target.scope.id))
					.returning({ fencingToken: scopes.fencingToken, revision: scopes.revision })
					.get();
				if (!row) throw fail("stale_lease", "A batch member disappeared during admission");
				return this.createLeaseRecord(kind, target, leaseId, row);
			});
		});
		const group: LeaseGroup = {
			owner: this,
			contextToken: Object.freeze({ id: Symbol("workspace-write-batch-context") }),
			records: Object.freeze(records),
		};
		// No await or body dispatch between admission and installing ALL ranges.
		for (const record of records) {
			record.group = group;
			this.state.leases.set(record.token, record);
		}
		this.changed();
		return records[0];
	}

	private createLeaseRecord(
		kind: WorkspaceWriteLeaseKind,
		request: WorkspaceWriteTarget,
		leaseId: string,
		row: { fencingToken: number; revision: number },
	): LeaseRecord {
		const token = Object.freeze({ id: Symbol("workspace-write-lease") });
		const record = {
			owner: this,
			scope: request.scope,
			kind,
			token,
			binding: Object.freeze({
				deviceId: request.scope.deviceId,
				runtimeEpoch: request.runtime.runtimeEpoch,
				runtimeGeneration: request.runtime.runtimeGeneration,
				fencingToken: row.fencingToken,
			}),
			revision: row.revision,
			leaseId,
			uncertain: false,
			hadActivity: this.hasActivity(request.scope),
			mutations: new Map(),
			children: new Set(),
			closing: false,
			executionEnded: false,
			persistencePending: false,
		} as Omit<LeaseRecord, "lease"> as LeaseRecord;
		record.lease = Object.freeze({
			token,
			kind,
			scope: record.scope,
			executionBinding: record.binding,
			get scopeRevision() {
				return record.revision;
			},
			get overlappedUncoordinatedActivity() {
				return record.hadActivity;
			},
			get pendingMutationCount() {
				return pendingCount(record);
			},
			assertCurrent: (binding = record.binding) => {
				this.requireLive(record);
				if (!fileChangeExecutionBindingMatches(record.binding, binding)) {
					throw fail("stale_lease", "Execution binding does not match the active lease");
				}
				if (record.uncertain) throw fail("needs_verification", "Lease has an uncertain outcome");
				this.requireLeaseRow(this.db, record);
				this.requireNoQuarantine(
					this.db,
					record.scope,
					record,
					record.kind === "write" ? "write" : "strict",
				);
			},
			registerMutation: (id: string) => this.registerMutation(record, id),
			assertMutationPending: (id: string) => {
				assertString(id, "mutationId", 256);
				record.lease.assertCurrent();
				if (record.mutations.get(id) !== "pending") {
					throw fail("mutation_conflict", "Mutation is not pending on this lease");
				}
			},
			settle: (id: string, outcome: WorkspaceMutationOutcome) => this.settle(record, id, outcome),
			markUncertain: () => {
				this.requireLive(record);
				record.uncertain = true;
				record.revision = this.persistUncertainScope(record.scope);
			},
		});
		return record;
	}

	private registerMutation(record: LeaseRecord, id: string): void {
		assertString(id, "mutationId", 256);
		this.requireLive(record);
		if (record.mutations.has(id)) throw fail("mutation_conflict", "Mutation ID was already used");
		if (record.mutations.size >= WORKSPACE_WRITE_COORDINATOR_LIMITS.mutationsPerLease) {
			throw fail("capacity_exceeded", "Lease mutation budget exceeded");
		}
		record.lease.assertCurrent();
		this.transaction((tx) => {
			this.requireLeaseRow(tx, record);
			this.updateMutationCount(tx, record, pendingCount(record) + 1);
		});
		record.mutations.set(id, "pending");
		this.changed();
	}

	private settle(record: LeaseRecord, id: string, outcome: WorkspaceMutationOutcome): void {
		this.requireLive(record);
		if (record.mutations.get(id) !== "pending") {
			throw fail("mutation_conflict", "Mutation is not pending on this lease");
		}
		if (outcome !== "applied" && outcome !== "not_applied" && outcome !== "unknown") {
			throw fail("invalid_input", "Invalid mutation outcome");
		}
		if (outcome === "unknown") {
			record.lease.markUncertain();
			record.mutations.set(id, outcome);
			return;
		}
		this.transaction((tx) => {
			this.requireLeaseRow(tx, record);
			this.updateMutationCount(tx, record, pendingCount(record) - 1);
		});
		record.mutations.set(id, outcome);
		this.changed();
	}

	private requireLive(record: LeaseRecord): void {
		if (record.executionEnded || this.state.leases.get(record.token) !== record) {
			throw fail("stale_lease", "Lease execution has already ended");
		}
	}

	private requireLeaseRow(tx: QueryDb, record: LeaseRecord, checkRuntime = true) {
		this.requireLive(record);
		if (checkRuntime) this.requireRuntime(record.scope.deviceId, record.binding);
		const row = this.requireScope(tx, record.scope);
		if (
			row.fencingToken !== record.binding.fencingToken ||
			row.revision !== record.revision ||
			row.activeLeaseId !== record.leaseId ||
			row.activeLeaseEpoch !== this.state.ownerEpoch ||
			row.activeMutationCount !== pendingCount(record)
		) {
			throw fail("stale_lease", "Scope fence, lease owner, revision or mutation count has changed");
		}
		if (row.status !== "active" && !(record.uncertain && row.status === "needs_verification")) {
			throw scopeStatusError(row.status);
		}
		return row;
	}

	private updateMutationCount(tx: QueryDb, record: LeaseRecord, count: number): void {
		// All effects prepared within one lease share its scope revision. Advancing
		// it for each counter change would fence this lease's other prepared effects.
		// Captures still see the active lease/count and advancing coordination stamp.
		tx.update(scopes)
			.set({ activeMutationCount: count, updatedAt: now() })
			.where(eq(scopes.id, record.scope.id))
			.run();
	}

	private requireScope(tx: QueryDb, expected: Readonly<FileChangeScopeIdentity>) {
		// Deliberately exclude rootIdentityJson and presentation fields from hot reads.
		const row = tx
			.select({
				id: scopes.id,
				sourceInstanceId: scopes.sourceInstanceId,
				deviceId: scopes.deviceId,
				workspaceInstanceId: scopes.workspaceInstanceId,
				canonicalRoot: scopes.canonicalRoot,
				pathFlavor: scopes.pathFlavor,
				status: scopes.status,
				revision: scopes.revision,
				fencingToken: scopes.fencingToken,
				activeLeaseId: scopes.activeLeaseId,
				activeLeaseEpoch: scopes.activeLeaseEpoch,
				activeLeaseStartedAt: scopes.activeLeaseStartedAt,
				activeMutationCount: scopes.activeMutationCount,
			})
			.from(scopes)
			.where(eq(scopes.id, expected.id))
			.get();
		if (!row) throw fail("scope_not_found", "Unknown file-change scope");
		if (!sameScope(expected, row)) {
			throw fail(
				"scope_identity_mismatch",
				"Persisted scope no longer matches its verified identity",
			);
		}
		assertInteger(row.revision, "scope revision");
		assertInteger(row.fencingToken, "scope fencing token");
		assertInteger(row.activeMutationCount, "active mutation count");
		return row;
	}

	private requireRuntime(deviceId: string, expected: WorkspaceRuntimeBinding): void {
		assertRuntime(expected);
		const current = this.readRuntime(deviceId);
		if (!current || !sameRuntime(current, expected)) {
			throw fail("runtime_mismatch", "Authoritative device runtime changed or is unavailable");
		}
		assertRuntime(current);
	}

	private requireNoQuarantine(
		tx: QueryDb,
		scope: Readonly<FileChangeScopeIdentity>,
		owner?: LeaseRecord,
		mode: RecoveryBarrierMode = "strict",
	): void {
		this.requireNoQuarantineMany(tx, [scope], owner, false, mode);
	}

	private requireNoQuarantineMany(
		tx: QueryDb,
		targets: readonly Readonly<FileChangeScopeIdentity>[],
		owner?: LeaseRecord,
		admitting = false,
		mode: RecoveryBarrierMode = "strict",
	): void {
		// One bounded global indexed status read; one bounded lease read per device.
		// No broad ancestor, source filter, cross-device Cartesian lock or unbounded
		// inventory scan. Over-budget recovery fails closed, including unrelated rows.
		const blockers = tx
			.select({
				id: scopes.id,
				deviceId: scopes.deviceId,
				pathFlavor: scopes.pathFlavor,
				canonicalRoot: scopes.canonicalRoot,
			})
			.from(scopes)
			.where(eq(scopes.status, "needs_verification"))
			.limit(WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes + 1)
			.all();
		if (blockers.length > WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes) {
			throw fail("verification_backlog", "Recovery scope inventory exceeds the admission budget");
		}
		for (const blocker of blockers) {
			// Real uncertainty is NEVER exempted, even for a sibling in this group.
			if (targets.some((target) => barrierBlocks(target, blocker, mode))) {
				throw fail(
					"needs_verification",
					`An overlapping physical scope needs verification: "${blocker.canonicalRoot}" ` +
						`(scope ${blocker.id}). An admin can recover it in ` +
						"Settings → Storage → Workspace write barriers.",
				);
			}
		}
		for (const deviceId of new Set(targets.map((target) => target.deviceId))) {
			const leased = tx
				.select({
					id: scopes.id,
					sourceInstanceId: scopes.sourceInstanceId,
					workspaceInstanceId: scopes.workspaceInstanceId,
					deviceId: scopes.deviceId,
					pathFlavor: scopes.pathFlavor,
					canonicalRoot: scopes.canonicalRoot,
					activeLeaseId: scopes.activeLeaseId,
					activeLeaseEpoch: scopes.activeLeaseEpoch,
				})
				.from(scopes)
				.where(and(eq(scopes.deviceId, deviceId), isNotNull(scopes.activeLeaseId)))
				.limit(WORKSPACE_WRITE_COORDINATOR_LIMITS.activeLeases + 1)
				.all();
			const additions = admitting
				? targets.filter((target) => target.deviceId === deviceId).length
				: 0;
			if (leased.length + additions > WORKSPACE_WRITE_COORDINATOR_LIMITS.activeLeases) {
				throw fail("verification_backlog", "Durable lease inventory exceeds the admission budget");
			}
			for (const blocker of leased) {
				if (!targets.some((target) => barrierBlocks(target, blocker, mode))) continue;
				// An exemption is capability-based: a live REAL token in this state,
				// matching durable ownership/identity, and the exact same group object.
				// IDs supplied by callers or a new process cannot construct this proof.
				const members = owner?.group?.records ?? (owner ? [owner] : []);
				const owned = members.some(
					(member) =>
						!member.executionEnded &&
						!member.uncertain &&
						this.state.leases.get(member.token) === member &&
						(member === owner || (owner?.group && member.group === owner.group)) &&
						member.leaseId === blocker.activeLeaseId &&
						blocker.activeLeaseEpoch === this.state.ownerEpoch &&
						sameScope(member.scope, blocker),
				);
				if (!owned) {
					throw fail(
						"needs_verification",
						`An overlapping physical scope has an unfinished lease: "${blocker.canonicalRoot}" ` +
							`(scope ${blocker.id}). An admin can recover it in ` +
							"Settings → Storage → Workspace write barriers.",
					);
				}
			}
		}
	}

	private persistUncertainScope(scope: Readonly<FileChangeScopeIdentity>): number {
		const revision = this.transaction((tx) => this.persistUncertainScopeInTransaction(tx, scope));
		this.changed();
		return revision;
	}

	private persistUncertainScopeInTransaction(
		tx: QueryDb,
		scope: Readonly<FileChangeScopeIdentity>,
	): number {
		const row = this.requireScope(tx, scope);
		// No runtime/fence requirement here: lost authority must still quarantine,
		// never make an old result eligible to restore active on a new generation.
		if (row.status === "needs_verification") return row.revision;
		return this.updateScopeStatus(tx, scope.id, "needs_verification", row.revision);
	}

	private clearLeaseInTransaction(tx: QueryDb, record: LeaseRecord): void {
		// A reconnect does not prevent releasing finished, fully settled work.
		this.requireLeaseRow(tx, record, false);
		tx.update(scopes)
			.set({
				activeLeaseId: null,
				activeLeaseEpoch: null,
				activeLeaseStartedAt: null,
				activeMutationCount: 0,
				revision: next(record.revision),
				updatedAt: now(),
			})
			.where(eq(scopes.id, record.scope.id))
			.run();
	}

	private updateScopeStatus(
		tx: QueryDb,
		scopeId: string,
		status: typeof scopes.$inferSelect.status,
		revision: number,
	): number {
		const row = tx
			.update(scopes)
			.set({ status, revision: next(revision), updatedAt: now() })
			.where(and(eq(scopes.id, scopeId), eq(scopes.revision, revision)))
			.returning({ revision: scopes.revision })
			.get();
		if (!row) throw fail("stale_lease", "Scope revision changed during settlement");
		return row.revision;
	}

	private hasActivity(scope: Readonly<FileChangeScopeIdentity>): boolean {
		for (const activity of this.state.activities.values()) {
			if (overlaps(scope, activity.scope)) return true;
		}
		return false;
	}

	private rejectActivityOverlap(
		kind: WorkspaceWriteLeaseKind,
		scope: Readonly<FileChangeScopeIdentity>,
	) {
		for (const activity of this.state.activities.values()) {
			if (!overlaps(scope, activity.scope)) continue;
			if (activity.uncertain) {
				throw fail("needs_verification", "An uncertain activity still needs durable quarantine");
			}
			if (kind === "rollback") {
				throw fail("uncoordinated_activity", "An overlapping uncoordinated writer is registered");
			}
		}
	}

	private releaseGroup(group: LeaseGroup): void {
		for (const record of group.records) this.state.leases.delete(record.token);
		this.changed();
		this.pump();
	}

	private release(record: LeaseRecord): void {
		this.state.leases.delete(record.token);
		this.changed();
		this.pump();
	}

	private changed(): void {
		this.state.revision = next(this.state.revision);
	}

	private transaction<T>(work: (tx: QueryDb) => T): T {
		return this.db.transaction(work, { behavior: "immediate" });
	}
}

function waiterTargets(waiter: Waiter): readonly WorkspaceWriteTarget[] {
	return waiter.targets ?? [waiter.request];
}

function canStartRanges(
	state: WorkspaceWriteCoordinatorState,
	targets: readonly Pick<WorkspaceWriteTarget, "scope">[],
	earlier: readonly Waiter[],
): boolean {
	// Real scope records count against capacity, including overlapping aliases.
	if (state.leases.size + targets.length > WORKSPACE_WRITE_COORDINATOR_LIMITS.activeLeases) {
		return false;
	}
	for (const record of state.leases.values()) {
		if (targets.some((target) => overlaps(target.scope, record.scope))) return false;
	}
	// Whole-group FIFO on intersections, no head-of-line blocking disjoint devices
	// or roots. Waiting never holds even the otherwise-free members of a group.
	return !earlier.some((waiter) =>
		waiterTargets(waiter).some((waiting) =>
			targets.some((target) => overlaps(target.scope, waiting.scope)),
		),
	);
}

function copyBatchTargets(input: readonly WorkspaceWriteTarget[]): readonly WorkspaceWriteTarget[] {
	if (!Array.isArray(input)) throw fail("invalid_input", "Batch scopes must be a non-empty array");
	const length = input.length;
	assertInteger(length, "batch scope count");
	if (length === 0) throw fail("invalid_input", "Batch scopes must be a non-empty array");
	if (length > WORKSPACE_WRITE_COORDINATOR_LIMITS.batchScopes) {
		throw fail("capacity_exceeded", "Batch scope budget exceeded; the batch will NOT be split");
	}
	// Fix collection membership before reading descriptor getters; never trust an
	// overridden iterator or a growing caller array to respect the input budget.
	const entries = Array.from({ length }, (_, index) => input[index]);
	const byId = new Map<string, WorkspaceWriteTarget>();
	const runtimes = new Map<string, WorkspaceRuntimeBinding>();
	for (const target of entries) {
		if (!target || typeof target !== "object") throw fail("invalid_input", "Invalid batch target");
		const scope = copyScope(target.scope);
		const sourceRuntime = target.runtime;
		const runtime = Object.freeze({
			runtimeEpoch: sourceRuntime?.runtimeEpoch,
			runtimeGeneration: sourceRuntime?.runtimeGeneration,
		});
		assertRuntime(runtime);
		const previous = byId.get(scope.id);
		if (previous && !sameScope(previous.scope, scope)) {
			throw fail("scope_identity_mismatch", "Duplicate scope IDs have conflicting identities");
		}
		const deviceRuntime = runtimes.get(scope.deviceId);
		if (deviceRuntime && !sameRuntime(deviceRuntime, runtime)) {
			throw fail("runtime_mismatch", "Batch targets disagree on the authoritative device runtime");
		}
		runtimes.set(scope.deviceId, runtime);
		if (!previous) byId.set(scope.id, Object.freeze({ scope, runtime }));
	}
	return Object.freeze(
		[...byId.values()].sort((left, right) => {
			const key = ({ scope }: WorkspaceWriteTarget) => [
				scope.deviceId,
				scope.pathFlavor,
				pathKey(scope),
				scope.sourceInstanceId,
				scope.workspaceInstanceId,
				scope.id,
			];
			const a = key(left);
			const b = key(right);
			for (let index = 0; index < a.length; index++) {
				if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
			}
			return 0;
		}),
	);
}

type PhysicalScope = Pick<FileChangeScopeIdentity, "deviceId" | "pathFlavor" | "canonicalRoot">;
const immutablePhysicalKeys = new WeakMap<object, string>();

function pathKey(scope: Pick<PhysicalScope, "pathFlavor" | "canonicalRoot">): string {
	const cached = immutablePhysicalKeys.get(scope);
	if (cached !== undefined) return cached;
	if (scope.pathFlavor !== "posix" && scope.pathFlavor !== "windows") {
		throw fail("invalid_input", "An explicit disk path flavor is required");
	}
	assertString(scope.canonicalRoot, "canonicalRoot", FILE_CHANGE_LIMITS.metadataBytes);
	const paths = scope.pathFlavor === "windows" ? win32 : posix;
	const normalized = paths.normalize(scope.canonicalRoot);
	if (
		!paths.isAbsolute(normalized) ||
		(scope.pathFlavor === "windows" && !/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(normalized))
	) {
		throw fail("invalid_input", "Scope requires a fully qualified canonical root on its device");
	}
	const root = paths.parse(normalized).root;
	const trimmed =
		normalized.length > root.length
			? normalized.replace(scope.pathFlavor === "windows" ? /\\+$/ : /\/+$/, "")
			: normalized;
	const key = scope.pathFlavor === "windows" ? trimmed.toLowerCase() : trimmed;
	// Only immutable internal descriptors are cached; mutable caller input is copied.
	if (Object.isFrozen(scope)) immutablePhysicalKeys.set(scope, key);
	return key;
}

function containsScope(parent: PhysicalScope, child: PhysicalScope): boolean {
	if (parent.deviceId !== child.deviceId || parent.pathFlavor !== child.pathFlavor) return false;
	const a = pathKey(parent);
	const b = pathKey(child);
	const separator = parent.pathFlavor === "windows" ? "\\" : "/";
	// Keys are absolute, normalized and trailing-separator-free except at roots.
	// Component boundaries preserve both POSIX backslashes and names like ..cache.
	return a === b || b.startsWith(a.endsWith(separator) ? a : a + separator);
}

function overlaps(left: PhysicalScope, right: PhysicalScope): boolean {
	return containsScope(left, right) || containsScope(right, left);
}

/**
 * Durable recovery barriers guard a physical region, not a whole path namespace.
 * A scope root is always the nearest EXISTING parent directory of the actual
 * target file, so while a quarantined root Q still exists on disk, every file
 * under Q resolves to a root inside (or equal to) Q. A write-kind lease rooted
 * at an ANCESTOR of Q therefore touches exactly one file outside Q and can be
 * admitted; only `containsScope(blocker, target)` must block it. Rollback-kind
 * leases rewrite whole subtrees and observations read unverified state, so
 * callers pass "strict" to keep the bidirectional check for them.
 * Residual hole, accepted and documented: if Q itself was deleted, a new file
 * created under Q's old path resolves to an ancestor root and is admitted. That
 * file is self-contained new content; recovery re-observes the barrier's own
 * effect files, which new siblings never alter. Unmeasured writers (Bash) are
 * outside this barrier by design (see the class doc: NOT physical exclusion).
 */
type RecoveryBarrierMode = "write" | "strict";

function barrierBlocks(
	target: PhysicalScope,
	blocker: PhysicalScope,
	mode: RecoveryBarrierMode,
): boolean {
	return mode === "strict" ? overlaps(target, blocker) : containsScope(blocker, target);
}

function sameScope(
	left: Readonly<FileChangeScopeIdentity>,
	right: Readonly<FileChangeScopeIdentity>,
) {
	return (
		left.id === right.id &&
		left.sourceInstanceId === right.sourceInstanceId &&
		left.deviceId === right.deviceId &&
		left.workspaceInstanceId === right.workspaceInstanceId &&
		left.pathFlavor === right.pathFlavor &&
		pathKey(left) === pathKey(right)
	);
}

function copyScope(scope: Readonly<FileChangeScopeIdentity>): Readonly<FileChangeScopeIdentity> {
	if (!scope || typeof scope !== "object") throw fail("invalid_input", "Invalid scope identity");
	const copied = Object.freeze({
		id: scope.id,
		sourceInstanceId: scope.sourceInstanceId,
		deviceId: scope.deviceId,
		workspaceInstanceId: scope.workspaceInstanceId,
		pathFlavor: scope.pathFlavor,
		canonicalRoot: scope.canonicalRoot,
	});
	for (const key of ["id", "sourceInstanceId", "deviceId", "workspaceInstanceId"] as const) {
		assertString(copied[key], key, 256);
	}
	pathKey(copied);
	return copied;
}

function pendingCount(record: LeaseRecord): number {
	let count = 0;
	for (const outcome of record.mutations.values()) {
		if (outcome === "pending" || outcome === "unknown") count++;
	}
	return count;
}

function sameRuntime(a: WorkspaceRuntimeBinding, b: WorkspaceRuntimeBinding): boolean {
	return a.runtimeEpoch === b.runtimeEpoch && a.runtimeGeneration === b.runtimeGeneration;
}

function assertRuntime(runtime: WorkspaceRuntimeBinding): void {
	if (!runtime) throw fail("invalid_input", "An authoritative runtime binding is required");
	assertString(runtime.runtimeEpoch, "runtimeEpoch", 256);
	assertInteger(runtime.runtimeGeneration, "runtimeGeneration");
}

function assertString(value: string, name: string, maxBytes: number): void {
	if (
		typeof value !== "string" ||
		!value ||
		value.includes("\0") ||
		Buffer.byteLength(value) > maxBytes
	) {
		throw fail("invalid_input", `Invalid ${name}`);
	}
}

function assertInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > max) {
		throw fail("invalid_input", `Invalid ${name}`);
	}
}

function assertWaitTimeout(value: number): void {
	assertInteger(value, "waitTimeoutMs", WORKSPACE_WRITE_COORDINATOR_LIMITS.maxWaitTimeoutMs);
}

function next(value: number): number {
	assertInteger(value, "revision/fence", Number.MAX_SAFE_INTEGER - 1);
	return value + 1;
}

function scopeStatusError(status: typeof scopes.$inferSelect.status) {
	return status === "needs_verification"
		? fail("needs_verification", "Scope needs verification before a destructive operation")
		: fail("scope_inactive", "Scope is not active");
}

function fail(code: WorkspaceWriteCoordinatorErrorCode, message: string, cause?: unknown) {
	return new WorkspaceWriteCoordinatorError(code, message, cause);
}

function now(): string {
	return new Date().toISOString();
}

/**
 * The dialect-free core of the coordinator's durable sections, exported for the
 * PostgreSQL sibling (`postgres-workspace-lease-store.ts`) — and nothing else.
 *
 * Everything here is pure identity, range, barrier, validation or counter logic:
 * no SQL fragment, no drizzle object, no driver shape. The pieces that DO carry a
 * dialect (`behavior: "immediate"`, the sync `.get()/.run()/.all()` chaining) stay
 * private above; the PG store rewrites those against its own schema. The
 * in-process scheduler itself is NOT ported — see the sibling's header for why
 * its durable sections are the portable unit.
 */
export const workspaceLeaseInternals = {
	copyScope,
	sameScope,
	sameRuntime,
	barrierBlocks,
	overlaps,
	pendingCount,
	assertRuntime,
	assertString,
	assertInteger,
	assertWaitTimeout,
	next,
	scopeStatusError,
	fail,
	now,
};
