import {
	FILE_CHANGE_LIMITS,
	type FileChangeRevertMutationJournal,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import { type RemoteHistoryReceipt, remoteHistoryFileState } from "@shared/remote-history-protocol";
import { and, eq, sql } from "drizzle-orm";
import {
	fileChangeBlobs,
	remoteHistoryReceipts,
	revertOperationFiles,
	revertOperations,
	workspaceWriteLeases,
} from "../db/schema";
import type { FileChangeScopeIdentity } from "./file-change-identity";
import type { NarratorPrincipal } from "./narrator-acl";
import {
	isRemoteHistoryNoDispatchError,
	type RemoteHistoryNoDispatchError,
} from "./remote-history-service";
import type { RemoteWorkspaceHistoryRuntime } from "./remote-workspace-history-runtime";
import type { WorkspaceWriteCoordinatorDb } from "./workspace-write-coordinator";

declare const attestationBrand: unique symbol;
/** Opaque server-generated evidence: JSON/tool args cannot instantiate this capability. */
export type RemoteLeaseRecoveryAttestation = Readonly<{ [attestationBrand]: true }>;
interface Verified {
	registry: RemoteWorkspaceHistoryRuntime;
	scope: FileChangeScopeIdentity;
	leaseId: string;
	operationId: string;
	effectId: string;
	mutationId: string;
	receipt: RemoteHistoryReceipt;
	noDispatch?: RemoteHistoryNoDispatchError;
	generation: number;
	stamp: string;
}
const verified = new WeakMap<object, Verified>();
const verifiedReverts = new WeakMap<
	object,
	{
		registry: RemoteWorkspaceHistoryRuntime;
		scope: FileChangeScopeIdentity;
		leaseId: string;
		planId: string;
		planHash: string;
		stamp: string;
		generation: number;
		noDispatch: boolean;
		receipts: Array<{ operationId: string; digest: string; fence: number; rootIdentity: string }>;
	}
>();
function scopeKey(scope: FileChangeScopeIdentity) {
	return JSON.stringify([
		scope.id,
		scope.sourceInstanceId,
		scope.deviceId,
		scope.workspaceInstanceId,
		scope.pathFlavor,
		scope.canonicalRoot,
	]);
}
function stamp(database: WorkspaceWriteCoordinatorDb) {
	const client = (database as { $client?: { query(sql: string): { get(): unknown } } }).$client;
	if (!client) throw new Error("Remote recovery requires the original root database");
	return JSON.stringify([
		client.query("SELECT total_changes() AS value").get(),
		client.query("PRAGMA data_version").get(),
	]);
}

/** Mint only after live authority and an ORIGINAL native terminal receipt are checked.
 * A host process, epoch, matching file contents and TTL are never termination evidence. */
export async function attestRemoteLeaseRecovery(input: {
	registry: RemoteWorkspaceHistoryRuntime;
	principal: NarratorPrincipal;
	scope: FileChangeScopeIdentity;
	leaseId: string;
	operationId: string;
	signal: AbortSignal;
}): Promise<RemoteLeaseRecoveryAttestation> {
	const { registry } = input;
	const operation = registry.evidence.getOperation(input.operationId);
	if (
		!operation ||
		operation.ownerUserId !== input.principal.userId ||
		!operation.narratorId ||
		!operation.executionBindingJson ||
		operation.settlement !== "settled" ||
		!["tool", "editor"].includes(operation.sourceKind)
	)
		throw new Error("Remote recovery has no owned committed server operation");
	const effects = registry.evidence.listEffects(operation.id, { limit: 2 });
	if (effects.hasMore || effects.items.length !== 1)
		throw new Error("Remote recovery requires one exact original effect");
	const effect = effects.items[0];
	if (
		effect.identityJson.scopeId !== input.scope.id ||
		effect.identityJson.sourceInstanceId !== input.scope.sourceInstanceId ||
		effect.identityJson.workspaceInstanceId !== input.scope.workspaceInstanceId ||
		effect.identityJson.deviceId !== input.scope.deviceId ||
		effect.settlement !== "settled" ||
		!effect.executionConfirmed ||
		!effect.executionReceiptJson
	)
		throw new Error("Remote recovery server effect lacks source-qualified execution proof");
	const nativeId =
		operation.sourceKind === "tool"
			? `${operation.sourceId}:${operation.attempt}`
			: operation.sourceId;
	const { history } = await registry.resolveRecoveryHistory(
		{
			userId: input.principal.userId,
			narratorId: operation.narratorId,
			projectId: operation.projectId,
			kind:
				operation.sourceKind === "editor"
					? "human"
					: operation.actorJson.kind === "subagent"
						? "subagent"
						: "primary",
		},
		effect.identityJson,
		operation.executionBindingJson.fencingToken,
		input.signal,
	);
	const receipt = await history.status(nativeId, input.signal);
	const native = receipt.effects[0];
	const noDispatch =
		receipt.state === "rejected" ? await history.proveNoDispatch(receipt) : undefined;
	if (
		receipt.operationId !== nativeId ||
		receipt.requestDigest !== operation.requestDigest ||
		receipt.effects.length !== 1 ||
		!native ||
		native.path !==
			registry.options
				.backend(input.scope.deviceId)
				.paths.relative(input.scope.canonicalRoot, effect.identityJson.canonicalPath) ||
		!fileChangeStatesEqual(remoteHistoryFileState(native.before), effect.beforeStateJson) ||
		!fileChangeStatesEqual(
			remoteHistoryFileState(native.intended),
			effect.intendedAfterStateJson,
		) ||
		(noDispatch
			? !isRemoteHistoryNoDispatchError(noDispatch) ||
				operation.executionOutcome !== "failed" ||
				effect.executionReceiptJson.outcome !== "not_applied" ||
				effect.observedAfterStateJson.kind !== "unknown" ||
				native.outcome !== "pending" ||
				native.after !== undefined
			: receipt.state !== "finalized" ||
				receipt.serverCommitId !== operation.id ||
				native.outcome !== "applied" ||
				!native.after ||
				!fileChangeStatesEqual(remoteHistoryFileState(native.after), effect.observedAfterStateJson))
	)
		throw new Error("Remote recovery native terminal proof does not match the committed effect");
	const length = registry.options.db
		.select({ bytes: sql<number>`octet_length(${workspaceWriteLeases.mutationManifestJson})` })
		.from(workspaceWriteLeases)
		.where(eq(workspaceWriteLeases.leaseId, input.leaseId))
		.get();
	if (!length || length.bytes > FILE_CHANGE_LIMITS.summaryBytes)
		throw new Error("Remote recovery lease metadata budget exceeded");
	const lease = registry.options.db
		.select()
		.from(workspaceWriteLeases)
		.where(
			and(
				eq(workspaceWriteLeases.leaseId, input.leaseId),
				sql`octet_length(${workspaceWriteLeases.mutationManifestJson}) <= ${FILE_CHANGE_LIMITS.summaryBytes}`,
			),
		)
		.get();
	const mutation = lease?.mutationManifestJson.mutations[0];
	if (
		!lease ||
		lease.deviceId === "local" ||
		lease.scopeId !== input.scope.id ||
		lease.deviceId !== input.scope.deviceId ||
		lease.status !== "quarantined" ||
		lease.executionClass !== "unknown" ||
		lease.mutationManifestJson.mutations.length !== 1 ||
		mutation?.operationId !== operation.id ||
		mutation.effectId !== effect.id ||
		mutation.mutationId !== effect.mutationId ||
		lease.fencingToken !== receipt.binding.fence ||
		lease.runtimeEpoch !== operation.executionBindingJson.runtimeEpoch ||
		lease.runtimeGeneration !== operation.executionBindingJson.runtimeGeneration
	)
		throw new Error("Remote recovery cannot release a different lease or mutation");
	const proof = Object.freeze({}) as RemoteLeaseRecoveryAttestation;
	verified.set(proof, {
		registry,
		scope: Object.freeze({ ...input.scope }),
		leaseId: input.leaseId,
		operationId: operation.id,
		effectId: effect.id,
		mutationId: effect.mutationId,
		receipt: structuredClone(receipt),
		noDispatch,
		generation: registry.options.backend(input.scope.deviceId).runtimeGeneration,
		stamp: stamp(registry.options.db),
	});
	return proof;
}

export async function attestRemoteRevertLeaseRecovery(input: {
	registry: RemoteWorkspaceHistoryRuntime;
	principal: NarratorPrincipal;
	narratorId: string;
	planId: string;
	planHash: string;
	scope: FileChangeScopeIdentity;
	leaseId: string;
	signal: AbortSignal;
	workspaceSnapshot?: { captureId: string; treeDigest: string };
	noDispatchProofs?: readonly RemoteHistoryNoDispatchError[];
}): Promise<RemoteLeaseRecoveryAttestation> {
	const { registry } = input;
	const noDispatch = input.noDispatchProofs !== undefined;
	if (
		noDispatch &&
		(!input.noDispatchProofs?.length ||
			input.noDispatchProofs.length > FILE_CHANGE_LIMITS.revertFiles ||
			input.noDispatchProofs.some((proof) => !isRemoteHistoryNoDispatchError(proof)))
	)
		throw new Error("Original branded native refusal proofs required");
	const plan = registry.options.db
		.select()
		.from(revertOperations)
		.where(eq(revertOperations.id, input.planId))
		.get();
	if (
		!plan ||
		plan.status !== (noDispatch ? "compensated" : "committed") ||
		plan.protocolVersion !== 2 ||
		plan.scope !== (input.workspaceSnapshot ? "workspace" : "narrator") ||
		plan.requestedBySubjectKey !== `human:${input.principal.userId}` ||
		plan.narratorId !== input.narratorId ||
		plan.planHash !== input.planHash
	)
		throw new Error("Owned committed revert plan required");
	if (input.workspaceSnapshot) {
		const ref = registry.options.db
			.select({
				digest: fileChangeBlobs.digest,
				bytes: fileChangeBlobs.sizeBytes,
				state: fileChangeBlobs.status,
			})
			.from(fileChangeBlobs)
			.where(eq(fileChangeBlobs.digest, plan.selectorBlobDigest ?? ""))
			.get();
		if (!ref || ref.state !== "ready" || ref.bytes > FILE_CHANGE_LIMITS.summaryBytes)
			throw new Error("Explicit workspace snapshot selector unavailable");
		const namespace = await registry.auditNamespace(input.signal);
		const bytes = await namespace.store.readBytes(
			{ algorithm: "sha256", digest: ref.digest, sizeBytes: ref.bytes },
			{ signal: input.signal, maxBytes: FILE_CHANGE_LIMITS.summaryBytes },
		);
		const selector = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
			purpose?: string;
			origin?: {
				captureId?: string;
				descriptor?: { digest?: string };
				binding?: {
					scopeId?: string;
					sourceInstanceId?: string;
					workspaceInstanceId?: string;
					root?: string;
				};
			};
		};
		if (
			selector.purpose !== "remote_workspace_snapshot_restore_v1" ||
			selector.origin?.captureId !== input.workspaceSnapshot.captureId ||
			selector.origin.descriptor?.digest !== input.workspaceSnapshot.treeDigest ||
			selector.origin.binding?.scopeId !== input.scope.id ||
			selector.origin.binding.sourceInstanceId !== input.scope.sourceInstanceId ||
			selector.origin.binding.workspaceInstanceId !== input.scope.workspaceInstanceId ||
			selector.origin.binding.root !== input.scope.canonicalRoot
		)
			throw new Error("Workspace recovery cannot borrow narrator undo or another snapshot source");
	}
	const sizes = registry.options.db
		.select({
			id: revertOperationFiles.id,
			size: sql<number>`octet_length(${revertOperationFiles.receiptJson}) + octet_length(${revertOperationFiles.identityJson})`,
		})
		.from(revertOperationFiles)
		.where(
			and(
				eq(revertOperationFiles.revertOperationId, plan.id),
				eq(revertOperationFiles.scopeId, input.scope.id),
			),
		)
		.limit(FILE_CHANGE_LIMITS.revertFiles + 1)
		.all();
	if (
		!sizes.length ||
		sizes.length > FILE_CHANGE_LIMITS.revertFiles ||
		sizes.some((row) => row.size > FILE_CHANGE_LIMITS.metadataBytes) ||
		sizes.reduce((total, row) => total + row.size, 0) > FILE_CHANGE_LIMITS.summaryBytes
	)
		throw new Error("Revert recovery metadata budget exceeded");
	const files = registry.options.db
		.select()
		.from(revertOperationFiles)
		.where(
			and(
				eq(revertOperationFiles.revertOperationId, plan.id),
				eq(revertOperationFiles.scopeId, input.scope.id),
				sql`octet_length(${revertOperationFiles.receiptJson}) + octet_length(${revertOperationFiles.identityJson}) <= ${FILE_CHANGE_LIMITS.metadataBytes}`,
			),
		)
		.limit(FILE_CHANGE_LIMITS.revertFiles)
		.all();
	if (files.length !== sizes.length) throw new Error("Original revert phase inventory changed");
	const proofs = new Map<
		string,
		{ operationId: string; digest: string; fence: number; rootIdentity: string }
	>();
	for (const file of files) {
		const phase = (file.receiptJson as FileChangeRevertMutationJournal | null)?.apply;
		if (
			!phase?.receipt?.confirmed ||
			phase.receipt.outcome !== (noDispatch ? "not_applied" : "applied") ||
			(noDispatch &&
				(file.receiptJson as FileChangeRevertMutationJournal | null)?.compensate !== null) ||
			file.identityJson.deviceId !== input.scope.deviceId ||
			file.identityJson.sourceInstanceId !== input.scope.sourceInstanceId ||
			file.identityJson.workspaceInstanceId !== input.scope.workspaceInstanceId
		)
			throw new Error("Original revert file has no exact native phase proof");
		const { history } = await registry.resolveRecoveryHistory(
			{
				userId: input.principal.userId,
				narratorId: input.narratorId,
				projectId: plan.projectId,
				kind: "human",
			},
			file.identityJson,
			phase.executionBinding.fencingToken,
			input.signal,
		);
		const nativeId = phase.receipt.receiptId;
		const receipt = await history.status(nativeId, input.signal);
		const path = registry.options
			.backend(input.scope.deviceId)
			.paths.relative(input.scope.canonicalRoot, file.identityJson.canonicalPath);
		const matches = receipt.effects.filter((effect) => effect.path === path);
		const refusal = noDispatch
			? input.noDispatchProofs?.find((proof) => proof.receipt.operationId === nativeId)
			: undefined;
		if (
			matches.length !== 1 ||
			!fileChangeStatesEqual(remoteHistoryFileState(matches[0].before), file.expectedStateJson) ||
			!fileChangeStatesEqual(remoteHistoryFileState(matches[0].intended), file.desiredStateJson) ||
			(noDispatch
				? !refusal ||
					receipt.state !== "rejected" ||
					receipt.requestDigest !== refusal.receipt.requestDigest ||
					receipt.payloadDigest !== refusal.receipt.payloadDigest ||
					matches[0].outcome !== "pending" ||
					matches[0].after !== undefined ||
					phase.receipt.mutationId !== file.applyMutationId ||
					phase.receipt.requestDigest !== file.applyRequestDigest
				: !["settled", "finalized"].includes(receipt.state) ||
					matches[0].outcome !== "applied" ||
					!matches[0].after ||
					!fileChangeStatesEqual(remoteHistoryFileState(matches[0].after), file.desiredStateJson))
		)
			throw new Error("Original native revert receipt does not prove this file");
		if (noDispatch) await history.proveNoDispatch(receipt);
		const terminal =
			noDispatch || receipt.state === "finalized"
				? receipt
				: await history.finalize(nativeId, receipt.requestDigest, plan.id, input.signal);
		if (!noDispatch && (terminal.state !== "finalized" || terminal.serverCommitId !== plan.id))
			throw new Error("Revert native terminal commit acknowledgement unavailable");
		proofs.set(nativeId, {
			operationId: nativeId,
			digest: terminal.requestDigest,
			fence: terminal.binding.fence,
			rootIdentity: terminal.binding.rootIdentity,
		});
	}
	if (noDispatch) {
		const expectedPaths = new Set(
			files.map((file) =>
				registry.options
					.backend(input.scope.deviceId)
					.paths.relative(input.scope.canonicalRoot, file.identityJson.canonicalPath),
			),
		);
		const covered = new Set<string>();
		for (const refusal of input.noDispatchProofs ?? []) {
			const receipt = refusal.receipt;
			if (
				!proofs.has(receipt.operationId) ||
				receipt.binding.scopeId !== input.scope.id ||
				receipt.binding.sourceInstanceId !== input.scope.sourceInstanceId ||
				receipt.binding.workspaceInstanceId !== input.scope.workspaceInstanceId ||
				receipt.binding.root !== input.scope.canonicalRoot
			)
				throw new Error("Refusal cannot attest another original revert scope");
			for (const effect of receipt.effects) {
				if (!expectedPaths.has(effect.path) || covered.has(effect.path))
					throw new Error("Refusal proof does not cover exactly the original whole lease");
				covered.add(effect.path);
			}
		}
		if (covered.size !== files.length)
			throw new Error("Refusal proof omits an original lease target");
	}
	const lengths = registry.options.db
		.select({ size: sql<number>`octet_length(${workspaceWriteLeases.mutationManifestJson})` })
		.from(workspaceWriteLeases)
		.where(eq(workspaceWriteLeases.leaseId, input.leaseId))
		.get();
	if (!lengths || lengths.size > FILE_CHANGE_LIMITS.summaryBytes)
		throw new Error("Original revert lease metadata budget exceeded");
	const lease = registry.options.db
		.select()
		.from(workspaceWriteLeases)
		.where(
			and(
				eq(workspaceWriteLeases.leaseId, input.leaseId),
				sql`octet_length(${workspaceWriteLeases.mutationManifestJson}) <= ${FILE_CHANGE_LIMITS.summaryBytes}`,
			),
		)
		.get();
	const ids = new Set(files.map((file) => file.applyMutationId));
	if (
		!lease ||
		lease.scopeId !== input.scope.id ||
		lease.deviceId !== input.scope.deviceId ||
		!["executing", "quarantined"].includes(lease.status) ||
		lease.executionClass !== "unknown" ||
		lease.mutationManifestJson.mutations.length !== ids.size ||
		lease.mutationManifestJson.mutations.some((item) => !ids.has(item.mutationId)) ||
		[...proofs.values()].some((proof) => proof.fence !== lease.fencingToken) ||
		(noDispatch &&
			files.some((file) => {
				const phase = (file.receiptJson as FileChangeRevertMutationJournal | null)?.apply;
				return (
					!phase?.receipt ||
					phase.executionBinding.runtimeEpoch !== lease.runtimeEpoch ||
					phase.executionBinding.runtimeGeneration !== lease.runtimeGeneration ||
					phase.executionBinding.deviceId !== lease.deviceId ||
					(["deviceId", "runtimeEpoch", "runtimeGeneration", "fencingToken"] as const).some(
						(key) => phase.receipt?.executionBinding[key] !== phase.executionBinding[key],
					)
				);
			}))
	)
		throw new Error("Revert lease contains unrelated or unproven mutations");
	const token = Object.freeze({}) as RemoteLeaseRecoveryAttestation;
	verifiedReverts.set(token, {
		registry,
		scope: Object.freeze({ ...input.scope }),
		leaseId: input.leaseId,
		planId: plan.id,
		planHash: input.planHash,
		generation: registry.options.backend(input.scope.deviceId).runtimeGeneration,
		stamp: stamp(registry.options.db),
		noDispatch,
		receipts: [...proofs.values()],
	});
	return token;
}

/** Synchronous recheck at exclusive reservation and SAME-root atomic release. */
export function assertRemoteLeaseRecoveryAttestation(
	proof: RemoteLeaseRecoveryAttestation,
	input: { scope: FileChangeScopeIdentity; leaseId?: string },
	database: WorkspaceWriteCoordinatorDb,
): void {
	const revert = verifiedReverts.get(proof);
	if (revert) {
		if (
			revert.registry.options.db !== database ||
			input.scope.deviceId === "local" ||
			scopeKey(revert.scope) !== scopeKey(input.scope) ||
			revert.leaseId !== input.leaseId ||
			revert.generation !==
				revert.registry.options.backend(input.scope.deviceId).runtimeGeneration ||
			stamp(database) !== revert.stamp
		)
			throw new Error("Revert recovery attestation is stale or for another authority");
		const plan = revert.registry.options.db
			.select({ status: revertOperations.status, hash: revertOperations.planHash })
			.from(revertOperations)
			.where(eq(revertOperations.id, revert.planId))
			.get();
		if (
			plan?.status !== (revert.noDispatch ? "compensated" : "committed") ||
			plan.hash !== revert.planHash
		)
			throw new Error("Revert server commit changed before release");
		for (const expected of revert.receipts) {
			const receipt = revert.registry.options.db
				.select({
					state: remoteHistoryReceipts.state,
					digest: remoteHistoryReceipts.requestDigest,
					commit: remoteHistoryReceipts.serverCommitId,
					fence: remoteHistoryReceipts.fencingToken,
					root: remoteHistoryReceipts.rootIdentity,
					device: remoteHistoryReceipts.deviceId,
					workspace: remoteHistoryReceipts.workspaceInstanceId,
				})
				.from(remoteHistoryReceipts)
				.where(
					and(
						eq(remoteHistoryReceipts.sourceInstanceId, input.scope.sourceInstanceId),
						eq(remoteHistoryReceipts.scopeId, input.scope.id),
						eq(remoteHistoryReceipts.operationId, expected.operationId),
					),
				)
				.get();
			if (
				receipt?.state !== (revert.noDispatch ? "rejected" : "finalized") ||
				receipt.digest !== expected.digest ||
				receipt.commit !== (revert.noDispatch ? null : revert.planId) ||
				receipt.fence !== expected.fence ||
				receipt.root !== expected.rootIdentity ||
				receipt.device !== input.scope.deviceId ||
				receipt.workspace !== input.scope.workspaceInstanceId
			)
				throw new Error("Revert native terminal receipt changed before release");
		}
		return;
	}
	const value = verified.get(proof);
	if (
		!value ||
		value.registry.options.db !== database ||
		input.scope.deviceId === "local" ||
		value.leaseId !== input.leaseId ||
		scopeKey(value.scope) !== scopeKey(input.scope) ||
		value.generation !== value.registry.options.backend(input.scope.deviceId).runtimeGeneration ||
		stamp(database) !== value.stamp
	)
		throw new Error(
			"Remote recovery attestation is absent, forged, stale or for another authority",
		);
	const receipt = value.registry.options.db
		.select({
			state: remoteHistoryReceipts.state,
			digest: remoteHistoryReceipts.requestDigest,
			commit: remoteHistoryReceipts.serverCommitId,
			deviceId: remoteHistoryReceipts.deviceId,
			workspace: remoteHistoryReceipts.workspaceInstanceId,
			rootIdentity: remoteHistoryReceipts.rootIdentity,
			fence: remoteHistoryReceipts.fencingToken,
		})
		.from(remoteHistoryReceipts)
		.where(
			and(
				eq(remoteHistoryReceipts.sourceInstanceId, value.scope.sourceInstanceId),
				eq(remoteHistoryReceipts.scopeId, value.scope.id),
				eq(remoteHistoryReceipts.operationId, value.receipt.operationId),
			),
		)
		.get();
	const operation = value.registry.evidence.getOperation(value.operationId);
	const effect = value.registry.evidence.getEffect(value.operationId, value.mutationId);
	if (
		(value.noDispatch
			? !isRemoteHistoryNoDispatchError(value.noDispatch) ||
				receipt?.state !== "rejected" ||
				receipt.commit !== null ||
				operation?.executionOutcome !== "failed" ||
				effect?.executionReceiptJson?.outcome !== "not_applied" ||
				effect.observedAfterStateJson.kind !== "unknown"
			: receipt?.state !== "finalized" || receipt.commit !== value.operationId) ||
		receipt?.digest !== value.receipt.requestDigest ||
		receipt.deviceId !== value.scope.deviceId ||
		receipt.workspace !== value.scope.workspaceInstanceId ||
		receipt.rootIdentity !== value.receipt.binding.rootIdentity ||
		receipt.fence !== value.receipt.binding.fence ||
		operation?.settlement !== "settled" ||
		effect?.id !== value.effectId ||
		effect.settlement !== "settled" ||
		!effect.executionConfirmed
	)
		throw new Error("Remote terminal receipt or server commit changed before release");
}
