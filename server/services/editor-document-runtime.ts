import { AsyncLocalStorage } from "node:async_hooks";
import { join, relative, sep } from "node:path";
import { and, eq } from "drizzle-orm";
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
import { createEditorFileAtomicIo } from "./editor-file-atomic-io";
import {
	EditorHelperSession,
	editorHelperAvailable,
	editorHostReceiptAvailable,
	resolveEditorHelper,
	withEditorHelperMetadata,
} from "./editor-helper";
import {
	type EditorDurableOperation,
	EditorRemoteOperationStore,
	editorReceiptStorageSupported,
} from "./editor-remote-operation-store";
import {
	EditorFileChangeUncertainError,
	executeEditorFileChange,
	getCurrentLocalFileChangeRuntime,
	getDefaultLocalFileChangeRuntime,
	localFileChangeRuntimeBinding,
} from "./file-change-runtime";
import { workspaceContextService } from "./workspace-context-service";
import { withWorkspaceAdmission } from "./worktree-lifecycle-guard";
import { closeClaim, openClaim, sealClaim } from "./worktree-write-claims";

function hostReceiptStorageAvailable() {
	return editorReceiptStorageSupported(
		process.platform,
		process.platform === "win32" && editorHostReceiptAvailable(),
	);
}
const operationStoreContext = hotSafe(
	"editor.operation-store.context.v1",
	() => new AsyncLocalStorage<EditorRemoteOperationStore>(),
);
/** Trusted fixture/platform integration seam; never selected by an HTTP field or environment path. */
export function withEditorOperationStore<T>(store: EditorRemoteOperationStore, run: () => T): T {
	return operationStoreContext.run(store, run);
}
export function editorOperationStore() {
	return (
		operationStoreContext.getStore() ??
		new EditorRemoteOperationStore(join(getNarraforkHome(), "editor-native-operations"))
	);
}
async function openEditorReceiptRpc(record: EditorDurableOperation, signal?: AbortSignal) {
	if (record.deviceId !== "local") {
		const backend = resolveBackend({ requested: record.deviceId });
		if (!(backend instanceof RemoteBackend)) throw new Error("Original editor device unavailable");
		const rpc = backend.editorWriteRpc();
		return {
			...rpc,
			call: <T>(method: string, params: object, supplied?: AbortSignal) =>
				rpc.call<T>(method, params, supplied ?? signal),
		};
	}
	const runtime = localFileChangeRuntimeBinding();
	if (!runtime) throw new Error("Local editor runtime unavailable");
	const helper = await EditorHelperSession.open(
		resolveEditorHelper,
		getNarraforkHome(),
		join(getNarraforkHome(), "editor-native"),
		runtime.runtimeEpoch,
		{ signal },
	);
	try {
		await helper.capabilities();
		return helper;
	} catch (error) {
		await helper.close();
		throw error;
	}
}
async function acknowledgeEditorReceipt(operationId: string, authorize?: () => Promise<void>) {
	if (!authorize) return;
	const record = await editorOperationStore().get(operationId);
	if (!record) return;
	const runtime = await getCurrentLocalFileChangeRuntime();
	// Failed-but-positively-rejected attempts transfer proof too. Unknown executions
	// are left for the explicit query path, never auto-promoted by this cleanup.
	if (runtime.evidence.getOperation(record.hostOperationId)?.settlement !== "settled") return;
	await authorize();
	const rpc = await openEditorReceiptRpc(record);
	try {
		const request = {
			namespace: record.namespace,
			resourceKey: record.resourceKey,
			operationId,
			requestDigest: record.requestDigest,
		};
		const proof = await rpc.call<EditorQueryResult>("editor.query", request);
		if (!proof.result || proof.outcome !== proof.result.outcome)
			throw new Error("Terminal editor proof unavailable");
		const receipt = proof.result;
		await authorize();
		runtime.settleEditorReceipt(record, receipt);
		await withEditorHelperMetadata(rpc, () =>
			editorOperationStore().markSettled(operationId, receipt),
		);
		await rpc.call("editor.query", { ...request, acknowledgeTerminal: true });
	} finally {
		await rpc.close();
	}
}
export const executeAtomicEditorFileChange: EditorDocumentDependencies["execute"] = async (
	request,
) => {
	if (!hostReceiptStorageAvailable())
		throw new AppError(
			"Host durable editor receipt storage unavailable",
			503,
			"EDITOR_PROVIDER_UNSUPPORTED",
		);
	const { resourceKey, remote } = request;
	if (!resourceKey)
		throw new AppError("Editor resource binding unavailable", 503, "EDITOR_PROVIDER_UNSUPPORTED");
	const backend = remote?.backend;
	const io = createEditorFileAtomicIo({
		resourceKey,
		store: editorOperationStore(),
		...(remote && backend instanceof RemoteBackend
			? {
					open: async () => backend.editorWriteRpc(),
					read: (path: string, signal?: AbortSignal) =>
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
				}
			: {}),
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
		await acknowledgeEditorReceipt(request.requestId, request.authorizeReceipt).catch((error) =>
			logger.debug("Editor engine ACK deferred", { error: String(error) }),
		);
	}
};

export function getEditorDocumentService(): EditorDocumentService {
	// A hot module reload must not clean up the live previous generation's pinned objects.
	return hotSafe(
		"narrafork.editor-documents.v1",
		() =>
			new EditorDocumentService({
				root: join(getNarraforkHome(), "editor-transfers"),
				execute: executeAtomicEditorFileChange,
				writerUnavailableReason: (binding) =>
					!hostReceiptStorageAvailable()
						? "host_receipt_storage_unavailable"
						: binding.rawSource
							? "durable_executor_unavailable"
							: "verified_helper_unavailable",
				writerAvailable: (binding) =>
					hostReceiptStorageAvailable() &&
					(binding.rawSource
						? binding.writeTarget?.backend instanceof RemoteBackend &&
							binding.writeTarget.backend.supportsEditorDurableWrite
						: editorHelperAvailable()),
				rawWriter: { execute: executeAtomicEditorFileChange, queryOperation: queryEditorOperation },
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
	const record = await editorOperationStore().get(operationId, actor.signal);
	if (record) {
		if (
			record.userId !== actor.userId ||
			record.narratorId !== actor.narratorId ||
			!actor.authorizeOperation
		)
			throw new EditorDocumentError("EDITOR_OPERATION_UNKNOWN", "No owned operation receipt", 404);
		await actor.authorizeOperation(record.deviceId);
		if (record.receipt) {
			try {
				(await getDefaultLocalFileChangeRuntime()).settleEditorReceipt(record, record.receipt);
			} catch {
				await actor.authorizeOperation(record.deviceId);
				return { status: "uncertain", operationId };
			}
			await actor.authorizeOperation(record.deviceId);
			return record.receipt.outcome === "committed"
				? {
						status: "saved",
						operationId,
						result: { status: "saved", operationId, ...record.saved },
					}
				: { status: "failed", operationId };
		}
		const rpc = await openEditorReceiptRpc(record, actor.signal);
		try {
			const result = await rpc.call<EditorQueryResult>("editor.query", {
				namespace: record.namespace,
				resourceKey: record.resourceKey,
				operationId,
				requestDigest: record.requestDigest,
			});
			await actor.authorizeOperation(record.deviceId);
			if (
				result?.operationId !== operationId ||
				!["committed", "rejected", "uncertain", "not_found", "proven_not_executed"].includes(
					result.outcome,
				)
			)
				throw new Error("Invalid editor query result");
			if (result.outcome !== "committed" && result.outcome !== "rejected")
				return { status: "uncertain", operationId };
			if (!result.result || result.result.outcome !== result.outcome)
				throw new Error("Missing durable editor receipt");
			const receipt = result.result;
			const runtime = await getDefaultLocalFileChangeRuntime();
			try {
				runtime.settleEditorReceipt(record, receipt);
				await withEditorHelperMetadata(rpc, () =>
					editorOperationStore().markSettled(operationId, receipt, actor.signal),
				);
				await rpc
					.call("editor.query", {
						namespace: record.namespace,
						resourceKey: record.resourceKey,
						operationId,
						requestDigest: record.requestDigest,
						acknowledgeTerminal: true,
					})
					.catch(() => {});
			} catch (error) {
				logger.warn("Editor receipt recovery retains original barrier", {
					operationId,
					error: String(error),
				});
				return { status: "uncertain", operationId };
			}
			await actor.authorizeOperation(record.deviceId);
			return result.outcome === "committed"
				? {
						status: "saved",
						operationId,
						result: { status: "saved", operationId, ...record.saved },
					}
				: { status: "failed", operationId };
		} finally {
			await rpc.close();
		}
	}
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
	const effects = runtime.evidence.listEffects(row.id, { limit: 2 }).items;
	const deviceId = effects[0]?.identityJson.deviceId ?? "local";
	if (actor.authorizeOperation) await actor.authorizeOperation(deviceId);
	else if (deviceId !== "local")
		throw new EditorDocumentError(
			"EDITOR_OPERATION_UNKNOWN",
			"Original receipt device authorization unavailable",
			403,
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
