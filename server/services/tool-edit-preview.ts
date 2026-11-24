import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	FILE_CHANGE_EVIDENCE_VERSION,
	FILE_CHANGE_LIMITS,
	type FileChangeState,
	isFileHistoryEnabledForDevice,
} from "@shared/file-change-protocol";
import type {
	ToolEditPreview,
	ToolEditPreviewSide,
	ToolEditPreviewUnavailableReason,
} from "@shared/tool-edit-preview";
import { and, eq, inArray } from "drizzle-orm";
import { activeDatabaseBackend, db, sqlite } from "../db";
import { narratorToolCalls, worktreeTreeSnapshots } from "../db/schema";
import { readQuery, readQueryFirst } from "../db/worker-read";
import { runReadTask, WorkersUnavailableError } from "../lib/db-worker/pool";
import {
	sameToolEditBinding,
	type ToolEditEffect,
	type ToolEditOperation,
	type ToolEditPreviewSnapshot,
} from "../lib/db-worker/tool-edit-preview-query";
import { logger } from "../lib/logger";
import { normalizePathForComparison } from "../lib/platform-path";
import { FileChangeBlobStore, FileChangeBlobStoreError } from "./file-change-blob-store";
import { FileChangeEvidenceService } from "./file-change-evidence";
import {
	createFileChangeIdentity,
	type FileChangeScopeIdentity,
	fileChangeIdentityKey,
} from "./file-change-identity";
import { type ToolPreviewReadSnapshot, toolEditPreviewColumns } from "./tool-edit-preview-reader";
import { snapshotPathIdentity } from "./tree-snapshot-paths";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const PREVIEW_TIMEOUT_MS = 5_000;

export { toolEditPreviewColumns } from "./tool-edit-preview-reader";
export type ToolEditPreviewMetadata = ToolPreviewReadSnapshot["row"];
type ToolRow = NonNullable<ToolEditPreviewMetadata>;

type PreviewEvidence =
	| { status: "missing" }
	| { status: "too_large" }
	| {
			status: "ambiguous";
			row: ToolRow;
			original: ToolRow | null;
			operation: ToolEditOperation;
	  }
	| {
			status: "ok";
			row: ToolRow;
			original: ToolRow | null;
			operation: ToolEditOperation;
			effect?: ToolEditEffect;
			scope: FileChangeScopeIdentity | null;
	  };

async function readEvidence(row: ToolRow, signal: AbortSignal): Promise<PreviewEvidence> {
	if (activeDatabaseBackend === "sqlite") {
		if (!sqlite.filename || sqlite.filename === ":memory:" || sqlite.inTransaction)
			throw new WorkersUnavailableError("requires_committed_file");
		const snapshot = await runReadTask<ToolEditPreviewSnapshot>(
			sqlite.filename,
			{ kind: "toolEditPreview", toolCallId: row.id },
			{ signal, timeoutMs: PREVIEW_TIMEOUT_MS },
		);
		if (snapshot.status === "missing" || snapshot.status === "too_large") return snapshot;
		const common = {
			row: snapshot.row as ToolRow,
			original: (snapshot.original as ToolRow | undefined) ?? null,
			operation: snapshot.operation,
		};
		if (snapshot.status === "ambiguous") return { status: "ambiguous", ...common };
		return {
			status: "ok",
			...common,
			effect: snapshot.effect,
			scope: snapshot.scope,
		};
	}
	return readPostgresPreviewSnapshot(row.id, signal);
}

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

function operationMatches(
	row: ToolRow,
	operation: ToolEditOperation,
	original: ToolRow | null = null,
): boolean {
	const originId = row.executionOriginToolCallId ?? row.id;
	if (
		row.executionIdentityVersion !== 1 ||
		row.executionAttempt < 1 ||
		(operation.evidenceVersion !== 2 &&
			operation.evidenceVersion !== FILE_CHANGE_EVIDENCE_VERSION) ||
		operation.sourceKind !== "tool" ||
		operation.sourceId !== originId ||
		operation.toolCallId !== originId ||
		operation.toolUseId !== row.toolUseId ||
		operation.attempt !== row.executionAttempt ||
		(operation.evidenceVersion === 2 &&
			(operation.executionBindingJson?.deviceId !== row.executionDeviceId ||
				operation.executionBindingJson?.runtimeGeneration !== row.runtimeGeneration))
	)
		return false;
	// COW retains the immutable original PK even after the original row is deleted.
	// If it still exists, verify the whole frozen source binding, not just a SDK ID.
	if (row.executionOriginToolCallId) {
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
	operation: ToolEditOperation,
	effect: ToolEditEffect,
	scope: FileChangeScopeIdentity | null,
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
	const identity = snapshotPathIdentity(root);
	const legacyIdentity = normalizePathForComparison(root);
	const paths = identity === legacyIdentity ? [identity] : [identity, legacyIdentity];
	const hashes = [row.treeHashBefore, row.treeHashAfter].filter(
		(hash): hash is string => hash !== null && /^[a-f0-9]{40,64}$/.test(hash),
	);
	if (hashes.length === 0) return missing;
	// The exact tool row already freezes these hashes and cwd. A v1 path alias is
	// evidence only for those explicit hashes, never proof of the current directory.
	const recorded = await readQuery(
		db
			.select({ treeHash: worktreeTreeSnapshots.treeHash })
			.from(worktreeTreeSnapshots)
			.where(
				and(
					eq(worktreeTreeSnapshots.deviceId, row.executionDeviceId as string),
					inArray(worktreeTreeSnapshots.worktreePath, paths),
					inArray(worktreeTreeSnapshots.treeHash, hashes),
				),
			)
			// The unique (device, path, hash) index bounds two paths × two hashes to four rows.
			.limit(4),
		{ executionPolicy: "worker-required", maxRows: 4, signal, timeoutMs: PREVIEW_TIMEOUT_MS },
	);
	const recordedHashes = new Set(recorded.map(({ treeHash }) => treeHash));
	const side = async (hash: string | null): Promise<ToolEditPreviewSide> => {
		if (!hash || !recordedHashes.has(hash)) return unavailable("missing_evidence");
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

async function readPostgresPreviewSnapshot(
	toolCallId: string,
	signal: AbortSignal,
): Promise<PreviewEvidence> {
	const origin = (id: string) =>
		readQueryFirst(
			db
				.select(toolEditPreviewColumns)
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, id))
				.limit(1),
			{ executionPolicy: "worker-required", signal, maxRows: 1, timeoutMs: PREVIEW_TIMEOUT_MS },
		);
	const row = (await origin(toolCallId)) ?? null;
	if (!row) return { status: "missing" };
	const original = row.executionOriginToolCallId
		? ((await origin(row.executionOriginToolCallId)) ?? null)
		: null;
	const evidence = new FileChangeEvidenceService(db);
	const operation = row.fileChangeOperationId
		? await evidence.getOperation(row.fileChangeOperationId, {
				signal,
				timeoutMs: PREVIEW_TIMEOUT_MS,
			})
		: null;
	if (!operation) return { status: "missing" };
	const effects = (
		await evidence.listEffects(operation.id, {
			limit: 2,
			signal,
			timeoutMs: PREVIEW_TIMEOUT_MS,
		})
	).items;
	if (effects.length > 1)
		return {
			status: "ambiguous",
			row,
			original,
			operation: operation as ToolEditOperation,
		};
	const effect = effects[0] as ToolEditEffect | undefined;
	const scope = effect
		? ((await evidence.getScope(effect.scopeId, {
				signal,
				timeoutMs: PREVIEW_TIMEOUT_MS,
			})) as FileChangeScopeIdentity | null)
		: null;
	return {
		status: "ok",
		row,
		original,
		operation: operation as ToolEditOperation,
		effect,
		scope,
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
		signal.throwIfAborted();
		// The message-ref selector supplies the frozen execution target, not request input.
		if (!isFileHistoryEnabledForDevice(row.executionDeviceId)) return result;
		if (!row.fileChangeOperationId) return { ...result, ...(await treePreview(row, signal)) };
		const snapshot = await readEvidence(row, signal);
		signal.throwIfAborted();
		if (snapshot.status === "missing") return reject("missing_evidence");
		if (snapshot.status === "too_large") return reject("too_large");
		if (snapshot.status === "ambiguous") return reject("ambiguous");
		if (
			!sameToolEditBinding(row, snapshot.row) ||
			!operationMatches(row, snapshot.operation, snapshot.original)
		)
			return reject("identity_unverified");
		const { operation, effect, scope } = snapshot;
		if (!effect) return reject("missing_evidence");
		if (!effectMatches(row, operation, effect, scope)) {
			return reject("identity_unverified");
		}
		const blobs = new FileChangeBlobStore();
		const [before, after] = await Promise.all([
			readToolEditPreviewState(effect.beforeStateJson, blobs, signal),
			// Intended bytes are NOT proof of what the backend actually observed.
			readToolEditPreviewState(effect.observedAfterStateJson, blobs, signal),
		]);
		return { ...result, source: "evidence", before, after };
	} catch (error) {
		if (signal.aborted)
			return reject(signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled");
		throw error;
	} finally {
		if (performance.now() - started >= 1_000)
			logger.warn("Slow tool edit preview", {
				toolCallId: row.id,
				elapsedMs: Math.round(performance.now() - started),
			});
	}
}
