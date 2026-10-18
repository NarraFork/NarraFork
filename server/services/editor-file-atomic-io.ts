import { createHash } from "node:crypto";
import { join } from "node:path";
import { EDITOR_FILE_MAX_BYTES } from "../../shared/editor-document";
import type {
	EditorApplyRequest,
	EditorApplyResult,
	EditorStageHandle,
} from "../../shared/editor-provider-contracts";
import type { FsStatResult } from "../lib/agent/execution/rpc-types";
import { AppError } from "../lib/errors";
import { getNarraforkHome } from "../lib/narrafork-home";
import {
	type EditorHelperResolver,
	EditorHelperSession,
	type EditorRpc,
	resolveEditorHelper,
	withEditorHelperMetadata,
} from "./editor-helper";
import {
	type EditorRemoteOperationStore,
	editorOperationNamespace,
} from "./editor-remote-operation-store";
import {
	type FileChangeLocalIo,
	fileChangeLocalIo,
	type LocalFileApplyInput,
	type LocalFileApplyResult,
} from "./file-change-local-io";

export interface EditorAtomicIoOptions {
	resourceKey: string;
	store: EditorRemoteOperationStore;
	read?: FileChangeLocalIo["read"];
	open?(input: LocalFileApplyInput): Promise<EditorRpc>;
	resolveHelper?: EditorHelperResolver;
	stateDir?: string;
}
function reject(message: string, code = "EDITOR_APPLY_REJECTED") {
	return new AppError(message, 409, code);
}
export function validateEditorApplyResult(
	result: EditorApplyResult,
	request: EditorApplyRequest,
	digest: string,
	bytes: number,
) {
	if (
		!result ||
		result.operationId !== request.operationId ||
		!["committed", "rejected", "uncertain"].includes(result.outcome) ||
		(result.outcome === "committed" &&
			(result.rawDigest !== digest || result.totalBytes !== bytes)) ||
		(result.outcome !== "committed" && (result.rawDigest !== null || result.totalBytes !== null))
	)
		throw new Error("Invalid editor durable receipt");
	return result;
}
/** Editor only: all preimage, intent, observed evidence and locks stay in the existing runtime. */
export function createEditorFileAtomicIo(options: EditorAtomicIoOptions): FileChangeLocalIo {
	return {
		read:
			options.read ??
			((path, signal) => fileChangeLocalIo.read(path, signal, EDITOR_FILE_MAX_BYTES)),
		async apply(input): Promise<LocalFileApplyResult> {
			const parentEffects = { createdPaths: [], possiblePaths: [] };
			let dispatched = false;
			let associated = false;
			let rpc: EditorRpc | undefined;
			let stageId: string | undefined;
			const editor = input.editor;
			if (
				!editor ||
				editor.intended.kind !== "regular" ||
				(editor.before.kind !== "regular" && editor.before.kind !== "absent")
			)
				return {
					kind: "not_applied",
					parentEffects,
					error: reject("Editor requires verified before/intended evidence"),
				};
			const intended = editor.intended;
			const owner = {
				namespace: editorOperationNamespace(
					editor.scope.sourceInstanceId,
					editor.userId,
					input.backend.deviceId,
				),
				resourceKey: options.resourceKey,
			};
			try {
				input.signal.throwIfAborted();
				await input.assertTarget();
				if (input.before.mode !== null && (input.before.mode & 0o222) === 0)
					throw reject("File is read-only");
				if (input.nextBytes.length > EDITOR_FILE_MAX_BYTES)
					throw reject("Editor output exceeds 20 MiB");
				if (options.open) {
					rpc = await options.open(input);
				} else {
					const session = await EditorHelperSession.open(
						options.resolveHelper ?? resolveEditorHelper,
						editor.scope.canonicalRoot,
						options.stateDir ?? join(getNarraforkHome(), "editor-native"),
						editor.executionBinding.runtimeEpoch,
						{ signal: input.signal },
					);
					rpc = session;
					const capabilities = await session.capabilities(input.signal);
					if (capabilities.runtimeEpoch !== editor.executionBinding.runtimeEpoch)
						throw reject("Helper epoch mismatch");
				}
				const root = await rpc.call<FsStatResult>(
					"fs.stat",
					{
						path: editor.scope.canonicalRoot,
						editorIdentity: true,
						editorRoot: editor.scope.canonicalRoot,
					},
					input.signal,
				);
				if (
					!root.isDirectory ||
					!root.rootIdentity ||
					!root.runtimeEpoch ||
					root.canonicalRoot !== editor.scope.canonicalRoot ||
					root.runtimeEpoch !== editor.executionBinding.runtimeEpoch
				)
					throw reject("Editor root/session identity changed");
				// No target parent creation: an absent parent is rejected before dispatch.
				const parent = await rpc.call<FsStatResult>(
					"fs.stat",
					{
						path: input.backend.paths.dirname(input.canonicalPath),
						editorIdentity: true,
						editorRoot: editor.scope.canonicalRoot,
					},
					input.signal,
				);
				if (!parent.isDirectory) throw reject("Editor target parent must already exist");
				const identity = {
					deviceId: input.backend.deviceId,
					pathFlavor: editor.scope.pathFlavor,
					canonicalPath: input.canonicalPath,
					workspaceIdentity: root.rootIdentity,
					runtimeEpoch: root.runtimeEpoch,
					runtimeGeneration: editor.executionBinding.runtimeGeneration,
					fencingToken: editor.executionBinding.fencingToken,
				};
				const stage = await rpc.call<EditorStageHandle>(
					"editor.stage.open",
					{ ...owner, maxBytes: EDITOR_FILE_MAX_BYTES, idleTimeoutMs: 10_000 },
					input.signal,
				);
				if (
					!stage?.stageId ||
					stage.stageId.length > 128 ||
					stage.resourceKey !== owner.resourceKey
				)
					throw reject("Invalid editor stage");
				stageId = stage.stageId;
				let seq = 0;
				for (let offset = 0; offset < input.nextBytes.length; offset += 65536) {
					const chunk = input.nextBytes.subarray(offset, offset + 65536);
					await rpc.call(
						"editor.stage.append",
						{
							...owner,
							stageId,
							seq: seq++,
							offset,
							bytes: chunk.length,
							digest: createHash("sha256").update(chunk).digest("hex"),
							dataB64: Buffer.from(chunk).toString("base64"),
						},
						input.signal,
					);
				}
				await rpc.call(
					"editor.stage.seal",
					{
						...owner,
						stageId,
						totalBytes: input.nextBytes.length,
						rawDigest: intended.blob.digest,
					},
					input.signal,
				);
				const request: EditorApplyRequest = {
					...owner,
					operationId: editor.sourceId,
					requestDigest: editor.requestDigest,
					stageId,
					identity,
					expectedRawHash: editor.before.kind === "absent" ? null : editor.before.blob.digest,
					metadataPolicy: "preserve",
				};
				const saved = editor.preparedResult as { hash: string; bytes: number };
				if (
					!saved ||
					!/^[a-f0-9]{64}$/.test(saved.hash) ||
					saved.bytes !== input.nextBytes.length ||
					!Number.isSafeInteger(editor.snapshotRevision)
				)
					throw reject("Missing editor snapshot recovery metadata");
				await withEditorHelperMetadata(rpc, () =>
					options.store.put({
						version: 1,
						createdAt: Date.now(),
						userId: editor.userId,
						narratorId: editor.narratorId,
						leaseId: editor.leaseId,
						effectId: editor.effectId,
						saved: {
							...saved,
							snapshotRevision: editor.snapshotRevision,
							...(editor.hashKind ? { hashKind: editor.hashKind } : {}),
						},

						deviceId: input.backend.deviceId,
						operationId: editor.sourceId,
						hostOperationId: editor.operationId,
						requestDigest: editor.requestDigest,
						...owner,
						root: editor.scope.canonicalRoot,
						identity,
						rawDigest: intended.blob.digest,
						bytes: input.nextBytes.length,
					}),
				);
				associated = true;
				await input.assertTarget();
				input.signal.throwIfAborted();
				input.onDispatch();
				dispatched = true;
				const result = validateEditorApplyResult(
					await rpc.call<EditorApplyResult>("editor.apply", request, input.signal),
					request,
					intended.blob.digest,
					input.nextBytes.length,
				);
				if (result.outcome === "committed") return { kind: "applied", error: null, parentEffects };
				return {
					kind: result.outcome === "rejected" ? "not_applied" : "target_mutation_unknown",
					parentEffects,
					error: reject(
						result.error?.message ?? "Editor mutation outcome unknown",
						result.error?.code,
					),
				};
			} catch (error) {
				return {
					kind: dispatched ? "target_mutation_unknown" : "not_applied",
					parentEffects,
					error,
				};
			} finally {
				if (rpc && stageId && !dispatched)
					await rpc
						.call("editor.stage.abort", { ...owner, stageId, reason: "cancel" })
						.catch(() => {});
				if (associated && !dispatched) {
					// Release the primary process before standalone no-dispatch metadata cleanup.
					await rpc?.close();
					rpc = undefined;
					// This is positive Host no-dispatch evidence, not an inference from query/not-found.
					await options.store
						.markSettled(editor.sourceId, {
							operationId: editor.sourceId,
							outcome: "rejected",
							rawDigest: null,
							totalBytes: null,
							error: {
								code: "EDITOR_NOT_DISPATCHED",
								message: "Host rejected before editor.apply dispatch",
							},
						})
						.catch(() => {});
				}
				await rpc?.close();
			}
		},
	};
}
