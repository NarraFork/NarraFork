import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { FILE_CHANGE_LIMITS } from "../../shared/file-change-protocol";
import {
	fileChangeBlobReservations,
	fileChangeBlobs,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
	fileChangeStorageBudgets,
	revertOperationFiles,
	revertOperations,
} from "../db/schema";
import { boundedBodyText, hasBlockStorage } from "../lib/narrator-bodies";

export interface FileBlobReadInput {
	kind: "budget" | "metadata" | "reservations";
	digest: string | null;
	status: "reserved" | "reconcile_required" | null;
	after: { createdAt: string; id: string } | null;
	limit: number;
}
export function readFileBlobCatalog(
	sqlite: Database,
	input: FileBlobReadInput,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const db = drizzle(sqlite);
	const budget =
		db
			.select()
			.from(fileChangeStorageBudgets)
			.where(eq(fileChangeStorageBudgets.id, "file-change-blobs"))
			.limit(1)
			.get() ?? null;
	const blob =
		input.kind === "metadata" && input.digest
			? (db
					.select()
					.from(fileChangeBlobs)
					.where(eq(fileChangeBlobs.digest, input.digest))
					.limit(1)
					.get() ?? null)
			: null;
	const reservations =
		input.kind === "reservations" && budget && input.status !== null
			? db
					.select()
					.from(fileChangeBlobReservations)
					.where(
						and(
							eq(fileChangeBlobReservations.budgetId, budget.id),
							eq(fileChangeBlobReservations.status, input.status),
							input.after
								? sql`(${fileChangeBlobReservations.createdAt}, ${fileChangeBlobReservations.id}) > (${input.after.createdAt}, ${input.after.id})`
								: undefined,
						),
					)
					.orderBy(asc(fileChangeBlobReservations.createdAt), asc(fileChangeBlobReservations.id))
					.limit(input.limit + 1)
					.all()
			: [];
	signal.throwIfAborted();
	return { budget, blob, reservations };
}
export type FileBlobReadSnapshot = ReturnType<typeof readFileBlobCatalog>;

export interface EditorOperationReadInput {
	sourceInstanceId: string;
	sourceId: string;
}
export function readEditorOperationEvidence(
	sqlite: Database,
	input: EditorOperationReadInput,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const db = drizzle(sqlite);
	const operation =
		db
			.select()
			.from(fileChangeOperations)
			.where(
				and(
					eq(fileChangeOperations.sourceInstanceId, input.sourceInstanceId),
					eq(fileChangeOperations.sourceKind, "editor"),
					eq(fileChangeOperations.sourceId, input.sourceId),
					eq(fileChangeOperations.attempt, 1),
				),
			)
			.limit(1)
			.get() ?? null;
	const effects = operation
		? db
				.select()
				.from(fileChangeEffects)
				.where(eq(fileChangeEffects.operationId, operation.id))
				.orderBy(asc(fileChangeEffects.fileKey), asc(fileChangeEffects.phase))
				.limit(3)
				.all()
		: [];
	signal.throwIfAborted();
	return { operation, effects };
}
export type EditorOperationReadSnapshot = ReturnType<typeof readEditorOperationEvidence>;

export interface RevertReadInput {
	owner: { subjectKey: string; narratorId: string | null; projectId: string | null };
	planId: string;
	cursor: string | null;
	limit: number;
}
export function revertPlanFilesQuery(
	db: Pick<ReturnType<typeof drizzle>, "select">,
	input: RevertReadInput,
	planId: string,
) {
	return db
		.select()
		.from(revertOperationFiles)
		.where(
			and(
				eq(revertOperationFiles.revertOperationId, planId),
				input.cursor ? sql`${revertOperationFiles.fileKey} > ${input.cursor}` : undefined,
			),
		)
		.orderBy(asc(revertOperationFiles.fileKey))
		.limit(input.limit);
}
export function readRevertPlan(sqlite: Database, input: RevertReadInput, signal: AbortSignal) {
	signal.throwIfAborted();
	const db = drizzle(sqlite);
	const operation =
		db
			.select()
			.from(revertOperations)
			.where(
				and(
					eq(revertOperations.id, input.planId),
					eq(revertOperations.requestedBySubjectKey, input.owner.subjectKey),
					sql`${revertOperations.narratorId} IS ${input.owner.narratorId}`,
					sql`${revertOperations.projectId} IS ${input.owner.projectId}`,
				),
			)
			.limit(1)
			.get() ?? null;
	const files = operation && input.limit ? revertPlanFilesQuery(db, input, operation.id).all() : [];
	const budget =
		db
			.select()
			.from(fileChangeStorageBudgets)
			.where(eq(fileChangeStorageBudgets.id, "file-change-blobs"))
			.limit(1)
			.get() ?? null;
	const scopeIds = [...new Set(files.map((file) => file.scopeId))];
	const scopes = scopeIds.length
		? db
				.select()
				.from(fileChangeScopes)
				.where(inArray(fileChangeScopes.id, scopeIds))
				.limit(101)
				.all()
		: [];
	const digests = [
		...new Set(
			[
				operation?.selectorBlobDigest,
				operation?.planBlobDigest,
				operation?.historyManifestBlobDigest,
				...files.map((file) => file.desiredBlobDigest),
			].filter((value): value is string => typeof value === "string"),
		),
	];
	const blobs = digests.length
		? db
				.select()
				.from(fileChangeBlobs)
				.where(inArray(fileChangeBlobs.digest, digests))
				.limit(104)
				.all()
		: [];
	signal.throwIfAborted();
	return { operation, files, budget, scopes, blobs };
}
export type RevertReadSnapshot = ReturnType<typeof readRevertPlan>;

export interface RevertBodyInput {
	id: string;
	contentBytes: number;
	digestOnly: boolean;
}
export interface RevertBodySummary {
	digest: string;
	blocks: Array<{
		index: number;
		key: string;
		digest: string;
		type: string;
		toolUseId: string | null;
	}>;
}
export interface RevertBodyVerifyInput {
	entries: Array<{ id: string; contentBytes: number; digest: string }>;
}
export function validateRevertSelectionBodyVerify(input: unknown): input is RevertBodyVerifyInput {
	if (!input || typeof input !== "object") return false;
	const entries = (input as Record<string, unknown>).entries;
	if (!Array.isArray(entries) || !entries.length || entries.length > 16) return false;
	let bytes = 0;
	for (const raw of entries) {
		if (!raw || typeof raw !== "object") return false;
		const entry = raw as Record<string, unknown>;
		if (
			typeof entry.id !== "string" ||
			!entry.id ||
			Buffer.byteLength(entry.id) > 256 ||
			typeof entry.digest !== "string" ||
			!/^[a-f0-9]{64}$/.test(entry.digest) ||
			typeof entry.contentBytes !== "number" ||
			!Number.isSafeInteger(entry.contentBytes) ||
			entry.contentBytes < 0
		)
			return false;
		bytes += entry.contentBytes;
		if (bytes > FILE_CHANGE_LIMITS.historyCowBytes) return false;
	}
	return true;
}
export function readRevertSelectionBody(
	sqlite: Database,
	input: RevertBodyInput,
	signal: AbortSignal,
): {
	summary: RevertBodySummary | null;
	error: "STALE" | "BODY_UNVERIFIED" | null;
} {
	signal.throwIfAborted();
	// Measure and assemble the same body inside the caller's readonly snapshot.
	const body = boundedBodyText(sqlite, input.id, hasBlockStorage(sqlite), {
		maxBytes: FILE_CHANGE_LIMITS.historyCowBytes,
		exactBytes: input.contentBytes,
	});
	if (body === undefined) return { summary: null, error: "STALE" };
	const hash = (text: string) => createHash("sha256").update(text).digest("hex");
	const digest = hash(body);
	if (input.digestOnly) return { summary: { digest, blocks: [] }, error: null };
	try {
		const parsed: unknown = JSON.parse(body);
		if (!Array.isArray(parsed) || parsed.length > FILE_CHANGE_LIMITS.historyToolRelatedChanges)
			throw new Error("block budget");
		const seen = new Set<string>();
		const blocks: RevertBodySummary["blocks"] = [];
		let bytes = Buffer.byteLength(JSON.stringify({ digest, blocks }));
		for (let index = 0; index < parsed.length; index++) {
			signal.throwIfAborted();
			const block = parsed[index];
			if (!block || typeof block.type !== "string" || block.type.length > 100)
				throw new Error("invalid block");
			if (
				block.type === "compact" &&
				(block.status === "compacting" ||
					block.status === "running" ||
					block.attempts?.at(-1)?.status === "running")
			)
				throw new Error("live compact");
			const toolUseId = block.type === "tool_use" ? block.id : null;
			if (
				block.type === "tool_use" &&
				(typeof toolUseId !== "string" ||
					!toolUseId ||
					toolUseId.length > 256 ||
					seen.has(toolUseId))
			)
				throw new Error("tool identity");
			if (toolUseId) seen.add(toolUseId);
			const blockDigest = hash(JSON.stringify(block));
			const item = {
				index,
				key: hash(JSON.stringify([input.id, digest, index, blockDigest])),
				digest: blockDigest,
				type: block.type,
				toolUseId,
			};
			bytes += Buffer.byteLength(JSON.stringify(item)) + (blocks.length ? 1 : 0);
			if (bytes > FILE_CHANGE_LIMITS.summaryBytes) throw new Error("metadata budget");
			blocks.push(item);
		}
		return { summary: { digest, blocks }, error: null };
	} catch {
		signal.throwIfAborted();
		return { summary: null, error: "BODY_UNVERIFIED" };
	}
}
export function readRevertSelectionBodyVerify(
	sqlite: Database,
	input: RevertBodyVerifyInput,
	signal: AbortSignal,
): { matches: boolean } {
	if (!validateRevertSelectionBodyVerify(input))
		throw new Error("Invalid bounded body verification batch");
	let matches = true;
	for (const entry of input.entries) {
		signal.throwIfAborted();
		const current = readRevertSelectionBody(
			sqlite,
			{ id: entry.id, contentBytes: entry.contentBytes, digestOnly: true },
			signal,
		);
		if (current.error || current.summary?.digest !== entry.digest) matches = false;
	}
	return { matches };
}
