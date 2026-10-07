import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type {
	RemoteHistoryBinding,
	RemoteHistoryObject,
	RemoteHistoryReceipt,
	RemoteHistoryRequest,
} from "@shared/remote-history-protocol";
import { and, eq, sql } from "drizzle-orm";
import { fileChangeScopes, remoteTreeCaptures } from "../db/schema";
import type { NarratorPrincipal } from "./narrator-acl";
import { loadNarratorForAccess } from "./narrator-acl";
import { loadProjectForAccess } from "./project-acl";
import { assertRemoteHistoryBinding, assertRemoteHistoryObject } from "./remote-history-service";
import { remoteTreeCapturePolicy } from "./remote-tree-snapshot-hooks";
import type {
	RemoteHistoryActor,
	RemoteWorkspaceHistoryRuntime,
} from "./remote-workspace-history-runtime";
import type { RevertPlanOwner } from "./revert-plan-service";
import { RevertPlannerLocalAccess } from "./revert-planner-local-access";

export interface RemoteWorkspaceSnapshotOrigin {
	captureId: string;
	narratorId: string;
	projectId: string | null;
	deviceId: string;
	binding: RemoteHistoryBinding;
	contextKey: string;
	workspaceRevision: number;
	descriptor: RemoteHistoryObject;
	receipt: RemoteHistoryReceipt;
}
export interface RemoteWorkspaceRestoreAuthority {
	owner(
		principal: NarratorPrincipal,
		narratorId: string,
		signal: AbortSignal,
	): Promise<RevertPlanOwner>;
	snapshot(
		principal: NarratorPrincipal,
		narratorId: string,
		captureId: string,
		signal: AbortSignal,
	): Promise<RemoteWorkspaceSnapshotOrigin>;
	policy(
		actor: RemoteHistoryActor,
		origin: RemoteWorkspaceSnapshotOrigin,
		signal: AbortSignal,
	): Promise<NonNullable<RemoteHistoryRequest["treePolicy"]>>;
	authorizeEntry(
		principal: NarratorPrincipal,
		narratorId: string,
		origin: RemoteWorkspaceSnapshotOrigin,
		path: string,
		need: "read" | "write",
		signal: AbortSignal,
	): Promise<void>;
}

export function assertCompleteWorkspaceSnapshot(origin: RemoteWorkspaceSnapshotOrigin) {
	const receipt = origin.receipt;
	assertRemoteHistoryBinding(origin.binding, receipt.binding);
	assertRemoteHistoryObject(origin.binding, origin.descriptor);
	if (
		receipt.kind !== "capture" ||
		receipt.captureKind !== "whole_directory" ||
		receipt.coverage !== "complete" ||
		receipt.consistency !== "stable_double_scan" ||
		!["settled", "finalized"].includes(receipt.state) ||
		receipt.effects.length !== 0 ||
		receipt.tree?.objectId !== origin.descriptor.objectId ||
		origin.descriptor.kind !== "tree" ||
		origin.descriptor.path !== "" ||
		!receipt.policyDigest ||
		receipt.entryCount === undefined ||
		receipt.entryCount > FILE_CHANGE_LIMITS.capturePaths
	)
		throw new Error("Snapshot is not a complete source-qualified whole-directory observation");
}

/** Explicit current human ACL for ORIGINAL snapshot scope, not the current narrator cwd. */
export function createProductionRemoteWorkspaceRestoreAuthority(
	registry: RemoteWorkspaceHistoryRuntime,
): RemoteWorkspaceRestoreAuthority {
	const access = new RevertPlannerLocalAccess();
	return {
		owner: (...args) => access.owner(...args),
		async snapshot(principal, narratorId, captureId, signal) {
			await access.owner(principal, narratorId, signal);
			const row = registry.options.db
				.select()
				.from(remoteTreeCaptures)
				.where(
					and(
						eq(remoteTreeCaptures.id, captureId),
						sql`coalesce(octet_length(${remoteTreeCaptures.receiptMetadataJson}),0) <= ${FILE_CHANGE_LIMITS.summaryBytes}`,
						sql`coalesce(octet_length(${remoteTreeCaptures.descriptorJson}),0) <= ${FILE_CHANGE_LIMITS.metadataBytes}`,
					),
				)
				.get();
			if (!row || row.state !== "complete" || !row.receiptMetadataJson || !row.descriptorJson)
				throw new Error("Complete remote snapshot record unavailable");
			const provenance = row;
			if (provenance.originContextVersion !== 1 || provenance.originProjectId === undefined)
				throw new Error("Legacy snapshot lacks immutable original project provenance");
			if (
				row.narratorId !== narratorId ||
				![`human:${principal.userId}`, `narrator:${narratorId}`].includes(row.actorSubjectKey)
			)
				throw new Error("Snapshot origin narrator/actor is outside this explicit restore context");
			await loadNarratorForAccess(row.narratorId, principal, "read");
			if (provenance.originProjectId) {
				await loadProjectForAccess(provenance.originProjectId, principal, "read");
				await loadProjectForAccess(provenance.originProjectId, principal, "write");
			}
			const binding = row.receiptMetadataJson.binding;
			const scope = registry.options.db
				.select()
				.from(fileChangeScopes)
				.where(eq(fileChangeScopes.id, row.scopeId))
				.get();
			if (
				!scope ||
				scope.deviceId !== row.deviceId ||
				scope.sourceInstanceId !== row.sourceInstanceId ||
				scope.workspaceInstanceId !== row.workspaceInstanceId ||
				scope.canonicalRoot !== binding.root ||
				scope.rootIdentityJson?.object !== row.rootIdentity
			)
				throw new Error("Snapshot source/root record changed");
			const origin: RemoteWorkspaceSnapshotOrigin = {
				captureId: row.id,
				narratorId: row.narratorId,
				projectId: provenance.originProjectId,
				deviceId: row.deviceId,
				binding,
				contextKey: row.contextKey,
				workspaceRevision: row.workspaceRevision,
				descriptor: row.descriptorJson,
				receipt: row.receiptMetadataJson,
			};
			assertCompleteWorkspaceSnapshot(origin);
			return origin;
		},
		async policy(actor, origin, signal) {
			const backend = registry.options.backend(origin.deviceId);
			await registry.options.authorize(
				actor,
				{
					deviceId: origin.deviceId,
					cwd: origin.binding.root,
					lexicalPath: origin.binding.root,
					canonicalPath: origin.binding.root,
					runtimeGeneration: backend.runtimeGeneration,
					rootIdentity: origin.binding.rootIdentity,
				},
				"read",
				signal,
			);
			const result = await remoteTreeCapturePolicy(
				actor,
				{
					deviceId: origin.deviceId,
					cwd: origin.binding.root,
					lexicalPath: origin.binding.root,
					canonicalPath: origin.binding.root,
					runtimeGeneration: backend.runtimeGeneration,
					rootIdentity: origin.binding.rootIdentity,
				},
				backend,
				signal,
			);
			if (result.policyDigest !== origin.receipt.policyDigest)
				throw new Error(
					"Snapshot exclusion/read policy changed; absence coverage is not transferable",
				);
			return result;
		},
		async authorizeEntry(principal, narratorId, origin, path, need, signal) {
			await access.owner(principal, narratorId, signal);
			if (origin.projectId) await loadProjectForAccess(origin.projectId, principal, need);
			const backend = registry.options.backend(origin.deviceId);
			const canonicalPath = backend.paths.resolve(origin.binding.root, path);
			if (!backend.paths.contains(origin.binding.root, canonicalPath))
				throw new Error("Restore entry outside recorded snapshot root");
			await registry.options.authorize(
				{ userId: principal.userId, narratorId, projectId: origin.projectId, kind: "human" },
				{
					deviceId: origin.deviceId,
					cwd: origin.binding.root,
					lexicalPath: canonicalPath,
					canonicalPath,
					runtimeGeneration: backend.runtimeGeneration,
					rootIdentity: origin.binding.rootIdentity,
				},
				need,
				signal,
			);
		},
	};
}
