import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

export {
	acquireFileHistoryCapture,
	type FileHistoryTarget,
	withFileHistoryCapture,
	withFileHistoryWrite,
} from "./file-history-locks";

import {
	workspaceWriteLeases as durableLeases,
	fileChangeScopes as scopes,
	workspaceExecutionOwners,
} from "@server/db/schema";
import {
	assertWorkspaceMaintenanceAuthority,
	assertWorkspaceOwnerEndedEvidence,
	type WorkspaceOwnerEndedEvidence,
} from "./workspace-execution-owner";
import {
	appendWorkspaceMutation,
	pruneWorkspaceTerminalLeases,
	readWorkspaceLeaseBarriers,
	settleWorkspaceMutation,
	type WorkspaceLeaseRow,
	type WorkspaceMutationManifest,
} from "./workspace-write-lease-store";
import {
	freezeWorkspaceRanges,
	readWorkspaceRanges,
	type WorkspaceWriteRange,
	workspaceRangesContain,
	workspaceRangesIntersect,
} from "./workspace-write-ranges";

export type { WorkspaceMutationManifest } from "./workspace-write-lease-store";
export type { WorkspaceWriteRange } from "./workspace-write-ranges";

import { hotSafe } from "@server/lib/hot-safe";
import { generateId } from "@server/lib/id";
import { FILE_CHANGE_LIMITS, type FileChangeExecutionBinding } from "@shared/file-change-protocol";
import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { SQLiteTransactionConfig } from "drizzle-orm/sqlite-core";
import {
	type FileChangeScopeIdentity,
	fileChangeExecutionBindingMatches,
} from "./file-change-identity";
import { retryWorkspaceMetadata } from "./workspace-metadata-retry";

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

type QueryDb = Pick<BunSQLiteDatabase, "select" | "insert" | "update" | "delete" | "get">;
export type WorkspaceRecoveryTransaction = QueryDb;
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
		readonly recoveryReason?: "owner_unknown",
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
	/** Frozen physical mutation bounds; omitted means the entire scope subtree. */
	ranges?: readonly WorkspaceWriteRange[];
	/** Trusted native-IO caller only; unknown execution can outlive its owning process. */
	executionClass?: "local_file_io" | "unknown";
}

export type WorkspaceWriteTarget = Readonly<
	Pick<WorkspaceWriteRequest, "scope" | "runtime" | "ranges" | "executionClass">
>;

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
	readonly leaseId: string;
	readonly ranges: readonly WorkspaceWriteRange[];
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
	registerMutation(mutationId: string, manifest?: WorkspaceMutationManifest): void;
	/** Exact pending ID plus live durable ownership; a positive total alone is insufficient. */
	assertMutationPending(mutationId: string): void;
	/** Caller supplies an authoritative outcome, not an inference from current bytes. */
	settle(mutationId: string, outcome: WorkspaceMutationOutcome): void;
	/** Commit evidence and mutation guard together; the callback must be synchronous. */
	settleWith<T>(
		mutationId: string,
		body: (tx: WorkspaceRecoveryTransaction) => { outcome: WorkspaceMutationOutcome; value: T },
	): T;
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
	readonly quarantinedLeaseCount: number;
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
	ranges: readonly WorkspaceWriteRange[];
	uncertain: boolean;
	hadActivity: boolean;
	mutations: Map<string, "pending" | WorkspaceMutationOutcome>;
	/** Stable JSON-array indexes; optional for leases spanning an in-version reload. */
	mutationIndexes?: Map<string, number>;
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
	/** Absent means a pre-persistent-range runtime; upgrading that live process is unsafe. */
	readonly persistentLeaseVersion?: 1;
	upgradeBlocked?: true;
	/** Process ownership epoch, independent of every device's execution runtime. */
	readonly ownerEpoch: string;
	readonly executionContext: AsyncLocalStorage<WorkspaceWriteLeaseToken>;
	readonly leases: Map<WorkspaceWriteLeaseToken, LeaseRecord>;
	readonly activities: Map<WorkspaceActivityToken, ActivityRecord>;
	readonly waiters: Waiter[];
	/** Optional only for a hot-safe state allocated before persistent leases. */
	recoveries?: Map<symbol, WorkspaceRecoveryInfo>;
	owners?: Set<WeakRef<WorkspaceWriteCoordinator>>;
	revision: number;
	pumping: boolean;
}

export function createWorkspaceWriteCoordinatorState(): WorkspaceWriteCoordinatorState {
	return {
		persistentLeaseVersion: 1,
		ownerEpoch: generateId(),
		executionContext: new AsyncLocalStorage(),
		leases: new Map(),
		activities: new Map(),
		waiters: [],
		recoveries: new Map(),
		revision: 0,
		pumping: false,
	};
}

export interface WorkspaceRecoveryRequest {
	scope: Readonly<FileChangeScopeIdentity>;
	leaseId?: string;
}
export interface WorkspaceRecoveryInfo {
	readonly scope: Readonly<FileChangeScopeIdentity>;
	readonly leaseId: string | null;
	readonly ranges: readonly WorkspaceWriteRange[];
	/** False for an explicitly attested legacy maintenance recovery, never forged as proof. */
	readonly executionEnded: boolean;
	readonly scopeRevision: number;
	readonly fencingToken: number;
	readonly lease: WorkspaceLeaseRow | null;
	readonly rootVerification: boolean;
	readonly initialRootVerification: boolean;
	/** Hash of the exact observed barrier, independent of unrelated B scope revisions. */
	readonly generation: string;
}
export interface WorkspaceRecoveryReservation extends WorkspaceRecoveryInfo {
	/** Revalidate a retained reservation between HTTP requests without releasing its ranges. */
	assertCurrent(): void;
	/** Synchronous evidence/audit writes and barrier clearance share this short transaction. */
	complete<T>(work: (tx: WorkspaceRecoveryTransaction) => T): T;
	release(): void;
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
		if (this.state.persistentLeaseVersion !== 1 || this.state.upgradeBlocked) {
			this.state.upgradeBlocked = true;
			const error = fail(
				"recovery_conflict",
				"Persistent-range leases require a maintenance restart after the schema migration; the previous live coordinator cannot be hot-upgraded safely",
			);
			const known = new Set([...this.state.leases.values()].map((record) => record.owner));
			for (const activity of this.state.activities.values()) known.add(activity.owner);
			for (const waiter of this.state.waiters) known.add(waiter.owner);
			const rejectAdmissions = () => {
				for (const waiter of this.state.waiters.splice(0)) {
					waiter.cleanup();
					waiter.reject(error);
				}
			};
			for (const owner of known) {
				owner.acquire = () => Promise.reject(error);
				owner.grant = () => {
					throw error;
				};
				owner.grantMany = () => {
					throw error;
				};
				owner.registerActivity = () => {
					throw error;
				};
				owner.pump = rejectAdmissions;
			}
			rejectAdmissions();
			throw error;
		}
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
			...[...(this.state.owners ?? [])].flatMap((reference) => {
				const owner = reference.deref();
				return owner ? [owner] : [];
			}),
			...Array.from(this.state.leases.values(), (record) => record.owner),
			...Array.from(this.state.activities.values(), (record) => record.owner),
			...this.state.waiters.map((waiter) => waiter.owner),
		]);
		for (const owner of owners) {
			// Preserve own DB/runtime/ALS fields, but replace EVERY callable admission
			// and activity entry point. Updating only pump allowed a stale singleton
			// to keep granting scope-only leases or start activity inside recovery.
			for (const name of Object.getOwnPropertyNames(WorkspaceWriteCoordinator.prototype)) {
				if (name === "constructor") continue;
				const descriptor = Object.getOwnPropertyDescriptor(
					WorkspaceWriteCoordinator.prototype,
					name,
				);
				if (descriptor) Object.defineProperty(owner, name, descriptor);
			}
		}
		owners.add(this);
		this.state.owners = new Set([...owners].map((owner) => new WeakRef(owner)));
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
		for (const record of group.records) record.executionEnded = true;
		try {
			// All durable settlement commits, or every range remains a recovery hold.
			await retryWorkspaceMetadata(() =>
				this.transaction((tx) => {
					for (const record of group.records) {
						this.clearLeaseInTransaction(tx, record);
					}
				}),
			);
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
				{ scope: record.scope, runtime: record.binding, ranges: record.ranges, leaseToken: token },
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
		for (const reservation of this.state.recoveries?.values() ?? []) {
			if (
				workspaceRangesIntersect(
					scope,
					freezeWorkspaceRanges(scope),
					reservation.scope,
					reservation.ranges,
				)
			)
				throw fail(
					"recovery_conflict",
					"A recovery reservation excludes new uncoordinated activity",
				);
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
		const quarantined = readWorkspaceLeaseBarriers(
			this.db,
			scope.deviceId,
			"quarantined",
			WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes,
		);
		if (!quarantined)
			throw fail("verification_backlog", "Durable quarantine inventory exceeds capture budget");
		const quarantinedLeaseCount = quarantined.filter((lease) =>
			workspaceRangesIntersect(
				scope,
				freezeWorkspaceRanges(scope),
				lease,
				readWorkspaceRanges(lease, lease.rangesJson),
			),
		).length;
		return Object.freeze({
			scopeRevision: row.revision,
			fencingToken: row.fencingToken,
			status: quarantinedLeaseCount && row.status === "active" ? "needs_verification" : row.status,
			quarantinedLeaseCount,
			durableLeasePresent: row.activeLeaseId !== null || quarantinedLeaseCount > 0,
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

	/** Metadata-only qualification; an absent registry proves end ONLY within this owner epoch. */
	/** A process-death proof only terminates controlled native IO, never a shell or unknown writer. */
	recordLocalOwnerTermination(leaseId: string, proof: WorkspaceOwnerEndedEvidence): boolean {
		assertString(leaseId, "leaseId", 256);
		assertWorkspaceMaintenanceAuthority();
		return this.transaction((tx) => {
			const lease = tx.select().from(durableLeases).where(eq(durableLeases.leaseId, leaseId)).get();
			if (!lease) throw fail("recovery_conflict", "Recovery lease disappeared");
			assertWorkspaceOwnerEndedEvidence(proof, lease.ownerEpoch);
			const owner = tx
				.select({ identity: workspaceExecutionOwners.identityJson })
				.from(workspaceExecutionOwners)
				.where(eq(workspaceExecutionOwners.ownerEpoch, lease.ownerEpoch))
				.get();
			if (!owner?.identity || JSON.stringify(owner.identity) !== JSON.stringify(proof.identity)) {
				throw fail(
					"recovery_conflict",
					"Persisted owner identity changed since termination observation",
				);
			}
			if (
				lease.deviceId !== "local" ||
				lease.executionClass !== "local_file_io" ||
				lease.ownerEpoch === this.state.ownerEpoch
			) {
				throw fail(
					"recovery_conflict",
					"Owner termination cannot acknowledge this execution class",
				);
			}
			if (lease.executionEndedAt || lease.status === "settled" || lease.status === "recovered")
				return false;
			const scopeRow = tx.select().from(scopes).where(eq(scopes.id, lease.scopeId)).get();
			if (!scopeRow) throw fail("scope_not_found", "Recovery scope disappeared");
			const scope = copyScope(scopeRow);
			const ranges = readWorkspaceRanges(lease, lease.rangesJson);
			for (const reservation of this.state.recoveries?.values() ?? []) {
				if (workspaceRangesIntersect(scope, ranges, reservation.scope, reservation.ranges)) {
					throw fail("recovery_conflict", "A recovery already holds the owner termination range");
				}
			}
			// Reuse live execution/activity checks. The capability—not a caller boolean—
			// supplies the otherwise missing proof. No filesystem operation runs here.
			this.inspectRecoveryWithAuthority({ scope, leaseId }, () => {
				assertWorkspaceMaintenanceAuthority();
				assertWorkspaceOwnerEndedEvidence(proof, lease.ownerEpoch);
			});
			const timestamp = now();
			const updated = tx
				.update(durableLeases)
				.set({
					status: "quarantined",
					executionEndedAt: timestamp,
					updatedAt: timestamp,
					terminationEvidenceJson: {
						version: 1,
						kind: "owner_ended",
						ownerEpoch: lease.ownerEpoch,
						reason: proof.reason,
						observedAt: proof.observedAt,
					},
				})
				.where(
					and(
						eq(durableLeases.leaseId, leaseId),
						eq(durableLeases.ownerEpoch, lease.ownerEpoch),
						eq(durableLeases.status, lease.status),
					),
				)
				.returning({ id: durableLeases.leaseId })
				.get();
			if (!updated)
				throw fail("recovery_conflict", "Lease changed during owner termination acknowledgement");
			if (scopeRow.activeLeaseId === leaseId) this.clearRecoveredScope(tx, scope, scopeRow, true);
			return true;
		});
	}
	inspectRecovery(input: WorkspaceRecoveryRequest): WorkspaceRecoveryInfo {
		return this.inspectRecoveryWithAuthority(input);
	}

	private inspectRecoveryWithAuthority(
		input: WorkspaceRecoveryRequest,
		maintenanceAuthority?: () => void,
	): WorkspaceRecoveryInfo {
		maintenanceAuthority?.();
		const scope = copyScope(input.scope);
		if (maintenanceAuthority && scope.deviceId !== "local") {
			throw fail("recovery_conflict", "Maintenance recovery requires a local workspace");
		}
		const current = this.requireScope(this.db, scope);
		const leaseId = input.leaseId ?? current.activeLeaseId;
		const lease = leaseId
			? (this.db.select().from(durableLeases).where(eq(durableLeases.leaseId, leaseId)).get() ??
				null)
			: null;
		if (
			lease &&
			(lease.scopeId !== scope.id ||
				lease.deviceId !== scope.deviceId ||
				lease.pathFlavor !== scope.pathFlavor ||
				!["executing", "quarantined"].includes(lease.status))
		)
			throw fail("recovery_conflict", "Lease is not a matching recovery barrier");
		if (input.leaseId && !lease && current.activeLeaseId !== input.leaseId)
			throw fail("recovery_conflict", "Unknown recovery lease");
		// Legacy maintenance reserves the whole root, not only the displayed effect.
		const ranges =
			lease && !maintenanceAuthority
				? readWorkspaceRanges(lease, lease.rangesJson)
				: freezeWorkspaceRanges(scope);
		for (const record of this.state.leases.values()) {
			if (
				record.leaseId === leaseId ||
				workspaceRangesIntersect(
					scope,
					ranges,
					record.scope,
					record.ranges ?? freezeWorkspaceRanges(record.scope),
				)
			)
				throw fail(
					"recovery_conflict",
					"A registered execution or persistence hold covers the recovery range",
				);
		}
		for (const record of this.state.activities.values()) {
			if (
				workspaceRangesIntersect(scope, ranges, record.scope, freezeWorkspaceRanges(record.scope))
			)
				throw fail("recovery_conflict", "A registered activity covers the recovery range");
		}
		if (!lease && !current.activeLeaseId && current.status !== "needs_verification")
			throw fail("invalid_input", "Scope has no recovery barrier");
		const rootIdentity =
			!lease || maintenanceAuthority
				? this.db
						.select({ rootIdentityJson: scopes.rootIdentityJson })
						.from(scopes)
						.where(eq(scopes.id, scope.id))
						.get()?.rootIdentityJson
				: undefined;
		const initialRootVerification =
			!lease &&
			current.status === "needs_verification" &&
			rootIdentity === null &&
			current.activeLeaseId === null &&
			current.activeLeaseEpoch === null &&
			current.activeLeaseStartedAt === null &&
			current.activeMutationCount === 0;
		if (initialRootVerification) {
			const legacy = this.db
				.select({
					deviceId: scopes.deviceId,
					pathFlavor: scopes.pathFlavor,
					canonicalRoot: scopes.canonicalRoot,
				})
				.from(scopes)
				.where(
					and(
						eq(scopes.deviceId, scope.deviceId),
						ne(scopes.id, scope.id),
						or(isNotNull(scopes.activeLeaseId), eq(scopes.status, "needs_verification")),
					),
				)
				.limit(WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes + 1)
				.all();
			if (
				legacy.length > WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes ||
				legacy.some((blocker) => overlaps(scope, blocker))
			)
				throw fail(
					"recovery_conflict",
					"Initial root verification overlaps a legacy scope barrier",
				);
			for (const status of ["executing", "quarantined"] as const) {
				const blockers = readWorkspaceLeaseBarriers(
					this.db,
					scope.deviceId,
					status,
					WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes,
				);
				if (
					!blockers ||
					blockers.some((blocker) =>
						workspaceRangesIntersect(
							scope,
							ranges,
							blocker,
							readWorkspaceRanges(blocker, blocker.rangesJson),
						),
					)
				)
					throw fail(
						"recovery_conflict",
						"Initial root verification overlaps durable execution evidence",
					);
			}
		}
		const epoch = lease?.ownerEpoch ?? current.activeLeaseEpoch;
		const executionEnded =
			initialRootVerification || !!lease?.executionEndedAt || epoch === this.state.ownerEpoch;
		if (!executionEnded && !maintenanceAuthority)
			throw new WorkspaceWriteCoordinatorError(
				"recovery_conflict",
				"A different or unknown owner epoch is not proof that execution ended",
				undefined,
				"owner_unknown",
			);
		if (lease) {
			lease.rangesJson = Object.freeze({ version: 1, ranges });
			lease.mutationManifestJson = Object.freeze({
				version: 1,
				mutations: Object.freeze(
					lease.mutationManifestJson.mutations.map((mutation) => Object.freeze({ ...mutation })),
				),
			});
			Object.freeze(lease);
		}
		const generation = createHash("sha256")
			.update(
				JSON.stringify(
					maintenanceAuthority
						? { lease, current, rootIdentity }
						: (lease ?? { ...current, rootIdentity }),
				),
			)
			.digest("hex");
		return Object.freeze({
			scope,
			leaseId,
			ranges,
			lease,
			executionEnded,
			scopeRevision: current.revision,
			fencingToken: current.fencingToken,
			rootVerification: current.status === "needs_verification",
			initialRootVerification,
			generation,
		});
	}

	reserveRecovery(input: WorkspaceRecoveryRequest): WorkspaceRecoveryReservation {
		return this.reserveRecoveryWithAuthority(input);
	}

	/** Server-only maintenance capability. It cannot override a live execution or persistence hold. */
	reserveMaintenance(
		input: WorkspaceRecoveryRequest,
		assertAuthority: () => void,
	): WorkspaceRecoveryReservation {
		if (typeof assertAuthority !== "function")
			throw fail("invalid_input", "Maintenance requires a trusted authority check");
		return this.reserveRecoveryWithAuthority(input, assertAuthority);
	}

	private reserveRecoveryWithAuthority(
		input: WorkspaceRecoveryRequest,
		maintenanceAuthority?: () => void,
	): WorkspaceRecoveryReservation {
		const info = this.inspectRecoveryWithAuthority(input, maintenanceAuthority);
		const scope = info.scope;
		const recoveryRequest = Object.freeze({ scope, leaseId: info.leaseId ?? undefined });
		this.state.recoveries ??= new Map();
		const reservations = this.state.recoveries;
		if (reservations.size >= WORKSPACE_WRITE_COORDINATOR_LIMITS.activeLeases)
			throw fail("capacity_exceeded", "Recovery reservation budget exceeded");
		for (const other of reservations.values()) {
			if (workspaceRangesIntersect(info.scope, info.ranges, other.scope, other.ranges))
				throw fail("recovery_conflict", "Recovery range is already reserved");
		}
		const token = Symbol("workspace-recovery");
		reservations.set(token, info);
		this.changed();
		const release = () => {
			if (reservations.delete(token)) {
				this.changed();
				this.pump();
			}
		};
		const assertCurrent = () => {
			if (!reservations.has(token))
				throw fail("recovery_conflict", "Recovery reservation was released");
			const fresh = this.inspectRecoveryWithAuthority(recoveryRequest, maintenanceAuthority);
			if (fresh.generation !== info.generation) {
				throw fail("recovery_conflict", "Recovery barrier changed since reservation");
			}
		};
		return Object.freeze({
			...info,
			release,
			assertCurrent,
			complete: <T>(work: (tx: WorkspaceRecoveryTransaction) => T): T => {
				const client = (
					this.db as WorkspaceWriteCoordinatorDb & { $client?: { inTransaction: boolean } }
				).$client;
				if (client?.inTransaction)
					throw fail(
						"recovery_conflict",
						"Recovery must own the outermost transaction; releasing a reservation at a savepoint would pump before commit",
					);
				if (!reservations.has(token))
					throw fail("recovery_conflict", "Recovery reservation was released");
				const result = this.transaction((tx) => {
					const fresh = this.inspectRecoveryWithAuthority(recoveryRequest, maintenanceAuthority);
					if (fresh.generation !== info.generation)
						throw fail("recovery_conflict", "Recovery barrier changed since reservation");
					const value = work(tx);
					if (value instanceof Promise)
						throw fail("invalid_input", "Recovery transaction callback must be synchronous");
					maintenanceAuthority?.();
					if (info.lease) {
						const recovered = tx
							.update(durableLeases)
							.set({
								status: "recovered",
								executionEndedAt:
									info.lease.executionEndedAt ?? (info.executionEnded ? now() : null),
								updatedAt: now(),
							})
							.where(
								and(
									eq(durableLeases.leaseId, info.lease.leaseId),
									eq(durableLeases.status, info.lease.status),
								),
							)
							.returning({ id: durableLeases.leaseId })
							.get();
						if (!recovered) throw fail("recovery_conflict", "Recovery lease changed");
						// A quarantined A is detached: never touch a concurrently executing B's fence/count.
						const scopeRow = this.requireScope(tx, scope);
						if (scopeRow.activeLeaseId === info.leaseId)
							this.clearRecoveredScope(tx, scope, scopeRow, true);
					} else {
						const scopeRow = this.requireScope(tx, scope);
						if (info.initialRootVerification) {
							const verified = tx
								.select({ rootIdentityJson: scopes.rootIdentityJson })
								.from(scopes)
								.where(eq(scopes.id, scope.id))
								.get();
							if (scopeRow.status !== "active" || !verified?.rootIdentityJson)
								throw fail(
									"recovery_conflict",
									"Initial root recovery requires explicit verified root identity in this transaction",
								);
						}
						this.clearRecoveredScope(tx, scope, scopeRow);
					}
					return value;
				});
				release(); // Only after the enclosing immediate transaction committed.
				return result;
			},
		});
	}

	private clearRecoveredScope(
		tx: QueryDb,
		scope: Readonly<FileChangeScopeIdentity>,
		row: ReturnType<WorkspaceWriteCoordinator["requireScope"]>,
		preserveStatus = false,
	): void {
		tx.update(scopes)
			.set({
				status: preserveStatus ? row.status : "active",
				activeLeaseId: null,
				activeLeaseEpoch: null,
				activeLeaseStartedAt: null,
				activeMutationCount: 0,
				revision: next(row.revision),
				fencingToken: next(row.fencingToken),
				updatedAt: now(),
			})
			.where(
				and(
					eq(scopes.id, scope.id),
					eq(scopes.revision, row.revision),
					eq(scopes.fencingToken, row.fencingToken),
				),
			)
			.run();
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
		const reservation = this.reserveRecovery({ scope });
		try {
			reservation.complete(() => undefined);
			const row = this.requireScope(this.db, scope);
			return { revision: row.revision, fencingToken: row.fencingToken };
		} finally {
			reservation.release();
		}
	}

	/**
	 * Retry ONLY a failed quarantine write after the execution body has ended.
	 * This cannot resume IO, clear needs_verification, or reuse an old fence.
	 */
	/** Retry ended metadata holds only. Never restart a body or drop an unpersisted range. */
	async retryFinishedPersistence(
		scopeInput: Readonly<FileChangeScopeIdentity>,
	): Promise<{ retried: number; remaining: number }> {
		const scope = copyScope(scopeInput);
		this.requireScope(this.db, scope);
		const matches = (record: LeaseRecord) =>
			record.executionEnded &&
			record.persistencePending &&
			workspaceRangesIntersect(
				scope,
				freezeWorkspaceRanges(scope),
				record.scope,
				record.ranges ?? freezeWorkspaceRanges(record.scope),
			);
		const records = [...this.state.leases.values()]
			.filter(matches)
			.slice(0, WORKSPACE_WRITE_COORDINATOR_LIMITS.batchScopes);
		const processed = new Set<WorkspaceWriteLeaseToken>();
		const deadline = performance.now() + 2_000;
		let retried = 0;
		for (const record of records) {
			if (processed.has(record.token) || performance.now() >= deadline) continue;
			const members = record.group?.records ?? [record];
			if (members.some((member) => !member.executionEnded || !member.persistencePending)) {
				throw fail(
					"recovery_conflict",
					"Only an entirely ended batch can retry metadata finalization",
				);
			}
			await retryWorkspaceMetadata(
				() =>
					record.owner.transaction((tx) => {
						for (const member of members) record.owner.clearLeaseInTransaction(tx, member);
					}),
				{ deadline },
			);
			for (const member of members) {
				member.persistencePending = false;
				processed.add(member.token);
			}
			if (record.group) record.owner.releaseGroup(record.group);
			else record.owner.release(record);
			retried += members.length;
		}
		return { retried, remaining: [...this.state.leases.values()].filter(matches).length };
	}
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
		this.transaction((tx) => this.clearLeaseInTransaction(tx, record, true));
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
				this.clearLeaseInTransaction(tx, record, true);
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
			ranges: copyRanges(input.scope, input.ranges),
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
				!workspaceRangesContain(
					record.scope,
					record.ranges ?? freezeWorkspaceRanges(record.scope),
					request.ranges ?? freezeWorkspaceRanges(request.scope),
				) ||
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
		// IO really ended; keep the range registered during metadata backoff, but
		// prevent a retained token from dispatching fresh work in that async gap.
		record.executionEnded = true;
		try {
			await retryWorkspaceMetadata(() =>
				this.transaction((tx) => this.clearLeaseInTransaction(tx, record)),
			);
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
				: this.canStart(request.scope, this.state.waiters, request.ranges)
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

	private canStart(
		scope: Readonly<FileChangeScopeIdentity>,
		earlier: readonly Waiter[],
		ranges?: readonly WorkspaceWriteRange[],
	): boolean {
		return canStartRanges(this.state, [{ scope, ranges }], earlier);
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
			this.requireNoQuarantine(
				tx,
				request.scope,
				undefined,
				kind === "write" ? "write" : "strict",
				request.ranges,
			);
			const granted = tx
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
			this.persistAdmission(tx, request, leaseId, granted);
			return granted;
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
				targets.map((target) => target.ranges ?? freezeWorkspaceRanges(target.scope)),
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
				this.persistAdmission(tx, target, leaseId, row);
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

	private persistAdmission(
		tx: QueryDb,
		request: WorkspaceWriteTarget,
		leaseId: string,
		row: { fencingToken: number; revision: number },
	): void {
		if (
			request.executionClass !== undefined &&
			request.executionClass !== "unknown" &&
			(request.executionClass !== "local_file_io" || request.scope.deviceId !== "local")
		) {
			throw fail("invalid_input", "Native file IO classification requires a local execution");
		}
		const timestamp = now();
		tx.insert(durableLeases)
			.values({
				leaseId,
				scopeId: request.scope.id,
				deviceId: request.scope.deviceId,
				ownerEpoch: this.state.ownerEpoch,
				executionClass: request.executionClass ?? "unknown",
				runtimeEpoch: request.runtime.runtimeEpoch,
				runtimeGeneration: request.runtime.runtimeGeneration,
				fencingToken: row.fencingToken,
				scopeRevision: row.revision,
				pathFlavor: request.scope.pathFlavor,
				status: "executing",
				rangesJson: { version: 1, ranges: request.ranges ?? freezeWorkspaceRanges(request.scope) },
				mutationManifestJson: { version: 1, mutations: [] },
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.run();
		pruneWorkspaceTerminalLeases(tx);
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
			ranges: request.ranges ?? freezeWorkspaceRanges(request.scope),
			uncertain: false,
			hadActivity: this.hasActivity(request.scope),
			mutations: new Map(),
			mutationIndexes: new Map(),
			children: new Set(),
			closing: false,
			executionEnded: false,
			persistencePending: false,
		} as Omit<LeaseRecord, "lease"> as LeaseRecord;
		record.lease = Object.freeze({
			leaseId,
			ranges: record.ranges,
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
					record.ranges,
				);
			},
			registerMutation: (id: string, manifest?: WorkspaceMutationManifest) =>
				this.registerMutation(record, id, manifest),
			assertMutationPending: (id: string) => {
				assertString(id, "mutationId", 256);
				record.lease.assertCurrent();
				if (record.mutations.get(id) !== "pending") {
					throw fail("mutation_conflict", "Mutation is not pending on this lease");
				}
			},
			settle: (id: string, outcome: WorkspaceMutationOutcome) => this.settle(record, id, outcome),
			settleWith: <T>(
				id: string,
				body: (tx: WorkspaceRecoveryTransaction) => { outcome: WorkspaceMutationOutcome; value: T },
			) => this.settleWith(record, id, body),
			markUncertain: () => {
				this.requireLive(record);
				record.uncertain = true;
				// Admission already durably guards this execution; do not conflate an
				// unknown mutation with root/activity identity verification.
				this.transaction((tx) => {
					this.requireLeaseRow(tx, record, false);
					tx.update(durableLeases)
						.set({ updatedAt: now() })
						.where(eq(durableLeases.leaseId, record.leaseId))
						.run();
				});
			},
		});
		return record;
	}

	private registerMutation(
		record: LeaseRecord,
		id: string,
		manifest?: WorkspaceMutationManifest,
	): void {
		assertString(id, "mutationId", 256);
		this.requireLive(record);
		if (record.mutations.has(id)) throw fail("mutation_conflict", "Mutation ID was already used");
		if (record.mutations.size >= WORKSPACE_WRITE_COORDINATOR_LIMITS.mutationsPerLease) {
			throw fail("capacity_exceeded", "Lease mutation budget exceeded");
		}
		record.lease.assertCurrent();
		this.transaction((tx) => {
			this.requireLeaseRow(tx, record);
			appendWorkspaceMutation(tx, record.leaseId, id, manifest, record.mutations.size);
			this.updateMutationCount(tx, record, pendingCount(record) + 1);
		});
		record.mutationIndexes?.set(id, record.mutations.size);
		record.mutations.set(id, "pending");
		this.changed();
	}

	private settle(record: LeaseRecord, id: string, outcome: WorkspaceMutationOutcome): void {
		this.settleWith(record, id, () => ({ outcome, value: undefined }));
	}

	private settleWith<T>(
		record: LeaseRecord,
		id: string,
		body: (tx: WorkspaceRecoveryTransaction) => { outcome: WorkspaceMutationOutcome; value: T },
	): T {
		this.requireLive(record);
		if (record.mutations.get(id) !== "pending") {
			throw fail("mutation_conflict", "Mutation is not pending on this lease");
		}
		// Updating the in-memory manifest before the OUTER commit would leave it ahead
		// of a rolled-back evidence transaction and prevent a safe metadata-only retry.
		const client = (
			this.db as WorkspaceWriteCoordinatorDb & { $client?: { inTransaction: boolean } }
		).$client;
		if (client?.inTransaction) {
			throw fail("invalid_input", "Mutation settlement must own the outermost transaction");
		}
		const result = this.transaction((tx) => {
			// This is an immutable result for already-dispatched IO, not new execution.
			// A device reconnect cannot invalidate its journal settlement; durable
			// scope/fence/lease ownership is still checked against the original binding.
			this.requireLeaseRow(tx, record, false);
			const settled = body(tx);
			if (
				settled instanceof Promise ||
				!settled ||
				!["applied", "not_applied", "unknown"].includes(settled.outcome)
			) {
				throw fail("invalid_input", "Settlement requires a synchronous authoritative outcome");
			}
			settleWorkspaceMutation(
				tx,
				record.leaseId,
				id,
				settled.outcome,
				record.mutationIndexes?.get(id) ?? [...record.mutations.keys()].indexOf(id),
			);
			if (settled.outcome !== "unknown")
				this.updateMutationCount(tx, record, pendingCount(record) - 1);
			return settled;
		});
		if (result.outcome === "unknown") record.uncertain = true;
		record.mutations.set(id, result.outcome);
		this.changed();
		return result.value;
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
		ranges?: readonly WorkspaceWriteRange[],
	): void {
		this.requireNoQuarantineMany(tx, [scope], owner, false, mode, [
			ranges ?? freezeWorkspaceRanges(scope),
		]);
	}

	private requireNoQuarantineMany(
		tx: QueryDb,
		targets: readonly Readonly<FileChangeScopeIdentity>[],
		owner?: LeaseRecord,
		admitting = false,
		_mode: RecoveryBarrierMode = "strict",
		targetRanges: readonly (readonly WorkspaceWriteRange[])[] = targets.map((target) =>
			freezeWorkspaceRanges(target),
		),
	): void {
		const intersects = (blocker: PhysicalScope) =>
			targets.some((target, index) =>
				workspaceRangesIntersect(target, targetRanges[index], blocker, [
					{ kind: "subtree", canonicalPath: blocker.canonicalRoot },
				]),
			);
		for (const deviceId of new Set(targets.map((target) => target.deviceId))) {
			for (const status of ["executing", "quarantined"] as const) {
				const barriers = readWorkspaceLeaseBarriers(
					tx,
					deviceId,
					status,
					WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes,
				);
				if (!barriers)
					throw fail(
						"verification_backlog",
						"Durable execution inventory exceeds the admission budget",
					);
				for (const barrier of barriers) {
					const ranges = readWorkspaceRanges(barrier, barrier.rangesJson);
					if (
						!targets.some((target, index) =>
							workspaceRangesIntersect(target, targetRanges[index], barrier, ranges),
						)
					)
						continue;
					const members = owner?.group?.records ?? (owner ? [owner] : []);
					const owned =
						status === "executing" &&
						members.some(
							(member) =>
								!member.executionEnded &&
								!member.uncertain &&
								this.state.leases.get(member.token) === member &&
								member.leaseId === barrier.leaseId &&
								member.scope.id === barrier.scopeId &&
								member.binding.deviceId === barrier.deviceId &&
								barrier.ownerEpoch === this.state.ownerEpoch,
						);
					if (!owned)
						throw fail(
							"needs_verification",
							`An overlapping workspace lease needs verification: ${barrier.leaseId}`,
						);
				}
			}
		}
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
			if (intersects(blocker)) {
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
				if (!intersects(blocker)) continue;
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

	private clearLeaseInTransaction(tx: QueryDb, record: LeaseRecord, forceQuarantine = false): void {
		// The caller has joined the body AND every child/IO. Do not infer this from
		// pending count, a runtime disconnect, a timeout, or an empty scheduler.
		const row = this.requireScope(tx, record.scope);
		if (
			this.state.leases.get(record.token) !== record ||
			row.activeLeaseId !== record.leaseId ||
			row.activeLeaseEpoch !== this.state.ownerEpoch ||
			row.revision !== record.revision ||
			row.fencingToken !== record.binding.fencingToken ||
			row.activeMutationCount !== pendingCount(record)
		)
			throw fail("stale_lease", "Durable finalization ownership changed");
		if (!record.ranges) {
			// Hot-safe v1 records were admitted before immutable ranges existed.
			// Never fabricate narrower evidence or detach their unknown outcome.
			if (forceQuarantine || record.uncertain || pendingCount(record) > 0) {
				this.persistUncertainScopeInTransaction(tx, record.scope);
				return;
			}
			tx.update(scopes)
				.set({
					activeLeaseId: null,
					activeLeaseEpoch: null,
					activeLeaseStartedAt: null,
					activeMutationCount: 0,
					revision: next(row.revision),
					updatedAt: now(),
				})
				.where(and(eq(scopes.id, record.scope.id), eq(scopes.activeLeaseId, record.leaseId)))
				.run();
			return;
		}
		const timestamp = now();
		const finished = tx
			.update(durableLeases)
			.set({
				status:
					forceQuarantine || record.uncertain || pendingCount(record) > 0
						? "quarantined"
						: "settled",
				executionEndedAt: timestamp,
				updatedAt: timestamp,
			})
			.where(
				and(
					eq(durableLeases.leaseId, record.leaseId),
					eq(durableLeases.status, "executing"),
					eq(durableLeases.ownerEpoch, this.state.ownerEpoch),
				),
			)
			.returning({ id: durableLeases.leaseId })
			.get();
		if (!finished) throw fail("stale_lease", "Durable execution lease disappeared");
		// Crucially, leave scope.status/root verification untouched: unknown Bash
		// activity or a separately invalidated root must not be laundered as active.
		tx.update(scopes)
			.set({
				activeLeaseId: null,
				activeLeaseEpoch: null,
				activeLeaseStartedAt: null,
				activeMutationCount: 0,
				revision: next(row.revision),
				updatedAt: timestamp,
			})
			.where(
				and(
					eq(scopes.id, record.scope.id),
					eq(scopes.activeLeaseId, record.leaseId),
					eq(scopes.revision, row.revision),
				),
			)
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

function copyRanges(
	scope: Readonly<FileChangeScopeIdentity>,
	ranges?: readonly WorkspaceWriteRange[],
): readonly WorkspaceWriteRange[] {
	try {
		return freezeWorkspaceRanges(scope, ranges);
	} catch (cause) {
		throw fail("invalid_input", "Invalid workspace mutation ranges", cause);
	}
}

function waiterTargets(waiter: Waiter): readonly WorkspaceWriteTarget[] {
	return waiter.targets ?? [waiter.request];
}

function canStartRanges(
	state: WorkspaceWriteCoordinatorState,
	targets: readonly Pick<WorkspaceWriteTarget, "scope" | "ranges">[],
	earlier: readonly Waiter[],
): boolean {
	// Real scope records count against capacity, including overlapping aliases.
	if (state.leases.size + targets.length > WORKSPACE_WRITE_COORDINATOR_LIMITS.activeLeases) {
		return false;
	}
	for (const record of state.leases.values()) {
		if (targets.some((target) => overlaps(target.scope, record.scope))) return false;
	}
	for (const reservation of state.recoveries?.values() ?? []) {
		if (
			targets.some((target) =>
				workspaceRangesIntersect(
					target.scope,
					target.ranges ?? freezeWorkspaceRanges(target.scope),
					reservation.scope,
					reservation.ranges,
				),
			)
		)
			return false;
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
		const ranges = copyRanges(scope, target.ranges);
		if (
			previous &&
			(!workspaceRangesContain(scope, previous.ranges ?? freezeWorkspaceRanges(scope), ranges) ||
				!workspaceRangesContain(scope, ranges, previous.ranges ?? freezeWorkspaceRanges(scope)))
		)
			throw fail("invalid_input", "Duplicate scope IDs have conflicting ranges");
		const executionClass = target.executionClass ?? "unknown";
		if (previous && previous.executionClass !== executionClass) {
			throw fail("invalid_input", "Duplicate scope IDs have conflicting execution classes");
		}
		if (!previous) byId.set(scope.id, Object.freeze({ scope, runtime, ranges, executionClass }));
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

/** Legacy scope-only callers are conservative in BOTH directions. Actual files
 * use immutable range intersection above; a scope identity is not a write range. */
type RecoveryBarrierMode = "write" | "strict";

function barrierBlocks(
	target: PhysicalScope,
	blocker: PhysicalScope,
	_mode: RecoveryBarrierMode,
): boolean {
	return overlaps(target, blocker);
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
		? fail(
				"needs_verification",
				"Scope needs verification before a destructive operation. Check Settings → Storage → Workspace write barriers for the affected scope, recovery or administrator maintenance; retrying the edit does not clear this barrier.",
			)
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
