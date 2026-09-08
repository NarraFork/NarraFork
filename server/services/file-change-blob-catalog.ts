import {
	fileChangeBlobs as blobs,
	fileChangeStorageBudgets as budgets,
	fileChangeBlobReservations as reservations,
} from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { FILE_CHANGE_LIMITS, type FileChangeBlobRef } from "@shared/file-change-protocol";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { SQLiteTransactionConfig } from "drizzle-orm/sqlite-core";
import type {
	FileChangeBlobAdmission,
	FileChangeBlobLease,
	FileChangeBlobRelease,
} from "./file-change-blob-store";

/** A database has ONE physical blob namespace, not one quota per project/user. */
export const FILE_CHANGE_BLOB_BUDGET_ID = "file-change-blobs";
const MAX_KEY_LENGTH = 256;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
type QueryDb = Pick<BunSQLiteDatabase, "select" | "insert" | "update" | "get">;

export type FileChangeBlobCatalogDb = QueryDb & {
	transaction<T>(work: (tx: QueryDb) => T, config?: SQLiteTransactionConfig): T;
};
export type FileChangeBlobBudgetMetadata = Readonly<typeof budgets.$inferSelect>;
export type FileChangeBlobMetadata = Readonly<typeof blobs.$inferSelect>;
export type FileChangeBlobReservationMetadata = Readonly<typeof reservations.$inferSelect>;

export type FileChangeBlobCatalogErrorCode =
	| "invalid_input"
	| "invalid_ref"
	| "namespace_mismatch"
	| "namespace_unverified"
	| "generation_mismatch"
	| "quota_exceeded"
	| "reservation_not_found"
	| "release_conflict"
	| "size_mismatch"
	| "catalog_mismatch"
	| "reconciliation_required"
	| "aborted";

export class FileChangeBlobCatalogError extends Error {
	constructor(
		readonly code: FileChangeBlobCatalogErrorCode,
		message: string,
	) {
		super(message);
		this.name = "FileChangeBlobCatalogError";
	}
}

export interface FileChangeBlobReservationToken {
	reservationId: string;
	ownerEpoch: string;
	generation: number;
}
export interface FileChangeBlobCatalogLease
	extends FileChangeBlobLease,
		Readonly<FileChangeBlobReservationToken> {}

export interface FileChangeBlobCatalogOptions {
	/** Inject the application connection; this module never opens a database. */
	db: FileChangeBlobCatalogDb;
	/** Stable identity of this physical store, NOT an actor/project quota key. */
	namespaceKey: string;
}

type Access = {
	expectedGeneration: number;
	mode: "writer" | "maintenance";
};
type ReservationCursor = { createdAt: string; id: string };

/**
 * Internal metadata/admission service, not an ACL or a content API. Bind the SAME
 * physical namespace to this catalog and FileChangeBlobStore. Only its verified
 * publication callback may supply a release result; hashes are not permissions.
 *
 * Startup MUST initializeNamespace using the observed generation. An existing
 * ready row is invalidated, never treated as proof that its bodies still exist.
 * A separate, NOT implemented here, maintenance worker must quiesce publishers,
 * verify namespace identity and physical bytes (including temporary/orphan data),
 * reconcile catalog rows and every unfinished reservation, and only then complete
 * reconciliation. Generation fencing cannot stop filesystem IO already in flight.
 *
 * No scans/SUM, filesystem operations, TTL eviction, body deletion, automatic
 * recovery, or retry loops. All transactions are synchronous, indexed and small;
 * maintenance enumeration is cursor-limited. Use a root connection, not an outer
 * transaction spanning IO: the release journal must commit before settlement.
 */
export class FileChangeBlobCatalog {
	private readonly db: FileChangeBlobCatalogDb;
	private readonly namespaceKey: string;

	constructor(options: FileChangeBlobCatalogOptions) {
		assertKey(options.namespaceKey, "namespaceKey");
		this.db = options.db;
		this.namespaceKey = options.namespaceKey;
		// Do not change shared connection settings. Reject a potentially blocking one.
		// Bun's Drizzle raw get() returns a positional row, unlike Database.query().get().
		const timeout = this.db.get<[number]>(sql`PRAGMA busy_timeout`)?.[0];
		if (timeout === undefined || timeout < 0 || timeout > 250) {
			throw fail("invalid_input", "Catalog requires SQLite busy_timeout between 0 and 250ms");
		}
		if (this.db.get<[number]>(sql`PRAGMA foreign_keys`)?.[0] !== 1) {
			throw fail("invalid_input", "Catalog requires SQLite foreign_keys enabled");
		}
	}

	/** Bounded metadata only; null means initialization has not happened. */
	getBudget(): FileChangeBlobBudgetMetadata | null {
		const row = this.db
			.select()
			.from(budgets)
			.where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.get();
		if (!row) return null;
		this.checkBudget(row);
		return Object.freeze(row);
	}

	/** null explicitly means a new namespace. Reinitialization retains ALL counters. */
	initializeNamespace(input: {
		expectedGeneration: number | null;
		quotaBytes?: number;
	}): FileChangeBlobBudgetMetadata {
		if (input.expectedGeneration !== null) assertNumber(input.expectedGeneration, "generation");
		if (input.quotaBytes !== undefined) assertNumber(input.quotaBytes, "quotaBytes");
		return this.transaction((tx) => {
			// A singleton cannot be bypassed by changing namespaceKey on another instance.
			const existing = tx.select().from(budgets).limit(2).all();
			if (existing.length > 1 || (existing[0] && existing[0].id !== FILE_CHANGE_BLOB_BUDGET_ID)) {
				throw fail(
					"namespace_mismatch",
					"A database must bind exactly one physical blob namespace",
				);
			}
			const current = existing[0];
			if (current) {
				this.checkBudget(current);
				if (current.generation !== input.expectedGeneration) throw generationMismatch();
				return this.updateBudget(tx, {
					status: "unverified",
					generation: nextGeneration(current.generation),
					quotaBytes: input.quotaBytes ?? current.quotaBytes,
				});
			}
			if (input.expectedGeneration !== null) throw generationMismatch();
			const row = tx
				.insert(budgets)
				.values({
					id: FILE_CHANGE_BLOB_BUDGET_ID,
					namespaceKey: this.namespaceKey,
					quotaBytes: input.quotaBytes ?? FILE_CHANGE_LIMITS.blobSoftQuotaBytes,
					updatedAt: now(),
				})
				.returning()
				.get();
			return Object.freeze(row);
		});
	}

	/** Stops admissions and fences old handles; never cancels/forgives their leases. */
	beginReconciliation(input: { expectedGeneration: number }): FileChangeBlobBudgetMetadata {
		assertNumber(input.expectedGeneration, "generation");
		return this.transaction((tx) => {
			const current = this.requireBudget(tx, input.expectedGeneration);
			return this.updateBudget(tx, {
				status: "reconciling",
				generation: nextGeneration(current.generation),
			});
		});
	}

	/**
	 * Worker-attested totals, NEVER a startup guess or SUM on the request thread.
	 * No unfinished lease (including a zero-byte lease) may be silently cleared.
	 * usedBytes may exceed quota: existing evidence is retained, new writes denied.
	 */
	completeReconciliation(input: {
		expectedGeneration: number;
		verifiedUsedBytes: number;
		verification: {
			namespaceIdentityVerified: true;
			writersQuiescent: true;
			physicalInventoryComplete: true;
			catalogMatchesInventory: true;
		};
	}): FileChangeBlobBudgetMetadata {
		assertNumber(input.verifiedUsedBytes, "verifiedUsedBytes");
		const proof = input.verification;
		if (
			proof?.namespaceIdentityVerified !== true ||
			proof.writersQuiescent !== true ||
			proof.physicalInventoryComplete !== true ||
			proof.catalogMatchesInventory !== true
		) {
			throw fail("invalid_input", "A complete external worker verification is required");
		}
		return this.transaction((tx) => {
			const current = this.requireAccess(tx, {
				expectedGeneration: input.expectedGeneration,
				mode: "maintenance",
			});
			for (const status of ["reserved", "reconcile_required"] as const) {
				const pending = tx
					.select({ id: reservations.id })
					.from(reservations)
					.where(and(eq(reservations.budgetId, current.id), eq(reservations.status, status)))
					.limit(1)
					.get();
				if (pending)
					throw fail(
						"reconciliation_required",
						"Unfinished reservations must be reconciled individually",
					);
			}
			if (current.reservedBytes !== 0) {
				throw fail(
					"reconciliation_required",
					"Reservation counter mismatch requires investigation",
				);
			}
			return this.updateBudget(tx, {
				status: "ready",
				usedBytes: input.verifiedUsedBytes,
				reconciledAt: now(),
			});
		});
	}

	/** Capture a fence once. Every reserve/release checks it again in its transaction. */
	admission(input: { expectedGeneration: number; ownerEpoch: string }): FileChangeBlobAdmission {
		assertNumber(input.expectedGeneration, "generation");
		assertKey(input.ownerEpoch, "ownerEpoch");
		const { expectedGeneration, ownerEpoch } = input;
		return Object.freeze({
			reserve: ({ expectedSize, signal }: { expectedSize: number; signal: AbortSignal }) =>
				this.reserve({ expectedGeneration, ownerEpoch, expectedSize, signal }),
		});
	}

	reserve(input: {
		expectedGeneration: number;
		ownerEpoch: string;
		expectedSize: number;
		signal: AbortSignal;
	}): FileChangeBlobCatalogLease {
		assertNumber(input.expectedSize, "expectedSize", FILE_CHANGE_LIMITS.blobBytes);
		assertKey(input.ownerEpoch, "ownerEpoch");
		checkSignal(input.signal);
		const token = this.transaction((tx) => {
			const current = this.requireAccess(tx, {
				expectedGeneration: input.expectedGeneration,
				mode: "writer",
			});
			checkSignal(input.signal);
			// Subtraction avoids overflow of used + reserved + expected at MAX_SAFE_INTEGER.
			if (
				current.usedBytes > current.quotaBytes ||
				current.reservedBytes > current.quotaBytes - current.usedBytes ||
				input.expectedSize > current.quotaBytes - current.usedBytes - current.reservedBytes
			) {
				throw fail("quota_exceeded", "Blob storage quota does not admit this reservation");
			}
			const reservationId = generateId();
			tx.insert(reservations)
				.values({
					id: reservationId,
					budgetId: current.id,
					ownerEpoch: input.ownerEpoch,
					generation: current.generation,
					expectedSize: input.expectedSize,
					createdAt: now(),
				})
				.run();
			this.updateBudget(tx, { reservedBytes: current.reservedBytes + input.expectedSize });
			return Object.freeze({
				reservationId,
				ownerEpoch: input.ownerEpoch,
				generation: current.generation,
			});
		});
		let firstResult: FileChangeBlobRelease | undefined;
		return Object.freeze({
			...token,
			release: (input: FileChangeBlobRelease) => {
				const result = this.validateReleaseOrPreserve(token, input);
				if (firstResult && !sameRelease(firstResult, result)) {
					throw fail("release_conflict", "A lease cannot be released with a different outcome");
				}
				firstResult = result;
				this.retryRelease(token, result);
			},
		});
	}

	/** Retry ONLY the original store result; an abandoned/crashed owner needs worker proof. */
	retryRelease(token: FileChangeBlobReservationToken, input: FileChangeBlobRelease): void {
		validateToken(token);
		const result = this.validateReleaseOrPreserve(token, input);
		const access: Access = { expectedGeneration: token.generation, mode: "writer" };
		try {
			this.recordRelease(access, token, result);
			this.settleRelease(access, token, result);
		} catch (error) {
			this.preserveReservation(token, error);
		}
	}

	/** Metadata only. A catalog ready row alone never proves a body currently exists. */
	getMetadata(input: {
		expectedGeneration: number;
		ref: FileChangeBlobRef;
	}): FileChangeBlobMetadata | null {
		const ref = validateRef(input.ref);
		return this.transaction((tx) => {
			this.requireAccess(tx, { expectedGeneration: input.expectedGeneration, mode: "writer" });
			const row = tx.select().from(blobs).where(eq(blobs.digest, ref.digest)).get();
			if (!row) return null;
			checkBlob(row, ref);
			return Object.freeze(row);
		});
	}

	/** One status per page uses (budget_id,status,created_at,id), never TTL reclamation. */
	listReservations(input: {
		expectedGeneration: number;
		status: "reserved" | "reconcile_required";
		limit?: number;
		after?: ReservationCursor;
	}): { items: FileChangeBlobReservationMetadata[]; nextCursor: ReservationCursor | null } {
		const limit = input.limit ?? FILE_CHANGE_LIMITS.historyPageItems;
		assertNumber(limit, "limit", FILE_CHANGE_LIMITS.historyPageItems);
		if (!limit || !["reserved", "reconcile_required"].includes(input.status))
			throw fail("invalid_input", "Invalid reservation page");
		if (input.after) {
			assertKey(input.after.id, "cursor id");
			if (
				typeof input.after.createdAt !== "string" ||
				input.after.createdAt.length !== 24 ||
				Number.isNaN(Date.parse(input.after.createdAt))
			)
				throw fail("invalid_input", "Invalid reservation time cursor");
		}
		const rows = this.transaction((tx) => {
			const current = this.requireBudget(tx, input.expectedGeneration);
			return tx
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
				.limit(limit + 1)
				.all();
		});
		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit).map((row) => Object.freeze(row));
		const last = items[items.length - 1];
		return {
			items,
			nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
		};
	}

	/**
	 * Explicit external-worker terminal proof, not an expired lease/old owner guess.
	 * result.ref requires full physical hash/size verification; null requires proof
	 * that this attempt retained NO physical bytes, including temporary files.
	 * A recorded publication cannot be rewritten into a failed/not-published result.
	 */
	reconcileReservation(input: {
		expectedGeneration: number;
		reservationId: string;
		ownerEpoch: string;
		result: FileChangeBlobRelease;
		verification: { ownerStopped: true; temporaryBytesRemoved: true; outcomeVerified: true };
	}): void {
		const token = {
			reservationId: input.reservationId,
			ownerEpoch: input.ownerEpoch,
			generation: input.expectedGeneration,
		};
		validateToken(token);
		if (
			input.verification?.ownerStopped !== true ||
			input.verification.temporaryBytesRemoved !== true ||
			input.verification.outcomeVerified !== true
		)
			throw fail(
				"invalid_input",
				"Reconciliation requires verified owner termination and physical outcome",
			);
		const result = validateRelease(input.result);
		const access: Access = { expectedGeneration: input.expectedGeneration, mode: "maintenance" };
		this.recordRelease(access, token, result);
		this.settleRelease(access, token, result);
	}

	/** Worker-only metadata correction; never deletes bodies or revives expired evidence. */
	reconcileBlob(input: {
		expectedGeneration: number;
		ref: FileChangeBlobRef;
		physicalState: "verified" | "missing";
	}): FileChangeBlobMetadata {
		const ref = validateRef(input.ref);
		if (!["verified", "missing"].includes(input.physicalState))
			throw fail("invalid_input", "Invalid physical blob observation");
		return this.transaction((tx) => {
			const current = this.requireAccess(tx, {
				expectedGeneration: input.expectedGeneration,
				mode: "maintenance",
			});
			const existing = tx.select().from(blobs).where(eq(blobs.digest, ref.digest)).get();
			if (existing) checkBlob(existing, ref);
			const status =
				existing?.status === "expired"
					? "expired"
					: input.physicalState === "verified"
						? "ready"
						: "missing";
			const row = tx
				.insert(blobs)
				.values({
					...blobValues(ref, current.generation),
					status,
				})
				.onConflictDoUpdate({
					target: blobs.digest,
					set: { status, gcGeneration: current.generation, updatedAt: now() },
				})
				.returning()
				.get();
			return Object.freeze(row);
		});
	}

	private recordRelease(
		access: Access,
		token: FileChangeBlobReservationToken,
		result: FileChangeBlobRelease,
	): void {
		this.transaction((tx) => {
			const current = this.requireAccess(tx, access);
			const reservation = this.requireReservation(tx, token);
			if (access.mode === "writer" && reservation.generation !== token.generation)
				throw generationMismatch();
			checkOutcome(reservation, result);
			if (reservation.status === "settled") return;
			if (result.ref) {
				const existing = tx.select().from(blobs).where(eq(blobs.digest, result.ref.digest)).get();
				if (existing) {
					checkBlob(existing, result.ref);
					checkAdoptable(existing, access);
				} else {
					tx.insert(blobs).values(blobValues(result.ref, current.generation)).run();
				}
			}
			tx.update(reservations)
				.set({
					status: "reconcile_required",
					blobDigest: result.ref?.digest ?? null,
					published: result.published,
				})
				.where(eq(reservations.id, reservation.id))
				.run();
		});
	}

	private settleRelease(
		access: Access,
		token: FileChangeBlobReservationToken,
		result: FileChangeBlobRelease,
	): void {
		this.transaction((tx) => {
			const current = this.requireAccess(tx, access);
			const reservation = this.requireReservation(tx, token);
			if (access.mode === "writer" && reservation.generation !== token.generation)
				throw generationMismatch();
			checkOutcome(reservation, result);
			if (reservation.status === "settled") return;
			if (reservation.published === null || reservation.status !== "reconcile_required")
				throw fail("reconciliation_required", "Release intent must be durable before settlement");
			let addedBytes = 0;
			if (result.ref) {
				const row = tx.select().from(blobs).where(eq(blobs.digest, result.ref.digest)).get();
				if (!row) throw fail("catalog_mismatch", "The durable release lost its blob metadata");
				checkBlob(row, result.ref);
				checkAdoptable(row, access);
				if (row.status !== "ready") {
					addedBytes = row.sizeBytes;
					tx.update(blobs)
						.set({ status: "ready", gcGeneration: current.generation, updatedAt: now() })
						.where(eq(blobs.id, row.id))
						.run();
				}
			}
			if (
				current.reservedBytes < reservation.expectedSize ||
				addedBytes > Number.MAX_SAFE_INTEGER - current.usedBytes
			)
				throw fail("catalog_mismatch", "Blob accounting counters cannot be settled safely");
			this.updateBudget(tx, {
				usedBytes: current.usedBytes + addedBytes,
				reservedBytes: current.reservedBytes - reservation.expectedSize,
			});
			tx.update(reservations)
				.set({ status: "settled", settledAt: now() })
				.where(eq(reservations.id, reservation.id))
				.run();
		});
	}

	private validateReleaseOrPreserve(
		token: FileChangeBlobReservationToken,
		input: FileChangeBlobRelease,
	): FileChangeBlobRelease {
		try {
			return validateRelease(input);
		} catch (error) {
			return this.preserveReservation(token, error);
		}
	}

	private preserveReservation(token: FileChangeBlobReservationToken, original: unknown): never {
		// A stale owner must not mutate the worker's newer generation, even on failure.
		try {
			this.transaction((tx) => {
				const current = this.requireBudget(tx, token.generation);
				if (current.status !== "ready") return;
				tx.update(reservations)
					.set({ status: "reconcile_required" })
					.where(
						and(
							eq(reservations.id, token.reservationId),
							eq(reservations.budgetId, current.id),
							eq(reservations.ownerEpoch, token.ownerEpoch),
							eq(reservations.generation, token.generation),
							inArray(reservations.status, ["reserved", "reconcile_required"]),
						),
					)
					.run();
			});
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

	private requireReservation(
		tx: QueryDb,
		token: FileChangeBlobReservationToken,
	): typeof reservations.$inferSelect {
		const row = tx
			.select()
			.from(reservations)
			.where(
				and(
					eq(reservations.id, token.reservationId),
					eq(reservations.budgetId, FILE_CHANGE_BLOB_BUDGET_ID),
					eq(reservations.ownerEpoch, token.ownerEpoch),
				),
			)
			.get();
		if (!row)
			throw fail("reservation_not_found", "Reservation does not belong to this owner/namespace");
		assertNumber(row.expectedSize, "stored expectedSize", FILE_CHANGE_LIMITS.blobBytes);
		if (!["reserved", "reconcile_required", "settled"].includes(row.status))
			throw fail("catalog_mismatch", "Invalid reservation status");
		return row;
	}

	private requireBudget(tx: QueryDb, expectedGeneration: number): typeof budgets.$inferSelect {
		assertNumber(expectedGeneration, "generation");
		const row = tx.select().from(budgets).where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID)).get();
		if (!row) throw fail("namespace_unverified", "Blob namespace has not been initialized");
		this.checkBudget(row);
		if (row.generation !== expectedGeneration) throw generationMismatch();
		return row;
	}

	private requireAccess(tx: QueryDb, access: Access): typeof budgets.$inferSelect {
		const row = this.requireBudget(tx, access.expectedGeneration);
		if (row.status !== (access.mode === "writer" ? "ready" : "reconciling"))
			throw fail("namespace_unverified", "Blob namespace is not verified for this operation");
		return row;
	}

	private checkBudget(row: typeof budgets.$inferSelect): void {
		if (row.namespaceKey !== this.namespaceKey)
			throw fail("namespace_mismatch", "Database is bound to a different physical blob namespace");
		for (const field of ["usedBytes", "reservedBytes", "quotaBytes", "generation"] as const)
			assertNumber(row[field], field);
		if (!["unverified", "reconciling", "ready"].includes(row.status))
			throw fail("catalog_mismatch", "Invalid namespace status");
	}

	private updateBudget(
		tx: QueryDb,
		values: Partial<typeof budgets.$inferInsert>,
	): FileChangeBlobBudgetMetadata {
		return Object.freeze(
			tx
				.update(budgets)
				.set({ ...values, updatedAt: now() })
				.where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
				.returning()
				.get(),
		);
	}

	private transaction<T>(work: (tx: QueryDb) => T): T {
		return this.db.transaction(work, { behavior: "immediate" });
	}
}

function blobValues(ref: FileChangeBlobRef, generation: number): typeof blobs.$inferInsert {
	return {
		id: generateId(),
		digest: ref.digest,
		sizeBytes: ref.sizeBytes,
		storageKey: storageKey(ref),
		status: "staging",
		gcGeneration: generation,
		createdAt: now(),
		updatedAt: now(),
	};
}

function checkBlob(row: typeof blobs.$inferSelect, ref: FileChangeBlobRef): void {
	if (
		row.digest !== ref.digest ||
		row.sizeBytes !== ref.sizeBytes ||
		row.storageKey !== storageKey(ref)
	)
		throw fail(
			"catalog_mismatch",
			"Catalog hash, size or relative storage key differs from the verified object",
		);
	if (!["staging", "ready", "expired", "missing"].includes(row.status))
		throw fail("catalog_mismatch", "Invalid blob status");
}

function checkAdoptable(row: typeof blobs.$inferSelect, access: Access): void {
	if (
		row.status === "expired" ||
		(access.mode === "writer" &&
			(row.status === "missing" ||
				(row.status === "staging" && row.gcGeneration !== access.expectedGeneration)))
	)
		throw fail(
			"reconciliation_required",
			"An unavailable/unreconciled blob cannot be adopted by a write",
		);
}

function checkOutcome(row: typeof reservations.$inferSelect, result: FileChangeBlobRelease): void {
	if (result.ref && result.ref.sizeBytes !== row.expectedSize)
		throw fail("size_mismatch", "Published blob size does not match the reservation");
	if (
		row.published !== null &&
		(row.blobDigest !== (result.ref?.digest ?? null) || row.published !== result.published)
	)
		throw fail("release_conflict", "The durable reservation has a different publication result");
	if (row.status === "settled" && row.published === null)
		throw fail("catalog_mismatch", "Settled reservation has no durable outcome");
}

function validateRelease(input: FileChangeBlobRelease): FileChangeBlobRelease {
	assertPlainFields(input, ["ref", "published"]);
	if (typeof input.published !== "boolean" || (input.ref === null && input.published))
		throw fail("invalid_input", "Publication result requires a reference when published");
	return Object.freeze({
		ref: input.ref === null ? null : validateRef(input.ref),
		published: input.published,
	});
}

function validateRef(input: FileChangeBlobRef): FileChangeBlobRef {
	assertPlainFields(input, ["algorithm", "digest", "sizeBytes"]);
	if (
		input.algorithm !== "sha256" ||
		typeof input.digest !== "string" ||
		input.digest.length !== 64 ||
		!DIGEST_PATTERN.test(input.digest) ||
		!Number.isSafeInteger(input.sizeBytes) ||
		input.sizeBytes < 0 ||
		input.sizeBytes > FILE_CHANGE_LIMITS.blobBytes
	)
		throw fail("invalid_ref", "Blob reference has an invalid algorithm, digest or size");
	return Object.freeze({ algorithm: "sha256", digest: input.digest, sizeBytes: input.sizeBytes });
}

function assertPlainFields(input: unknown, fields: string[]): void {
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input))
	)
		throw fail("invalid_ref", "Blob metadata must be a plain object");
	const keys = Reflect.ownKeys(input);
	if (
		keys.length !== fields.length ||
		keys.some(
			(key) =>
				typeof key !== "string" ||
				!fields.includes(key) ||
				!Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, "value"),
		)
	)
		throw fail("invalid_ref", "Blob metadata contains extra fields or accessors");
}

function sameRelease(left: FileChangeBlobRelease, right: FileChangeBlobRelease): boolean {
	return (
		left.published === right.published &&
		left.ref?.digest === right.ref?.digest &&
		left.ref?.sizeBytes === right.ref?.sizeBytes
	);
}

function storageKey(ref: FileChangeBlobRef): string {
	return `sha256/${ref.digest.slice(0, 2)}/${ref.digest}`;
}

function validateToken(token: FileChangeBlobReservationToken): void {
	assertKey(token.reservationId, "reservationId");
	assertKey(token.ownerEpoch, "ownerEpoch");
	assertNumber(token.generation, "generation");
}

function checkSignal(signal: AbortSignal): void {
	if (!(signal instanceof AbortSignal))
		throw fail("invalid_input", "Reservation requires an AbortSignal");
	if (signal.aborted) throw fail("aborted", "Blob reservation was aborted");
}

function assertKey(value: string, field: string): void {
	if (
		typeof value !== "string" ||
		!value.length ||
		value.length > MAX_KEY_LENGTH ||
		[...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	)
		throw fail("invalid_input", `${field} must be a bounded nonempty key`);
}

function assertNumber(value: number, field: string, maximum = Number.MAX_SAFE_INTEGER): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw fail("invalid_input", `${field} must be a nonnegative safe integer within its budget`);
}

function nextGeneration(value: number): number {
	assertNumber(value + 1, "next generation");
	return value + 1;
}

function now(): string {
	return new Date().toISOString();
}

function generationMismatch(): FileChangeBlobCatalogError {
	return fail("generation_mismatch", "Blob namespace generation changed; this handle is fenced");
}

function fail(code: FileChangeBlobCatalogErrorCode, message: string): FileChangeBlobCatalogError {
	return new FileChangeBlobCatalogError(code, message);
}
