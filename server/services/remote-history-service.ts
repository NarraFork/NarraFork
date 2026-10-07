import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { AppError } from "@server/lib/errors";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type {
	RemoteHistoryBackend,
	RemoteHistoryBinding,
	RemoteHistoryObject,
	RemoteHistoryOperations,
	RemoteHistoryReceipt,
	RemoteHistoryRequest,
	RemoteHistoryState,
} from "@shared/remote-history-protocol";

export interface RemoteHistoryIntent {
	request: RemoteHistoryRequest;
	kind: "mutate" | "restore" | "compensate";
}

/** Adapter for the server catalog/journal. Production must use durable storage. */
export interface RemoteHistoryJournal {
	putIntent(
		request: RemoteHistoryRequest,
		kind: "mutate" | "restore" | "compensate",
	): Promise<void>;
	// Recovery must re-use the original durable intent, not caller-supplied guesses.
	getIntent?(operationId: string): Promise<RemoteHistoryIntent | null>;
	putReceipt(receipt: RemoteHistoryReceipt): Promise<void>;
	markUnknown(binding: RemoteHistoryBinding, operationId: string): Promise<void>;
	putObject(object: RemoteHistoryObject): Promise<void>;
}

export class RemoteHistoryUncertainError extends Error {
	constructor(
		readonly binding: RemoteHistoryBinding,
		readonly operationId: string,
		options: ErrorOptions,
	) {
		super("Remote history result is unknown; query the original operation receipt", options);
	}
}

const noDispatchProof = Symbol("verified remote history no-dispatch");
const verifiedNoDispatchErrors = new WeakSet<RemoteHistoryNoDispatchError>();

/** Constructed only after exact refusal proof and its server journal are durable.
 * A matching error string, RPC failure or unrecorded response is never this proof. */
export class RemoteHistoryNoDispatchError extends AppError {
	constructor(
		readonly receipt: RemoteHistoryReceipt,
		proof: unknown,
	) {
		super(
			"unsupported_cross_filesystem: private recovery and the existing target must share a filesystem; mutation was not dispatched",
			409,
			"UNSUPPORTED_CROSS_FILESYSTEM",
		);
		if (proof !== noDispatchProof) throw new Error("Verified refusal proof required");
		verifiedNoDispatchErrors.add(this);
		Object.freeze(this);
	}
}

export function isRemoteHistoryNoDispatchError(
	error: unknown,
): error is RemoteHistoryNoDispatchError {
	return error instanceof RemoteHistoryNoDispatchError && verifiedNoDispatchErrors.has(error);
}

function sameRefusalState(a: RemoteHistoryState, b: RemoteHistoryState): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "absent" || b.kind === "absent") return a.kind === b.kind;
	const object = (x: RemoteHistoryObject | undefined, y: RemoteHistoryObject | undefined) =>
		!x || !y
			? x === y
			: (
					[
						"sourceInstanceId",
						"workspaceInstanceId",
						"scopeId",
						"objectId",
						"algorithm",
						"digest",
						"sizeBytes",
						"kind",
						"path",
					] as const
				).every((key) => x[key] === y[key]);
	return (
		a.mode === b.mode &&
		a.incarnation === b.incarnation &&
		object(a.object, b.object) &&
		object(a.metadata, b.metadata)
	);
}

function assertNoDispatchReceipt(
	kind: "mutate" | "restore" | "compensate",
	request: RemoteHistoryRequest,
	receipt: RemoteHistoryReceipt,
): void {
	assertRemoteHistoryBinding(request.binding, receipt.binding);
	if (
		receipt.state !== "rejected" ||
		receipt.reason !== "unsupported_cross_filesystem" ||
		receipt.kind !== kind ||
		receipt.operationId !== request.operationId ||
		receipt.requestDigest !== request.requestDigest ||
		!/^[a-f0-9]{64}$/.test(receipt.payloadDigest) ||
		!receipt.finishedAt ||
		receipt.serverCommitId !== undefined ||
		!request.changes?.length ||
		!Array.isArray(receipt.effects) ||
		receipt.effects.length > FILE_CHANGE_LIMITS.revertFiles ||
		receipt.effects.length !== request.changes.length ||
		// This adapter refuses only existing-file quarantine, never safe absence
		// publication. Missing legacy native identity/metadata is not upgraded.
		!receipt.effects.some((effect) => effect.before.kind === "regular") ||
		!receipt.effects.every((effect, i) => {
			const change = request.changes?.[i];
			return (
				change &&
				effect.path === change.path &&
				effect.outcome === "pending" &&
				effect.after === undefined &&
				(effect.before.kind !== "regular" ||
					(Boolean(effect.before.incarnation) &&
						Boolean(effect.before.metadata) &&
						effect.before.object.path === change.path &&
						effect.before.metadata?.path === change.path)) &&
				(effect.intended.kind !== "regular" || effect.intended.object.path === change.path) &&
				sameRefusalState(effect.before, change.expected) &&
				sameRefusalState(effect.intended, change.desired)
			);
		})
	)
		throw new Error("Remote refusal lacks exact original no-dispatch proof");
}

function snapshotNoDispatchReceipt(receipt: RemoteHistoryReceipt): RemoteHistoryReceipt {
	if (!Array.isArray(receipt.effects) || receipt.effects.length > FILE_CHANGE_LIMITS.revertFiles)
		throw new Error("Remote refusal effect budget exceeded");
	const state = (value: RemoteHistoryState): RemoteHistoryState =>
		value.kind === "absent"
			? Object.freeze({ ...value })
			: Object.freeze({
					...value,
					object: Object.freeze({ ...value.object }),
					metadata: value.metadata ? Object.freeze({ ...value.metadata }) : undefined,
				});
	return Object.freeze({
		...receipt,
		binding: Object.freeze({ ...receipt.binding }),
		effects: Object.freeze(
			receipt.effects.map((effect) =>
				Object.freeze({
					...effect,
					before: state(effect.before),
					intended: state(effect.intended),
				}),
			),
		) as unknown as RemoteHistoryReceipt["effects"],
	});
}

export function assertRemoteHistoryBinding(
	expected: RemoteHistoryBinding,
	actual: RemoteHistoryBinding,
): void {
	for (const key of [
		"sourceInstanceId",
		"workspaceInstanceId",
		"scopeId",
		"root",
		"rootIdentity",
		"fence",
	] as const) {
		if (expected[key] !== actual[key]) throw new Error(`Remote history ${key} mismatch`);
	}
}

export function remoteHistoryObjectId(
	scopeId: string,
	kind: "blob" | "tree",
	digest: string,
	path: string,
): string {
	return createHash("sha256").update(`${scopeId}\0${kind}\0${path}\0${digest}`).digest("hex");
}

export function assertRemoteHistoryObject(
	binding: RemoteHistoryBinding,
	object: RemoteHistoryObject,
): void {
	if (
		object.sourceInstanceId !== binding.sourceInstanceId ||
		object.workspaceInstanceId !== binding.workspaceInstanceId ||
		object.scopeId !== binding.scopeId ||
		object.algorithm !== "sha256" ||
		!/^[a-f0-9]{64}$/.test(object.digest) ||
		object.objectId !==
			remoteHistoryObjectId(binding.scopeId, object.kind, object.digest, object.path) ||
		typeof object.path !== "string" ||
		object.path.length > 4096 ||
		object.path.includes("\0") ||
		(object.kind === "blob" ? !object.path : object.path !== "") ||
		!Number.isSafeInteger(object.sizeBytes) ||
		object.sizeBytes < 0 ||
		object.sizeBytes > FILE_CHANGE_LIMITS.blobBytes ||
		!["blob", "tree"].includes(object.kind)
	)
		throw new Error("Remote object provenance/integrity descriptor mismatch");
}

/** Async-chunked hashing keeps large single-file audit bytes off one long tick. */
export async function remoteHistoryDigest(
	bytes: Uint8Array,
	signal?: AbortSignal,
): Promise<string> {
	if (bytes.byteLength > FILE_CHANGE_LIMITS.blobBytes) throw new Error("Remote blob too large");
	const hash = createHash("sha256");
	for (let start = 0; start < bytes.byteLength; start += FILE_CHANGE_LIMITS.streamChunkBytes) {
		signal?.throwIfAborted();
		hash.update(bytes.subarray(start, start + FILE_CHANGE_LIMITS.streamChunkBytes));
		await yieldToEventLoop();
	}
	return hash.digest("hex");
}

function snapshotRequest(request: RemoteHistoryRequest): RemoteHistoryRequest {
	const state = (value: RemoteHistoryState) =>
		value.kind === "absent"
			? Object.freeze({ kind: "absent" as const })
			: Object.freeze({ ...value, object: Object.freeze({ ...value.object }) });
	return {
		...request,
		binding: Object.freeze({ ...request.binding }),
		treePolicy: request.treePolicy
			? { ...request.treePolicy, deniedDirectories: [...request.treePolicy.deniedDirectories] }
			: undefined,
		paths: request.paths ? [...request.paths] : undefined,
		changes: request.changes?.map((change) =>
			Object.freeze({
				...change,
				expected: state(change.expected),
				desired: state(change.desired),
			}),
		),
	};
}

export class RemoteHistoryService {
	constructor(
		readonly backend: RemoteHistoryBackend,
		readonly binding: RemoteHistoryBinding,
		private readonly journal: RemoteHistoryJournal,
	) {
		if (!backend.supportsRemoteHistory) throw new Error("Remote history capability unavailable");
		this.binding = Object.freeze({ ...binding });
	}

	async stageObject(input: {
		stageId: string;
		requestDigest: string;
		path: string;
		bytes: Uint8Array;
		signal?: AbortSignal;
	}): Promise<RemoteHistoryObject> {
		if (!this.backend.supportsRemoteObjectStage)
			throw new Error("Executor upgrade required: history.object-stage.v1");
		const digest = await remoteHistoryDigest(input.bytes, input.signal);
		const object: RemoteHistoryObject = {
			sourceInstanceId: this.binding.sourceInstanceId,
			workspaceInstanceId: this.binding.workspaceInstanceId,
			scopeId: this.binding.scopeId,
			path: input.path,
			kind: "blob",
			algorithm: "sha256",
			digest,
			sizeBytes: input.bytes.length,
			objectId: remoteHistoryObjectId(this.binding.scopeId, "blob", digest, input.path),
		};
		const base = {
			binding: this.binding,
			stageId: input.stageId,
			requestDigest: input.requestDigest,
			object,
		};
		let status = await this.backend.remoteHistory(
			"objectStage",
			{ ...base, operation: "begin" },
			input.signal,
		);
		assertRemoteHistoryBinding(this.binding, status.binding);
		if (status.state === "unknown")
			throw new Error("Stage requires reconciliation; original staging retained");
		const chunkBytes = Math.min(
			this.backend.remoteHistoryChunkBytes ?? FILE_CHANGE_LIMITS.streamChunkBytes,
			FILE_CHANGE_LIMITS.streamChunkBytes,
		);
		if (chunkBytes < 1) throw new Error("RPC chunk budget unavailable");
		for (let offset = status.written; offset < input.bytes.length; offset += chunkBytes) {
			input.signal?.throwIfAborted();
			const chunk = input.bytes.subarray(offset, offset + chunkBytes);
			status = await this.backend.remoteHistory(
				"objectStage",
				{
					...base,
					operation: "append",
					offset,
					contentBase64: Buffer.from(chunk).toString("base64"),
					chunkDigest: await remoteHistoryDigest(chunk, input.signal),
				},
				input.signal,
			);
			if (status.written !== offset + chunk.length || status.state !== "pending")
				throw new Error("Stage append receipt mismatch");
			await yieldToEventLoop();
		}
		status = await this.backend.remoteHistory(
			"objectStage",
			{ ...base, operation: "finish" },
			input.signal,
		);
		assertRemoteHistoryBinding(this.binding, status.binding);
		assertRemoteHistoryObject(this.binding, status.object);
		if (
			status.state !== "ready" ||
			status.object.objectId !== object.objectId ||
			status.written !== object.sizeBytes
		)
			throw new Error("Stage complete-object receipt mismatch");
		await this.journal.putObject(object);
		return object;
	}

	async captureTree(
		request: RemoteHistoryRequest,
		signal?: AbortSignal,
	): Promise<RemoteHistoryReceipt> {
		if (!this.backend.supportsRemoteTreeCapture)
			throw new Error("Whole-directory capture capability unavailable");
		request = snapshotRequest(request);
		assertRemoteHistoryBinding(this.binding, request.binding);
		const receipt = await this.backend.remoteHistory("captureTree", request, signal);
		if (receipt.captureKind !== "whole_directory")
			throw new Error("Whole-directory capture returned a sparse receipt");
		await this.record(receipt, request);
		return receipt;
	}

	async capture(
		request: RemoteHistoryRequest,
		signal?: AbortSignal,
	): Promise<RemoteHistoryReceipt> {
		request = snapshotRequest(request);
		assertRemoteHistoryBinding(this.binding, request.binding);
		const receipt = await this.backend.remoteHistory("capture", request, signal);
		await this.record(receipt, request);
		return receipt;
	}

	async dispatch(
		kind: "mutate" | "restore" | "compensate",
		request: RemoteHistoryRequest,
		signal?: AbortSignal,
	): Promise<RemoteHistoryReceipt> {
		request = snapshotRequest(request);
		assertRemoteHistoryBinding(this.binding, request.binding);
		signal?.throwIfAborted();
		// Server intent is durable before remote dispatch. IO is never retried with a new ID.
		await this.journal.putIntent(
			{
				...request,
				changes: request.changes?.map(({ contentBase64: _content, ...change }) => change),
			},
			kind,
		);
		let refusal: RemoteHistoryReceipt | undefined;
		try {
			const receipt = await this.backend.remoteHistory(kind, request, signal);
			if (receipt.state === "rejected") {
				assertNoDispatchReceipt(kind, request, receipt);
				refusal = snapshotNoDispatchReceipt(receipt);
				await this.record(refusal, request);
			} else {
				await this.record(receipt, request);
				return receipt;
			}
		} catch (cause) {
			try {
				await this.journal.markUnknown(this.binding, request.operationId);
			} catch {
				/* Preserve the original intent if the server journal is unavailable. */
			}
			throw new RemoteHistoryUncertainError(this.binding, request.operationId, { cause });
		}
		// Deliberately outside the uncertainty catch: this exact durable refusal
		// can settle the original intent/lease without inventing a completed write.
		if (!refusal) throw new Error("Remote refusal proof unavailable");
		throw new RemoteHistoryNoDispatchError(refusal, noDispatchProof);
	}

	/** Recover only a real original refusal after a lost response. The server's
	 * private intent is mandatory; no read of current files and no redispatch. */
	async proveNoDispatch(receipt: RemoteHistoryReceipt): Promise<RemoteHistoryNoDispatchError> {
		const frozen = snapshotNoDispatchReceipt(receipt);
		assertRemoteHistoryBinding(this.binding, frozen.binding);
		if (!this.journal.getIntent)
			throw new Error("Original durable remote intent reader unavailable");
		const original = await this.journal.getIntent(frozen.operationId);
		if (!original) throw new Error("Original durable remote intent unavailable");
		const request = snapshotRequest(original.request);
		assertRemoteHistoryBinding(this.binding, request.binding);
		assertNoDispatchReceipt(original.kind, request, frozen);
		await this.record(frozen, request);
		return new RemoteHistoryNoDispatchError(frozen, noDispatchProof);
	}

	async status(operationId: string, signal?: AbortSignal): Promise<RemoteHistoryReceipt> {
		const receipt = await this.backend.remoteHistory(
			"status",
			{ binding: this.binding, operationId },
			signal,
		);
		if (receipt.operationId !== operationId) throw new Error("Remote receipt operation mismatch");
		if (receipt.state === "rejected") {
			// A forged/mismatched status must never poison Unknown into a terminal
			// rejected row before the original intent has been checked.
			return (await this.proveNoDispatch(receipt)).receipt;
		}
		await this.record(receipt);
		return receipt;
	}

	async finalize(
		operationId: string,
		requestDigest: string,
		serverCommitId: string,
		signal?: AbortSignal,
	): Promise<RemoteHistoryReceipt> {
		const receipt = await this.backend.remoteHistory(
			"finalize",
			{
				binding: this.binding,
				operationId,
				requestDigest,
				serverCommitId,
			},
			signal,
		);
		await this.record(receipt, { operationId, requestDigest });
		return receipt;
	}

	async inspect(paths: string[], cursor?: string, signal?: AbortSignal) {
		const result = await this.backend.remoteHistory(
			"inspect",
			{ binding: this.binding, paths, cursor },
			signal,
		);
		assertRemoteHistoryBinding(this.binding, result.binding);
		return result;
	}

	async readObject(object: RemoteHistoryObject, signal?: AbortSignal): Promise<Uint8Array> {
		assertRemoteHistoryObject(this.binding, object);
		const bytes = new Uint8Array(object.sizeBytes);
		let offset = 0;
		do {
			signal?.throwIfAborted();
			const chunk = await this.backend.remoteHistory(
				"objectRead",
				{
					binding: this.binding,
					object,
					offset,
					maxBytes: FILE_CHANGE_LIMITS.streamChunkBytes,
				},
				signal,
			);
			assertRemoteHistoryObject(this.binding, chunk.object);
			if (
				chunk.object.digest !== object.digest ||
				chunk.object.sizeBytes !== object.sizeBytes ||
				chunk.offset !== offset ||
				chunk.contentBase64.length > Math.ceil(FILE_CHANGE_LIMITS.streamChunkBytes / 3) * 4
			)
				throw new Error("Remote object chunk mismatch");
			const decoded = Buffer.from(chunk.contentBase64, "base64");
			if (
				decoded.toString("base64") !== chunk.contentBase64 ||
				offset + decoded.length > bytes.length ||
				(!chunk.eof && decoded.length === 0)
			)
				throw new Error("Remote object chunk is incomplete or invalid");
			bytes.set(decoded, offset);
			offset += decoded.length;
			if (chunk.eof) break;
			await yieldToEventLoop();
		} while (offset < bytes.length);
		if (offset !== bytes.length || (await remoteHistoryDigest(bytes, signal)) !== object.digest)
			throw new Error("Remote object integrity mismatch");
		return bytes;
	}

	private async record(
		receipt: RemoteHistoryReceipt,
		request?: Pick<RemoteHistoryRequest, "operationId" | "requestDigest">,
	): Promise<void> {
		assertRemoteHistoryBinding(this.binding, receipt.binding);
		if (
			request &&
			(receipt.operationId !== request.operationId ||
				receipt.requestDigest !== request.requestDigest)
		)
			throw new Error("Remote receipt operation/digest mismatch");
		if (!Array.isArray(receipt.effects) || receipt.effects.length > FILE_CHANGE_LIMITS.revertFiles)
			throw new Error("Remote receipt effect budget exceeded");
		const objects = new Map<string, RemoteHistoryObject>();
		for (const effect of receipt.effects) {
			for (const state of [effect.before, effect.intended, effect.after]) {
				if (state?.kind === "regular") {
					assertRemoteHistoryObject(this.binding, state.object);
					objects.set(state.object.objectId, state.object);
					if (state.metadata) {
						assertRemoteHistoryObject(this.binding, state.metadata);
						objects.set(state.metadata.objectId, state.metadata);
					}
				}
			}
		}
		for (const attempt of receipt.captureAttempts ?? []) {
			if (attempt.tree) {
				assertRemoteHistoryObject(this.binding, attempt.tree);
				objects.set(attempt.tree.objectId, attempt.tree);
			}
		}
		if (receipt.tree) {
			assertRemoteHistoryObject(this.binding, receipt.tree);
			objects.set(receipt.tree.objectId, receipt.tree);
		}
		let published = 0;
		for (const object of objects.values()) {
			await this.journal.putObject(object);
			if (++published % 16 === 0) await yieldToEventLoop();
		}
		await this.journal.putReceipt(receipt);
	}
}

export type RemoteHistoryOpen = RemoteHistoryOperations["open"];
export { createPersistentRemoteHistoryJournal } from "./remote-history-journal";
