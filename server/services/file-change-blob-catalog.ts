import {
	fileChangeBlobs as blobs,
	fileChangeStorageBudgets as budgets,
	fileChangeBlobReservations as reservations,
} from "@server/db/schema";
import { hotSafe } from "@server/lib/hot-safe";
import { generateId } from "@server/lib/id";
import { FILE_CHANGE_LIMITS, type FileChangeBlobRef } from "@shared/file-change-protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { SQLiteTransactionConfig } from "drizzle-orm/sqlite-core";
import type { ReadQueryOptions } from "../db/worker-read";
import type {
	FileChangeBlobAdmission,
	FileChangeBlobLease,
	FileChangeBlobRelease,
} from "./file-change-blob-store";
import {
	attachFileHistoryCatalogDiagnostic,
	type FileHistoryCatalogStage,
} from "./file-change-history-diagnostics";

export const FILE_CHANGE_BLOB_BUDGET_ID = "file-change-blobs";
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
	| "quota_exceeded"
	| "release_conflict"
	| "size_mismatch"
	| "catalog_mismatch"
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
	/** Historical metadata only; this value grants no publication authority. */
	generation: number;
}
export interface FileChangeBlobCatalogLease
	extends FileChangeBlobLease,
		Readonly<FileChangeBlobReservationToken> {}
export interface FileChangeBlobCatalogOptions {
	db: FileChangeBlobCatalogDb;
	namespaceKey: string;
}
type ReservationCursor = { createdAt: string; id: string };

// The process already has a single-instance boundary. These are byte counters,
// not execution locks: independent files publish concurrently, including hot reloads.
// Cold-start reservation rows remain archival; they are never replayed or cleared.
const activeBytes = hotSafe("file-change-blob-active-bytes:v3", () => new Map<string, number>());

/**
 * Immutable-content catalog with process-local temporary quota accounting.
 * Published catalog bytes consume the durable quota. Orphan physical bytes remain
 * intact and are additionally constrained by the blob store's free-space checks.
 * Initialization is idempotent; legacy status/generation/reservations are archival.
 * Only the verified blob store callback may report publication; hashes are not ACLs.
 */
export class FileChangeBlobCatalog {
	private readonly db: FileChangeBlobCatalogDb;
	private readonly namespaceKey: string;
	constructor(options: FileChangeBlobCatalogOptions) {
		assertKey(options.namespaceKey, "namespaceKey");
		this.db = options.db;
		this.namespaceKey = options.namespaceKey;
		const timeout = this.db.get<[number]>(sql`PRAGMA busy_timeout`)?.[0];
		if (timeout === undefined || timeout < 0 || timeout > 250)
			throw fail("invalid_input", "Catalog requires SQLite busy_timeout between 0 and 250ms");
		if (this.db.get<[number]>(sql`PRAGMA foreign_keys`)?.[0] !== 1)
			throw fail("invalid_input", "Catalog requires SQLite foreign_keys enabled");
	}

	async readBudget(
		options: Pick<ReadQueryOptions, "signal" | "timeoutMs" | "deadlineAt"> = {},
	): Promise<FileChangeBlobBudgetMetadata | null> {
		const { readQueryFirst } = await import("../db/worker-read");
		const row = await readQueryFirst(
			this.db.select().from(budgets).where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID)).limit(1),
			{ ...options, executionPolicy: "worker-required", maxRows: 1 },
		);
		if (!row) return null;
		checkBudget(row, this.namespaceKey, "budget_read");
		return Object.freeze(row);
	}
	async readMetadata(
		input: { expectedGeneration?: number; ref: FileChangeBlobRef } & Pick<
			ReadQueryOptions,
			"signal" | "timeoutMs" | "deadlineAt"
		>,
	): Promise<FileChangeBlobMetadata | null> {
		const ref = validateRef(input.ref);
		const budget = await this.readBudget(input);
		if (!budget) throw fail("namespace_unverified", "Blob catalog has not been initialized");
		const { readQueryFirst } = await import("../db/worker-read");
		const row = await readQueryFirst(
			this.db.select().from(blobs).where(eq(blobs.digest, ref.digest)).limit(1),
			{ ...input, executionPolicy: "worker-required", maxRows: 1 },
		);
		if (!row) return null;
		checkBlob(row, ref);
		return Object.freeze(row);
	}
	getBudget(): FileChangeBlobBudgetMetadata | null {
		const row = this.db
			.select()
			.from(budgets)
			.where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.limit(1)
			.get();
		if (!row) return null;
		checkBudget(row, this.namespaceKey, "budget_read");
		return Object.freeze(row);
	}

	/** Leaves existing bodies, counters and legacy audit metadata untouched. */
	initializeNamespace(
		input: { expectedGeneration?: number | null; quotaBytes?: number } = {},
	): FileChangeBlobBudgetMetadata {
		if (input.quotaBytes !== undefined) assertNumber(input.quotaBytes, "quotaBytes");
		return this.transaction((tx) => {
			const rows = tx.select().from(budgets).limit(2).all();
			if (rows.length > 1 || (rows[0] && rows[0].id !== FILE_CHANGE_BLOB_BUDGET_ID))
				throw attachFileHistoryCatalogDiagnostic(
					fail("namespace_mismatch", "A database must bind exactly one physical blob namespace"),
					{
						stage: "initialize",
						reason: rows.length > 1 ? "cardinality" : "budget_id",
						currentKey: this.namespaceKey,
						row: rows[0],
						observedRows: rows.length > 1 ? 2 : 1,
						// The multi-row guard deliberately never reads either row's ID.
						rowIdMatches: rows.length > 1 ? undefined : false,
					},
				);
			const current = rows[0];
			if (current) {
				checkBudget(current, this.namespaceKey, "initialize");
				if (input.quotaBytes === undefined || input.quotaBytes === current.quotaBytes)
					return Object.freeze(current);
				return Object.freeze(
					tx
						.update(budgets)
						.set({ quotaBytes: input.quotaBytes, updatedAt: now() })
						.where(eq(budgets.id, current.id))
						.returning()
						.get(),
				);
			}
			return Object.freeze(
				tx
					.insert(budgets)
					.values({
						id: FILE_CHANGE_BLOB_BUDGET_ID,
						namespaceKey: this.namespaceKey,
						quotaBytes: input.quotaBytes ?? FILE_CHANGE_LIMITS.blobSoftQuotaBytes,
						updatedAt: now(),
					})
					.returning()
					.get(),
			);
		});
	}

	admission(input: { expectedGeneration?: number; ownerEpoch: string }): FileChangeBlobAdmission {
		assertKey(input.ownerEpoch, "ownerEpoch");
		return Object.freeze({
			reserve: ({ expectedSize, signal }: { expectedSize: number; signal: AbortSignal }) =>
				this.reserve({ ...input, expectedSize, signal }),
		});
	}
	reserve(input: {
		expectedGeneration?: number;
		ownerEpoch: string;
		expectedSize: number;
		signal: AbortSignal;
	}): FileChangeBlobCatalogLease {
		assertKey(input.ownerEpoch, "ownerEpoch");
		checkSignal(input.signal);
		const expectedSize = input.expectedSize;
		const budget = this.requireBudget(this.db);
		const releaseBytes = reserveBytes(this.namespaceKey, budget, expectedSize);
		const token = Object.freeze({
			reservationId: generateId(),
			ownerEpoch: input.ownerEpoch,
			generation: budget.generation,
		});
		let firstResult: FileChangeBlobRelease | undefined;
		let settled = false;
		return Object.freeze({
			...token,
			release: (input: FileChangeBlobRelease) => {
				try {
					const result = validateRelease(input);
					checkPublicationSize(result, expectedSize);
					if (firstResult && !sameRelease(firstResult, result))
						throw fail("release_conflict", "A publication result is immutable");
					firstResult = result;
					if (settled) return;
					this.recordPublication(result);
					settled = true;
				} finally {
					// A failed accounting attempt affects this history item, never a persistent gate.
					releaseBytes();
				}
			},
		});
	}

	private recordPublication(result: FileChangeBlobRelease): void {
		if (!result.ref) return;
		const ref = result.ref;
		this.transaction((tx) => {
			const current = this.requireBudget(tx, "publication_accounting");
			const existing = tx.select().from(blobs).where(eq(blobs.digest, ref.digest)).limit(1).get();
			if (existing) checkBlob(existing, ref);
			if (existing?.status === "ready") return;
			const usedBytes = publicationUsedBytes(current.usedBytes, ref.sizeBytes);
			tx.insert(blobs)
				.values(blobValues(ref, current.generation))
				.onConflictDoUpdate({
					target: blobs.digest,
					set: { status: "ready", updatedAt: now() },
				})
				.run();
			tx.update(budgets)
				.set({ usedBytes, updatedAt: now() })
				.where(eq(budgets.id, current.id))
				.run();
		});
	}

	getMetadata(input: {
		expectedGeneration?: number;
		ref: FileChangeBlobRef;
	}): FileChangeBlobMetadata | null {
		const ref = validateRef(input.ref);
		this.requireBudget(this.db);
		const row = this.db.select().from(blobs).where(eq(blobs.digest, ref.digest)).limit(1).get();
		if (!row) return null;
		checkBlob(row, ref);
		return Object.freeze(row);
	}

	/** Read-only access to abandoned v2 reservations for diagnostics. */
	listReservations(input: {
		expectedGeneration?: number;
		status: "reserved" | "reconcile_required";
		limit?: number;
		after?: ReservationCursor;
	}) {
		const limit = reservationPage(input);
		const current = this.requireBudget(this.db);
		const rows = this.db
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
		return reservationPageResult(rows, limit);
	}
	private requireBudget(tx: QueryDb, stage: FileHistoryCatalogStage = "budget_read") {
		const row = tx
			.select()
			.from(budgets)
			.where(eq(budgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.limit(1)
			.get();
		if (!row) throw fail("namespace_unverified", "Blob catalog has not been initialized");
		checkBudget(row, this.namespaceKey, stage);
		return row;
	}
	private transaction<T>(work: (tx: QueryDb) => T): T {
		return this.db.transaction(work, { behavior: "immediate" });
	}
}

function reserveBytes(
	namespaceKey: string,
	budget: Pick<FileChangeBlobBudgetMetadata, "usedBytes" | "quotaBytes">,
	expectedSize: number,
): () => void {
	assertNumber(expectedSize, "expectedSize", FILE_CHANGE_LIMITS.blobBytes);
	const reserved = activeBytes.get(namespaceKey) ?? 0;
	if (
		budget.usedBytes > budget.quotaBytes ||
		reserved > budget.quotaBytes - budget.usedBytes ||
		expectedSize > budget.quotaBytes - budget.usedBytes - reserved
	)
		throw fail("quota_exceeded", "Blob storage quota does not admit these bytes");
	activeBytes.set(namespaceKey, reserved + expectedSize);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const remaining = (activeBytes.get(namespaceKey) ?? 0) - expectedSize;
		if (remaining > 0) activeBytes.set(namespaceKey, remaining);
		else activeBytes.delete(namespaceKey);
	};
}
function publicationUsedBytes(usedBytes: number, sizeBytes: number): number {
	const result = usedBytes + sizeBytes;
	assertNumber(result, "usedBytes");
	return result;
}
function checkBudget(
	row: Pick<FileChangeBlobBudgetMetadata, "namespaceKey" | "usedBytes" | "quotaBytes">,
	namespaceKey: string,
	stage?: FileHistoryCatalogStage,
) {
	if (row.namespaceKey !== namespaceKey) {
		const error = fail(
			"namespace_mismatch",
			"Database is bound to a different physical blob namespace",
		);
		// Shared validation callers retain their existing two-argument behavior.
		throw stage
			? attachFileHistoryCatalogDiagnostic(error, {
					stage,
					reason: "key_mismatch",
					currentKey: namespaceKey,
					row,
				})
			: error;
	}
	for (const field of ["usedBytes", "quotaBytes"] as const) assertNumber(row[field], field);
}
function blobValues(ref: FileChangeBlobRef, generation: number): typeof blobs.$inferInsert {
	return {
		id: generateId(),
		digest: ref.digest,
		sizeBytes: ref.sizeBytes,
		storageKey: storageKey(ref),
		status: "ready",
		gcGeneration: generation,
		createdAt: now(),
		updatedAt: now(),
	};
}
function checkBlob(
	row: Pick<FileChangeBlobMetadata, "digest" | "sizeBytes" | "storageKey">,
	ref: FileChangeBlobRef,
) {
	if (
		row.digest !== ref.digest ||
		row.sizeBytes !== ref.sizeBytes ||
		row.storageKey !== storageKey(ref)
	)
		throw fail(
			"catalog_mismatch",
			"Catalog hash, size or relative key differs from the verified object",
		);
}
function checkPublicationSize(result: FileChangeBlobRelease, expectedSize: number) {
	if (result.ref && result.ref.sizeBytes !== expectedSize)
		throw fail("size_mismatch", "Published blob size differs from the reservation");
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
		!DIGEST_PATTERN.test(input.digest) ||
		!Number.isSafeInteger(input.sizeBytes) ||
		input.sizeBytes < 0 ||
		input.sizeBytes > FILE_CHANGE_LIMITS.blobBytes
	)
		throw fail("invalid_ref", "Blob reference has an invalid algorithm, digest or size");
	return Object.freeze({ algorithm: "sha256", digest: input.digest, sizeBytes: input.sizeBytes });
}
function assertPlainFields(input: unknown, fields: string[]) {
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
function sameRelease(left: FileChangeBlobRelease, right: FileChangeBlobRelease) {
	return (
		left.published === right.published &&
		left.ref?.digest === right.ref?.digest &&
		left.ref?.sizeBytes === right.ref?.sizeBytes
	);
}
function storageKey(ref: FileChangeBlobRef) {
	return `sha256/${ref.digest.slice(0, 2)}/${ref.digest}`;
}
function checkSignal(signal: AbortSignal) {
	if (!(signal instanceof AbortSignal))
		throw fail("invalid_input", "Reservation requires an AbortSignal");
	if (signal.aborted) throw fail("aborted", "Blob reservation was aborted");
}
function assertKey(value: string, field: string) {
	if (
		typeof value !== "string" ||
		!value.length ||
		value.length > 256 ||
		[...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	)
		throw fail("invalid_input", `${field} must be a bounded nonempty key`);
}
function assertNumber(value: number, field: string, maximum = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw fail("invalid_input", `${field} must be a bounded nonnegative safe integer`);
}
function reservationPage(input: {
	status: string;
	limit?: number;
	after?: ReservationCursor;
}): number {
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
	return limit;
}
function reservationPageResult<T extends { createdAt: string; id: string }>(
	rows: T[],
	limit: number,
) {
	const items = rows.slice(0, limit).map((row) => Object.freeze(row));
	const last = items.at(-1);
	return {
		items,
		nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
	};
}
function now() {
	return new Date().toISOString();
}
function fail(code: FileChangeBlobCatalogErrorCode, message: string) {
	return new FileChangeBlobCatalogError(code, message);
}

export const blobCatalogInternals = {
	reserveBytes,
	publicationUsedBytes,
	checkBudget,
	blobValues,
	checkBlob,
	checkPublicationSize,
	validateRelease,
	validateRef,
	sameRelease,
	checkSignal,
	assertKey,
	assertNumber,
	reservationPage,
	reservationPageResult,
	now,
	fail,
};
