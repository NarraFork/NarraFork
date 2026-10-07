import { join } from "node:path";
import type {
	WorkspaceAttachmentBackend,
	WorkspaceAttachmentBinding,
	WorkspaceAttachmentOperation,
	WorkspaceAttachmentOperations,
} from "@shared/workspace-attachment-protocol";
import { getNarraforkHome } from "../lib/narrafork-home";
import type {
	WorkspaceAttachmentAccess,
	WorkspaceAttachmentAdmittedIdentity,
} from "../lib/uploads";
import {
	isWorkspaceAttachmentProof,
	type WorkspaceAttachmentTarget,
} from "../lib/workspace-attachment-io";
import { localDirectoryIdentity } from "./file-change-local-io";
import { getDefaultLocalFileChangeRuntime } from "./file-change-runtime";
import { getRemoteWorkspaceHistoryRuntime } from "./remote-workspace-history-runtime";
import type { WorkspaceWriteLease } from "./workspace-write-coordinator";

function bindingMatches(a: WorkspaceAttachmentBinding, b: WorkspaceAttachmentBinding) {
	return [
		"sourceInstanceId",
		"workspaceInstanceId",
		"scopeId",
		"root",
		"rootIdentity",
		"fence",
	].every(
		(key) =>
			a[key as keyof WorkspaceAttachmentBinding] === b[key as keyof WorkspaceAttachmentBinding],
	);
}
function guardedAttachmentBackend(input: {
	native: WorkspaceAttachmentBackend;
	binding: WorkspaceAttachmentBinding;
	lease: WorkspaceWriteLease;
	admitted: WorkspaceAttachmentAdmittedIdentity;
	canonicalPath(relative: string): string;
	authorize(signal: AbortSignal): Promise<void>;
}): WorkspaceAttachmentBackend {
	const pending = new Set<string>();
	const settled = new Set<string>();
	return {
		supportsWorkspaceAttachment: input.native.supportsWorkspaceAttachment,
		async workspaceAttachment<K extends WorkspaceAttachmentOperation>(
			operation: K,
			request: WorkspaceAttachmentOperations[K]["request"],
			signal?: AbortSignal,
		): Promise<WorkspaceAttachmentOperations[K]["result"]> {
			const bounded = signal ?? AbortSignal.timeout(300_000);
			if (request.operationId !== input.admitted.operationId)
				throw new Error("Attachment operation changed its fixed server-admitted identity");
			if (!bindingMatches(request.binding, input.binding))
				throw new Error("Attachment request does not match its actual held scope/fence");
			const origin =
				"path" in request ? request.path : "proof" in request ? request.proof.path : undefined;
			if (origin !== undefined && input.canonicalPath(origin) !== input.admitted.canonicalPath)
				throw new Error("Attachment primitive attempted another file");
			await input.authorize(bounded);
			input.lease.assertCurrent();
			if (!pending.has(request.operationId)) {
				input.lease.registerMutation(request.operationId);
				pending.add(request.operationId);
			}
			const result = await input.native.workspaceAttachment(operation, request, bounded);
			if (
				!bindingMatches(result.binding, input.binding) ||
				result.operationId !== request.operationId ||
				result.requestDigest !== request.requestDigest
			)
				throw new Error("Attachment native result is not its original operation/fence");
			if ("state" in result && result.state === "committed") {
				if (
					!isWorkspaceAttachmentProof(result.proof) ||
					!bindingMatches(result.proof.binding, input.binding) ||
					result.proof.operationId !== request.operationId ||
					result.proof.requestDigest !== request.requestDigest ||
					input.canonicalPath(result.proof.path) !== input.admitted.canonicalPath
				)
					throw new Error("Attachment commit has no exact native creation proof");
				if (!settled.has(request.operationId)) {
					input.lease.settle(request.operationId, "applied");
					settled.add(request.operationId);
				}
			} else if ("outcome" in result && ["deleted", "already_deleted"].includes(result.outcome)) {
				if (!settled.has(request.operationId)) {
					input.lease.settle(
						request.operationId,
						result.outcome === "deleted" ? "applied" : "not_applied",
					);
					settled.add(request.operationId);
				}
			} else if (
				("state" in result && ["unknown", "conflict", "cleaned"].includes(result.state)) ||
				("outcome" in result && ["unknown", "conflict"].includes(result.outcome))
			) {
				input.lease.markUncertain();
			}
			return result;
		},
	};
}

/** Production attachment composition, independent from the 32MiB history blob store.
 * Exact human/path authority is supplied by the existing artifact access intersection. */
export async function withWorkspaceAttachmentTarget<Result>(input: {
	narratorId: string;
	userId: string;
	access: WorkspaceAttachmentAccess;
	admitted: WorkspaceAttachmentAdmittedIdentity;
	signal: AbortSignal;
	body(target: WorkspaceAttachmentTarget): Promise<Result>;
}): Promise<Result> {
	const { backend, workspaceContext } = input.access;
	const generation = backend.runtimeGeneration;
	const authorize = async (signal: AbortSignal) => {
		if (
			backend.runtimeGeneration !== generation ||
			(await input.access.authorizeWrite(input.admitted.canonicalPath, backend, signal)) !== true
		)
			throw new Error("Attachment live artifact authority changed");
	};
	await authorize(input.signal);
	if (backend.kind === "remote") {
		const dispatch = backend.workspaceAttachment;
		if (!dispatch || !backend.supportsWorkspaceAttachment)
			throw new Error("Executor upgrade required for proven streaming attachment creation");
		const registry = await getRemoteWorkspaceHistoryRuntime();
		return registry.withAttachmentLease(
			{
				userId: input.userId,
				narratorId: input.narratorId,
				projectId: workspaceContext.contextProjectId ?? null,
				kind: "human",
			},
			{
				deviceId: backend.deviceId,
				cwd: workspaceContext.cwd,
				lexicalPath: input.admitted.lexicalPath,
				canonicalPath: input.admitted.canonicalPath,
				runtimeGeneration: generation,
			},
			input.signal,
			async (endpoint) => {
				const native: WorkspaceAttachmentBackend = {
					supportsWorkspaceAttachment: backend.supportsWorkspaceAttachment,
					workspaceAttachment: dispatch.bind(backend),
				};
				const controlled = guardedAttachmentBackend({
					native,
					binding: endpoint.binding,
					lease: endpoint.lease,
					admitted: input.admitted,
					canonicalPath: (relative) => backend.paths.resolve(endpoint.binding.root, relative),
					async authorize(signal) {
						await authorize(signal);
						await endpoint.assertCurrent();
					},
				});
				try {
					return await input.body({
						deviceId: backend.deviceId,
						binding: endpoint.binding,
						backend: controlled,
					});
				} catch (error) {
					if (endpoint.lease.pendingMutationCount) endpoint.lease.markUncertain();
					throw error;
				}
			},
		);
	}
	const runtime = await getDefaultLocalFileChangeRuntime();
	const prepared = await runtime.prepareWorkspaceActivityScope({
		backend,
		cwd: workspaceContext.cwd,
		canonicalPath: input.admitted.canonicalPath,
		signal: input.signal,
	});
	return runtime.coordinator.withWrite(
		{
			scope: prepared.scope,
			runtime: prepared.runtime,
			signal: input.signal,
			executionClass: "local_file_io",
			ranges: [{ kind: "subtree", canonicalPath: prepared.scope.canonicalRoot }],
		},
		async (lease) => {
			const binding: WorkspaceAttachmentBinding = {
				sourceInstanceId: prepared.scope.sourceInstanceId,
				workspaceInstanceId: prepared.scope.workspaceInstanceId,
				scopeId: prepared.scope.id,
				root: prepared.root,
				rootIdentity: prepared.rootIdentity,
				fence: lease.executionBinding.fencingToken,
			};
			const assertCurrent = async (signal: AbortSignal) => {
				await authorize(signal);
				lease.assertCurrent();
				if ((await localDirectoryIdentity(prepared.root)) !== prepared.rootIdentity)
					throw new Error("Attachment native local root changed");
				const actual = await backend.resolvePathIdentity(input.admitted.lexicalPath, { signal });
				if (
					!backend.paths.equals(actual.canonicalPath, input.admitted.canonicalPath) ||
					actual.runtimeGeneration !== generation
				)
					throw new Error("Attachment local target changed");
				lease.assertCurrent();
			};
			const { createLocalWorkspaceAttachmentBackend } = await import(
				"./local-workspace-attachment"
			);
			const native = await createLocalWorkspaceAttachmentBackend({
				binding,
				privateRoot: join(getNarraforkHome(), "workspace-attachment-native"),
				assertCurrent,
				async authorizePath(path, signal) {
					if (!backend.paths.equals(path, input.admitted.canonicalPath))
						throw new Error("Local attachment primitive changed its admitted file");
					await authorize(signal);
				},
			});
			try {
				return await input.body({
					deviceId: backend.deviceId,
					binding,
					backend: guardedAttachmentBackend({
						native,
						binding,
						lease,
						admitted: input.admitted,
						canonicalPath: (relative) => backend.paths.resolve(binding.root, relative),
						authorize: assertCurrent,
					}),
				});
			} catch (error) {
				if (lease.pendingMutationCount) lease.markUncertain();
				throw error;
			} finally {
				await native.close();
			}
		},
	);
}
