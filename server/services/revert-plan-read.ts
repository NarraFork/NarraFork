import { createHash } from "node:crypto";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeIdentity,
	type FileChangeState,
	type KnownFileChangeState,
} from "@shared/file-change-protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { alias } from "drizzle-orm/sqlite-core";
import {
	fileChangeBlobs,
	fileChangeScopes,
	revertOperationFiles,
	revertOperations,
} from "../db/schema";
import { AppError } from "../lib/errors";
import { createFileChangeIdentity, fileChangeIdentityKey } from "./file-change-identity";
import type {
	AppendRevertPlanFile,
	RevertPlanFileCursor,
	RevertPlanHeader,
	RevertPlanManifestProof,
	RevertPlanOwner,
	RevertPlanPage,
} from "./revert-plan-service";
export type Executor = Pick<BunSQLiteDatabase, "select" | "insert" | "update">;
export type PlanRecord = typeof revertOperations.$inferSelect;
export type FileRecord = typeof revertOperationFiles.$inferSelect;

export class RevertPlanError extends AppError {
	constructor(code: string, message: string) {
		super(message, 409, `REVERT_PLAN_${code}`);
		this.name = "RevertPlanError";
	}
}

export const HEADER_KEYS = [
	"subjectKey",
	"narratorId",
	"projectId",
	"idempotencyKey",
	"requestDigest",
	"kind",
	"revertScope",
	"selectorKind",
	"selector",
	"historyManifest",
	"expectedMessageVersion",
	"expectedFileCount",
	"parentRevertId",
];

export function revertPlanHeaderDigest(input: RevertPlanHeader): string {
	return digest(normalizeHeader(input));
}

export function fingerprintRevertPlanFiles(files: AppendRevertPlanFile[]) {
	integer(files.length, "files", 0, FILE_CHANGE_LIMITS.revertFiles);
	return fingerprintNormalizedFiles(files.map(normalizeFile));
}

export function fingerprintNormalizedFiles(files: ReturnType<typeof normalizeFile>[]) {
	const entries = new Map<number, string>();
	const identities = new Set<string>();
	let fileEvidenceBytes = 0;
	for (const file of files) {
		integer(file.sequence, "sequence", 0, files.length - 1);
		if (entries.has(file.sequence) || identities.has(file.fileKey))
			throw fail("DUPLICATE_FILE", "The complete file list contains duplicates");
		entries.set(file.sequence, digest(file));
		identities.add(file.fileKey);
		fileEvidenceBytes += stateBytes(file.expected) + stateBytes(file.desired);
		evidenceBudget(fileEvidenceBytes);
	}
	return { fileCount: files.length, orderedFilesDigest: orderedDigest(entries), fileEvidenceBytes };
}

export function normalizeOwner(input: RevertPlanOwner): RevertPlanOwner {
	text(input.subjectKey, "subjectKey");
	return {
		subjectKey: input.subjectKey,
		narratorId: nullableId(input.narratorId),
		projectId: nullableId(input.projectId),
	};
}

export function normalizeHeader(input: RevertPlanHeader) {
	text(input.idempotencyKey, "idempotencyKey");
	sha256(input.requestDigest);
	if (
		!["revert", "unrevert", "history_delete", "rollback_to_block", "edit_regenerate"].includes(
			input.kind,
		) ||
		!["narrator", "workspace"].includes(input.revertScope) ||
		!["all", "from_seq", "messages", "tool_calls", "after_block"].includes(input.selectorKind)
	)
		throw fail("INVALID_INPUT", "Unknown plan kind, scope or selector kind");
	integer(input.expectedFileCount, "expectedFileCount", 0, FILE_CHANGE_LIMITS.revertFiles);
	integer(input.expectedMessageVersion, "expectedMessageVersion");
	const owner = normalizeOwner(input);
	if (input.revertScope === "narrator" && !owner.narratorId)
		throw fail("INVALID_INPUT", "Narrator scope requires a narrator context");
	const parentRevertId = nullableId(input.parentRevertId ?? null);
	if ((input.kind === "unrevert") !== (parentRevertId !== null))
		throw fail("PARENT_UNAVAILABLE", "Only unrevert requires a committed parent journal");
	const header = {
		...owner,
		protocolVersion: FILE_CHANGE_EVIDENCE_VERSION,
		idempotencyKey: input.idempotencyKey,
		requestDigest: input.requestDigest,
		kind: input.kind,
		revertScope: input.revertScope,
		selectorKind: input.selectorKind,
		selector: normalizeRef(input.selector),
		historyManifest: normalizeRef(input.historyManifest),
		expectedMessageVersion: input.expectedMessageVersion,
		expectedFileCount: input.expectedFileCount,
		parentRevertId,
	};
	metadata(header);
	return header;
}

export function normalizeProof(input: RevertPlanManifestProof): RevertPlanManifestProof {
	keys(input, [
		"source",
		"headerDigest",
		"orderedFilesDigest",
		"fileEvidenceBytes",
		"computation",
		"selectorCoverage",
		"historyCoverage",
		"omittedFiles",
		"unknownFiles",
	]);
	if (
		input.source !== "trusted_published_planner_v1" ||
		(input.computation !== "complete" && input.computation !== "partial") ||
		input.selectorCoverage !== "complete" ||
		(input.historyCoverage !== "complete" && input.historyCoverage !== "partial") ||
		input.omittedFiles < 0 ||
		input.unknownFiles < 0
	)
		throw fail(
			"COVERAGE_UNPROVEN",
			"Explicit complete computation and source coverage with no unknown/omitted files are required",
		);
	sha256(input.headerDigest);
	sha256(input.orderedFilesDigest);
	integer(
		input.fileEvidenceBytes,
		"fileEvidenceBytes",
		0,
		FILE_CHANGE_LIMITS.operationEvidenceBytes,
	);
	return { ...input };
}

export function normalizeRef(ref: FileChangeBlobRef): FileChangeBlobRef {
	keys(ref, ["algorithm", "digest", "sizeBytes"]);
	if (ref.algorithm !== "sha256") throw fail("INVALID_INPUT", "Only SHA-256 refs are supported");
	sha256(ref.digest);
	integer(ref.sizeBytes, "blob size", 0, FILE_CHANGE_LIMITS.blobBytes);
	return { algorithm: "sha256", digest: ref.digest, sizeBytes: ref.sizeBytes };
}

export function normalizeState(state: FileChangeState): KnownFileChangeState {
	if (!state || state.kind === "unknown")
		throw fail("UNKNOWN_STATE", "Unknown/null states cannot enter a fixed plan");
	if (state.kind === "absent") {
		keys(state, ["kind"]);
		return { kind: "absent" };
	}
	if (state.kind !== "regular" && state.kind !== "symlink")
		throw fail("UNKNOWN_STATE", "Unsupported file state");
	keys(state, state.kind === "regular" ? ["kind", "blob", "mode"] : ["kind", "target", "mode"]);
	if (state.mode !== null) integer(state.mode, "mode", 0, 0xffff);
	return state.kind === "regular"
		? { kind: "regular", blob: normalizeRef(state.blob), mode: state.mode }
		: { kind: "symlink", target: normalizeRef(state.target), mode: state.mode };
}

export function normalizeFile(input: AppendRevertPlanFile) {
	keys(input, ["sequence", "identity", "expected", "desired"]);
	integer(input.sequence, "sequence", 0, FILE_CHANGE_LIMITS.revertFiles - 1);
	keys(input.identity, [
		"sourceInstanceId",
		"deviceId",
		"workspaceInstanceId",
		"scopeId",
		"pathFlavor",
		"objectRole",
		"canonicalPath",
		"lexicalPath",
		"displayPath",
	]);
	const fileKey = fileChangeIdentityKey(input.identity);
	const file = {
		sequence: input.sequence,
		identity: { ...input.identity },
		fileKey,
		expected: normalizeState(input.expected),
		desired: normalizeState(input.desired),
	};
	metadata(file);
	return file;
}

export function headerFromRow(
	row: PlanRecord,
	refs: { selector: FileChangeBlobRef; historyManifest: FileChangeBlobRef },
) {
	if (row.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION || row.expectedMessageVersion === null)
		throw fail("LEGACY_UNVERIFIED", "A full v2 plan journal is required");
	return normalizeHeader({
		subjectKey: row.requestedBySubjectKey,
		narratorId: row.narratorId,
		projectId: row.projectId,
		idempotencyKey: row.idempotencyKey,
		requestDigest: row.requestDigest,
		kind: row.kind,
		revertScope: row.scope,
		selectorKind: row.selectorKind,
		...refs,
		expectedMessageVersion: row.expectedMessageVersion,
		expectedFileCount: row.fileCount,
		parentRevertId: row.parentRevertId,
	});
}

export function planHash(
	header: ReturnType<typeof normalizeHeader>,
	plan: FileChangeBlobRef,
	proof: RevertPlanManifestProof,
) {
	return digest(["revert-plan-commitment-v1", header, plan, proof]);
}

export function orderedDigest(entries: Map<number, string>): string {
	const hash = createHash("sha256").update("revert-plan-ordered-files-v1\n");
	for (let sequence = 0; sequence < entries.size; sequence++) {
		const entry = entries.get(sequence);
		if (!entry) throw fail("INCOMPLETE_SET", "The ordered manifest has a missing position");
		hash.update(`${sequence}:${entry}\n`);
	}
	return hash.digest("hex");
}

export function fileValues(operation: PlanRecord, file: ReturnType<typeof normalizeFile>) {
	const binding = [
		operation.id,
		operation.requestDigest,
		operation.planHash,
		file.fileKey,
		file.sequence,
	];
	return {
		revertOperationId: operation.id,
		scopeId: file.identity.scopeId,
		fileKey: file.fileKey,
		identityJson: file.identity,
		sequence: file.sequence,
		expectedStateJson: file.expected,
		desiredStateJson: file.desired,
		beforeBlobDigest: stateRef(file.expected)?.digest ?? null,
		desiredBlobDigest: stateRef(file.desired)?.digest ?? null,
		applyMutationId: digest(["revert-mutation-v1", ...binding, "apply"]),
		compensateMutationId: digest(["revert-mutation-v1", ...binding, "compensate"]),
		applyRequestDigest: digest([
			"revert-request-v1",
			...binding,
			"apply",
			file.expected,
			file.desired,
		]),
		compensateRequestDigest: digest([
			"revert-request-v1",
			...binding,
			"compensate",
			file.desired,
			file.expected,
		]),
	};
}

export function assertFileValues(row: FileRecord, values: ReturnType<typeof fileValues>) {
	for (const key of Object.keys(values) as (keyof typeof values)[])
		if (!equal(row[key], values[key]))
			throw fail("REQUEST_CONFLICT", "A file's immutable metadata or phase binding changed");
	if (
		row.status !== "prepared" ||
		row.observedAfterStateJson !== null ||
		row.observedAfterBlobDigest !== null ||
		row.compensationAfterStateJson !== null ||
		row.compensationAfterBlobDigest !== null ||
		row.receiptJson !== null
	)
		throw fail("INVALID_TRANSITION", "An attempted/unknown file is not a prepared intent");
}

export function assertScope(tx: Executor, identity: FileChangeIdentity) {
	const scope = tx
		.select({
			id: fileChangeScopes.id,
			sourceInstanceId: fileChangeScopes.sourceInstanceId,
			deviceId: fileChangeScopes.deviceId,
			workspaceInstanceId: fileChangeScopes.workspaceInstanceId,
			canonicalRoot: fileChangeScopes.canonicalRoot,
			pathFlavor: fileChangeScopes.pathFlavor,
			status: fileChangeScopes.status,
		})
		.from(fileChangeScopes)
		.where(eq(fileChangeScopes.id, identity.scopeId))
		.get();
	if (!scope || scope.status !== "active")
		throw fail("TARGET_UNVERIFIED", "A verified active scope is required");
	if (!equal(createFileChangeIdentity(scope, identity), identity))
		throw fail(
			"IDENTITY_CONFLICT",
			"Identity does not match its actual source/device/workspace/path scope",
		);
}

export function assertParent(
	tx: Executor,
	row: Pick<
		PlanRecord,
		"kind" | "parentRevertId" | "requestedBySubjectKey" | "narratorId" | "projectId"
	>,
) {
	if (row.kind !== "unrevert") return;
	const parent = tx
		.select()
		.from(revertOperations)
		.where(
			and(
				eq(revertOperations.id, row.parentRevertId ?? ""),
				eq(revertOperations.requestedBySubjectKey, row.requestedBySubjectKey),
				sql`${revertOperations.narratorId} IS ${row.narratorId}`,
				sql`${revertOperations.projectId} IS ${row.projectId}`,
			),
		)
		.get();
	if (
		!parent ||
		parent.kind !== "revert" ||
		parent.status !== "committed" ||
		parent.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION ||
		!parent.coverageComplete ||
		!parent.planHash ||
		!parent.planBlobDigest ||
		!parent.selectorBlobDigest ||
		!parent.historyManifestBlobDigest ||
		parent.expectedMessageVersion === null
	)
		throw fail(
			"PARENT_UNAVAILABLE",
			"Unrevert requires a committed v2 revert journal in the same authorized owner/context",
		);
	metadata(parent);
}

export function assertPlanned(row: PlanRecord) {
	if (row.protocolVersion !== FILE_CHANGE_EVIDENCE_VERSION || row.expectedMessageVersion === null)
		throw fail("LEGACY_UNVERIFIED", "A full v2 plan declaration is required");
	integer(row.fileCount, "expectedFileCount", 0, FILE_CHANGE_LIMITS.revertFiles);
	if (
		row.status !== "planned" ||
		row.coverageComplete ||
		row.appliedFileCount !== 0 ||
		!row.planHash
	)
		throw fail("INVALID_TRANSITION", "Only an incomplete unattempted plan accepts preparation");
}

export function assertSameRevision(before: PlanRecord, after: PlanRecord) {
	if (before.updatedAt !== after.updatedAt || !equal(before, after))
		throw fail(
			"CONCURRENT_CHANGE",
			"The plan changed between preparation pages; retry from the beginning",
		);
}

export function requireOwner(tx: Executor, owner: RevertPlanOwner, planId: string): PlanRecord {
	text(planId, "planId");
	const row = tx
		.select()
		.from(revertOperations)
		.where(
			and(
				eq(revertOperations.id, planId),
				eq(revertOperations.requestedBySubjectKey, owner.subjectKey),
				sql`${revertOperations.narratorId} IS ${owner.narratorId}`,
				sql`${revertOperations.projectId} IS ${owner.projectId}`,
			),
		)
		.get();
	if (!row) throw fail("NOT_FOUND", "Plan not found in the owning context");
	metadata(row);
	return row;
}

export function catalogRef(tx: Executor, digestValue: string | null): FileChangeBlobRef {
	if (!digestValue) throw fail("LEGACY_UNVERIFIED", "Original manifest references are required");
	const blob = tx
		.select({
			digest: fileChangeBlobs.digest,
			sizeBytes: fileChangeBlobs.sizeBytes,
			status: fileChangeBlobs.status,
		})
		.from(fileChangeBlobs)
		.where(eq(fileChangeBlobs.digest, digestValue))
		.get();
	if (!blob || blob.status !== "ready")
		throw fail("BLOB_NOT_READY", "A referenced published object is not ready");
	return normalizeRef({ algorithm: "sha256", digest: blob.digest, sizeBytes: blob.sizeBytes });
}

export function requireReadyRef(tx: Executor, ref: FileChangeBlobRef) {
	if (!equal(catalogRef(tx, ref.digest), ref))
		throw fail("BLOB_NOT_READY", "Published object size does not match the fixed reference");
}

export function assertPinnedRefsStillReady(tx: Executor, planId: string) {
	// Scoped EXISTS, <=1000 admitted files; no body materialization or global aggregate.
	// Recheck readiness changed during a page yield, not just the last visited page.
	const before = alias(fileChangeBlobs, "revert_expected_blob");
	const desired = alias(fileChangeBlobs, "revert_desired_blob");
	const row = tx
		.select({ id: revertOperationFiles.id })
		.from(revertOperationFiles)
		.leftJoin(before, eq(revertOperationFiles.beforeBlobDigest, before.digest))
		.leftJoin(desired, eq(revertOperationFiles.desiredBlobDigest, desired.digest))
		.leftJoin(fileChangeScopes, eq(revertOperationFiles.scopeId, fileChangeScopes.id))
		.where(
			and(
				eq(revertOperationFiles.revertOperationId, planId),
				sql`(
			${revertOperationFiles.status} != 'prepared' OR ${fileChangeScopes.status} IS NOT 'active'
			OR (${revertOperationFiles.beforeBlobDigest} IS NOT NULL AND (${before.status} IS NOT 'ready'
				OR ${before.sizeBytes} IS NOT coalesce(json_extract(${revertOperationFiles.expectedStateJson}, '$.blob.sizeBytes'), json_extract(${revertOperationFiles.expectedStateJson}, '$.target.sizeBytes'))))
			OR (${revertOperationFiles.desiredBlobDigest} IS NOT NULL AND (${desired.status} IS NOT 'ready'
				OR ${desired.sizeBytes} IS NOT coalesce(json_extract(${revertOperationFiles.desiredStateJson}, '$.blob.sizeBytes'), json_extract(${revertOperationFiles.desiredStateJson}, '$.target.sizeBytes'))))
		)`,
			),
		)
		.limit(1)
		.get();
	if (row)
		throw fail(
			"BLOB_NOT_READY",
			"Pinned file evidence or scope became unavailable during preparation",
		);
}

export function selectFiles(
	tx: Executor,
	planId: string,
	cursor: RevertPlanFileCursor | undefined,
	limit: number,
): FileRecord[] {
	return tx
		.select()
		.from(revertOperationFiles)
		.where(
			and(
				eq(revertOperationFiles.revertOperationId, planId),
				cursor ? sql`${revertOperationFiles.fileKey} > ${cursor.fileKey}` : undefined,
			),
		)
		.orderBy(asc(revertOperationFiles.fileKey))
		.limit(limit)
		.all();
}

export function fileCursor(row: FileRecord): RevertPlanFileCursor {
	return { fileKey: row.fileKey };
}

export function stateRef(state: KnownFileChangeState) {
	return state.kind === "regular" ? state.blob : state.kind === "symlink" ? state.target : null;
}

export function stateBytes(state: KnownFileChangeState) {
	return stateRef(state)?.sizeBytes ?? 0;
}

export function refBytes(refs: {
	selector: FileChangeBlobRef;
	plan: FileChangeBlobRef;
	historyManifest: FileChangeBlobRef;
}) {
	return refs.selector.sizeBytes + refs.plan.sizeBytes + refs.historyManifest.sizeBytes;
}

export function boundedPage<T, C>(
	rows: T[],
	limit: number,
	cursor: (row: T) => C,
): RevertPlanPage<T, C> {
	const items: T[] = [];
	let bytes = 1024;
	for (const row of rows) {
		metadata(row);
		const size = Buffer.byteLength(JSON.stringify(row)) + 1;
		if (items.length === limit || bytes + size > FILE_CHANGE_LIMITS.summaryBytes) break;
		items.push(row);
		bytes += size;
	}
	if (rows.length && !items.length)
		throw fail("METADATA_BUDGET", "A row cannot fit in a bounded summary");
	const hasMore = rows.length > items.length;
	const last = items.at(-1);
	return { items, hasMore, nextCursor: hasMore && last ? cursor(last) : null };
}

export function pageLimit(value: number = FILE_CHANGE_LIMITS.historyPageItems) {
	integer(value, "page size", 1, FILE_CHANGE_LIMITS.historyPageItems);
	return value;
}

export function nullableId(value: string | null) {
	if (value !== null) text(value, "context id");
	return value;
}

export function text(value: string, name: string) {
	if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 256)
		throw fail("INVALID_INPUT", `Invalid ${name}`);
}

export function integer(value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw fail("BUDGET_OR_INPUT", `Invalid or over-budget ${name}`);
}

export function sha256(value: string) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		throw fail("INVALID_INPUT", "Invalid SHA-256 digest");
}

export function keys(value: object, allowed: string[]) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !allowed.includes(key))
	)
		throw fail("INVALID_INPUT", "Only bounded, declared metadata fields are accepted");
}

export function metadata(value: unknown) {
	if (Buffer.byteLength(JSON.stringify(value)) > FILE_CHANGE_LIMITS.metadataBytes)
		throw fail("METADATA_BUDGET", "Metadata exceeds the shared row budget");
}

export function evidenceBudget(bytes: number) {
	integer(bytes, "evidence bytes", 0, FILE_CHANGE_LIMITS.operationEvidenceBytes);
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

export function digest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

export function equal(a: unknown, b: unknown): boolean {
	return canonical(a) === canonical(b);
}

export function fail(code: string, message: string) {
	return new RevertPlanError(code, message);
}
