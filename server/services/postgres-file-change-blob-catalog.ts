/**
 * PostgreSQL counterpart of `FileChangeBlobCatalog`'s atomic write sections
 * (`file-change-blob-catalog.ts`).
 *
 * WHY A SIBLING, NOT A FLAG
 * -------------------------
 * The SQLite catalog is strictly synchronous: `reserve` returns a lease whose
 * `release` runs two short transactions INLINE. A networked driver cannot satisfy
 * that — so the PostgreSQL counterpart is its own module with honestly async
 * methods (including an async `release` on the lease), sharing with the SQLite
 * catalog the section CONTENT and the dialect-free core (`blobCatalogInternals`:
 * validation, outcome checks, storage keys, generation arithmetic). What is
 * rewritten here is the dialect shape:
 *
 *   - the constructor's `PRAGMA busy_timeout` / `PRAGMA foreign_keys` checks have
 *     no PG counterpart. Foreign keys are always enforced; a multi-second busy
 *     handler is precisely what the main-thread performance rules forbid, and the
 *     contention answer on a networked engine is the whole-section retry, not a
 *     blocking wait. "Root connection, no ambient transaction" is structural:
 *     every method opens its OWN `db.transaction` through `withPgRetry`.
 *   - `behavior: "immediate"` is a SQLite lock-level hint with no PG spelling;
 *     every PG transaction takes its row locks as it goes, which is why the
 *     budget row is re-read inside each section before being updated.
 *   - `.get()/.run()/.all()` chaining → awaited statements; `.onConflictDoUpdate`
 *     is shared drizzle vocabulary and stays.
 *
 * HOW THE PORT CONTRACT IS MET (see `server/db/backend/write-port.ts`)
 * --------------------------------------------------------------------
 * - PROMISE boundary: every method is honestly async end to end.
 * - ATOMICITY: each section runs in one `db.transaction`; any rejection rolls all
 *   of it back. Sections are NAMED async functions invoked through non-async
 *   arrows.
 * - RETRY: `withPgRetry` wraps the WHOLE section. Sections are idempotent under
 *   replay: generation fencing re-reads the budget row inside the section, the
 *   reservation release is a two-transaction intent-then-settle pair whose second
 *   pass is a no-op once settled, and `reconcileBlob` upserts by digest — a replay
 *   after a lost commit acknowledgement repeats nothing.
 * - CONFLICTS: the generation fence rejects with the same
 *   `FileChangeBlobCatalogError` codes the SQLite catalog produces, never a
 *   driver error.
 */
import { withPgRetry } from "@server/db/pg-retry";
import {
	fileChangeBlobs as blobs,
	fileChangeStorageBudgets as budgets,
	fileChangeBlobReservations as reservations,
} from "@server/db/postgres-schema";
import { generateId } from "@server/lib/id";
import { FILE_CHANGE_LIMITS, type FileChangeBlobRef } from "@shared/file-change-protocol";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import {
	blobCatalogInternals as B,
	FILE_CHANGE_BLOB_BUDGET_ID,
	FileChangeBlobCatalogError,
} from "./file-change-blob-catalog";
import type { FileChangeBlobAdmission, FileChangeBlobRelease } from "./file-change-blob-store";

/** Transaction handle as produced by `db.transaction(async (tx) => …`. PG-side only. */
type Tx = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];
/**
 * Row shapes are typed against the SQLITE schema's inference DELIBERATELY (see
 * `postgres-revert-plan-store.ts` for the full argument): the two schemas hold the
 * same application values, and `blobCatalogInternals` is typed against the SQLite
 * rows. The PG driver's results are cast at the query boundary.
 */
type BudgetRecord = typeof import("../db/schema").fileChangeStorageBudgets["$inferSelect"];
type BlobRecord = typeof import("../db/schema").fileChangeBlobs["$inferSelect"];
type ReservationRecord = typeof import("../db/schema").fileChangeBlobReservations["$inferSelect"];

type Access = {
	expectedGeneration: number;
	mode: "writer" | "maintenance";
};
type ReservationCursor = { createdAt: string; id: string };

export interface PostgresBlobReservationToken {
	reservationId: string;
	ownerEpoch: string;
	generation: number;
}

/**
 * The PG lease: same token and outcome vocabulary as the SQLite lease, with an
 * honestly ASYNC `release` (the only shape a networked driver can honour). The
 * different signature is the whole reason this module is a sibling rather than a
 * flag on the SQLite class.
 */
export interface PostgresBlobCatalogLease extends PostgresBlobReservationToken {
	release(input: FileChangeBlobRelease): Promise<void>;
}

/**
 * The PostgreSQL blob catalog. Same `namespaceKey` binding as the SQLite catalog;
 * `database` must be a ROOT handle — sections open their own transactions.
 */
export class PostgresFileChangeBlobCatalog {
	private readonly db: BunSQLDatabase;
	private readonly namespaceKey: string;

	constructor(options: { db: BunSQLDatabase; namespaceKey: string }) {
		B.assertKey(options.namespaceKey, "namespaceKey");
		this.db = options.db;
		this.namespaceKey = options.namespaceKey;
		// No PRAGMA checks here — see the header. The invariants those checks pinned
		// (FKs on, no multi-second blocking waits) are the engine's defaults on PG.
	}

	/** Bounded metadata only; null means initialization has not happened. */
	async getBudget(): Promise<Readonly<BudgetRecord> | null> {
		const rows = (await this.db
			.select()
			.from(budgets)
			.where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID))) as BudgetRecord[];
		const row = rows[0];
		if (!row) return null;
		this.checkBudget(row);
		return Object.freeze(row);
	}

	/** null explicitly means a new namespace. Reinitialization retains ALL counters. */
	async initializeNamespace(input: {
		expectedGeneration: number | null;
		quotaBytes?: number;
	}): Promise<Readonly<BudgetRecord>> {
		if (input.expectedGeneration !== null) B.assertNumber(input.expectedGeneration, "generation");
		if (input.quotaBytes !== undefined) B.assertNumber(input.quotaBytes, "quotaBytes");
		return withPgRetry(
			() => this.db.transaction((tx) => this.initializeNamespaceSection(tx, input)),
			{ label: "blobCatalog.initializeNamespace" },
		);
	}

	private async initializeNamespaceSection(
		tx: Tx,
		input: { expectedGeneration: number | null; quotaBytes?: number },
	): Promise<Readonly<BudgetRecord>> {
		// A singleton cannot be bypassed by changing namespaceKey on another instance.
		const existing = (await tx.select().from(budgets).limit(2)) as BudgetRecord[];
		if (existing.length > 1 || (existing[0] && existing[0].id !== FILE_CHANGE_BLOB_BUDGET_ID)) {
			throw B.fail(
				"namespace_mismatch",
				"A database must bind exactly one physical blob namespace",
			);
		}
		const current = existing[0];
		if (current) {
			this.checkBudget(current);
			if (current.generation !== input.expectedGeneration) throw B.generationMismatch();
			return this.updateBudget(tx, {
				status: "unverified",
				generation: B.nextGeneration(current.generation),
				quotaBytes: input.quotaBytes ?? current.quotaBytes,
			});
		}
		if (input.expectedGeneration !== null) throw B.generationMismatch();
		const inserted = await tx
			.insert(budgets)
			.values({
				id: FILE_CHANGE_BLOB_BUDGET_ID,
				namespaceKey: this.namespaceKey,
				quotaBytes: input.quotaBytes ?? FILE_CHANGE_LIMITS.blobSoftQuotaBytes,
				updatedAt: B.now(),
			})
			.returning();
		const row = inserted[0] as BudgetRecord | undefined;
		if (!row) throw B.fail("catalog_mismatch", "Budget insert returned no row");
		return Object.freeze(row);
	}

	/** Stops admissions and fences old handles; never cancels/forgives their leases. */
	async beginReconciliation(input: {
		expectedGeneration: number;
	}): Promise<Readonly<BudgetRecord>> {
		B.assertNumber(input.expectedGeneration, "generation");
		return withPgRetry(
			() => this.db.transaction((tx) => this.beginReconciliationSection(tx, input)),
			{ label: "blobCatalog.beginReconciliation" },
		);
	}

	private async beginReconciliationSection(
		tx: Tx,
		input: { expectedGeneration: number },
	): Promise<Readonly<BudgetRecord>> {
		const current = await this.requireBudget(tx, input.expectedGeneration);
		return this.updateBudget(tx, {
			status: "reconciling",
			generation: B.nextGeneration(current.generation),
		});
	}

	/**
	 * Worker-attested totals, NEVER a startup guess or SUM on the request thread.
	 * No unfinished lease (including a zero-byte lease) may be silently cleared.
	 */
	async completeReconciliation(input: {
		expectedGeneration: number;
		verifiedUsedBytes: number;
		verification: {
			namespaceIdentityVerified: true;
			writersQuiescent: true;
			physicalInventoryComplete: true;
			catalogMatchesInventory: true;
		};
	}): Promise<Readonly<BudgetRecord>> {
		B.assertNumber(input.verifiedUsedBytes, "verifiedUsedBytes");
		const proof = input.verification;
		if (
			proof?.namespaceIdentityVerified !== true ||
			proof.writersQuiescent !== true ||
			proof.physicalInventoryComplete !== true ||
			proof.catalogMatchesInventory !== true
		) {
			throw B.fail("invalid_input", "A complete external worker verification is required");
		}
		return withPgRetry(
			() => this.db.transaction((tx) => this.completeReconciliationSection(tx, input)),
			{ label: "blobCatalog.completeReconciliation" },
		);
	}

	private async completeReconciliationSection(
		tx: Tx,
		input: { expectedGeneration: number; verifiedUsedBytes: number },
	): Promise<Readonly<BudgetRecord>> {
		const current = await this.requireAccess(tx, {
			expectedGeneration: input.expectedGeneration,
			mode: "maintenance",
		});
		for (const status of ["reserved", "reconcile_required"] as const) {
			const pending = await tx
				.select({ id: reservations.id })
				.from(reservations)
				.where(and(eq(reservations.budgetId, current.id), eq(reservations.status, status)))
				.limit(1);
			if (pending[0]) {
				throw B.fail(
					"reconciliation_required",
					"Unfinished reservations must be reconciled individually",
				);
			}
		}
		if (current.reservedBytes !== 0) {
			throw B.fail(
				"reconciliation_required",
				"Reservation counter mismatch requires investigation",
			);
		}
		return this.updateBudget(tx, {
			status: "ready",
			usedBytes: input.verifiedUsedBytes,
			reconciledAt: B.now(),
		});
	}

	/** Capture a fence once. Every reserve/release checks it again in its transaction. */
	admission(input: { expectedGeneration: number; ownerEpoch: string }): FileChangeBlobAdmission {
		B.assertNumber(input.expectedGeneration, "generation");
		B.assertKey(input.ownerEpoch, "ownerEpoch");
		const { expectedGeneration, ownerEpoch } = input;
		return Object.freeze({
			reserve: ({ expectedSize, signal }: { expectedSize: number; signal: AbortSignal }) =>
				this.reserve({ expectedGeneration, ownerEpoch, expectedSize, signal }) as never,
		});
	}

	async reserve(input: {
		expectedGeneration: number;
		ownerEpoch: string;
		expectedSize: number;
		signal: AbortSignal;
	}): Promise<PostgresBlobCatalogLease> {
		B.assertNumber(input.expectedSize, "expectedSize", FILE_CHANGE_LIMITS.blobBytes);
		B.assertKey(input.ownerEpoch, "ownerEpoch");
		B.checkSignal(input.signal);
		const token = await withPgRetry(
			() => this.db.transaction((tx) => this.reserveSection(tx, input)),
			{ label: "blobCatalog.reserve" },
		);
		let firstResult: FileChangeBlobRelease | undefined;
		return Object.freeze({
			...token,
			release: async (releaseInput: FileChangeBlobRelease) => {
				const result = await this.validateReleaseOrPreserve(token, releaseInput);
				if (firstResult && !B.sameRelease(firstResult, result)) {
					throw B.fail("release_conflict", "A lease cannot be released with a different outcome");
				}
				firstResult = result;
				await this.retryRelease(token, result);
			},
		});
	}

	private async reserveSection(
		tx: Tx,
		input: {
			expectedGeneration: number;
			ownerEpoch: string;
			expectedSize: number;
			signal: AbortSignal;
		},
	): Promise<PostgresBlobReservationToken> {
		const current = await this.requireAccess(tx, {
			expectedGeneration: input.expectedGeneration,
			mode: "writer",
		});
		B.checkSignal(input.signal);
		// Subtraction avoids overflow of used + reserved + expected at MAX_SAFE_INTEGER.
		if (
			current.usedBytes > current.quotaBytes ||
			current.reservedBytes > current.quotaBytes - current.usedBytes ||
			input.expectedSize > current.quotaBytes - current.usedBytes - current.reservedBytes
		) {
			throw B.fail("quota_exceeded", "Blob storage quota does not admit this reservation");
		}
		const reservationId = generateId();
		await tx.insert(reservations).values({
			id: reservationId,
			budgetId: current.id,
			ownerEpoch: input.ownerEpoch,
			generation: current.generation,
			expectedSize: input.expectedSize,
			createdAt: B.now(),
		});
		await this.updateBudget(tx, { reservedBytes: current.reservedBytes + input.expectedSize });
		return Object.freeze({
			reservationId,
			ownerEpoch: input.ownerEpoch,
			generation: current.generation,
		});
	}

	/** Retry ONLY the original store result; an abandoned/crashed owner needs worker proof. */
	async retryRelease(
		token: PostgresBlobReservationToken,
		input: FileChangeBlobRelease,
	): Promise<void> {
		B.validateToken(token);
		const result = B.validateRelease(input);
		const access: Access = { expectedGeneration: token.generation, mode: "writer" };
		try {
			await this.recordRelease(access, token, result);
			await this.settleRelease(access, token, result);
		} catch (error) {
			await this.preserveReservation(token, error);
		}
	}

	/** Metadata only. A catalog ready row alone never proves a body currently exists. */
	async getMetadata(input: {
		expectedGeneration: number;
		ref: FileChangeBlobRef;
	}): Promise<Readonly<BlobRecord> | null> {
		const ref = B.validateRef(input.ref);
		return withPgRetry(
			() => this.db.transaction((tx) => this.getMetadataSection(tx, input.expectedGeneration, ref)),
			{ label: "blobCatalog.getMetadata" },
		);
	}

	private async getMetadataSection(
		tx: Tx,
		expectedGeneration: number,
		ref: FileChangeBlobRef,
	): Promise<Readonly<BlobRecord> | null> {
		await this.requireAccess(tx, { expectedGeneration, mode: "writer" });
		const rows = (await tx
			.select()
			.from(blobs)
			.where(eq(blobs.digest, ref.digest))) as BlobRecord[];
		const row = rows[0];
		if (!row) return null;
		B.checkBlob(row, ref);
		return Object.freeze(row);
	}

	/** One status per page uses (budget_id,status,created_at,id), never TTL reclamation. */
	async listReservations(input: {
		expectedGeneration: number;
		status: "reserved" | "reconcile_required";
		limit?: number;
		after?: ReservationCursor;
	}): Promise<{ items: Readonly<ReservationRecord>[]; nextCursor: ReservationCursor | null }> {
		const limit = input.limit ?? FILE_CHANGE_LIMITS.historyPageItems;
		B.assertNumber(limit, "limit", FILE_CHANGE_LIMITS.historyPageItems);
		if (!limit || !["reserved", "reconcile_required"].includes(input.status)) {
			throw B.fail("invalid_input", "Invalid reservation page");
		}
		if (input.after) {
			B.assertKey(input.after.id, "cursor id");
			if (
				typeof input.after.createdAt !== "string" ||
				input.after.createdAt.length !== 24 ||
				Number.isNaN(Date.parse(input.after.createdAt))
			) {
				throw B.fail("invalid_input", "Invalid reservation time cursor");
			}
		}
		const rows = await withPgRetry(
			() => this.db.transaction((tx) => this.listReservationsSection(tx, input, limit)),
			{ label: "blobCatalog.listReservations" },
		);
		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit).map((row) => Object.freeze(row));
		const last = items[items.length - 1];
		return {
			items,
			nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
		};
	}

	private async listReservationsSection(
		tx: Tx,
		input: {
			expectedGeneration: number;
			status: "reserved" | "reconcile_required";
			after?: ReservationCursor;
		},
		limit: number,
	): Promise<ReservationRecord[]> {
		const current = await this.requireBudget(tx, input.expectedGeneration);
		return (await tx
			.select()
			.from(reservations)
			.where(
				and(
					eq(reservations.budgetId, current.id),
					eq(reservations.status, input.status),
					input.after
						? sql`(${reservations.createdAt}, ${reservations.id}) > (${input.after.createdAt}, ${input.after.id})`
						: undefined,
				),
			)
			.orderBy(asc(reservations.createdAt), asc(reservations.id))
			.limit(limit + 1)) as ReservationRecord[];
	}

	/**
	 * Explicit external-worker terminal proof, not an expired lease/old owner guess.
	 * A recorded publication cannot be rewritten into a failed/not-published result.
	 */
	async reconcileReservation(input: {
		expectedGeneration: number;
		reservationId: string;
		ownerEpoch: string;
		result: FileChangeBlobRelease;
		verification: { ownerStopped: true; temporaryBytesRemoved: true; outcomeVerified: true };
	}): Promise<void> {
		const token = {
			reservationId: input.reservationId,
			ownerEpoch: input.ownerEpoch,
			generation: input.expectedGeneration,
		};
		B.validateToken(token);
		if (
			input.verification?.ownerStopped !== true ||
			input.verification.temporaryBytesRemoved !== true ||
			input.verification.outcomeVerified !== true
		) {
			throw B.fail(
				"invalid_input",
				"Reconciliation requires verified owner termination and physical outcome",
			);
		}
		const result = B.validateRelease(input.result);
		const access: Access = { expectedGeneration: input.expectedGeneration, mode: "maintenance" };
		await this.recordRelease(access, token, result);
		await this.settleRelease(access, token, result);
	}

	/** Worker-only metadata correction; never deletes bodies or revives expired evidence. */
	async reconcileBlob(input: {
		expectedGeneration: number;
		ref: FileChangeBlobRef;
		physicalState: "verified" | "missing";
	}): Promise<Readonly<BlobRecord>> {
		const ref = B.validateRef(input.ref);
		if (!["verified", "missing"].includes(input.physicalState)) {
			throw B.fail("invalid_input", "Invalid physical blob observation");
		}
		return withPgRetry(
			() =>
				this.db.transaction((tx) =>
					this.reconcileBlobSection(tx, input.expectedGeneration, ref, input.physicalState),
				),
			{ label: "blobCatalog.reconcileBlob" },
		);
	}

	private async reconcileBlobSection(
		tx: Tx,
		expectedGeneration: number,
		ref: FileChangeBlobRef,
		physicalState: "verified" | "missing",
	): Promise<Readonly<BlobRecord>> {
		const current = await this.requireAccess(tx, { expectedGeneration, mode: "maintenance" });
		const existingRows = (await tx
			.select()
			.from(blobs)
			.where(eq(blobs.digest, ref.digest))) as BlobRecord[];
		const existing = existingRows[0];
		if (existing) B.checkBlob(existing, ref);
		const status =
			existing?.status === "expired"
				? "expired"
				: physicalState === "verified"
					? "ready"
					: "missing";
		const upserted = await tx
			.insert(blobs)
			.values({
				...B.blobValues(ref, current.generation),
				status,
			})
			.onConflictDoUpdate({
				target: blobs.digest,
				set: { status, gcGeneration: current.generation, updatedAt: B.now() },
			})
			.returning();
		const row = upserted[0] as BlobRecord | undefined;
		if (!row) throw B.fail("catalog_mismatch", "Blob upsert returned no row");
		return Object.freeze(row);
	}

	private async recordRelease(
		access: Access,
		token: PostgresBlobReservationToken,
		result: FileChangeBlobRelease,
	): Promise<void> {
		await withPgRetry(
			() => this.db.transaction((tx) => this.recordReleaseSection(tx, access, token, result)),
			{ label: "blobCatalog.recordRelease" },
		);
	}

	private async recordReleaseSection(
		tx: Tx,
		access: Access,
		token: PostgresBlobReservationToken,
		result: FileChangeBlobRelease,
	): Promise<void> {
		const current = await this.requireAccess(tx, access);
		const reservation = await this.requireReservation(tx, token);
		if (access.mode === "writer" && reservation.generation !== token.generation) {
			throw B.generationMismatch();
		}
		B.checkOutcome(reservation, result);
		if (reservation.status === "settled") return;
		if (result.ref) {
			const existingRows = (await tx
				.select()
				.from(blobs)
				.where(eq(blobs.digest, result.ref.digest))) as BlobRecord[];
			const existing = existingRows[0];
			if (existing) {
				B.checkBlob(existing, result.ref);
				B.checkAdoptable(existing, access);
			} else {
				await tx.insert(blobs).values(B.blobValues(result.ref, current.generation));
			}
		}
		await tx
			.update(reservations)
			.set({
				status: "reconcile_required",
				blobDigest: result.ref?.digest ?? null,
				published: result.published,
			})
			.where(eq(reservations.id, reservation.id));
	}

	private async settleRelease(
		access: Access,
		token: PostgresBlobReservationToken,
		result: FileChangeBlobRelease,
	): Promise<void> {
		await withPgRetry(
			() => this.db.transaction((tx) => this.settleReleaseSection(tx, access, token, result)),
			{ label: "blobCatalog.settleRelease" },
		);
	}

	private async settleReleaseSection(
		tx: Tx,
		access: Access,
		token: PostgresBlobReservationToken,
		result: FileChangeBlobRelease,
	): Promise<void> {
		const current = await this.requireAccess(tx, access);
		const reservation = await this.requireReservation(tx, token);
		if (access.mode === "writer" && reservation.generation !== token.generation) {
			throw B.generationMismatch();
		}
		B.checkOutcome(reservation, result);
		if (reservation.status === "settled") return;
		if (reservation.published === null || reservation.status !== "reconcile_required") {
			throw B.fail("reconciliation_required", "Release intent must be durable before settlement");
		}
		let addedBytes = 0;
		if (result.ref) {
			const rows = (await tx
				.select()
				.from(blobs)
				.where(eq(blobs.digest, result.ref.digest))) as BlobRecord[];
			const row = rows[0];
			if (!row) throw B.fail("catalog_mismatch", "The durable release lost its blob metadata");
			B.checkBlob(row, result.ref);
			B.checkAdoptable(row, access);
			if (row.status !== "ready") {
				addedBytes = row.sizeBytes;
				await tx
					.update(blobs)
					.set({ status: "ready", gcGeneration: current.generation, updatedAt: B.now() })
					.where(eq(blobs.id, row.id));
			}
		}
		if (
			current.reservedBytes < reservation.expectedSize ||
			addedBytes > Number.MAX_SAFE_INTEGER - current.usedBytes
		) {
			throw B.fail("catalog_mismatch", "Blob accounting counters cannot be settled safely");
		}
		await this.updateBudget(tx, {
			usedBytes: current.usedBytes + addedBytes,
			reservedBytes: current.reservedBytes - reservation.expectedSize,
		});
		await tx
			.update(reservations)
			.set({ status: "settled", settledAt: B.now() })
			.where(eq(reservations.id, reservation.id));
	}

	private async validateReleaseOrPreserve(
		token: PostgresBlobReservationToken,
		input: FileChangeBlobRelease,
	): Promise<FileChangeBlobRelease> {
		try {
			return B.validateRelease(input);
		} catch (error) {
			return await this.preserveReservation(token, error);
		}
	}

	private async preserveReservation(
		token: PostgresBlobReservationToken,
		original: unknown,
	): Promise<never> {
		// A stale owner must not mutate the worker's newer generation, even on failure.
		try {
			await withPgRetry(
				() => this.db.transaction((tx) => this.preserveReservationSection(tx, token)),
				{ label: "blobCatalog.preserveReservation" },
			);
		} catch (error) {
			if (!(error instanceof FileChangeBlobCatalogError && error.code === "generation_mismatch")) {
				throw new AggregateError(
					[original, error],
					"Blob release and recovery marker both failed; reservation retained",
				);
			}
		}
		throw original;
	}

	private async preserveReservationSection(
		tx: Tx,
		token: PostgresBlobReservationToken,
	): Promise<void> {
		const current = await this.requireBudget(tx, token.generation);
		if (current.status !== "ready") return;
		await tx
			.update(reservations)
			.set({ status: "reconcile_required" })
			.where(
				and(
					eq(reservations.id, token.reservationId),
					eq(reservations.budgetId, current.id),
					eq(reservations.ownerEpoch, token.ownerEpoch),
					eq(reservations.generation, token.generation),
					inArray(reservations.status, ["reserved", "reconcile_required"]),
				),
			);
	}

	private async requireReservation(
		tx: Tx,
		token: PostgresBlobReservationToken,
	): Promise<ReservationRecord> {
		const rows = (await tx
			.select()
			.from(reservations)
			.where(
				and(
					eq(reservations.id, token.reservationId),
					eq(reservations.budgetId, FILE_CHANGE_BLOB_BUDGET_ID),
					eq(reservations.ownerEpoch, token.ownerEpoch),
				),
			)) as ReservationRecord[];
		const row = rows[0];
		if (!row) {
			throw B.fail("reservation_not_found", "Reservation does not belong to this owner/namespace");
		}
		B.assertNumber(row.expectedSize, "stored expectedSize", FILE_CHANGE_LIMITS.blobBytes);
		if (!["reserved", "reconcile_required", "settled"].includes(row.status)) {
			throw B.fail("catalog_mismatch", "Invalid reservation status");
		}
		return row;
	}

	private async requireBudget(tx: Tx, expectedGeneration: number): Promise<BudgetRecord> {
		B.assertNumber(expectedGeneration, "generation");
		const rows = (await tx
			.select()
			.from(budgets)
			.where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID))) as BudgetRecord[];
		const row = rows[0];
		if (!row) throw B.fail("namespace_unverified", "Blob namespace has not been initialized");
		this.checkBudget(row);
		if (row.generation !== expectedGeneration) throw B.generationMismatch();
		return row;
	}

	private async requireAccess(tx: Tx, access: Access): Promise<BudgetRecord> {
		const row = await this.requireBudget(tx, access.expectedGeneration);
		if (row.status !== (access.mode === "writer" ? "ready" : "reconciling")) {
			throw B.fail("namespace_unverified", "Blob namespace is not verified for this operation");
		}
		return row;
	}

	private checkBudget(row: BudgetRecord): void {
		if (row.namespaceKey !== this.namespaceKey) {
			throw B.fail(
				"namespace_mismatch",
				"Database is bound to a different physical blob namespace",
			);
		}
		for (const field of ["usedBytes", "reservedBytes", "quotaBytes", "generation"] as const) {
			B.assertNumber(row[field], field);
		}
		if (!["unverified", "reconciling", "ready"].includes(row.status)) {
			throw B.fail("catalog_mismatch", "Invalid namespace status");
		}
	}

	private async updateBudget(
		tx: Tx,
		values: Partial<typeof budgets.$inferInsert>,
	): Promise<Readonly<BudgetRecord>> {
		const updated = await tx
			.update(budgets)
			.set({ ...values, updatedAt: B.now() })
			.where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.returning();
		const row = updated[0] as BudgetRecord | undefined;
		if (!row) throw B.fail("namespace_unverified", "Blob namespace has not been initialized");
		return Object.freeze(row);
	}
}

// Re-exported so callers name the same vocabulary the SQLite catalog produces.
export { FileChangeBlobCatalogError };

/**
 * Compose the catalog over a caller-supplied handle. Nothing here opens a
 * connection — tests and the future composition root build their own.
 */
export function createPostgresFileChangeBlobCatalog(options: {
	db: BunSQLDatabase;
	namespaceKey: string;
}): PostgresFileChangeBlobCatalog {
	return new PostgresFileChangeBlobCatalog(options);
}
