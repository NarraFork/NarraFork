import { join, relative, sep } from "node:path";
import { EDITOR_FILE_MAX_BYTES, type EditorOperationResult } from "../../shared/editor-document";
import type { EditorQueryResult } from "../../shared/editor-provider-contracts";
import { resolveBackend } from "../lib/agent/execution/registry";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { getNarraforkHome } from "../lib/narrafork-home";
import { settings } from "../lib/settings";
import { RemoteBackend } from "./device-remote-backend";
import {
	type EditorDocumentDependencies,
	EditorDocumentError,
	EditorDocumentService,
} from "./editor-document-service";
import {
	createEditorFileAtomicIo,
	type EditorReceiptQuery,
	editorOperationNamespace,
	editorWriterResourceKey,
} from "./editor-file-atomic-io";
import type { FileChangeEffectRecord, FileChangeOperationRecord } from "./file-change-evidence";
import { createFileChangeLocalIo } from "./file-change-local-io";
import {
	EditorFileChangeUncertainError,
	executeEditorFileChange,
	getCurrentLocalFileChangeRuntime,
	getDefaultLocalFileChangeRuntime,
	remoteEditorIntent,
} from "./file-change-runtime";
import { workspaceContextService } from "./workspace-context-service";
import { withWorkspaceAdmission } from "./worktree-lifecycle-guard";
import { closeClaim, openClaim, sealClaim } from "./worktree-write-claims";

function remoteQueryRequest(operation: FileChangeOperationRecord, effect: FileChangeEffectRecord) {
	const intent = remoteEditorIntent(operation, effect);
	if (!intent) throw new Error("Original remote editor intent unavailable");
	const namespace = editorOperationNamespace(
		operation.sourceInstanceId,
		intent.ownerUserId,
		intent.deviceId,
	);
	return {
		namespace,
		resourceKey: editorWriterResourceKey(namespace, operation.id, effect.id),
		operationId: operation.sourceId,
		requestDigest: intent.requestDigest,
	};
}
function remoteResult(
	operation: FileChangeOperationRecord,
	effect: FileChangeEffectRecord,
): EditorOperationResult {
	const operationId = operation.sourceId;
	const intent = remoteEditorIntent(operation, effect);
	if (
		!intent ||
		operation.settlement !== "settled" ||
		effect.settlement !== "settled" ||
		!effect.executionConfirmed
	)
		return { status: "uncertain", operationId };
	if (effect.executionReceiptJson?.outcome === "not_applied")
		return { status: "failed", operationId };
	const after = effect.observedAfterStateJson;
	if (
		effect.executionReceiptJson?.outcome !== "applied" ||
		after.kind !== "regular" ||
		after.blob.digest !== intent.intended.blob.digest ||
		after.blob.sizeBytes !== intent.intended.blob.sizeBytes
	)
		return { status: "uncertain", operationId };
	return {
		status: "saved",
		operationId,
		result: {
			status: "saved",
			operationId,
			hashKind: "raw-sha256",
			hash: after.blob.digest,
			bytes: after.blob.sizeBytes,
			snapshotRevision: intent.snapshotRevision,
		},
	};
}
/** ACK lets the executor retire terminal proof once the Host holds it durably. Idempotent. */
async function acknowledgeEditorReceipt(deviceId: string, query: EditorReceiptQuery) {
	const backend = resolveBackend({ requested: deviceId });
	if (!(backend instanceof RemoteBackend)) throw new Error("Original editor device unavailable");
	await backend.editorWriteRpc().call("editor.query", { ...query, acknowledgeTerminal: true });
}

export const executeEditorDocumentFileChange: EditorDocumentDependencies["execute"] = async (
	request,
) => {
	const { remote, resourceKey } = request;
	if (remote && !(remote.backend instanceof RemoteBackend))
		throw new AppError("Unsupported editor backend", 503, "EDITOR_PROVIDER_UNSUPPORTED");
	if (!resourceKey)
		throw new AppError("Editor resource binding unavailable", 503, "EDITOR_PROVIDER_UNSUPPORTED");
	const backend = remote?.backend;
	let terminal: { query: EditorReceiptQuery; hostOperationId: string } | undefined;
	const io =
		remote && backend instanceof RemoteBackend
			? createEditorFileAtomicIo({
					rpc: backend.editorWriteRpc(),
					read: (path, signal) =>
						backend.editorObservation(
							{
								deviceId: backend.deviceId,
								pathFlavor: backend.pathFlavor,
								canonicalPath: path,
								workspaceIdentity: remote.rootIdentity,
								...remote.runtime,
								fencingToken: backend.runtimeGeneration,
							},
							resourceKey,
							signal,
						),
					onReceipt: (receipt, query, hostOperationId) => {
						if (receipt.outcome !== "uncertain") terminal = { query, hostOperationId };
					},
				})
			: createFileChangeLocalIo(undefined, {
					maxBytes: EDITOR_FILE_MAX_BYTES,
					createParents: false,
					cancelledMutationIsUnknown: true,
				});
	const run = () =>
		withWorkspaceAdmission(
			{ deviceId: backend?.deviceId ?? "local", path: request.cwd },
			async () => {
				await request.authorize();
				return executeEditorFileChange({ ...request, io });
			},
		);
	if (request.workspaceRevision === undefined)
		throw new AppError("Editor workspace revision unavailable", 409, "EDITOR_IDENTITY_CHANGED");
	try {
		return await workspaceContextService.withRevision(
			request.narratorId,
			request.workspaceRevision,
			undefined,
			run,
		);
	} finally {
		// The runtime settles a terminal receipt itself; ACK only once that is durable.
		// A failed ACK is retried by the next operation query, never by a reapply.
		if (backend && terminal) {
			const { query, hostOperationId } = terminal;
			try {
				const runtime = await getCurrentLocalFileChangeRuntime();
				if ((await runtime.evidence.getOperation(hostOperationId))?.settlement === "settled")
					await acknowledgeEditorReceipt(backend.deviceId, query);
			} catch (error) {
				logger.debug("Editor engine ACK deferred", { error: String(error) });
			}
		}
	}
};

export function getEditorDocumentService(): EditorDocumentService {
	return hotSafe(
		"narrafork.editor-documents.v1",
		() =>
			new EditorDocumentService({
				root: join(getNarraforkHome(), "editor-transfers"),
				execute: executeEditorDocumentFileChange,
				writerUnavailableReason: () => "durable_executor_unavailable",
				writerAvailable: (binding) =>
					binding.writeTarget
						? binding.writeTarget.backend instanceof RemoteBackend &&
							binding.writeTarget.backend.supportsEditorDurableWrite
						: !binding.rawSource && (!binding.deviceId || binding.deviceId === "local"),
				atomicWriter: (binding) => binding.writeTarget?.backend instanceof RemoteBackend,
				rawWriter: {
					execute: executeEditorDocumentFileChange,
					queryOperation: queryEditorOperation,
				},
				queryOperation: queryEditorOperation,
				async afterWrite(binding, narratorId, requestId, run, actor) {
					if (binding.deviceId && binding.deviceId !== "local") return run();
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
	actor.signal?.throwIfAborted();
	const runtime = await getDefaultLocalFileChangeRuntime();
	const namespace = await runtime.verifyNamespace(actor.signal);
	const operation = await runtime.evidence.getEditorOperation(
		namespace.sourceInstanceId,
		operationId,
	);
	if (
		!operation ||
		operation.ownerUserId !== actor.userId ||
		operation.narratorId !== actor.narratorId
	)
		throw new EditorDocumentError(
			"EDITOR_OPERATION_UNKNOWN",
			"No owned durable receipt is available; verify before retrying",
			404,
		);
	const effects = (await runtime.evidence.listEffects(operation.id, { limit: 2 })).items;
	const deviceId =
		operation.executionBindingJson?.deviceId ?? effects[0]?.identityJson.deviceId ?? "local";
	const authorize = actor.authorizeOperation?.bind(actor, deviceId);
	if (authorize) await authorize();
	else if (deviceId !== "local")
		throw new EditorDocumentError(
			"EDITOR_OPERATION_UNKNOWN",
			"Original receipt device authorization unavailable",
			403,
		);
	if (authorize && deviceId !== "local") {
		const effect = effects.length === 1 ? effects[0] : undefined;
		if (!effect || !remoteEditorIntent(operation, effect))
			return {
				status: "uncertain",
				operationId,
				error: {
					code: "EDITOR_RESULT_UNAVAILABLE",
					message:
						"This remote save has no durable receipt binding; verify the file before retrying",
				},
			};
		const query = remoteQueryRequest(operation, effect);
		if (operation.settlement === "settled") {
			const result = remoteResult(operation, effect);
			// Retry only the terminal ACK; an offline executor never downgrades SQLite proof.
			if (result.status !== "uncertain")
				await acknowledgeEditorReceipt(deviceId, query).catch((error) =>
					logger.debug("Editor engine ACK deferred", { error: String(error) }),
				);
			return result;
		}
		// Lost reply or cold recovery: adopt only a positively terminal executor receipt.
		try {
			const backend = resolveBackend({ requested: deviceId });
			if (!(backend instanceof RemoteBackend))
				throw new Error("Original editor device unavailable");
			const rpc = backend.editorWriteRpc();
			const proof = await rpc.call<EditorQueryResult>("editor.query", query, actor.signal);
			if (
				proof?.result &&
				proof.result.outcome === proof.outcome &&
				(proof.outcome === "committed" || proof.outcome === "rejected")
			) {
				try {
					await runtime.settleEditorReceipt(operation.id, proof.result);
				} catch (error) {
					logger.warn("Editor receipt contradicts original intent", {
						operationId,
						error: String(error),
					});
					return { status: "uncertain", operationId };
				}
				await rpc.call("editor.query", { ...query, acknowledgeTerminal: true }, actor.signal);
			}
		} catch (error) {
			actor.signal?.throwIfAborted();
			logger.debug("Editor remote query unavailable", { operationId, error: String(error) });
		}
		// Access may have been revoked while the RPC was in flight.
		await authorize();
		const latest = await runtime.evidence.getOperation(operation.id);
		const observed = await runtime.evidence.getEffect(operation.id, effect.mutationId);
		return latest && observed
			? remoteResult(latest, observed)
			: { status: "uncertain", operationId };
	}
	if (operation.settlement !== "settled") return { status: "uncertain", operationId };
	if (operation.executionOutcome !== "succeeded") return { status: "failed", operationId };
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
			...(recovery.hashKind ? { hashKind: recovery.hashKind } : {}),
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
