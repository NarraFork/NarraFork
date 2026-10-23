import { createHash } from "node:crypto";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeExecutionReceipt,
	type FileChangeState,
	fileChangeStatesEqual,
} from "@shared/file-change-protocol";
import {
	type RemoteHistoryChange,
	type RemoteHistoryReceipt,
	type RemoteHistoryState,
	remoteHistoryFileState,
} from "@shared/remote-history-protocol";
import { createFileChangeIdentity, fileChangeIdentityKey } from "./file-change-identity";
import { RemoteFileChangeRuntime } from "./remote-file-change-runtime";
import {
	assertRemoteHistoryBinding,
	isRemoteHistoryNoDispatchError,
	remoteHistoryObjectId,
} from "./remote-history-service";
import {
	getRemoteWorkspaceHistoryRuntime,
	REMOTE_HISTORY_INLINE_WRITE_BYTES,
	type RemoteHistoryTarget,
	type RemoteWorkspaceHistoryRuntime,
	remoteHistoryWriteBudget,
} from "./remote-workspace-history-runtime";
import { RevertPlannerRemoteAccess } from "./revert-planner-remote-access";
import {
	type RevertPlannerAccess,
	RevertPlannerError,
	type RevertPlannerFileAccess,
} from "./revert-planner-service";
import type {
	RevertTransactionProvider,
	RevertTransactionProviderInput,
} from "./revert-transaction-service";

function actor(input: RevertPlannerFileAccess) {
	if (!input.owner.narratorId || input.owner.subjectKey !== `human:${input.principal.userId}`)
		throw new Error("Owned narrator revert plan required");
	return {
		userId: input.principal.userId,
		narratorId: input.owner.narratorId,
		projectId: input.owner.projectId,
		kind: "human" as const,
	};
}
export async function resolveRecordedRemoteRevertScope(
	input: RevertPlannerFileAccess,
	injected?: RemoteWorkspaceHistoryRuntime,
) {
	const registry = injected ?? (await getRemoteWorkspaceHistoryRuntime());
	const scope = registry.evidence.getScope(input.identity.scopeId);
	if (
		!scope ||
		scope.deviceId === "local" ||
		scope.sourceInstanceId !== input.identity.sourceInstanceId ||
		scope.workspaceInstanceId !== input.identity.workspaceInstanceId ||
		(scope.status !== "active" && scope.status !== "needs_verification")
	)
		throw new Error(
			"Recorded remote history scope unavailable; legacy provenance cannot be upgraded",
		);
	let backend: ReturnType<RemoteWorkspaceHistoryRuntime["options"]["backend"]>;
	try {
		backend = registry.options.backend(scope.deviceId);
		if (backend.kind !== "remote" || !backend.supportsRemoteHistory || !backend.remoteHistory)
			throw new Error("Capability unavailable");
	} catch {
		throw new RevertPlannerError(
			"UNSUPPORTED_BACKEND",
			"The recorded device has no available verified history provider",
		);
	}
	const context = actor(input);
	const endpoint = await registry.resolve(
		context,
		{
			deviceId: scope.deviceId,
			cwd: scope.canonicalRoot,
			canonicalPath: input.identity.canonicalPath,
			lexicalPath: input.identity.lexicalPath,
			rootIdentity: scope.rootIdentityJson?.object,
			runtimeGeneration: backend.runtimeGeneration,
		},
		"write",
		input.signal,
		input.identity,
		true,
	);
	registry.coordinator.assertRevertActivityBarrier(scope);
	const runtime = registry.runtimeBinding(scope.deviceId);
	if (!runtime) throw new Error("Recorded remote device offline");
	return {
		...endpoint,
		assertCurrent: async (signal: AbortSignal) => {
			await endpoint.assertCurrent(signal);
			registry.coordinator.assertRevertActivityBarrier(scope);
		},
		executionBinding: {
			deviceId: scope.deviceId,
			...runtime,
			fencingToken: Math.max(1, scope.fencingToken),
		},
		scopeRevision: scope.revision,
		unknownCoverage: registry.coordinator.revertUnknownCoverage(scope),
	};
}

/** Shared auth/context plus per-record IO routing; does not inspect narrator's current cwd. */
export function createRecordQualifiedRevertAccess(
	local: RevertPlannerAccess,
	injected?: RemoteWorkspaceHistoryRuntime,
): RevertPlannerAccess {
	const remote = new RevertPlannerRemoteAccess({
		authenticate: (...args) => local.authenticate(...args),
		authorizeNarrator: (...args) => local.authorizeNarrator(...args),
		resolveContext: (input) => local.resolveContext(input),
		async authorizeFile(input) {
			await local.authenticate(input.principal, input.signal);
			const context = await local.resolveContext({
				principal: input.principal,
				narratorId: actor(input).narratorId,
				signal: input.signal,
			});
			if (context.projectId !== input.owner.projectId)
				throw new Error("Revert plan project changed");
			await resolveRecordedRemoteRevertScope(input, injected);
		},
		resolveRecordedScope: (input) => resolveRecordedRemoteRevertScope(input, injected),
	});
	return {
		authenticate: (...args) => local.authenticate(...args),
		authorizeNarrator: (...args) => local.authorizeNarrator(...args),
		resolveContext: (input) => local.resolveContext(input),
		authorizeFile: (input) =>
			(input.identity.deviceId === "local" ? local : remote).authorizeFile(input),
		resolveFile: (input) =>
			(input.identity.deviceId === "local" ? local : remote).resolveFile(input),
	};
}

/** Uses native restore/conditional compensate receipts, not a host filesystem implementation. */
export class RemoteRevertTransactionProvider implements RevertTransactionProvider {
	private readonly batches = new WeakMap<
		RevertTransactionProviderInput["manifest"],
		{
			id: string;
			digest: string;
			receipt: RemoteHistoryReceipt;
			finalized: boolean;
			targets?: RemoteHistoryTarget[];
		}
	>();
	private readonly nativeBefore = new WeakMap<
		RevertTransactionProviderInput["manifest"],
		RemoteHistoryState
	>();
	private readonly nativeAfter = new WeakMap<
		RevertTransactionProviderInput["manifest"],
		RemoteHistoryState
	>();
	constructor(private readonly registry: RemoteWorkspaceHistoryRuntime) {}
	handles(identity: RevertTransactionProviderInput["manifest"]["identity"]) {
		return identity.deviceId !== "local";
	}
	async verifyScope(
		scope: RevertTransactionProviderInput["scope"],
		manifest: RevertTransactionProviderInput["manifest"],
		signal: AbortSignal,
	) {
		signal.throwIfAborted();
		const identity = manifest.identity;
		if (
			scope.id !== identity.scopeId ||
			scope.sourceInstanceId !== identity.sourceInstanceId ||
			scope.workspaceInstanceId !== identity.workspaceInstanceId ||
			scope.deviceId !== identity.deviceId ||
			!scope.rootIdentityJson?.object ||
			fileChangeIdentityKey(createFileChangeIdentity(scope, identity)) !==
				fileChangeIdentityKey(identity)
		)
			throw new Error("Remote revert identity/scope mismatch");
	}
	private async endpoint(input: RevertTransactionProviderInput) {
		input.lease.assertCurrent();
		const resolved = await resolveRecordedRemoteRevertScope(
			{
				principal: input.principal,
				owner: input.owner,
				identity: input.manifest.identity,
				signal: input.signal,
			},
			this.registry,
		);
		if (
			resolved.runtime.history.binding.fence !== input.lease.executionBinding.fencingToken ||
			resolved.executionBinding.runtimeEpoch !== input.lease.executionBinding.runtimeEpoch ||
			resolved.executionBinding.runtimeGeneration !== input.lease.executionBinding.runtimeGeneration
		)
			throw new Error("Remote revert lease/connection fence changed");
		input.lease.assertCurrent();
		return resolved.runtime;
	}
	async guard(input: RevertTransactionProviderInput) {
		await this.verifyScope(input.scope, input.manifest, input.signal);
		await this.endpoint(input);
	}
	async preflight(input: RevertTransactionProviderInput) {
		const remote = await this.endpoint(input);
		const before = await remote.observe(input.manifest.identity, input.signal);
		if (!fileChangeStatesEqual(remoteHistoryFileState(before.state), input.manifest.expected))
			throw new Error("Remote revert current bytes/mode differ from prepared plan");
		if (before.state.kind === "regular" && (!before.state.incarnation || !before.state.metadata))
			throw new Error("Remote native metadata/incarnation evidence unavailable");
		this.nativeBefore.set(input.manifest, before.state);
		if (input.manifest.desired.kind === "regular") {
			if (input.manifest.desired.blob.sizeBytes > remoteHistoryWriteBudget(remote.history.backend))
				throw new Error("Executor upgrade required for chunked restore");
			await input.readBlob(input.manifest.desired.blob, input.signal);
		} else if (input.manifest.desired.kind !== "absent")
			throw new Error("Remote restore unsupported object");
		await this.guard(input);
	}
	async preflightMany(inputs: readonly RevertTransactionProviderInput[]) {
		if (!inputs.length) throw new Error("Empty native batch preflight");
		const remote = await this.endpoint(inputs[0]);
		const changes = inputs.map((input) => {
			const path = remote.relativePath(input.manifest.identity);
			const expected = this.nativeBefore.get(input.manifest);
			if (!expected) throw new Error("Native batch requires every original preflight");
			let desired = this.state(remote, path, input.manifest.desired);
			if (desired.kind === "regular" && expected.kind === "regular")
				desired = { ...desired, metadata: expected.metadata };
			return { path, expected, desired };
		});
		// This is the real server intent ceiling, not a truncating prefix or a split
		// into multiple operations behind the native one-scope pending barrier.
		if (
			Buffer.byteLength(JSON.stringify({ binding: remote.history.binding, changes })) >
			FILE_CHANGE_LIMITS.summaryBytes - FILE_CHANGE_LIMITS.metadataBytes
		)
			throw new Error("Native batch metadata exceeds the complete server journal budget");
	}

	private state(
		remote: RemoteFileChangeRuntime,
		path: string,
		state: FileChangeState,
	): RemoteHistoryState {
		if (state.kind === "absent") return { kind: "absent" };
		if (state.kind !== "regular" || state.mode === null)
			throw new Error("Remote restore requires known regular bytes and mode");
		const binding = remote.history.binding;
		return {
			kind: "regular",
			mode: state.mode,
			object: {
				...state.blob,
				path,
				objectId: remoteHistoryObjectId(binding.scopeId, "blob", state.blob.digest, path),
				kind: "blob",
				sourceInstanceId: binding.sourceInstanceId,
				workspaceInstanceId: binding.workspaceInstanceId,
				scopeId: binding.scopeId,
			},
		};
	}
	async mutateMany(
		inputs: readonly RevertTransactionProviderInput[],
		claims: readonly Parameters<RevertTransactionProvider["mutate"]>[1][],
		phase: "apply" | "compensate",
	): Promise<FileChangeExecutionReceipt[]> {
		if (!inputs.length || inputs.length !== claims.length)
			throw new Error("Exact remote batch claims required");
		const first = inputs[0];
		if (
			inputs.some(
				(input) =>
					input.planId !== first.planId ||
					input.planHash !== first.planHash ||
					input.scope.id !== first.scope.id ||
					input.lease !== first.lease,
			)
		)
			throw new Error("Remote batch cannot mix scopes, plans or fences");
		const history = await this.registry.resolveBatchHistory(
			actor({
				principal: first.principal,
				owner: first.owner,
				identity: first.manifest.identity,
				signal: first.signal,
			}),
			inputs.map((input) => ({
				deviceId: input.scope.deviceId,
				cwd: input.scope.canonicalRoot,
				lexicalPath: input.manifest.identity.lexicalPath,
				canonicalPath: input.manifest.identity.canonicalPath,
				runtimeGeneration: input.lease.executionBinding.runtimeGeneration,
				rootIdentity: input.scope.rootIdentityJson?.object,
			})),
			first.scope,
			first.lease,
			first.signal,
		);
		const logical = {
			version: 1,
			planId: first.planId,
			planHash: first.planHash,
			scopeId: first.scope.id,
			phase,
			claims: claims
				.map((claim) => ({ mutationId: claim.mutationId, requestDigest: claim.requestDigest }))
				.sort((a, b) => a.mutationId.localeCompare(b.mutationId)),
		};
		const digest = createHash("sha256").update(JSON.stringify(logical)).digest("hex");
		const id = `revert:${first.planId}:${first.scope.id}:${phase}`;
		const changes: RemoteHistoryChange[] = [];
		let original:
			| {
					id: string;
					digest: string;
					receipt: RemoteHistoryReceipt;
					finalized: boolean;
					targets?: RemoteHistoryTarget[];
			  }
			| undefined;
		for (let i = 0; i < inputs.length; i++) {
			const input = inputs[i];
			const claim = claims[i];
			input.lease.assertMutationPending(claim.mutationId);
			if (phase === "compensate") {
				const proof = this.batches.get(input.manifest);
				if (!proof || (original && original.id !== proof.id))
					throw new Error("Original native batch compensation proof unavailable");
				original = proof;
				continue;
			}
			const before = this.nativeBefore.get(input.manifest);
			if (!before || !fileChangeStatesEqual(remoteHistoryFileState(before), claim.expected))
				throw new Error("Original native batch preflight unavailable");
			const path = this.registry.options
				.backend(input.scope.deviceId)
				.paths.relative(input.scope.canonicalRoot, input.manifest.identity.canonicalPath);
			const remote = new RemoteFileChangeRuntime(
				history,
				this.registry.options.backend(input.scope.deviceId),
			);
			let desired = this.state(remote, path, claim.desired);
			if (desired.kind === "regular" && before.kind === "regular")
				desired = { ...desired, metadata: before.metadata };
			let contentBase64: string | undefined;
			if (desired.kind === "regular" && claim.desired.kind === "regular") {
				const bytes = await input.readBlob(claim.desired.blob, input.signal);
				if (bytes.byteLength > remoteHistoryWriteBudget(history.backend))
					throw new Error("Remote batch restore byte budget exceeded");
				if (history.backend.supportsRemoteObjectStage) {
					const object = await history.stageObject({
						stageId: `${claim.mutationId}:body`,
						requestDigest: claim.requestDigest,
						path,
						bytes,
						signal: input.signal,
					});
					if (object.objectId !== desired.object.objectId)
						throw new Error("Remote batch staging descriptor mismatch");
				} else contentBase64 = Buffer.from(bytes).toString("base64");
			}
			changes.push({
				path,
				expected: before,
				desired,
				...(contentBase64 === undefined ? {} : { contentBase64 }),
			});
		}
		let noDispatch = false;
		const receipt = await history
			.dispatch(
				phase === "apply" ? "restore" : "compensate",
				{
					binding: history.binding,
					operationId: id,
					requestDigest: digest,
					...(phase === "apply" ? { changes } : { originalOperationId: original?.id }),
				},
				first.signal,
			)
			.catch((error: unknown) => {
				if (phase !== "apply" || !isRemoteHistoryNoDispatchError(error)) throw error;
				noDispatch = true;
				return error.receipt;
			});
		assertRemoteHistoryBinding(history.binding, receipt.binding);
		if (
			receipt.operationId !== id ||
			receipt.requestDigest !== digest ||
			receipt.kind !== (phase === "apply" ? "restore" : "compensate")
		)
			throw new Error("Remote batch receipt differs from its original dispatch identity");
		const proof = {
			id,
			digest,
			receipt,
			finalized: false,
			targets: inputs.map((input) => ({
				deviceId: input.scope.deviceId,
				cwd: input.scope.canonicalRoot,
				lexicalPath: input.manifest.identity.lexicalPath,
				canonicalPath: input.manifest.identity.canonicalPath,
				runtimeGeneration: input.lease.executionBinding.runtimeGeneration,
				rootIdentity: input.scope.rootIdentityJson?.object,
			})),
		};
		const results: FileChangeExecutionReceipt[] = [];
		for (let i = 0; i < inputs.length; i++) {
			const input = inputs[i];
			const claim = claims[i];
			const path = this.registry.options
				.backend(input.scope.deviceId)
				.paths.relative(input.scope.canonicalRoot, input.manifest.identity.canonicalPath);
			const matching = receipt.effects.filter((effect) => effect.path === path);
			if (matching.length !== 1)
				throw new Error("Remote batch receipt has missing/ambiguous effects");
			const effect = matching[0];
			if (
				!fileChangeStatesEqual(remoteHistoryFileState(effect.before), claim.expected) ||
				!fileChangeStatesEqual(remoteHistoryFileState(effect.intended), claim.desired)
			)
				throw new Error("Remote batch receipt differs from fixed per-file claim");
			const applied =
				effect.outcome === "applied" &&
				effect.after !== undefined &&
				fileChangeStatesEqual(remoteHistoryFileState(effect.after), claim.desired);
			const notApplied = effect.outcome === "pending";
			const observedAfter =
				applied && effect.after
					? remoteHistoryFileState(effect.after)
					: notApplied
						? claim.expected
						: { kind: "unknown" as const, reason: "result_unknown" as const };
			if (applied && effect.after) {
				const namespace = await this.registry.auditNamespace(input.signal);
				const bytes =
					effect.after.kind === "regular"
						? await history.readObject(effect.after.object, input.signal)
						: null;
				await this.registry.importState(namespace, observedAfter, bytes, input.signal);
				if (phase === "apply") this.nativeAfter.set(input.manifest, effect.after);
			}
			if (phase === "apply" && !noDispatch) this.batches.set(input.manifest, proof);
			results.push({
				receiptId: receipt.operationId,
				mutationId: claim.mutationId,
				requestDigest: claim.requestDigest,
				executionBinding: claim.executionBinding,
				confirmed: applied || notApplied,
				outcome: applied ? "applied" : notApplied ? "not_applied" : "unknown",
				observedAfter,
			});
		}
		if (receipt.effects.length !== inputs.length)
			throw new Error("Remote batch receipt expanded the admitted effect set");
		return results;
	}

	async mutate(
		input: RevertTransactionProviderInput,
		claim: Parameters<RevertTransactionProvider["mutate"]>[1],
		phase: "apply" | "compensate",
		originalMutationId: string,
	): Promise<FileChangeExecutionReceipt> {
		const remote = await this.endpoint(input);
		const path = remote.relativePath(input.manifest.identity);
		const content =
			claim.desired.kind === "regular"
				? await input.readBlob(claim.desired.blob, input.signal)
				: undefined;
		if (content && content.byteLength > remoteHistoryWriteBudget(remote.history.backend))
			throw new Error("Remote restore byte budget exceeded");
		input.lease.assertMutationPending(claim.mutationId);
		const nativeBefore = this.nativeBefore.get(input.manifest);
		if (
			phase === "apply" &&
			(!nativeBefore ||
				!fileChangeStatesEqual(remoteHistoryFileState(nativeBefore), claim.expected))
		)
			throw new Error("Original native restore preflight unavailable");
		let desired = this.state(remote, path, claim.desired);
		if (desired.kind === "regular" && nativeBefore?.kind === "regular")
			desired = { ...desired, metadata: nativeBefore.metadata };
		const staged =
			phase === "apply" &&
			content !== undefined &&
			content.byteLength > REMOTE_HISTORY_INLINE_WRITE_BYTES;
		if (staged) {
			const object = await remote.history.stageObject({
				stageId: `${claim.mutationId}:restore`,
				requestDigest: claim.requestDigest,
				path,
				bytes: content,
				signal: input.signal,
			});
			if (desired.kind !== "regular" || object.objectId !== desired.object.objectId)
				throw new Error("Remote restore staging descriptor mismatch");
		}
		let noDispatch = false;
		const receipt = await remote.history
			.dispatch(
				phase === "apply" ? "restore" : "compensate",
				{
					binding: remote.history.binding,
					operationId: claim.mutationId,
					requestDigest: claim.requestDigest,
					...(phase === "compensate"
						? { originalOperationId: originalMutationId }
						: {
								changes: [
									{
										path,
										expected: nativeBefore as RemoteHistoryState,
										desired,
										...(content !== undefined && !staged
											? { contentBase64: Buffer.from(content).toString("base64") }
											: {}),
									},
								],
							}),
				},
				input.signal,
			)
			.catch((error: unknown) => {
				if (phase !== "apply" || !isRemoteHistoryNoDispatchError(error)) throw error;
				noDispatch = true;
				return error.receipt;
			});
		assertRemoteHistoryBinding(remote.history.binding, receipt.binding);
		const effect = receipt.effects[0];
		if (noDispatch) {
			if (
				receipt.kind !== "restore" ||
				receipt.operationId !== claim.mutationId ||
				receipt.requestDigest !== claim.requestDigest ||
				receipt.effects.length !== 1 ||
				effect?.path !== path ||
				!fileChangeStatesEqual(remoteHistoryFileState(effect.before), claim.expected) ||
				!fileChangeStatesEqual(remoteHistoryFileState(effect.intended), claim.desired)
			)
				throw new Error("Native refusal differs from the original restore claim");
			return {
				receiptId: receipt.operationId,
				mutationId: claim.mutationId,
				requestDigest: claim.requestDigest,
				executionBinding: claim.executionBinding,
				confirmed: true,
				outcome: "not_applied",
				observedAfter: claim.expected,
			};
		}
		if (
			(receipt.state !== "settled" && receipt.state !== "compensated") ||
			receipt.effects.length !== 1 ||
			effect.path !== path ||
			effect.outcome !== "applied" ||
			!effect.after ||
			!fileChangeStatesEqual(remoteHistoryFileState(effect.before), claim.expected) ||
			!fileChangeStatesEqual(remoteHistoryFileState(effect.intended), claim.desired) ||
			!fileChangeStatesEqual(remoteHistoryFileState(effect.after), claim.desired)
		)
			throw new Error("Remote restore result lacks an exact proven receipt; keep barrier");
		if (phase === "apply") this.nativeAfter.set(input.manifest, effect.after);
		const namespace = await this.registry.auditNamespace(input.signal);
		const after = remoteHistoryFileState(effect.after);
		const bytes =
			effect.after.kind === "regular"
				? await remote.history.readObject(effect.after.object, input.signal)
				: null;
		await this.registry.importState(namespace, after, bytes, input.signal);
		return {
			receiptId: receipt.operationId,
			mutationId: claim.mutationId,
			requestDigest: claim.requestDigest,
			executionBinding: claim.executionBinding,
			confirmed: true,
			outcome: "applied",
			observedAfter: after,
		};
	}
	async verifyDesired(input: RevertTransactionProviderInput) {
		const remote = await this.endpoint(input);
		const current = await remote.observe(input.manifest.identity, input.signal);
		const applied = this.nativeAfter.get(input.manifest);
		if (
			!applied ||
			!fileChangeStatesEqual(remoteHistoryFileState(current.state), input.manifest.desired) ||
			(applied.kind === "regular" &&
				(current.state.kind !== "regular" ||
					!applied.incarnation ||
					current.state.incarnation !== applied.incarnation ||
					current.state.metadata?.objectId !== applied.metadata?.objectId))
		)
			throw new Error(
				"Remote target bytes, metadata or incarnation changed after restore; conditional compensation only",
			);
	}
	async finalize(
		input: RevertTransactionProviderInput,
		claim: { mutationId: string; requestDigest: string },
		serverCommitId: string,
	) {
		const batch = this.batches.get(input.manifest);
		if (batch) {
			if (batch.finalized) return;
			if (!batch.targets) throw new Error("Original native batch target authorization unavailable");
			const history = await this.registry.resolveBatchHistory(
				actor({
					principal: input.principal,
					owner: input.owner,
					identity: input.manifest.identity,
					signal: input.signal,
				}),
				batch.targets,
				input.scope,
				input.lease,
				input.signal,
			);
			const receipt = await history.finalize(batch.id, batch.digest, serverCommitId, input.signal);
			if (receipt.state !== "finalized" || receipt.serverCommitId !== serverCommitId)
				throw new Error("Remote batch finalization not proven");
			batch.finalized = true;
			return;
		}
		const remote = await this.endpoint(input);
		const receipt = await remote.history.finalize(
			claim.mutationId,
			claim.requestDigest,
			serverCommitId,
			input.signal,
		);
		if (receipt.state !== "finalized" || receipt.serverCommitId !== serverCommitId)
			throw new Error("Remote finalization not proven");
	}
}
