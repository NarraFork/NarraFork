import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeState,
} from "@shared/file-change-protocol";
import type {
	ToolEditPreview,
	ToolEditPreviewSide,
	ToolEditPreviewUnavailableReason,
} from "@shared/tool-edit-preview";
import { type AnyColumn, and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorToolCalls, worktreeTreeSnapshots } from "../db/schema";
import { logger } from "../lib/logger";
import { FileChangeBlobStore, FileChangeBlobStoreError } from "./file-change-blob-store";
import {
	type FileChangeEffectRecord,
	FileChangeEvidenceService,
	type FileChangeOperationRecord,
	type FileChangeScopeRecord,
} from "./file-change-evidence";
import { createFileChangeIdentity, fileChangeIdentityKey } from "./file-change-identity";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const PREVIEW_TIMEOUT_MS = 5_000;
const METADATA_BYTES = FILE_CHANGE_LIMITS.metadataBytes;

function boundedText(column: AnyColumn) {
	return sql<
		string | null
	>`CASE WHEN octet_length(${column}) <= ${METADATA_BYTES} THEN ${column} ELSE NULL END`;
}

// Never load inputJson/outputJson: the model's edit strings are not historical evidence.
// Location extraction is separately capped before SQLite attempts to parse JSON.
export const toolEditPreviewColumns = {
	id: narratorToolCalls.id,
	narratorId: narratorToolCalls.narratorId,
	messageId: narratorToolCalls.messageId,
	toolUseId: narratorToolCalls.toolUseId,
	toolName: narratorToolCalls.toolName,
	executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
	executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
	executionAttempt: narratorToolCalls.executionAttempt,
	fileChangeOperationId: narratorToolCalls.fileChangeOperationId,
	executionDeviceId: boundedText(narratorToolCalls.executionDeviceId),
	executionCwd: boundedText(narratorToolCalls.executionCwd),
	executionPathFlavor: narratorToolCalls.executionPathFlavor,
	resolvedFilePath: boundedText(narratorToolCalls.resolvedFilePath),
	canonicalFilePath: boundedText(narratorToolCalls.canonicalFilePath),
	runtimeGeneration: narratorToolCalls.runtimeGeneration,
	treeHashBefore: boundedText(narratorToolCalls.treeHashBefore),
	treeHashAfter: boundedText(narratorToolCalls.treeHashAfter),
	locationJson: sql<string | null>`CASE
		WHEN octet_length(${narratorToolCalls.outputJson}) <= ${64 * 1024}
		THEN CASE WHEN json_valid(${narratorToolCalls.outputJson})
			THEN json_extract(${narratorToolCalls.outputJson}, '$._metadata') END
		END`,
};

export type ToolEditPreviewMetadata = ReturnType<typeof readOrigin>;
function readOrigin(id: string) {
	return db
		.select(toolEditPreviewColumns)
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.id, id))
		.get();
}
type ToolRow = NonNullable<ToolEditPreviewMetadata>;

function unavailable(reason: ToolEditPreviewUnavailableReason): ToolEditPreviewSide {
	return { status: "unavailable", reason };
}

function locationOf(value: string | null): ToolEditPreview["location"] {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== "object") return undefined;
		const { startLine, endLine, newEndLine } = parsed;
		if (
			[startLine, endLine, newEndLine].every((n) => Number.isSafeInteger(n) && n >= 1) &&
			endLine >= startLine &&
			newEndLine >= startLine
		)
			return { startLine, endLine, newEndLine };
	} catch {
		/* Malformed old metadata is not a preview failure. */
	}
	return undefined;
}

function operationMatches(row: ToolRow, operation: FileChangeOperationRecord): boolean {
	const originId = row.executionOriginToolCallId ?? row.id;
	if (
		row.executionIdentityVersion !== 1 ||
		row.executionAttempt < 1 ||
		operation.evidenceVersion !== FILE_CHANGE_EVIDENCE_VERSION ||
		operation.sourceKind !== "tool" ||
		operation.sourceId !== originId ||
		operation.toolCallId !== originId ||
		operation.toolUseId !== row.toolUseId ||
		operation.attempt !== row.executionAttempt ||
		operation.executionBindingJson?.deviceId !== row.executionDeviceId ||
		operation.executionBindingJson?.runtimeGeneration !== row.runtimeGeneration
	)
		return false;
	// COW retains the immutable original PK even after the original row is deleted.
	// If it still exists, verify the whole frozen source binding, not just a SDK ID.
	if (row.executionOriginToolCallId) {
		const original = readOrigin(originId);
		if (
			original &&
			(original.executionOriginToolCallId !== null ||
				original.fileChangeOperationId !== operation.id ||
				original.toolName !== row.toolName ||
				original.canonicalFilePath !== row.canonicalFilePath ||
				original.resolvedFilePath !== row.resolvedFilePath ||
				original.executionPathFlavor !== row.executionPathFlavor ||
				!operationMatches(original, operation))
		)
			return false;
	} else if (operation.narratorId !== row.narratorId) return false;
	return true;
}

function effectMatches(
	row: ToolRow,
	operation: FileChangeOperationRecord,
	effect: FileChangeEffectRecord,
	scope: FileChangeScopeRecord | null,
) {
	const identity = effect.identityJson;
	if (
		!scope ||
		scope.sourceInstanceId !== operation.sourceInstanceId ||
		scope.workspaceInstanceId !== identity.workspaceInstanceId
	)
		return false;
	try {
		const scoped = createFileChangeIdentity(scope, identity);
		if (
			fileChangeIdentityKey(scoped) !== effect.fileKey ||
			fileChangeIdentityKey(identity) !== effect.fileKey
		)
			return false;
	} catch {
		return false;
	}
	return (
		effect.operationId === operation.id &&
		effect.phase === "apply" &&
		identity.scopeId === effect.scopeId &&
		identity.sourceInstanceId === operation.sourceInstanceId &&
		identity.deviceId === row.executionDeviceId &&
		identity.pathFlavor === row.executionPathFlavor &&
		identity.objectRole === "referent" &&
		identity.canonicalPath === row.canonicalFilePath &&
		identity.lexicalPath === row.resolvedFilePath
	);
}

export async function readToolEditPreviewState(
	state: FileChangeState,
	blobs: Pick<FileChangeBlobStore, "readBytes">,
	signal: AbortSignal,
): Promise<ToolEditPreviewSide> {
	if (signal.aborted)
		return unavailable(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled");
	if (state.kind === "absent") return { status: "absent", content: "" };
	if (state.kind === "symlink") return unavailable("unsupported");
	if (state.kind === "unknown") {
		if (state.reason === "budget_exceeded" || state.reason === "quota_exceeded")
			return unavailable("too_large");
		if (state.reason === "unsupported_object" || state.reason === "unsupported_backend")
			return unavailable("unsupported");
		if (state.reason === "cancelled") return unavailable("cancelled");
		return unavailable("missing_evidence");
	}
	if (state.blob.sizeBytes > FILE_CHANGE_LIMITS.previewFileBytes) return unavailable("too_large");
	try {
		const bytes = await blobs.readBytes(state.blob, {
			maxBytes: FILE_CHANGE_LIMITS.previewFileBytes,
			signal,
			timeoutMs: PREVIEW_TIMEOUT_MS,
		});
		if (bytes.includes(0)) return unavailable("binary");
		try {
			return {
				status: "available",
				content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
			};
		} catch {
			return unavailable("invalid_encoding");
		}
	} catch (error) {
		if (signal.aborted)
			return unavailable(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled");
		if (error instanceof FileChangeBlobStoreError) {
			if (error.code === "too_large") return unavailable("too_large");
			if (error.code === "not_found") return unavailable("missing_evidence");
			if (error.code === "timeout") return unavailable("timeout");
			if (error.code === "aborted") return unavailable("cancelled");
		}
		return unavailable("unreadable");
	}
}

async function treePreview(
	row: ToolRow,
	signal: AbortSignal,
): Promise<Pick<ToolEditPreview, "source" | "before" | "after">> {
	const missing = {
		source: "unavailable" as const,
		before: unavailable("missing_evidence"),
		after: unavailable("missing_evidence"),
	};
	const cwd = row.executionCwd;
	const filePath = row.resolvedFilePath;
	// Frozen target only. Never infer a device/cwd from the narrator's current settings.
	if (
		row.executionDeviceId !== "local" ||
		!cwd ||
		!filePath ||
		row.executionPathFlavor !== (process.platform === "win32" ? "windows" : "posix") ||
		!isAbsolute(cwd) ||
		!isAbsolute(filePath) ||
		(row.canonicalFilePath !== null && row.canonicalFilePath !== filePath)
	)
		return missing;
	const rel = relative(cwd, filePath);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return missing;
	const root = resolve(cwd);
	const side = async (hash: string | null): Promise<ToolEditPreviewSide> => {
		if (!hash || !/^[a-f0-9]{40,64}$/.test(hash)) return unavailable("missing_evidence");
		const recorded = db
			.select({ id: worktreeTreeSnapshots.id })
			.from(worktreeTreeSnapshots)
			.where(
				and(
					eq(worktreeTreeSnapshots.deviceId, row.executionDeviceId as string),
					eq(worktreeTreeSnapshots.worktreePath, root),
					eq(worktreeTreeSnapshots.treeHash, hash),
				),
			)
			.limit(1)
			.get();
		if (!recorded) return unavailable("missing_evidence");
		return worktreeTreeSnapshot.readFilePreviewAtTree(
			root,
			hash,
			rel.split(sep).join("/"),
			row.executionDeviceId as string,
			FILE_CHANGE_LIMITS.previewFileBytes,
			{ signal, timeoutMs: PREVIEW_TIMEOUT_MS },
		);
	};
	const [before, after] = await Promise.all([side(row.treeHashBefore), side(row.treeHashAfter)]);
	return {
		source:
			before.status === "unavailable" && after.status === "unavailable" ? "unavailable" : "tree",
		before,
		after,
	};
}

/** Call only with metadata selected by the narrator message-ref visibility selector. */
export async function getToolEditPreview(
	row: ToolRow,
	requestSignal?: AbortSignal,
): Promise<ToolEditPreview> {
	const started = performance.now();
	const timeout = AbortSignal.timeout(PREVIEW_TIMEOUT_MS);
	const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
	const result: ToolEditPreview = {
		toolCallId: row.id,
		toolUseId: row.toolUseId,
		filePath: row.resolvedFilePath,
		deviceId: row.executionDeviceId,
		before: unavailable("missing_evidence"),
		after: unavailable("missing_evidence"),
		location: locationOf(row.locationJson),
		source: "unavailable",
	};
	const reject = (reason: ToolEditPreviewUnavailableReason) => ({
		...result,
		before: unavailable(reason),
		after: unavailable(reason),
	});
	try {
		if (row.toolName !== "Edit" && row.toolName !== "Write") return reject("unsupported");
		if (row.executionPathFlavor === "spec" || row.resolvedFilePath?.startsWith("spec://"))
			return reject("unsupported");
		if (signal.aborted) return reject("cancelled");
		if (!row.fileChangeOperationId) return { ...result, ...(await treePreview(row, signal)) };
		const evidence = new FileChangeEvidenceService(db);
		const operation = evidence.getOperation(row.fileChangeOperationId);
		if (!operation) return reject("missing_evidence");
		if (!operationMatches(row, operation)) return reject("identity_unverified");
		// Edit/Write mutate one file. Fail closed rather than choosing the first effect
		// or traversing an arbitrarily large operation (including compensation phases).
		const page = evidence.listEffects(operation.id, { limit: 2 });
		if (page.hasMore || page.items.length > 1) return reject("ambiguous");
		const effect = page.items[0];
		if (!effect) return reject("missing_evidence");
		if (!effectMatches(row, operation, effect, evidence.getScope(effect.scopeId))) {
			return reject("identity_unverified");
		}
		const blobs = new FileChangeBlobStore();
		const [before, after] = await Promise.all([
			readToolEditPreviewState(effect.beforeStateJson, blobs, signal),
			// Intended bytes are NOT proof of what the backend actually observed.
			readToolEditPreviewState(effect.observedAfterStateJson, blobs, signal),
		]);
		return { ...result, source: "evidence", before, after };
	} finally {
		if (performance.now() - started >= 1_000)
			logger.warn("Slow tool edit preview", {
				toolCallId: row.id,
				elapsedMs: Math.round(performance.now() - started),
			});
	}
}
