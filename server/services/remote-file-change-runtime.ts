import type { FileChangeIdentity } from "@shared/file-change-protocol";
import type {
	RemoteHistoryBinding,
	RemoteHistoryObject,
	RemoteHistoryReceipt,
	RemoteHistoryState,
} from "@shared/remote-history-protocol";
import { remoteHistoryFileState } from "@shared/remote-history-protocol";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import {
	assertRemoteHistoryBinding,
	type RemoteHistoryService,
	remoteHistoryDigest,
	remoteHistoryObjectId,
} from "./remote-history-service";

export interface RemoteFileObservation {
	identity: Readonly<FileChangeIdentity>;
	state: RemoteHistoryState;
	bytes: Uint8Array | null;
}

function sameRemoteObject(
	a: RemoteHistoryObject | undefined,
	b: RemoteHistoryObject | undefined,
): boolean {
	if (!a || !b) return a === b;
	return (
		a.sourceInstanceId === b.sourceInstanceId &&
		a.workspaceInstanceId === b.workspaceInstanceId &&
		a.scopeId === b.scopeId &&
		a.objectId === b.objectId &&
		a.digest === b.digest &&
		a.algorithm === b.algorithm &&
		a.kind === b.kind &&
		a.sizeBytes === b.sizeBytes &&
		a.path === b.path
	);
}
function sameRemoteState(a: RemoteHistoryState, b: RemoteHistoryState): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "absent" || b.kind === "absent") return a.kind === b.kind;
	return (
		a.mode === b.mode &&
		a.incarnation === b.incarnation &&
		sameRemoteObject(a.object, b.object) &&
		sameRemoteObject(a.metadata, b.metadata)
	);
}

/** IO adapter only. Existing TS Write/Edit/StructSed/encoding algorithms are callbacks. */
export class RemoteFileChangeRuntime {
	constructor(
		readonly history: RemoteHistoryService,
		readonly backend: Pick<ExecutionBackend, "deviceId" | "paths" | "pathFlavor">,
	) {}

	relativePath(identity: FileChangeIdentity): string {
		const binding = this.history.binding;
		if (
			identity.deviceId !== this.backend.deviceId ||
			identity.sourceInstanceId !== binding.sourceInstanceId ||
			identity.workspaceInstanceId !== binding.workspaceInstanceId ||
			identity.scopeId !== binding.scopeId ||
			identity.pathFlavor !== this.backend.pathFlavor ||
			identity.objectRole !== "referent" ||
			!this.backend.paths.isAbsolute(identity.canonicalPath) ||
			!this.backend.paths.contains(binding.root, identity.canonicalPath) ||
			this.backend.paths.equals(binding.root, identity.canonicalPath)
		)
			throw new Error("Recorded remote file identity is outside the admitted history binding");
		return this.backend.paths.relative(binding.root, identity.canonicalPath);
	}

	async observe(
		identity: FileChangeIdentity,
		signal?: AbortSignal,
	): Promise<RemoteFileObservation> {
		const relative = this.relativePath(identity);
		const result = await this.history.inspect([relative], undefined, signal);
		const observation = result.observations[0];
		if (
			result.observations.length !== 1 ||
			observation?.path !== relative ||
			!observation.state ||
			observation.error
		)
			throw new Error(
				`Remote evidence unavailable: ${observation?.error ?? "incomplete observation"}`,
			);
		const bytes =
			observation.state.kind === "absent"
				? null
				: await this.history.readObject(observation.state.object, signal);
		return { identity: Object.freeze({ ...identity }), state: observation.state, bytes };
	}

	async execute<Result>(input: {
		identity: FileChangeIdentity;
		operationId: string;
		/** Stable caller intent digest, bound to tool/editor request and granted target. */
		requestDigest: string;
		signal: AbortSignal;
		authorize(): Promise<void>;
		construct(
			before: RemoteFileObservation,
		):
			| Promise<{ nextBytes: Uint8Array; result: Result }>
			| { nextBytes: Uint8Array; result: Result };
		/** Persist effects/history using the real receipt before releasing its barrier. */
		commit(receipt: RemoteHistoryReceipt): Promise<string>;
	}): Promise<{ result: Result; receipt: RemoteHistoryReceipt }> {
		const identity = Object.freeze({ ...input.identity });
		const binding: RemoteHistoryBinding = Object.freeze({ ...this.history.binding });
		await input.authorize();
		input.signal.throwIfAborted();
		const before = await this.observe(identity, input.signal);
		const prepared = await input.construct(before);
		const digest = await remoteHistoryDigest(prepared.nextBytes, input.signal);
		const path = this.relativePath(identity);
		let object: RemoteHistoryObject = {
			path,
			algorithm: "sha256",
			digest,
			objectId: remoteHistoryObjectId(binding.scopeId, "blob", digest, path),
			sizeBytes: prepared.nextBytes.byteLength,
			kind: "blob",
			sourceInstanceId: binding.sourceInstanceId,
			workspaceInstanceId: binding.workspaceInstanceId,
			scopeId: binding.scopeId,
		};
		await input.authorize();
		input.signal.throwIfAborted();
		assertRemoteHistoryBinding(binding, this.history.binding);
		const staged = Boolean(this.history.backend.supportsRemoteObjectStage);
		if (staged)
			object = await this.history.stageObject({
				stageId: `${input.operationId}:body`,
				requestDigest: input.requestDigest,
				path,
				bytes: prepared.nextBytes,
				signal: input.signal,
			});
		await input.authorize();
		input.signal.throwIfAborted();
		const receipt = await this.history.dispatch(
			"mutate",
			{
				binding,
				operationId: input.operationId,
				requestDigest: input.requestDigest,
				changes: [
					{
						path: this.relativePath(identity),
						expected: before.state,
						desired: {
							kind: "regular",
							object,
							metadata: before.state.kind === "regular" ? before.state.metadata : undefined,
							mode:
								before.state.kind === "regular"
									? before.state.mode
									: this.backend.pathFlavor === "windows"
										? 0o666
										: 0o600,
						},
						...(staged
							? {}
							: { contentBase64: Buffer.from(prepared.nextBytes).toString("base64") }),
					},
				],
			},
			input.signal,
		);
		if (
			receipt.state !== "settled" ||
			receipt.effects.length !== 1 ||
			receipt.effects[0]?.outcome !== "applied"
		)
			throw new Error("Remote mutation requires reconciliation; barrier remains active");
		const effect = receipt.effects[0];
		if (
			!effect ||
			effect.path !== path ||
			!sameRemoteState(effect.before, before.state) ||
			effect.intended.kind !== "regular" ||
			effect.intended.object.objectId !== object.objectId ||
			effect.intended.mode !==
				(before.state.kind === "regular"
					? before.state.mode
					: this.backend.pathFlavor === "windows"
						? 0o666
						: 0o600) ||
			!effect.after ||
			effect.after.kind !== "regular" ||
			effect.after.object.objectId !== object.objectId ||
			effect.after.mode !== effect.intended.mode
		)
			throw new Error(
				"Remote mutation receipt does not prove the admitted path/expected/intended/after states",
			);
		await this.verifyApplied(receipt, input.signal);
		// A commit failure leaves a settled remote receipt. Recovery must consult the
		// server commit record before explicit conditional compensation/finalization.
		const serverCommitId = await input.commit(receipt);
		const finalized = await this.history.finalize(
			input.operationId,
			input.requestDigest,
			serverCommitId,
			input.signal,
		);
		return { result: prepared.result, receipt: finalized };
	}

	async verifyApplied(receipt: RemoteHistoryReceipt, signal?: AbortSignal): Promise<void> {
		assertRemoteHistoryBinding(this.history.binding, receipt.binding);
		for (const effect of receipt.effects) {
			if (effect.outcome !== "applied" || !effect.after)
				throw new Error("Receipt lacks applied IO proof");
			const inspected = await this.history.inspect([effect.path], undefined, signal);
			const observed = inspected.observations[0];
			if (
				observed?.path !== effect.path ||
				!observed.state ||
				!sameRemoteState(observed.state, effect.after)
			)
				throw new Error("Applied state changed externally; original receipt/barrier retained");
		}
	}

	fileState(observation: RemoteFileObservation) {
		return remoteHistoryFileState(observation.state);
	}
}
