/**
 * PostgreSQL counterpart of `WorkspaceWriteCoordinator`'s durable atomic sections
 * (`workspace-write-coordinator.ts`).
 *
 * WHAT IS PORTED, AND WHAT DELIBERATELY IS NOT
 * --------------------------------------------
 * The coordinator is TWO things: an in-process range scheduler (AsyncLocalStorage
 * contexts, symbol tokens, waiter queues — a single event loop's vocabulary, with
 * nothing for a second backend to implement) and a set of short DURABLE sections
 * that pin the lease, the fence and the mutation counters into
 * `file_change_scopes`. Only the second kind is portable, and only that kind is
 * here: the durable lease store a coordinator implementation runs its sections
 * against. The SQLite coordinator runs them as strictly synchronous `behavior:
 * "immediate"` transactions because its lease API is synchronous
 * (`registerMutation`/`settle` return void); this store exposes the SAME sections
 * as honestly async operations, which is the shape a PostgreSQL-backed
 * coordinator consumes. An async scheduler built on this store is future work;
 * nothing here changes the production coordinator.
 *
 * THE SECTION CONTENT IS SHARED, THE DIALECT SHAPE IS NOT
 * -------------------------------------------------------
 * Same reads, guards and writes in the same order as the SQLite sections, with
 * the dialect pieces rewritten:
 *
 *   - `behavior: "immediate"` has no PG spelling. Every write section FIRST takes
 *     transaction advisory locks for its physical devices, then row locks, then
 *     reads and validates ownership. Device locks cover overlapping scopes even
 *     when a scope row does not yet exist. READ COMMITTED ensures the inventory
 *     read AFTER a lock wait sees the preceding owner's commit. All batch device
 *     keys and scope ids are locked in fixed order before the first state read.
 *     `readScope` is a read-only snapshot, not an ownership reservation.
 *   - `.get()/.run()/.all()` chaining → awaited statements.
 *   - the runtime-authority callback (`readRuntime`) stays caller-injected and
 *     synchronous — it is process-local authority, not database state.
 *
 * HOW THE PORT CONTRACT IS MET (see `server/db/backend/write-port.ts`)
 * --------------------------------------------------------------------
 * - PROMISE boundary: every method is honestly async end to end.
 * - ATOMICITY: each section runs in one `db.transaction`; any rejection rolls all
 *   of it back. Sections are NAMED async functions invoked through non-async
 *   arrows.
 * - RETRY: `withPgRetry` wraps BEGIN through COMMIT, including every lock and
 *   guard. Only aborted SQLSTATE sections are replayed; ambiguous connection or
 *   commit-acknowledgement failures are NOT an exactly-once claim. There are no
 *   external side effects in a section; callers publish only after resolution.
 */
import { createHash } from "node:crypto";
import { withPgRetry } from "@server/db/pg-retry";
import { fileChangeScopes as scopes } from "@server/db/postgres-schema";
import { generateId } from "@server/lib/id";
import type { FileChangeExecutionBinding } from "@shared/file-change-protocol";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { FileChangeScopeIdentity } from "./file-change-identity";
import { fileChangeExecutionBindingMatches } from "./file-change-identity";
import {
	workspaceLeaseInternals as W,
	WORKSPACE_WRITE_COORDINATOR_LIMITS,
	type WorkspaceRuntimeBinding,
	WorkspaceWriteCoordinatorError,
} from "./workspace-write-coordinator";

/** Transaction handle as produced by `db.transaction(async (tx) => …`. PG-side only. */
type Tx = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];
/** The root handle, seen through the transaction's query interface. */
type RootQueryable = Tx;

type RecoveryBarrierMode = "write" | "strict";
type ScopeStatus = "active" | "needs_verification" | "retired";

/** The hot-read scope projection the sections guard on (root identity excluded). */
export interface DurableScopeRow {
	id: string;
	sourceInstanceId: string;
	deviceId: string;
	workspaceInstanceId: string;
	canonicalRoot: string;
	pathFlavor: string;
	status: string;
	revision: number;
	fencingToken: number;
	activeLeaseId: string | null;
	activeLeaseEpoch: string | null;
	activeLeaseStartedAt: string | null;
	activeMutationCount: number;
}

/** A lease claim, exactly as the SQLite coordinator's `grant` composes it. */
export interface LeaseClaim {
	scope: Readonly<FileChangeScopeIdentity>;
	runtime: WorkspaceRuntimeBinding;
	/** Caller-supplied so a whole-section replay reclaims the SAME lease identity. */
	leaseId: string;
	kind: "write" | "rollback";
	signal?: AbortSignal;
}

/** A batch lease claim: every member checked before the first guard is written. */
export interface BatchLeaseClaim {
	targets: readonly {
		scope: Readonly<FileChangeScopeIdentity>;
		runtime: WorkspaceRuntimeBinding;
	}[];
	leaseIds: readonly string[];
	kind: "write" | "rollback";
	signal?: AbortSignal;
}

/** Durable lease state used by the settlement sections. */
export interface DurableLease {
	scope: Readonly<FileChangeScopeIdentity>;
	binding: Readonly<FileChangeExecutionBinding>;
	leaseId: string;
	revision: number;
	pendingMutations: number;
}

/**
 * The PostgreSQL durable lease store. `ownerEpoch` is the process coordination
 * epoch (same value the in-process coordinator would use); `readRuntime` is the
 * caller's synchronous runtime authority, exactly as in the SQLite coordinator.
 */
export class PostgresWorkspaceLeaseStore {
	constructor(
		private readonly database: BunSQLDatabase,
		private readonly options: {
			ownerEpoch: string;
			readRuntime: (deviceId: string) => WorkspaceRuntimeBinding | null;
		},
	) {}

	// ── in-section guards (PG spellings of the coordinator's private helpers) ──

	/**
	 * A physical device is the smallest stable domain available to this store:
	 * barrierBlocks deliberately crosses workspace/source incarnations. Neither
	 * workspaceInstanceId nor the exact canonicalRoot may partition the lock:
	 * / overlaps /work, and /work overlaps /work/sub (Windows roots/aliases too).
	 * Serializing short durable sections per device is conservative for siblings,
	 * but never serializes unrelated devices or holds a lock during filesystem I/O.
	 *
	 * No scope row is needed for the advisory lock. A newly inserted scope must
	 * still pass admission under this same domain before it can own a lease.
	 * Hash collisions only over-serialize; sorting the actual signed lock keys
	 * (not the device names) also preserves lock order in that unlikely case.
	 */
	private async lockScopes(
		tx: Tx,
		targets: readonly Readonly<FileChangeScopeIdentity>[],
		signal?: AbortSignal,
	): Promise<void> {
		if (signal?.aborted) throw W.fail("aborted", "Workspace admission cancelled");
		// Bounded waits; 55P03 retries the entire transaction, never a statement.
		await tx.execute(sql`set local lock_timeout = '2s'`);
		await tx.execute(sql`set local statement_timeout = '5s'`);
		const keys = [
			...new Set(
				targets.map((target) =>
					createHash("sha256")
						.update(JSON.stringify(["narrafork.workspace-lease.device.v1", target.deviceId]))
						.digest()
						.readBigInt64BE(),
				),
			),
		].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		for (const key of keys) {
			await tx.execute(sql`select pg_advisory_xact_lock(${key.toString()}::bigint)`);
			if (signal?.aborted) throw W.fail("aborted", "Workspace admission cancelled");
		}
		for (const id of [...new Set(targets.map((target) => target.id))].sort()) {
			await tx.select({ id: scopes.id }).from(scopes).where(eq(scopes.id, id)).for("update");
		}
	}

	private requireRuntime(deviceId: string, expected: WorkspaceRuntimeBinding): void {
		W.assertRuntime(expected);
		const current = this.options.readRuntime(deviceId);
		if (!current || !W.sameRuntime(current, expected)) {
			throw W.fail("runtime_mismatch", "Authoritative device runtime changed or is unavailable");
		}
		W.assertRuntime(current);
	}

	private async requireScope(
		tx: Tx,
		expected: Readonly<FileChangeScopeIdentity>,
	): Promise<DurableScopeRow> {
		// Deliberately exclude rootIdentityJson and presentation fields from hot reads.
		const rows = (await tx
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
			.where(eq(scopes.id, expected.id))) as DurableScopeRow[];
		const row = rows[0];
		if (!row) throw W.fail("scope_not_found", "Unknown file-change scope");
		if (!W.sameScope(expected, row as unknown as FileChangeScopeIdentity)) {
			throw W.fail(
				"scope_identity_mismatch",
				"Persisted scope no longer matches its verified identity",
			);
		}
		W.assertInteger(row.revision, "scope revision");
		W.assertInteger(row.fencingToken, "scope fencing token");
		W.assertInteger(row.activeMutationCount, "active mutation count");
		return row;
	}

	private async requireNoQuarantineMany(
		tx: Tx,
		targets: readonly Readonly<FileChangeScopeIdentity>[],
		admitting: boolean,
		mode: RecoveryBarrierMode,
	): Promise<void> {
		// One bounded global indexed status read; one bounded lease read per device.
		const blockers = (await tx
			.select({
				id: scopes.id,
				deviceId: scopes.deviceId,
				pathFlavor: scopes.pathFlavor,
				canonicalRoot: scopes.canonicalRoot,
			})
			.from(scopes)
			.where(eq(scopes.status, "needs_verification"))
			.limit(WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes + 1)) as Pick<
			DurableScopeRow,
			"id" | "deviceId" | "pathFlavor" | "canonicalRoot"
		>[];
		if (blockers.length > WORKSPACE_WRITE_COORDINATOR_LIMITS.verificationScopes) {
			throw W.fail("verification_backlog", "Recovery scope inventory exceeds the admission budget");
		}
		for (const blocker of blockers) {
			// Real uncertainty is NEVER exempted, even for a sibling in this group.
			if (
				targets.some((target) =>
					W.barrierBlocks(target, blocker as unknown as FileChangeScopeIdentity, mode),
				)
			) {
				throw W.fail(
					"needs_verification",
					`An overlapping physical scope needs verification: "${blocker.canonicalRoot}" ` +
						`(scope ${blocker.id}). An admin can recover it in ` +
						"Settings → Storage → Workspace write barriers.",
				);
			}
		}
		for (const deviceId of new Set(targets.map((target) => target.deviceId))) {
			const leased = (await tx
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
				.limit(WORKSPACE_WRITE_COORDINATOR_LIMITS.activeLeases + 1)) as (Pick<
				DurableScopeRow,
				| "id"
				| "sourceInstanceId"
				| "workspaceInstanceId"
				| "deviceId"
				| "pathFlavor"
				| "canonicalRoot"
				| "activeLeaseId"
				| "activeLeaseEpoch"
			> & { [key: string]: unknown })[];
			const additions = admitting
				? targets.filter((target) => target.deviceId === deviceId).length
				: 0;
			if (leased.length + additions > WORKSPACE_WRITE_COORDINATOR_LIMITS.activeLeases) {
				throw W.fail(
					"verification_backlog",
					"Durable lease inventory exceeds the admission budget",
				);
			}
			for (const blocker of leased) {
				if (
					targets.some((target) =>
						W.barrierBlocks(target, blocker as unknown as FileChangeScopeIdentity, mode),
					)
				) {
					// No in-memory exemption here: the durable store cannot prove a live
					// in-process token. The coordinator's OWN quarantine check (which has
					// the lease registry) layers that exemption on top; a barrier owned
					// by ANOTHER epoch — or by nobody this store can see — always blocks.
					throw W.fail(
						"needs_verification",
						`An overlapping physical scope has an unfinished lease: "${blocker.canonicalRoot}" ` +
							`(scope ${blocker.id}). An admin can recover it in ` +
							"Settings → Storage → Workspace write barriers.",
					);
				}
			}
		}
	}

	// ── the durable sections ──

	/**
	 * Claim a lease on ONE scope: the `grant` section. Checks the durable barrier
	 * inventory, then bumps fence+revision and installs the lease in one update.
	 */
	async admitLease(claim: LeaseClaim): Promise<{ fencingToken: number; revision: number }> {
		const scope = W.copyScope(claim.scope);
		return withPgRetry(
			() => this.database.transaction((tx) => this.admitLeaseSection(tx, { ...claim, scope })),
			{ label: "workspaceLease.admit" },
		);
	}

	private async admitLeaseSection(
		tx: Tx,
		claim: LeaseClaim,
	): Promise<{ fencingToken: number; revision: number }> {
		await this.lockScopes(tx, [claim.scope], claim.signal);
		const current = await this.requireScope(tx, claim.scope);
		this.requireRuntime(claim.scope.deviceId, claim.runtime);
		if (claim.signal?.aborted) throw W.fail("aborted", "Workspace admission cancelled");
		if (current.status !== "active") throw W.scopeStatusError(current.status as ScopeStatus);
		if (
			current.activeLeaseId !== null ||
			current.activeLeaseEpoch !== null ||
			current.activeLeaseStartedAt !== null ||
			current.activeMutationCount !== 0
		) {
			throw W.fail(
				"needs_verification",
				`Scope "${current.canonicalRoot}" has an unfinished durable lease from a previous ` +
					"run. An admin can recover it in Settings → Storage → Workspace write barriers.",
			);
		}
		await this.requireNoQuarantineMany(
			tx,
			[claim.scope],
			false,
			claim.kind === "write" ? "write" : "strict",
		);
		const updated = await tx
			.update(scopes)
			.set({
				fencingToken: W.next(current.fencingToken),
				revision: W.next(current.revision),
				activeLeaseId: claim.leaseId,
				activeLeaseEpoch: this.options.ownerEpoch,
				activeLeaseStartedAt: W.now(),
				activeMutationCount: 0,
				updatedAt: W.now(),
			})
			.where(eq(scopes.id, claim.scope.id))
			.returning({ fencingToken: scopes.fencingToken, revision: scopes.revision });
		const row = updated[0];
		if (!row) throw W.fail("scope_not_found", "Unknown file-change scope");
		return row;
	}

	/** The `grantMany` section: every member checked BEFORE the first guard lands. */
	async admitLeaseBatch(
		claim: BatchLeaseClaim,
	): Promise<{ fencingToken: number; revision: number }[]> {
		const targets = claim.targets.map((target) => ({
			...target,
			scope: W.copyScope(target.scope),
		}));
		return withPgRetry(
			() =>
				this.database.transaction((tx) => this.admitLeaseBatchSection(tx, { ...claim, targets })),
			{ label: "workspaceLease.admitBatch" },
		);
	}

	private async admitLeaseBatchSection(
		tx: Tx,
		claim: BatchLeaseClaim,
	): Promise<{ fencingToken: number; revision: number }[]> {
		await this.lockScopes(
			tx,
			claim.targets.map((target) => target.scope),
			claim.signal,
		);
		const current: DurableScopeRow[] = [];
		for (const target of claim.targets) {
			const row = await this.requireScope(tx, target.scope);
			this.requireRuntime(target.scope.deviceId, target.runtime);
			if (claim.signal?.aborted) throw W.fail("aborted", "Workspace admission cancelled");
			if (row.status !== "active") throw W.scopeStatusError(row.status as ScopeStatus);
			if (
				row.activeLeaseId !== null ||
				row.activeLeaseEpoch !== null ||
				row.activeLeaseStartedAt !== null ||
				row.activeMutationCount !== 0
			) {
				throw W.fail(
					"needs_verification",
					`Scope "${row.canonicalRoot}" has an unfinished durable lease from a previous ` +
						"run. An admin can recover it in Settings → Storage → Workspace write barriers.",
				);
			}
			current.push(row);
		}
		// Check the complete inventory BEFORE writing the first guard.
		await this.requireNoQuarantineMany(
			tx,
			claim.targets.map((target) => target.scope),
			true,
			claim.kind === "write" ? "write" : "strict",
		);
		const rows: { fencingToken: number; revision: number }[] = [];
		for (const [index, target] of claim.targets.entries()) {
			const leaseId = claim.leaseIds[index];
			if (!leaseId) throw W.fail("invalid_input", "Every batch member needs a lease id");
			const updated = await tx
				.update(scopes)
				.set({
					fencingToken: W.next(current[index].fencingToken),
					revision: W.next(current[index].revision),
					activeLeaseId: leaseId,
					activeLeaseEpoch: this.options.ownerEpoch,
					activeLeaseStartedAt: W.now(),
					activeMutationCount: 0,
					updatedAt: W.now(),
				})
				.where(eq(scopes.id, target.scope.id))
				.returning({ fencingToken: scopes.fencingToken, revision: scopes.revision });
			const row = updated[0];
			if (!row) throw W.fail("stale_lease", "A batch member disappeared during admission");
			rows.push(row);
		}
		return rows;
	}

	/**
	 * The durable half of the lease-ownership re-check (`requireLeaseRow`): the
	 * fence, owner, revision and mutation count must all still match the claim.
	 */
	private async requireLeaseRow(
		tx: Tx,
		lease: DurableLease,
		checkRuntime: boolean,
	): Promise<DurableScopeRow> {
		if (checkRuntime) this.requireRuntime(lease.scope.deviceId, lease.binding);
		const row = await this.requireScope(tx, lease.scope);
		if (
			row.fencingToken !== lease.binding.fencingToken ||
			row.revision !== lease.revision ||
			row.activeLeaseId !== lease.leaseId ||
			row.activeLeaseEpoch !== this.options.ownerEpoch ||
			row.activeMutationCount !== lease.pendingMutations
		) {
			throw W.fail(
				"stale_lease",
				"Scope fence, lease owner, revision or mutation count has changed",
			);
		}
		return row;
	}

	/** The `registerMutation` section: ownership re-check + counter increment. */
	async registerMutation(lease: DurableLease): Promise<void> {
		W.assertString(lease.leaseId, "leaseId", 256);
		await withPgRetry(
			() => this.database.transaction((tx) => this.registerMutationSection(tx, lease)),
			{ label: "workspaceLease.registerMutation" },
		);
	}

	private async registerMutationSection(tx: Tx, lease: DurableLease): Promise<void> {
		await this.lockScopes(tx, [lease.scope]);
		await this.requireLeaseRow(tx, lease, true);
		await tx
			.update(scopes)
			.set({ activeMutationCount: lease.pendingMutations + 1, updatedAt: W.now() })
			.where(eq(scopes.id, lease.scope.id));
	}

	/** The `settle` section: ownership re-check + counter decrement. */
	async settleMutation(lease: DurableLease): Promise<void> {
		await withPgRetry(
			() => this.database.transaction((tx) => this.settleMutationSection(tx, lease)),
			{ label: "workspaceLease.settleMutation" },
		);
	}

	private async settleMutationSection(tx: Tx, lease: DurableLease): Promise<void> {
		await this.lockScopes(tx, [lease.scope]);
		await this.requireLeaseRow(tx, lease, true);
		await tx
			.update(scopes)
			.set({ activeMutationCount: lease.pendingMutations - 1, updatedAt: W.now() })
			.where(eq(scopes.id, lease.scope.id));
	}

	/**
	 * The `persistUncertainScope` section: quarantine the scope, idempotently.
	 * No runtime/fence requirement — lost authority must still quarantine.
	 */
	async persistUncertainScope(scopeInput: Readonly<FileChangeScopeIdentity>): Promise<number> {
		const scope = W.copyScope(scopeInput);
		return withPgRetry(
			() => this.database.transaction((tx) => this.persistUncertainSection(tx, scope)),
			{ label: "workspaceLease.persistUncertain" },
		);
	}

	private async persistUncertainSection(
		tx: Tx,
		scope: Readonly<FileChangeScopeIdentity>,
	): Promise<number> {
		await this.lockScopes(tx, [scope]);
		return this.persistUncertainSectionBody(tx, scope);
	}

	private async persistUncertainSectionBody(
		tx: Tx,
		scope: Readonly<FileChangeScopeIdentity>,
	): Promise<number> {
		const row = await this.requireScope(tx, scope);
		if (row.status === "needs_verification") return row.revision;
		return this.updateScopeStatus(tx, scope.id, "needs_verification", row.revision);
	}

	/**
	 * The lease-release section (`clearLeaseInTransaction` and the single-lease
	 * finalizer): a reconnect does not prevent releasing finished, fully settled
	 * work, so the runtime check is deliberately skipped.
	 */
	async clearLease(lease: DurableLease): Promise<void> {
		await withPgRetry(() => this.database.transaction((tx) => this.clearLeaseSection(tx, lease)), {
			label: "workspaceLease.clearLease",
		});
	}

	private async clearLeaseSection(tx: Tx, lease: DurableLease): Promise<void> {
		await this.lockScopes(tx, [lease.scope]);
		await this.requireLeaseRow(tx, lease, false);
		await tx
			.update(scopes)
			.set({
				activeLeaseId: null,
				activeLeaseEpoch: null,
				activeLeaseStartedAt: null,
				activeMutationCount: 0,
				revision: W.next(lease.revision),
				updatedAt: W.now(),
			})
			.where(eq(scopes.id, lease.scope.id));
	}

	/**
	 * The batch finalizer: ALL members settle durably in one section, or every
	 * range remains a recovery hold. `uncertain` quarantines the member,
	 * `clear` releases it.
	 */
	async finalizeLeaseBatch(
		members: readonly ({ lease: DurableLease } & { uncertain: boolean })[],
	): Promise<void> {
		await withPgRetry(
			() => this.database.transaction((tx) => this.finalizeLeaseBatchSection(tx, members)),
			{ label: "workspaceLease.finalizeBatch" },
		);
	}

	private async finalizeLeaseBatchSection(
		tx: Tx,
		members: readonly ({ lease: DurableLease } & { uncertain: boolean })[],
	): Promise<void> {
		await this.lockScopes(
			tx,
			members.map((member) => member.lease.scope),
		);
		for (const member of members) {
			if (member.uncertain) {
				await this.persistUncertainSectionBody(tx, member.lease.scope);
			} else {
				await this.requireLeaseRow(tx, member.lease, false);
				await tx
					.update(scopes)
					.set({
						activeLeaseId: null,
						activeLeaseEpoch: null,
						activeLeaseStartedAt: null,
						activeMutationCount: 0,
						revision: W.next(member.lease.revision),
						updatedAt: W.now(),
					})
					.where(eq(scopes.id, member.lease.scope.id));
			}
		}
	}

	/**
	 * The `recoverScopeBarrier` section: clear ONLY the durable barrier after
	 * human-driven external recovery, bumping fence AND revision so every stale
	 * backend of the old generation stays fenced out. The in-memory lease/activity
	 * checks are the coordinator's (they need the process registry); this store
	 * enforces the durable half, including never clearing a lease owned by the
	 * CALLER's own live epoch.
	 */
	async recoverScopeBarrier(
		scopeInput: Readonly<FileChangeScopeIdentity>,
	): Promise<{ revision: number; fencingToken: number }> {
		const scope = W.copyScope(scopeInput);
		return withPgRetry(
			() => this.database.transaction((tx) => this.recoverBarrierSection(tx, scope)),
			{ label: "workspaceLease.recoverBarrier" },
		);
	}

	private async recoverBarrierSection(
		tx: Tx,
		scope: Readonly<FileChangeScopeIdentity>,
	): Promise<{ revision: number; fencingToken: number }> {
		await this.lockScopes(tx, [scope]);
		const current = await this.requireScope(tx, scope);
		const leaseBarrier = current.activeLeaseId !== null;
		if (current.status !== "needs_verification" && !leaseBarrier) {
			throw W.fail("invalid_input", "Scope has no durable recovery barrier");
		}
		if (leaseBarrier && current.activeLeaseEpoch === this.options.ownerEpoch) {
			// A lease owned by THIS live process may still be running; never clear it.
			throw W.fail("recovery_conflict", "The durable lease belongs to the live coordination epoch");
		}
		const updated = await tx
			.update(scopes)
			.set({
				status: "active",
				activeLeaseId: null,
				activeLeaseEpoch: null,
				activeLeaseStartedAt: null,
				activeMutationCount: 0,
				revision: W.next(current.revision),
				fencingToken: W.next(current.fencingToken),
				updatedAt: W.now(),
			})
			.where(eq(scopes.id, scope.id))
			.returning({ revision: scopes.revision, fencingToken: scopes.fencingToken });
		const row = updated[0];
		if (!row) throw W.fail("scope_not_found", "Unknown file-change scope");
		return row;
	}

	/** The hot-read scope projection, exposed for capture summaries. */
	async readScope(scopeInput: Readonly<FileChangeScopeIdentity>): Promise<DurableScopeRow> {
		const scope = W.copyScope(scopeInput);
		return this.requireScope(this.database as unknown as RootQueryable, scope);
	}

	private async updateScopeStatus(
		tx: Tx,
		scopeId: string,
		status: ScopeStatus,
		revision: number,
	): Promise<number> {
		const updated = await tx
			.update(scopes)
			.set({ status, revision: W.next(revision), updatedAt: W.now() })
			.where(and(eq(scopes.id, scopeId), eq(scopes.revision, revision)))
			.returning({ revision: scopes.revision });
		const row = updated[0];
		if (!row) throw W.fail("stale_lease", "Scope revision changed during settlement");
		return row.revision;
	}
}

// Re-exported so callers name the same vocabulary the SQLite coordinator produces.
export { WorkspaceWriteCoordinatorError };

/** A fresh caller-supplied lease id, the same generator the coordinator uses. */
export function newWorkspaceLeaseId(): string {
	return generateId();
}

/** Same binding comparison the coordinator's lease uses. */
export { fileChangeExecutionBindingMatches };

/**
 * Compose the store over a caller-supplied handle. Nothing here opens a
 * connection — tests and the future composition root build their own.
 */
export function createPostgresWorkspaceLeaseStore(
	database: BunSQLDatabase,
	options: {
		ownerEpoch: string;
		readRuntime: (deviceId: string) => WorkspaceRuntimeBinding | null;
	},
): PostgresWorkspaceLeaseStore {
	return new PostgresWorkspaceLeaseStore(database, options);
}
