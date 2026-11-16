import { join, relative, sep } from "node:path";
import { EDITOR_FILE_MAX_BYTES, type EditorOperationResult } from "../../shared/editor-document";
import {
	EDITOR_TARGET_QUEUE_FEATURE,
	type EditorApplyResult,
	type EditorQueryResult,
} from "../../shared/editor-provider-contracts";
import { resolveBackend } from "../lib/agent/execution/registry";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { getNarraforkHome } from "../lib/narrafork-home";
import { hasDeviceProtocolFeature } from "./device-connection-service";
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
	getDefaultLocalFileChangeRuntime,
} from "./file-change-runtime";
import { workspaceContextService } from "./workspace-context-service";
import { withWorkspaceAdmission } from "./worktree-lifecycle-guard";
import { closeClaim, openClaim, sealClaim } from "./worktree-write-claims";

function editorRuntimeDiagnostic(
	level: "debug" | "warn",
	message: string,
	fields: Record<string, string | number | boolean>,
) {
	try {
		logger[level](message, fields);
	} catch {
		// Logging never changes a durable receipt or skips a finally cleanup.
	}
}

/** The original remote raw-v2 save as persisted. Null is never inferred: it only
 * means the row lacks a field the executor query is bound to, not non-execution. */
function remoteEditorIntent(operation: FileChangeOperationRecord) {
	const binding = operation.executionBindingJson;
	if (
		operation.sourceKind !== "editor" ||
		operation.attempt !== 1 ||
		!binding ||
		binding.deviceId === "local" ||
		!operation.ownerUserId ||
		!operation.requestDigest ||
		operation.editorRawSnapshotRevision === null
	)
		return null;
	const namespace = editorOperationNamespace(
		operation.sourceInstanceId,
		operation.ownerUserId,
		binding.deviceId,
	);
	return {
		deviceId: binding.deviceId,
		snapshotRevision: operation.editorRawSnapshotRevision,
		// The executor's exact-op binding is the stable correlation key. No lease is needed.
		query: {
			namespace,
			resourceKey: editorWriterResourceKey(namespace, operation.sourceId),
			operationId: operation.sourceId,
			requestDigest: operation.requestDigest,
		} satisfies EditorReceiptQuery,
	};
}
function remoteRpc(deviceId: string) {
	const backend = resolveBackend({ requested: deviceId });
	if (!(backend instanceof RemoteBackend)) throw new Error("Original editor device unavailable");
	return backend.editorWriteRpc();
}
/** ACK lets the executor retire terminal proof it no longer needs to hold. Idempotent;
 * a failed ACK is retried by the next explicit operation query, never by a reapply. */
async function acknowledgeEditorReceipt(deviceId: string, query: EditorReceiptQuery) {
	await remoteRpc(deviceId).call("editor.query", { ...query, acknowledgeTerminal: true });
}
type SavedSnapshot = {
	hashKind?: "raw-sha256";
	hash: string;
	bytes: number;
	snapshotRevision: number;
};
function savedResult(
	operationId: string,
	saved: SavedSnapshot,
	historyAvailable: boolean,
): EditorOperationResult {
	return {
		status: "saved",
		operationId,
		result: {
			status: "saved",
			operationId,
			...saved,
			diskOutcome: "applied",
			historyStatus: historyAvailable ? "complete" : "unavailable",
		},
	};
}

export const executeEditorDocumentFileChange: EditorDocumentDependencies["execute"] = async (
	request,
) => {
	const { remote, resourceKey } = request;
	if (remote && !(remote.backend instanceof RemoteBackend))
		throw new AppError("Unsupported editor backend", 503, "EDITOR_PROVIDER_UNSUPPORTED");
	if (remote && !hasDeviceProtocolFeature(remote.backend.deviceId, EDITOR_TARGET_QUEUE_FEATURE))
		throw new AppError(
			"Upgrade the executor: editor.target-queue.v1 is required",
			503,
			"EDITOR_PROVIDER_UNSUPPORTED",
		);
	if (!resourceKey)
		throw new AppError("Editor resource binding unavailable", 503, "EDITOR_PROVIDER_UNSUPPORTED");
	const backend = remote?.backend;
	let terminal: { query: EditorReceiptQuery; receipt: EditorApplyResult } | undefined;
	const io =
		remote && backend instanceof RemoteBackend
			? createEditorFileAtomicIo({
					deviceId: backend.deviceId,
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
					onReceipt: (receipt, query) => {
						if (receipt.outcome !== "uncertain") terminal = { query, receipt };
					},
				})
			: createFileChangeLocalIo(undefined, {
					maxBytes: EDITOR_FILE_MAX_BYTES,
					createParents: false,
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
		// The Host already holds this terminal proof as the returned real outcome. ACK
		// only shortens executor retention; history settlement is never a precondition.
		if (backend && terminal)
			await acknowledgeEditorReceipt(backend.deviceId, terminal.query).catch(() => {
				try {
					editorRuntimeDiagnostic("debug", "Editor engine ACK deferred", { deferred: true });
				} catch {
					// Diagnostics cannot change the already-settled write outcome.
				}
			});
	}
};

const EDITOR_SERVICE_KEY = "narrafork.editor-documents.v1";
const EDITOR_SERVICE_CLOSED_KEY = Symbol.for("narrafork.editor-documents.closed.v2");
function currentEditorDocumentService(): EditorDocumentService | undefined {
	const service: unknown = Reflect.get(globalThis, Symbol.for(EDITOR_SERVICE_KEY));
	if (!service) return undefined;
	if (
		typeof service !== "object" ||
		!("lifecycleVersion" in service) ||
		service.lifecycleVersion !== 2 ||
		!("dispose" in service) ||
		typeof service.dispose !== "function"
	)
		throw new AppError(
			"Editor worker ownership predates safe draining; restart the server manually",
			503,
			"EDITOR_RESTART_REQUIRED",
		);
	return service as EditorDocumentService;
}
/** Close the actual lazy production owner without instantiating an unused service. */
export async function closeEditorDocumentService(): Promise<void> {
	// A resource-free scalar latch also closes the not-yet-created lazy owner across HMR.
	Reflect.set(globalThis, EDITOR_SERVICE_CLOSED_KEY, true);
	await currentEditorDocumentService()?.dispose();
}
/** Explicit test reset, only after successful drain; failed ownership remains pinned. */
export async function resetEditorDocumentServiceForTests(): Promise<void> {
	await closeEditorDocumentService();
	Reflect.deleteProperty(globalThis, Symbol.for(EDITOR_SERVICE_KEY));
	Reflect.deleteProperty(globalThis, EDITOR_SERVICE_CLOSED_KEY);
}
export function getEditorDocumentService(): EditorDocumentService {
	if (Reflect.get(globalThis, EDITOR_SERVICE_CLOSED_KEY))
		throw new AppError("Editor documents are closed", 503, "EDITOR_CLOSED");
	// HMR retains the live owner. Old shapes lacking lifecycle proof fail closed, never duplicate it.
	const existing = currentEditorDocumentService();
	if (existing) return existing;
	return hotSafe(
		EDITOR_SERVICE_KEY,
		() =>
			new EditorDocumentService({
				root: join(getNarraforkHome(), "editor-transfers"),
				execute: executeEditorDocumentFileChange,
				writerUnavailableReason: () => "durable_executor_unavailable",
				writerAvailable: (binding) =>
					binding.writeTarget
						? binding.writeTarget.backend instanceof RemoteBackend &&
							binding.writeTarget.backend.supportsEditorDurableWrite &&
							hasDeviceProtocolFeature(
								binding.writeTarget.backend.deviceId,
								EDITOR_TARGET_QUEUE_FEATURE,
							)
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
						} catch {
							editorRuntimeDiagnostic("debug", "Closing large editor claim failed", {
								deferred: true,
							});
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
						} catch {
							editorRuntimeDiagnostic("debug", "Large editor save notification failed", {
								deferred: true,
							});
						}
					} catch (error) {
						changed = error instanceof EditorFileChangeUncertainError;
						try {
							if (claimPath) sealClaim(binding.cwd, claimId);
						} catch {
							editorRuntimeDiagnostic("debug", "Sealing large editor claim failed", {
								deferred: true,
							});
						}
						throw error;
					} finally {
						if (changed && claimPath) {
							try {
								const { invalidateWorkspaceTreeCache } = await import("./narrator-session-state");
								invalidateWorkspaceTreeCache(binding.cwd);
							} catch {
								editorRuntimeDiagnostic("debug", "Large editor tree cache invalidation failed", {
									deferred: true,
								});
							}
						}
					}
				},
			}),
	);
}

/** A recorded effect's real IO outcome. History blobs only add the optional complete status. */
function effectResult(
	operation: FileChangeOperationRecord,
	effect: FileChangeEffectRecord | undefined,
	operationId: string,
	saved: SavedSnapshot | null,
	/** The raw byte digest to compare with history; differs from a v1 text `hash`. */
	rawDigest = saved?.hash,
): EditorOperationResult {
	// Only a recorded not_applied outcome proves the target was left untouched. An unknown
	// IO result may already be on disk, so the client must verify instead of discarding.
	if (effect?.diskOutcome !== "applied")
		return effect?.diskOutcome === "not_applied" && operation.settlement === "settled"
			? { status: "failed", operationId }
			: { status: "uncertain", operationId };
	if (!saved)
		return {
			status: "uncertain",
			operationId,
			error: {
				code: "EDITOR_RESULT_UNAVAILABLE",
				message:
					"The write settled, but its saved snapshot metadata is unavailable; verify before retrying",
			},
		};
	const after = effect.observedAfterStateJson;
	if (
		after.kind === "regular"
			? after.blob.digest !== rawDigest || after.blob.sizeBytes !== saved.bytes
			: after.kind !== "unknown"
	)
		return { status: "uncertain", operationId };
	return savedResult(
		operationId,
		saved,
		after.kind === "regular" && operation.executionOutcome === "succeeded",
	);
}

export const queryEditorOperation: NonNullable<
	EditorDocumentDependencies["queryOperation"]
> = async (actor, operationId, recovery) => {
	actor.signal?.throwIfAborted();
	const runtime = await getDefaultLocalFileChangeRuntime();
	const namespace = await runtime.verifyNamespace(actor.signal);
	const operation = runtime.evidence.getEditorOperation(namespace.sourceInstanceId, operationId);
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
	const effects = runtime.evidence.listEffects(operation.id, { limit: 2 }).items;
	const effect = effects.length === 1 ? effects[0] : undefined;
	const deviceId =
		operation.executionBindingJson?.deviceId ?? effect?.identityJson.deviceId ?? "local";
	const authorize = actor.authorizeOperation?.bind(actor, deviceId);
	if (authorize) await authorize();
	else if (deviceId !== "local")
		throw new EditorDocumentError(
			"EDITOR_OPERATION_UNKNOWN",
			"Original receipt device authorization unavailable",
			403,
		);
	const ownedRecovery =
		recovery &&
		recovery.operationId === operationId &&
		recovery.userId === actor.userId &&
		recovery.narratorId === actor.narratorId
			? recovery
			: undefined;
	if (deviceId === "local")
		return effectResult(
			operation,
			effect,
			operationId,
			ownedRecovery
				? {
						...(ownedRecovery.hashKind ? { hashKind: ownedRecovery.hashKind } : {}),
						hash: ownedRecovery.hash,
						bytes: ownedRecovery.bytes,
						snapshotRevision: ownedRecovery.snapshotRevision,
					}
				: null,
			ownedRecovery?.rawDigest,
		);
	const intent = remoteEditorIntent(operation);
	if (!intent)
		return {
			status: "uncertain",
			operationId,
			error: {
				code: "EDITOR_RESULT_UNAVAILABLE",
				message: "This remote save has no durable receipt binding; verify the file before retrying",
			},
		};
	// A raw-v2 save's saved hash is its raw digest, so the recorded intent restores the
	// result even after the editor's own restart description was removed.
	const intended = effect?.intendedAfterStateJson;
	const saved =
		intended?.kind === "regular"
			? {
					hashKind: "raw-sha256" as const,
					hash: intended.blob.digest,
					bytes: intended.blob.sizeBytes,
					snapshotRevision: intent.snapshotRevision,
				}
			: null;
	// An applied effect whose intended blob was not recorded (history unavailable) cannot
	// restore the saved result itself; the executor's exact-op receipt below can.
	if (effect && effect.diskOutcome !== "unknown" && (saved || effect.diskOutcome !== "applied")) {
		const result = effectResult(operation, effect, operationId, saved);
		// Retry only the terminal ACK; an offline executor never downgrades recorded proof.
		if (result.status !== "uncertain")
			await acknowledgeEditorReceipt(deviceId, intent.query).catch(() =>
				editorRuntimeDiagnostic("debug", "Editor engine ACK deferred", { deferred: true }),
			);
		return result;
	}
	// Lost reply or cold recovery: only the executor's exact-op terminal receipt decides.
	// not_found/uncertain never prove non-execution and never permit a re-apply.
	let proof: EditorQueryResult | undefined;
	try {
		proof = await remoteRpc(deviceId).call<EditorQueryResult>(
			"editor.query",
			intent.query,
			actor.signal,
		);
	} catch {
		actor.signal?.throwIfAborted();
		editorRuntimeDiagnostic("debug", "Editor remote query unavailable", {
			operationId,
			unavailable: true,
		});
	}
	// Access may have been revoked while the RPC was in flight.
	await authorize?.();
	const receipt = proof?.result;
	if (
		!proof ||
		proof.operationId !== operationId ||
		!receipt ||
		receipt.operationId !== operationId ||
		receipt.outcome !== proof.outcome ||
		(proof.outcome !== "committed" && proof.outcome !== "rejected")
	)
		return { status: "uncertain", operationId };
	let committed: SavedSnapshot | undefined;
	if (proof.outcome === "committed") {
		if (typeof receipt.rawDigest !== "string" || !Number.isSafeInteger(receipt.totalBytes))
			return { status: "uncertain", operationId };
		// The executor bound this receipt to the original requestDigest. Without a recorded
		// effect (history unavailable) its proven raw digest is the saved raw-v2 hash.
		committed = saved ?? {
			hashKind: "raw-sha256",
			hash: receipt.rawDigest,
			bytes: receipt.totalBytes as number,
			snapshotRevision: intent.snapshotRevision,
		};
		if (receipt.rawDigest !== committed.hash || receipt.totalBytes !== committed.bytes) {
			editorRuntimeDiagnostic("warn", "Editor receipt contradicts original intent", {
				operationId,
			});
			return { status: "uncertain", operationId };
		}
	} else if (receipt.rawDigest !== null || receipt.totalBytes !== null)
		return { status: "uncertain", operationId };
	await acknowledgeEditorReceipt(deviceId, intent.query).catch(() =>
		editorRuntimeDiagnostic("debug", "Editor engine ACK deferred", { deferred: true }),
	);
	return committed ? savedResult(operationId, committed, false) : { status: "failed", operationId };
};

export function editorRuntimeUnavailable(error: unknown): never {
	if (error instanceof AppError) throw error;
	throw new AppError(
		"Editor operation receipt is unavailable; verify before retrying",
		503,
		"EDITOR_OPERATION_UNKNOWN",
	);
}
