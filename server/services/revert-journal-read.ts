import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
} from "@shared/file-change-protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import {
	fileChangeBlobs as blobs,
	revertOperationFiles as files,
	revertOperations as operations,
} from "../db/schema";
import { AppError } from "../lib/errors";
import type {
	RevertJournalContext,
	RevertJournalOperation,
	RevertJournalTransaction,
} from "./revert-mutation-journal";
export class RevertMutationJournalError extends AppError {
	constructor(code: string, message: string) {
		super(message, 409, `REVERT_JOURNAL_${code}`);
		this.name = "RevertMutationJournalError";
	}
}

export function requireOperation(
	tx: RevertJournalTransaction,
	ctx: RevertJournalContext,
): RevertJournalOperation {
	const row = tx
		.select()
		.from(operations)
		.where(
			and(
				eq(operations.id, ctx.planId),
				eq(operations.requestedBySubjectKey, ctx.owner.subjectKey),
				sql`${operations.narratorId} IS ${ctx.owner.narratorId}`,
				sql`${operations.projectId} IS ${ctx.owner.projectId}`,
			),
		)
		.get();
	if (!row) throw fail("NOT_FOUND", "Plan not found in the authorized owning context");
	metadata(row);
	if (
		row.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION ||
		!row.coverageComplete ||
		row.expectedMessageVersion === null ||
		!row.planBlobDigest ||
		!row.selectorBlobDigest ||
		!row.historyManifestBlobDigest
	)
		throw fail("LEGACY_UNVERIFIED", "A complete v2 prepared plan is required");
	if (row.planHash !== ctx.planHash) throw fail("REQUEST_CONFLICT", "The fixed plan hash changed");
	integer(row.fileCount, 0, FILE_CHANGE_LIMITS.revertFiles);
	integer(row.appliedFileCount, 0, row.fileCount);
	return row;
}

export function assertRevision(before: RevertJournalOperation, after: RevertJournalOperation) {
	if (!equal(before, after))
		throw fail("CONCURRENT_CHANGE", "The journal changed during a bounded page yield");
}

export function catalogRef(
	tx: RevertJournalTransaction,
	digestValue: string | null,
): FileChangeBlobRef {
	if (digestValue === null) throw fail("LEGACY_UNVERIFIED", "A manifest reference is missing");
	sha256(digestValue);
	const row = tx
		.select({ digest: blobs.digest, sizeBytes: blobs.sizeBytes, status: blobs.status })
		.from(blobs)
		.where(eq(blobs.digest, digestValue))
		.get();
	if (!row || row.status !== "ready") throw fail("BLOB_NOT_READY", "A raw object is not ready");
	integer(row.sizeBytes, 0, FILE_CHANGE_LIMITS.blobBytes);
	return { algorithm: "sha256", digest: row.digest, sizeBytes: row.sizeBytes };
}

export function selectFiles(
	tx: RevertJournalTransaction,
	id: string,
	cursor: string | undefined,
	limit: number,
) {
	return tx
		.select()
		.from(files)
		.where(
			and(eq(files.revertOperationId, id), cursor ? sql`${files.fileKey} > ${cursor}` : undefined),
		)
		.orderBy(asc(files.fileKey))
		.limit(limit)
		.all();
}

export function metadata(value: unknown) {
	if (Buffer.byteLength(JSON.stringify(value)) > FILE_CHANGE_LIMITS.metadataBytes)
		throw fail("METADATA_BUDGET", "Metadata exceeds the shared 8KiB row budget");
}

export function sha256(value: string) {
	if (typeof value !== "string" || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value))
		throw fail("INVALID_INPUT", "Invalid SHA-256 digest");
}

export function integer(value: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw fail("BUDGET_OR_INPUT", "Value exceeds its finite budget");
}

export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

export function equal(a: unknown, b: unknown) {
	return canonical(a) === canonical(b);
}

export function fail(code: string, message: string) {
	return new RevertMutationJournalError(code, message);
}
