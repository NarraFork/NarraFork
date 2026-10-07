import { createHash } from "node:crypto";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeRevertMutationJournal,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import { type RemoteHistoryReceipt, remoteHistoryFileState } from "@shared/remote-history-protocol";
import { and, eq, sql } from "drizzle-orm";
import {
	remoteHistoryReceipts,
	revertOperationFiles,
	revertOperations,
	workspaceWriteLeases,
} from "../db/schema";
import { NotFoundError } from "../lib/errors";
import type { NarratorPrincipal } from "./narrator-acl";
import {
	isRemoteHistoryNoDispatchError,
	type RemoteHistoryNoDispatchError,
} from "./remote-history-service";
import {
	getRemoteWorkspaceHistoryRuntime,
	type RemoteHistoryActor,
	type RemoteWorkspaceHistoryRuntime,
} from "./remote-workspace-history-runtime";
import {
	attestRemoteLeaseRecovery,
	attestRemoteRevertLeaseRecovery,
} from "./remote-workspace-lease-recovery-authority";
import { RevertMutationJournal } from "./revert-mutation-journal";

export interface RemoteControlRecoveryResult {
	operationId: string;
	state: "finalized" | "rejected" | "recovery_required";
	barrierReleased: boolean;
	reason?: string;
	receipt?: RemoteHistoryReceipt;
}

/** Actual owned file-operation recovery. Exact native receipt + durable server commit,
 * never current hashes, connection loss, host PID, lease age or an empty in-memory map. */
export async function reconcileRemoteFileOperation(input: {
	principal: NarratorPrincipal;
	operationId: string;
	signal: AbortSignal;
	registry?: RemoteWorkspaceHistoryRuntime;
}): Promise<RemoteControlRecoveryResult> {
	const registry = input.registry ?? (await getRemoteWorkspaceHistoryRuntime());
	const operation = registry.evidence.getOperation(input.operationId);
	if (
		!operation ||
		operation.ownerUserId !== input.principal.userId ||
		!operation.narratorId ||
		!["tool", "editor"].includes(operation.sourceKind) ||
		!operation.executionBindingJson
	)
		throw new Error("Owned remote file operation unavailable");
	const effects = registry.evidence.listEffects(operation.id, { limit: 2 });
	if (
		effects.hasMore ||
		effects.items.length !== 1 ||
		effects.items[0].identityJson.deviceId === "local"
	)
		throw new Error("Exactly one source-qualified remote effect is required");
	const effect = effects.items[0];
	const actor: RemoteHistoryActor = {
		userId: input.principal.userId,
		narratorId: operation.narratorId,
		projectId: operation.projectId,
		kind:
			operation.sourceKind === "editor"
				? "human"
				: operation.actorJson.kind === "subagent"
					? "subagent"
					: "primary",
	};
	const nativeId =
		operation.sourceKind === "tool"
			? `${operation.sourceId}:${operation.attempt}`
			: operation.sourceId;
	const outcome = (reason: string): RemoteControlRecoveryResult => ({
		operationId: operation.id,
		state: "recovery_required",
		barrierReleased: false,
		reason,
	});
	try {
		input.signal.throwIfAborted();
		const { history, scope } = await registry.resolveRecoveryHistory(
			actor,
			effect.identityJson,
			operation.executionBindingJson.fencingToken,
			input.signal,
		);
		const receipt = await history.status(nativeId, input.signal);
		const noDispatch =
			receipt.state === "rejected" ? await history.proveNoDispatch(receipt) : undefined;
		if (noDispatch && !isRemoteHistoryNoDispatchError(noDispatch))
			return outcome("Untrusted native refusal");
		const proof = receipt.effects[0];
		if (
			receipt.requestDigest !== operation.requestDigest ||
			receipt.operationId !== nativeId ||
			(!noDispatch && !["settled", "finalized"].includes(receipt.state)) ||
			receipt.effects.length !== 1 ||
			!proof ||
			(noDispatch
				? proof.outcome !== "pending" || proof.after !== undefined
				: !proof.after || proof.outcome !== "applied") ||
			proof.path !==
				registry.options
					.backend(scope.deviceId)
					.paths.relative(scope.canonicalRoot, effect.identityJson.canonicalPath) ||
			!fileChangeStatesEqual(remoteHistoryFileState(proof.before), effect.beforeStateJson) ||
			!fileChangeStatesEqual(
				remoteHistoryFileState(proof.intended),
				effect.intendedAfterStateJson,
			) ||
			(!noDispatch &&
				(!proof.after ||
					!fileChangeStatesEqual(
						remoteHistoryFileState(proof.after),
						effect.intendedAfterStateJson,
					)))
		)
			return outcome("Original native operation is not proven settled; retain its barrier");
		const observedAfter: FileChangeState = noDispatch
			? { kind: "unknown", reason: "result_unknown" }
			: remoteHistoryFileState(proof.after as NonNullable<typeof proof.after>);
		if (!noDispatch && proof.after) {
			const namespace = await registry.auditNamespace(input.signal);
			const bytes =
				proof.after.kind === "regular"
					? await history.readObject(proof.after.object, input.signal)
					: null;
			await registry.importState(namespace, observedAfter, bytes, input.signal);
		}
		if (effect.executionReceiptJson === null)
			registry.evidence.settleEffect({
				operationId: operation.id,
				mutationId: effect.mutationId,
				requestDigest: effect.requestDigest,
				receipt: {
					receiptId: nativeId,
					mutationId: effect.mutationId,
					requestDigest: effect.requestDigest,
					executionBinding: operation.executionBindingJson,
					confirmed: true,
					outcome: noDispatch ? "not_applied" : "applied",
					observedAfter,
				},
			});
		if (operation.executionOutcome === "running")
			registry.evidence.finishOperation(
				operation.id,
				noDispatch || operation.sourceKind !== "editor" ? "failed" : "succeeded",
			);
		const committed = registry.evidence.getOperation(operation.id);
		if (committed?.settlement !== "settled")
			return outcome("Server effect commit is not proven settled");
		const finalized =
			noDispatch || receipt.state === "finalized"
				? receipt
				: await history.finalize(nativeId, receipt.requestDigest, operation.id, input.signal);
		if (
			!noDispatch &&
			(finalized.state !== "finalized" || finalized.serverCommitId !== operation.id)
		)
			return outcome("Remote finalization did not acknowledge the original server commit");

		// Only bounded quarantine metadata enters memory. Multiple matches are a refusal,
		// not permission to clear unrelated operations sharing this scope or physical root.
		const candidates = registry.options.db
			.select({
				id: workspaceWriteLeases.leaseId,
				manifest: workspaceWriteLeases.mutationManifestJson,
			})
			.from(workspaceWriteLeases)
			.where(
				and(
					eq(workspaceWriteLeases.scopeId, scope.id),
					eq(workspaceWriteLeases.deviceId, scope.deviceId),
					eq(workspaceWriteLeases.status, "quarantined"),
					sql`octet_length(${workspaceWriteLeases.mutationManifestJson}) <= ${FILE_CHANGE_LIMITS.summaryBytes}`,
				),
			)
			.limit(FILE_CHANGE_LIMITS.historyPageItems + 1)
			.all();
		if (candidates.length > FILE_CHANGE_LIMITS.historyPageItems)
			return outcome("Recovery quarantine page budget exceeded");
		const matching = candidates.filter(
			(candidate) =>
				candidate.manifest?.mutations.length === 1 &&
				candidate.manifest.mutations[0].mutationId === effect.mutationId,
		);
		if (matching.length !== 1)
			return {
				operationId: operation.id,
				state: noDispatch ? "rejected" : "finalized",
				barrierReleased: false,
				receipt: finalized,
				reason: "No unique original quarantined lease; do not infer release from an empty registry",
			};
		const attestation = await attestRemoteLeaseRecovery({
			registry,
			principal: input.principal,
			scope,
			leaseId: matching[0].id,
			operationId: operation.id,
			signal: input.signal,
		});
		const reservation = registry.coordinator.reserveRemoteRecovery(
			{ scope, leaseId: matching[0].id },
			attestation,
		);
		try {
			reservation.complete(() => {
				// Receipt and server operation are checked AGAIN inside the same atomic lease release.
				const journal = registry.options.db
					.select({
						state: remoteHistoryReceipts.state,
						digest: remoteHistoryReceipts.requestDigest,
						commit: remoteHistoryReceipts.serverCommitId,
					})
					.from(remoteHistoryReceipts)
					.where(
						and(
							eq(remoteHistoryReceipts.sourceInstanceId, scope.sourceInstanceId),
							eq(remoteHistoryReceipts.scopeId, scope.id),
							eq(remoteHistoryReceipts.operationId, nativeId),
						),
					)
					.get();
				if (
					journal?.state !== (noDispatch ? "rejected" : "finalized") ||
					journal.digest !== operation.requestDigest ||
					journal.commit !== (noDispatch ? null : operation.id) ||
					registry.evidence.getOperation(operation.id)?.settlement !== "settled"
				)
					throw new Error("Recovery proof changed before barrier release");
			});
		} finally {
			reservation.release();
		}
		return {
			operationId: operation.id,
			state: noDispatch ? "rejected" : "finalized",
			barrierReleased: true,
			receipt: finalized,
		};
	} catch (error) {
		input.signal.throwIfAborted();
		return outcome(
			error instanceof Error ? error.message.slice(0, 512) : "Remote recovery unavailable",
		);
	}
}

/** A committed history program never triggers inverse compensation on replay.
 * Reconcile only its original native batch terminal acknowledgement and exact lease. */
export async function reconcileRemoteRevertPlan(input: {
	principal: NarratorPrincipal;
	narratorId: string;
	planId: string;
	planHash: string;
	signal: AbortSignal;
	registry?: RemoteWorkspaceHistoryRuntime;
}): Promise<{
	planId: string;
	status: "committed" | "compensated" | "recovery_required";
	barrierReleased: boolean;
	reason?: string;
}> {
	const registry = input.registry ?? (await getRemoteWorkspaceHistoryRuntime());
	const plan = registry.options.db
		.select({
			id: revertOperations.id,
			status: revertOperations.status,
			hash: revertOperations.planHash,
			owner: revertOperations.requestedBySubjectKey,
			narratorId: revertOperations.narratorId,
		})
		.from(revertOperations)
		.where(eq(revertOperations.id, input.planId))
		.get();
	if (
		!plan ||
		!["committed", "recovery_required", "compensated"].includes(plan.status) ||
		plan.owner !== `human:${input.principal.userId}` ||
		plan.narratorId !== input.narratorId ||
		plan.hash !== input.planHash
	)
		throw new NotFoundError("Revert plan", input.planId);
	const files = registry.options.db
		.select({ scopeId: revertOperationFiles.scopeId })
		.from(revertOperationFiles)
		.where(eq(revertOperationFiles.revertOperationId, plan.id))
		.limit(FILE_CHANGE_LIMITS.revertFiles + 1)
		.all();
	if (files.length > FILE_CHANGE_LIMITS.revertFiles)
		throw new Error("Revert recovery file budget exceeded");
	let released = false;
	try {
		const refusals =
			plan.status !== "committed" ? await proveRejectedRevertPlan(registry, input) : undefined;
		for (const scopeId of new Set(files.map((file) => file.scopeId))) {
			const scope = registry.evidence.getScope(scopeId);
			if (!scope) throw new Error("Recorded revert scope unavailable");
			if (scope.deviceId === "local") continue;
			const leases = registry.options.db
				.select({ id: workspaceWriteLeases.leaseId })
				.from(workspaceWriteLeases)
				.where(
					and(
						eq(workspaceWriteLeases.scopeId, scopeId),
						eq(workspaceWriteLeases.deviceId, scope.deviceId),
						sql`${workspaceWriteLeases.status} in ('executing','quarantined')`,
					),
				)
				.limit(FILE_CHANGE_LIMITS.historyPageItems + 1)
				.all();
			if (leases.length !== 1)
				throw new Error(
					"No unique original remote revert lease; do not infer release from empty state",
				);
			const proof = await attestRemoteRevertLeaseRecovery({
				registry,
				principal: input.principal,
				narratorId: input.narratorId,
				planId: input.planId,
				planHash: input.planHash,
				scope,
				leaseId: leases[0].id,
				signal: input.signal,
				noDispatchProofs: refusals?.get(scopeId),
			});
			const reservation = registry.coordinator.reserveRemoteRecovery(
				{ scope, leaseId: leases[0].id },
				proof,
			);
			try {
				reservation.complete(() => undefined);
				released = true;
			} finally {
				reservation.release();
			}
		}
		return {
			planId: plan.id,
			status: refusals ? "compensated" : "committed",
			barrierReleased: released,
		};
	} catch (error) {
		input.signal.throwIfAborted();
		return {
			planId: plan.id,
			status: "recovery_required",
			barrierReleased: false,
			reason:
				error instanceof Error ? error.message.slice(0, 512) : "Remote revert recovery unavailable",
		};
	}
}

/** Original batch IDs/digests come from fixed, claimed per-file journals. This
 * only closes a program whose EVERY native batch was proven never dispatched;
 * it does not compensate, finalize, infer current bytes or resume mutations. */
async function proveRejectedRevertPlan(
	registry: RemoteWorkspaceHistoryRuntime,
	input: Parameters<typeof reconcileRemoteRevertPlan>[0],
): Promise<Map<string, readonly RemoteHistoryNoDispatchError[]>> {
	const plan = registry.options.db
		.select()
		.from(revertOperations)
		.where(eq(revertOperations.id, input.planId))
		.get();
	if (
		!plan ||
		plan.scope !== "narrator" ||
		plan.protocolVersion !== 2 ||
		plan.requestedBySubjectKey !== `human:${input.principal.userId}` ||
		plan.narratorId !== input.narratorId ||
		plan.planHash !== input.planHash ||
		!["recovery_required", "compensated"].includes(plan.status)
	)
		throw new Error("Original owned narrator no-dispatch program required");
	const bytes = sql<number>`octet_length(${revertOperationFiles.receiptJson}) + octet_length(${revertOperationFiles.identityJson}) + octet_length(${revertOperationFiles.expectedStateJson}) + octet_length(${revertOperationFiles.desiredStateJson})`;
	const sizes = registry.options.db
		.select({ bytes })
		.from(revertOperationFiles)
		.where(eq(revertOperationFiles.revertOperationId, plan.id))
		.limit(FILE_CHANGE_LIMITS.revertFiles + 1)
		.all();
	if (
		!sizes.length ||
		sizes.length > FILE_CHANGE_LIMITS.revertFiles ||
		sizes.some((row) => row.bytes > FILE_CHANGE_LIMITS.metadataBytes) ||
		sizes.reduce((total, row) => total + row.bytes, 0) > FILE_CHANGE_LIMITS.summaryBytes
	)
		throw new Error("Original rejected revert metadata budget exceeded");
	const files = registry.options.db
		.select()
		.from(revertOperationFiles)
		.where(
			and(
				eq(revertOperationFiles.revertOperationId, plan.id),
				sql`${bytes} <= ${FILE_CHANGE_LIMITS.metadataBytes}`,
			),
		)
		.limit(FILE_CHANGE_LIMITS.revertFiles)
		.all();
	if (files.length !== sizes.length || files.length !== plan.fileCount)
		throw new Error("Original rejected file inventory changed");
	const groups = new Map<string, typeof files>();
	for (const file of files) {
		const journal = file.receiptJson as FileChangeRevertMutationJournal | null;
		if (
			file.identityJson.deviceId === "local" ||
			journal?.version !== 1 ||
			!journal.apply ||
			journal.compensate !== null ||
			(journal.apply.receipt &&
				(!journal.apply.receipt.confirmed || journal.apply.receipt.outcome !== "not_applied"))
		)
			throw new Error("Program contains an applied, foreign or unproven original phase");
		const group = groups.get(file.scopeId) ?? [];
		group.push(file);
		groups.set(file.scopeId, group);
	}
	const refusals = new Map<string, readonly RemoteHistoryNoDispatchError[]>();
	// Prove ALL batches before modifying any per-file server settlement.
	for (const [scopeId, group] of groups) {
		input.signal.throwIfAborted();
		const scope = registry.evidence.getScope(scopeId);
		const first = group[0];
		const phase = (first.receiptJson as FileChangeRevertMutationJournal).apply;
		if (
			!scope ||
			!phase ||
			group.some(
				(file) =>
					file.identityJson.scopeId !== scope.id ||
					file.identityJson.sourceInstanceId !== scope.sourceInstanceId ||
					file.identityJson.workspaceInstanceId !== scope.workspaceInstanceId ||
					file.identityJson.deviceId !== scope.deviceId ||
					(file.receiptJson as FileChangeRevertMutationJournal).apply?.executionBinding
						.fencingToken !== phase.executionBinding.fencingToken,
			)
		)
			throw new Error("Rejected program source or original fence changed");
		const { history } = await registry.resolveRecoveryHistory(
			{
				userId: input.principal.userId,
				narratorId: input.narratorId,
				projectId: plan.projectId,
				kind: "human",
			},
			first.identityJson,
			phase.executionBinding.fencingToken,
			input.signal,
		);
		const nativeId = `revert:${plan.id}:${scope.id}:apply`;
		const digest = createHash("sha256")
			.update(
				JSON.stringify({
					version: 1,
					planId: plan.id,
					planHash: input.planHash,
					scopeId: scope.id,
					phase: "apply",
					claims: group
						.map((file) => ({
							mutationId: file.applyMutationId,
							requestDigest: file.applyRequestDigest,
						}))
						.sort((a, b) => a.mutationId.localeCompare(b.mutationId)),
				}),
			)
			.digest("hex");
		const refusal = await history.proveNoDispatch(await history.status(nativeId, input.signal));
		const receipt = refusal.receipt;
		if (
			!isRemoteHistoryNoDispatchError(refusal) ||
			receipt.kind !== "restore" ||
			receipt.operationId !== nativeId ||
			receipt.requestDigest !== digest ||
			receipt.effects.length !== group.length
		)
			throw new Error("Original rejected batch differs from fixed plan claims");
		for (const file of group) {
			const path = registry.options
				.backend(scope.deviceId)
				.paths.relative(scope.canonicalRoot, file.identityJson.canonicalPath);
			const effects = receipt.effects.filter((effect) => effect.path === path);
			if (
				effects.length !== 1 ||
				!fileChangeStatesEqual(remoteHistoryFileState(effects[0].before), file.expectedStateJson) ||
				!fileChangeStatesEqual(remoteHistoryFileState(effects[0].intended), file.desiredStateJson)
			)
				throw new Error("Original rejected batch does not cover the fixed file intent");
		}
		refusals.set(scopeId, [refusal]);
	}
	const namespace = await registry.auditNamespace(input.signal);
	const namespaceKey = namespace.catalog.getBudget()?.namespaceKey;
	if (!namespaceKey) throw new Error("Original audit namespace unavailable");
	const journal = new RevertMutationJournal(registry.options.db, { namespaceKey });
	const ctx = {
		planId: plan.id,
		planHash: input.planHash,
		owner: {
			subjectKey: plan.requestedBySubjectKey,
			narratorId: plan.narratorId,
			projectId: plan.projectId,
		},
	};
	for (const file of files) {
		const phase = (file.receiptJson as FileChangeRevertMutationJournal).apply;
		const refusal = refusals.get(file.scopeId)?.[0];
		if (!phase || !refusal) throw new Error("Original refusal phase missing");
		await journal.recordApplyReceipt(
			ctx,
			file.id,
			phase.receipt ?? {
				receiptId: refusal.receipt.operationId,
				mutationId: file.applyMutationId,
				requestDigest: file.applyRequestDigest,
				executionBinding: phase.executionBinding,
				confirmed: true,
				outcome: "not_applied",
				observedAfter: { kind: "unknown", reason: "result_unknown" },
			},
		);
	}
	if (plan.status !== "compensated") journal.beginCompensation(ctx);
	const settled = await journal.finishCompensation(ctx, { signal: input.signal });
	if (settled.status !== "compensated")
		throw new Error("Original rejected program settlement is incomplete");
	return refusals;
}
