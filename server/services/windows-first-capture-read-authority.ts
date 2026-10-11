import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { canonicalWindowsIoJson } from "@shared/windows-io-authority";
import { eq, inArray } from "drizzle-orm";
import { aclGrants, narrators, projects, remoteDevices } from "../db/schema";
import { runWindowsIoBounded } from "../lib/windows-io-authority-budget";
import { executionPolicyRevision } from "./execution-policy/engine";
import { executionPolicyRepository } from "./execution-policy/repository";
import { loadNarratorForAccess } from "./narrator-acl";
import { loadProjectForAccess } from "./project-acl";
import {
	assertRemoteEditorSessionOrigin,
	type RemoteEditorSessionOrigin,
} from "./remote-history-recovery-auth";
import {
	authorizeRemoteHistoryTarget,
	type RemoteHistoryActor,
	type RemoteHistoryTarget,
	type RemoteWorkspaceHistoryRuntime,
} from "./remote-workspace-history-runtime";

export interface WindowsFirstCaptureReadStamp {
	readonly checkedAt: number;
	readonly expiresAt: number;
	readonly policyRevision: string;
	readonly aclDigest: string;
	readonly targetDigest: string;
}
function digest(value: unknown): string {
	const raw = canonicalWindowsIoJson(value);
	if (Buffer.byteLength(raw) > 16 * 1024)
		throw new Error("WINDOWS_FIRST_CAPTURE_FRESH_READ_STAMP_BUDGET");
	return createHash("sha256").update(raw).digest("hex");
}
/** Bounded read-only stamp, NOT a grant/readiness bool, signer or test provider.
 * Captures genuine HTTP ALS at registration, never remints/refreshed original ref.
 * Called on BOTH sides of every async deployment probe; no cached policy/ACL bool. */
export function bindWindowsFirstCaptureReadAuthority(input: {
	registry: { readonly options: Pick<RemoteWorkspaceHistoryRuntime["options"], "db"> };
	origin: RemoteEditorSessionOrigin;
	userId: string;
	actor: Readonly<RemoteHistoryActor>;
	target(): Readonly<RemoteHistoryTarget>;
}): (signal: AbortSignal) => Promise<WindowsFirstCaptureReadStamp> {
	const originalRequest = AsyncLocalStorage.snapshot();
	const readAclDigest = (target: Readonly<RemoteHistoryTarget>) => {
		const store = input.registry.options.db;
		const narrator = store
			.select({
				id: narrators.id,
				ownerUserId: narrators.ownerUserId,
				visibility: narrators.visibility,
				writeAudience: narrators.writeAudience,
				type: narrators.type,
				aclRootNarratorId: narrators.aclRootNarratorId,
				chapterId: narrators.chapterId,
				contextProjectId: narrators.contextProjectId,
			})
			.from(narrators)
			.where(eq(narrators.id, input.actor.narratorId))
			.get();
		if (!narrator) throw new Error("WINDOWS_FIRST_CAPTURE_READ_RESOURCE_DISAPPEARED");
		const aclRoot = narrator.aclRootNarratorId
			? store
					.select({
						id: narrators.id,
						ownerUserId: narrators.ownerUserId,
						visibility: narrators.visibility,
						writeAudience: narrators.writeAudience,
						type: narrators.type,
						aclRootNarratorId: narrators.aclRootNarratorId,
						chapterId: narrators.chapterId,
						contextProjectId: narrators.contextProjectId,
					})
					.from(narrators)
					.where(eq(narrators.id, narrator.aclRootNarratorId))
					.get()
			: null;
		if (narrator.aclRootNarratorId && !aclRoot)
			throw new Error("WINDOWS_FIRST_CAPTURE_READ_ACL_ROOT_DISAPPEARED");
		const scopes = [
			...new Set(
				[input.actor.narratorId, narrator.aclRootNarratorId, input.actor.projectId].filter(
					(value): value is string => typeof value === "string",
				),
			),
		];
		const grants = store
			.select({
				id: aclGrants.id,
				scopeType: aclGrants.scopeType,
				scopeId: aclGrants.scopeId,
				principalType: aclGrants.principalType,
				principalId: aclGrants.principalId,
				capability: aclGrants.capability,
			})
			.from(aclGrants)
			.where(inArray(aclGrants.scopeId, scopes))
			.orderBy(aclGrants.id)
			.limit(257)
			.all();
		if (grants.length > 256) throw new Error("WINDOWS_FIRST_CAPTURE_READ_ACL_STAMP_BUDGET");
		const project = input.actor.projectId
			? store
					.select({
						id: projects.id,
						ownerUserId: projects.ownerUserId,
						visibility: projects.visibility,
						status: projects.status,
					})
					.from(projects)
					.where(eq(projects.id, input.actor.projectId))
					.get()
			: null;
		const device = store
			.select({
				id: remoteDevices.id,
				revokedAt: remoteDevices.revokedAt,
				ownerScope: remoteDevices.ownerScope,
				scope: remoteDevices.scope,
				projectId: remoteDevices.projectId,
				createdBy: remoteDevices.createdBy,
				oauthOwnerGrantId: remoteDevices.oauthOwnerGrantId,
			})
			.from(remoteDevices)
			.where(eq(remoteDevices.id, target.deviceId))
			.get();
		if (!device || device.revokedAt || (input.actor.projectId && !project))
			throw new Error("WINDOWS_FIRST_CAPTURE_READ_RESOURCE_REVOKED");
		return digest({ narrator, aclRoot, project, device, grants });
	};
	return (original) => {
		const signal = AbortSignal.any([original, AbortSignal.timeout(5000)]);
		return runWindowsIoBounded(signal, () =>
			originalRequest(async () => {
				signal.throwIfAborted();
				if (input.actor.userId !== input.userId || input.actor.kind !== "human")
					throw new Error("WINDOWS_FIRST_CAPTURE_READ_ACTOR_NOT_ORIGINAL_HUMAN");
				const target = input.target();
				const targetDigest = digest(target);
				const principal = assertRemoteEditorSessionOrigin(
					input.registry,
					input.origin,
					input.userId,
					signal,
				);
				const beforePolicy = executionPolicyRevision(
					executionPolicyRepository.loadNow(input.actor.narratorId, input.registry.options.db),
				);
				const beforeAcl = readAclDigest(target);
				await loadNarratorForAccess(input.actor.narratorId, principal, "read");
				// Each fresh boundary uses a new engine, not shared loaded/compiled caches.
				await authorizeRemoteHistoryTarget(input.actor, target, "read", signal, true);
				const after = assertRemoteEditorSessionOrigin(
					input.registry,
					input.origin,
					input.userId,
					signal,
				);
				await loadNarratorForAccess(input.actor.narratorId, after, "read");
				if (input.actor.projectId) await loadProjectForAccess(input.actor.projectId, after, "read");
				// No awaits after these original-user and actual DB/policy projections.
				const latest = assertRemoteEditorSessionOrigin(
					input.registry,
					input.origin,
					input.userId,
					signal,
				);
				const policyRevision = executionPolicyRevision(
					executionPolicyRepository.loadNow(input.actor.narratorId, input.registry.options.db),
				);
				const aclDigest = readAclDigest(target);
				if (
					latest.isAdmin !== principal.isAdmin ||
					policyRevision !== beforePolicy ||
					aclDigest !== beforeAcl ||
					digest(input.target()) !== targetDigest
				)
					throw new Error("WINDOWS_FIRST_CAPTURE_READ_AUTHORITY_CHANGED_DURING_FRESH_CHECK");
				signal.throwIfAborted();
				const checkedAt = Date.now();
				return Object.freeze({
					checkedAt,
					expiresAt: Math.min(checkedAt + 1000, latest.expiresAtSeconds * 1000),
					policyRevision,
					aclDigest,
					targetDigest,
				});
			}),
		);
	};
}
