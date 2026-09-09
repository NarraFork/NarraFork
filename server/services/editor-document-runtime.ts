import { join, relative, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { getNarraforkHome } from "../lib/narrafork-home";
import { settings } from "../lib/settings";
import {
	type EditorDocumentDependencies,
	EditorDocumentError,
	EditorDocumentService,
} from "./editor-document-service";
import {
	EditorFileChangeUncertainError,
	executeEditorFileChange,
	getDefaultLocalFileChangeRuntime,
} from "./file-change-runtime";
import { closeClaim, openClaim, sealClaim } from "./worktree-write-claims";

export function getEditorDocumentService(): EditorDocumentService {
	// A hot module reload must not clean up the live previous generation's pinned objects.
	return hotSafe(
		"narrafork.editor-documents.v1",
		() =>
			new EditorDocumentService({
				root: join(getNarraforkHome(), "editor-transfers"),
				execute: executeEditorFileChange,
				queryOperation: queryEditorOperation,
				async afterWrite(binding, narratorId, requestId, run, actor) {
					const rel = relative(binding.cwd, binding.canonicalPath);
					const claimPath =
						rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel.split(sep).join("/") : null;
					const claimId = `human-${requestId}`;
					let changed = false;
					try {
						if (claimPath) openClaim(binding.cwd, narratorId, claimId, [claimPath]);
						await run();
						changed = true;
						try {
							if (claimPath) closeClaim(binding.cwd, claimId, [claimPath]);
						} catch (error) {
							logger.debug("Closing large editor claim failed", { error: String(error) });
						}
						try {
							const { interjectFileEditAsUserMessage } = await import("./file-edit-interject");
							await interjectFileEditAsUserMessage(narratorId, {
								filePath: binding.canonicalPath,
								worktreePath: binding.cwd,
								lineStats: null,
								locale: actor.locale ?? "en",
								userId: actor.userId,
							});
						} catch (error) {
							logger.debug("Large editor save notification failed", { error: String(error) });
						}
					} catch (error) {
						changed = error instanceof EditorFileChangeUncertainError;
						try {
							if (claimPath) sealClaim(binding.cwd, claimId);
						} catch (claimError) {
							logger.debug("Sealing large editor claim failed", { error: String(claimError) });
						}
						throw error;
					} finally {
						if (changed && claimPath) {
							try {
								const { invalidateWorkspaceTreeCache } = await import("./narrator-session-state");
								invalidateWorkspaceTreeCache(binding.cwd);
								if (settings.chapters.treeSnapshotsEnabled) {
									const { worktreeTreeSnapshot } = await import("./worktree-tree-snapshot");
									const tree = await worktreeTreeSnapshot.tryCaptureHot(binding.cwd, "local");
									if (tree) {
										const { advanceChapterSnapshot } = await import("./chapter-snapshot-ref");
										await advanceChapterSnapshot(binding.cwd, tree, "human editor save");
									}
								}
							} catch (error) {
								logger.debug("Large editor compatibility snapshot failed", {
									error: String(error),
								});
							}
						}
					}
				},
			}),
	);
}

export const queryEditorOperation: NonNullable<
	EditorDocumentDependencies["queryOperation"]
> = async (actor, operationId, recovery) => {
	const [{ db }, { fileChangeOperations }] = await Promise.all([
		import("../db"),
		import("../db/schema"),
	]);
	const runtime = await getDefaultLocalFileChangeRuntime();
	const namespace = await runtime.verifyNamespace();
	// Unique source-instance/kind/id/attempt lookup, never a journal scan.
	const row = db
		.select({
			id: fileChangeOperations.id,
			owner: fileChangeOperations.ownerUserId,
			narrator: fileChangeOperations.narratorId,
			status: fileChangeOperations.executionOutcome,
			settlement: fileChangeOperations.settlement,
		})
		.from(fileChangeOperations)
		.where(
			and(
				eq(fileChangeOperations.sourceInstanceId, namespace.sourceInstanceId),
				eq(fileChangeOperations.sourceKind, "editor"),
				eq(fileChangeOperations.sourceId, operationId),
				eq(fileChangeOperations.attempt, 1),
			),
		)
		.get();
	if (!row || row.owner !== actor.userId || row.narrator !== actor.narratorId)
		throw new EditorDocumentError(
			"EDITOR_OPERATION_UNKNOWN",
			"No owned durable receipt is available; verify before retrying",
			404,
		);
	if (row.settlement !== "settled") return { status: "uncertain", operationId };
	if (row.status !== "succeeded") return { status: "failed", operationId };
	if (
		!recovery ||
		recovery.operationId !== operationId ||
		recovery.userId !== actor.userId ||
		recovery.narratorId !== actor.narratorId
	)
		return {
			status: "uncertain",
			operationId,
			error: {
				code: "EDITOR_RESULT_UNAVAILABLE",
				message:
					"The write settled, but its saved snapshot metadata is unavailable; verify before retrying",
			},
		};
	const effects = runtime.evidence.listEffects(row.id, { limit: 2 }).items;
	const after = effects[0]?.observedAfterStateJson;
	if (
		effects.length !== 1 ||
		after?.kind !== "regular" ||
		after.blob.digest !== recovery.rawDigest ||
		after.blob.sizeBytes !== recovery.bytes
	)
		return { status: "uncertain", operationId };
	return {
		status: "saved",
		operationId,
		result: {
			status: "saved",
			operationId,
			hash: recovery.hash,
			bytes: recovery.bytes,
			snapshotRevision: recovery.snapshotRevision,
		},
	};
};

export function editorRuntimeUnavailable(error: unknown): never {
	if (error instanceof AppError) throw error;
	throw new AppError(
		"Editor operation receipt is unavailable; verify before retrying",
		503,
		"EDITOR_OPERATION_UNKNOWN",
	);
}
