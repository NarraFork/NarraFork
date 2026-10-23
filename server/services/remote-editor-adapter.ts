import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { setImmediate as yieldTick } from "node:timers/promises";
import { EDITOR_FILE_MAX_BYTES, EDITOR_TRANSFER_CHUNK_BYTES } from "@shared/editor-document";
import type { FileChangeIdentity } from "@shared/file-change-protocol";
import type { RemoteHistoryReceipt } from "@shared/remote-history-protocol";
import type { EditorOperationMetadata } from "../lib/validators/editor-documents";
import {
	type EditorActor,
	type EditorBinding,
	EditorDocumentError,
	type RemoteEditorAdapter,
	sameEditorBinding,
} from "./editor-document-service";
import {
	type EditorFileChangeRequest,
	EditorFileChangeUncertainError,
	type FileChangeCompletion,
} from "./file-change-runtime";
import type { RemoteFileChangeRuntime } from "./remote-file-change-runtime";
import { preflightWindowsEditorMetadata } from "./windows-editor-metadata-preflight";

type Request = EditorFileChangeRequest<{ hash: string; bytes: number }>;
type Completion = FileChangeCompletion<{ hash: string; bytes: number }>;

/** Installed by workspace/history composition, never inferred from cwd or user ownership. */
export interface RemoteEditorEndpoint {
	runtime: RemoteFileChangeRuntime;
	identity: Readonly<FileChangeIdentity>;
	/** Native inline budget until the negotiated chunk upload primitive is available. */
	maxWriteBytes: number;
	/** Real human editor evidence transaction; returns its durable server commit identity. */
	commit(
		receipt: RemoteHistoryReceipt,
		request: Request,
		result: Completion["result"],
	): Promise<{ completion: Completion; serverCommitId: string }>;
}
export interface RemoteEditorAdapterDependencies {
	resolve(
		actor: EditorActor,
		binding: Readonly<EditorBinding>,
		need: "read" | "write",
		signal: AbortSignal,
	): Promise<RemoteEditorEndpoint>;
	/** Exact owned editor operation lookup, with original device/root, not the current workspace. */
	queryOperation: RemoteEditorAdapter["queryOperation"];
	afterWrite?: RemoteEditorAdapter["afterWrite"];
}

function assertEndpoint(endpoint: RemoteEditorEndpoint, binding: EditorBinding): void {
	const { identity, runtime } = endpoint;
	if (
		!binding.deviceId ||
		binding.deviceId === "local" ||
		identity.deviceId !== binding.deviceId ||
		runtime.backend.deviceId !== binding.deviceId ||
		identity.canonicalPath !== binding.canonicalPath ||
		identity.lexicalPath !== binding.lexicalPath ||
		runtime.history.binding.root !== binding.cwd ||
		runtime.history.binding.rootIdentity !== binding.rootIdentity
	)
		throw new EditorDocumentError("EDITOR_IDENTITY_CHANGED", "Remote editor endpoint changed", 403);
	runtime.relativePath(identity);
}

/** All remote IO goes through F's evidence runtime. Local paths here are disposable transfer objects. */
export function createRemoteEditorAdapter(
	deps: RemoteEditorAdapterDependencies,
): RemoteEditorAdapter {
	return {
		async source(actor, binding, temporaryPath, signal) {
			binding = Object.freeze({ ...binding });
			const endpoint = await deps.resolve(actor, binding, "read", signal);
			assertEndpoint(endpoint, binding);
			if (endpoint.runtime.backend.pathFlavor === "windows") {
				const { getRemoteWorkspaceHistoryRuntime } = await import(
					"./remote-workspace-history-runtime"
				);
				const registry = await getRemoteWorkspaceHistoryRuntime();
				await preflightWindowsEditorMetadata({
					registry,
					userId: actor.userId,
					phase: "source",
					signal,
					assertCurrent: () => {
						assertEndpoint(endpoint, binding);
						const original = endpoint.runtime.history.binding;
						const live = registry.options.backend(endpoint.identity.deviceId);
						const scope = registry.evidence.getScope(endpoint.identity.scopeId);
						if (
							binding.runtimeGeneration === undefined ||
							live.runtimeGeneration !== binding.runtimeGeneration ||
							!scope ||
							scope.status !== "active" ||
							scope.activeLeaseId ||
							scope.activeMutationCount ||
							scope.sourceInstanceId !== original.sourceInstanceId ||
							scope.workspaceInstanceId !== original.workspaceInstanceId ||
							scope.canonicalRoot !== original.root ||
							scope.rootIdentityJson?.object !== original.rootIdentity ||
							scope.fencingToken !== original.fence
						)
							throw new EditorDocumentError(
								"EDITOR_IDENTITY_CHANGED",
								"Original editor source/runtime/fence changed",
								403,
							);
					},
					async authorize(bounded) {
						const fresh = await actor.authorize(
							{ path: binding.lexicalPath, deviceId: binding.deviceId, origin: "reference" },
							"read",
							binding,
						);
						if (!sameEditorBinding(fresh, binding))
							throw new EditorDocumentError(
								"EDITOR_IDENTITY_CHANGED",
								"Original editor binding changed",
								403,
							);
						if (!binding.deviceId || binding.runtimeGeneration === undefined)
							throw new EditorDocumentError(
								"EDITOR_IDENTITY_CHANGED",
								"Original Windows editor generation is missing",
								403,
							);
						await registry.options.authorize(
							{
								userId: actor.userId,
								narratorId: actor.narratorId,
								projectId: binding.projectId,
								kind: "human",
							},
							{
								deviceId: binding.deviceId,
								cwd: binding.cwd,
								lexicalPath: binding.lexicalPath,
								canonicalPath: binding.canonicalPath,
								runtimeGeneration: binding.runtimeGeneration,
								rootIdentity: binding.rootIdentity,
							},
							"read",
							bounded,
						);
					},
				});
			}
			const before = await endpoint.runtime.observe(endpoint.identity, signal);
			if (!before.bytes)
				throw new EditorDocumentError("EDITOR_SOURCE_MISSING", "Remote source is absent", 404);
			if (before.bytes.byteLength > EDITOR_FILE_MAX_BYTES)
				throw new EditorDocumentError(
					"EDITOR_SOURCE_TOO_LARGE",
					"Remote source exceeds editor byte budget",
					413,
				);
			const file = await open(temporaryPath, "wx", 0o600);
			try {
				for (
					let offset = 0;
					offset < before.bytes.byteLength;
					offset += EDITOR_TRANSFER_CHUNK_BYTES
				) {
					signal.throwIfAborted();
					const chunk = before.bytes.subarray(offset, offset + EDITOR_TRANSFER_CHUNK_BYTES);
					let written = 0;
					while (written < chunk.byteLength) {
						const result = await file.write(chunk, written, chunk.byteLength - written);
						if (!result.bytesWritten) throw new Error("Editor staging write made no progress");
						written += result.bytesWritten;
					}
					await yieldTick();
				}
			} finally {
				await file.close();
			}
		},
		async execute(actor, binding, request) {
			binding = Object.freeze({ ...binding });
			const endpoint = await deps.resolve(actor, binding, "write", request.signal);
			assertEndpoint(endpoint, binding);
			const digest = createHash("sha256")
				.update(
					JSON.stringify({
						version: 1,
						actor: actor.userId,
						narratorId: actor.narratorId,
						binding,
						identity: endpoint.identity,
						requestId: request.requestId,
						input: request.input,
					}),
				)
				.digest("hex");
			let prepared = false;
			let completion: Completion | undefined;
			let constructedResult: Completion["result"] | undefined;
			try {
				await endpoint.runtime.execute({
					identity: endpoint.identity,
					operationId: request.requestId,
					requestDigest: digest,
					signal: request.signal,
					async authorize() {
						await request.authorize();
						const fresh = await actor.authorize(
							{ path: binding.lexicalPath, deviceId: binding.deviceId, origin: "reference" },
							"write",
							binding,
						);
						if (!sameEditorBinding(fresh, binding))
							throw new EditorDocumentError(
								"EDITOR_IDENTITY_CHANGED",
								"Remote workspace changed",
								403,
							);
						assertEndpoint(endpoint, binding);
					},
					async construct(before) {
						const result = await request.construct({
							bytes: before.bytes,
							mode: before.state.kind === "regular" ? before.state.mode : null,
							identity: null,
						});
						if (result.nextBytes.byteLength > endpoint.maxWriteBytes)
							throw new EditorDocumentError(
								"EDITOR_REMOTE_WRITE_TOO_LARGE",
								"Executor upgrade required for chunked remote editor saves; keep the draft",
								413,
							);
						constructedResult = result.result;
						prepared = true;
						return result;
					},
					async commit(receipt) {
						if (!constructedResult) throw new Error("Editor result unavailable");
						const committed = await endpoint.commit(receipt, request, constructedResult);
						completion = committed.completion;
						return committed.serverCommitId;
					},
				});
				if (!completion) throw new Error("Remote editor evidence unavailable");
				return completion;
			} catch (error) {
				// Once mutation can have been dispatched, cancellation/disconnect is never no-write proof.
				if (prepared) throw new EditorFileChangeUncertainError(request.requestId, error);
				throw error;
			}
		},
		queryOperation(actor, operationId, recovery?: EditorOperationMetadata) {
			return deps.queryOperation(actor, operationId, recovery);
		},
		afterWrite: deps.afterWrite,
	};
}
