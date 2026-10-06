import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeEffect,
	type FileChangeIdentity,
	type FileChangeState,
	fileChangeStatesEqual,
	hasConfirmedNoFileChange,
	hasSettledMeasuredFileEffect,
	type KnownFileChangeState,
} from "@shared/file-change-protocol";
import { fileChangeExecutionBindingMatches, fileChangeIdentityKey } from "./file-change-identity";
import {
	FileChangeMergeError,
	type FileChangeMergeFailure,
	type FileChangeMergeOptions,
	mergeFileChangeBytes,
} from "./file-change-merge";

const DIGEST = /^[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

/** This must be the durable scope revision, not a timestamp or an ID sort key. */
export interface FileChangeReversalEffect extends FileChangeEffect {
	scopeRevision: number;
}

export interface FileChangeReversalInput {
	identity: FileChangeIdentity;
	current: FileChangeState;
	/** Complete, fixed selection for exactly this file. Never pass a sampled page. */
	effects: readonly FileChangeReversalEffect[];
	/** Explicit historical restoration, never an automatic merge fallback. */
	recoveryMode?: "snapshot";
	signal?: AbortSignal;
}

export interface FileChangeReversalDependencies {
	/** Authorized immutable raw IO. Promises must cover the actual operation lifetime,
	 * including cleanup. Cancellation returns promptly, but a still-pending callback
	 * retains its scope/concurrency slot until it really settles. */
	readBlob(
		ref: FileChangeBlobRef,
		options: { signal: AbortSignal; maxBytes: number },
	): Promise<Uint8Array>;
	publishBlob(
		bytes: Uint8Array,
		options: { signal: AbortSignal; expectedSize: number; expectedDigest: string },
	): Promise<FileChangeBlobRef>;
	/** May lower but never raise the plan lifetime hard bound; includes queue wait. */
	timeoutMs?: number;
	/** Trusted infrastructure/test options, never derived from selected paths. */
	mergeOptions?: Omit<FileChangeMergeOptions, "signal">;
	/** Independent cumulative read/merge work cap; repeated reads are never deduplicated. */
	maxProcessedBytes?: number;
	/** Planner-wide processing charge for merge work (blob IO is charged by readBlob). */
	processMergeBytes?: (bytes: number) => void;
}

export type FileChangeReversalFailure =
	| FileChangeMergeFailure
	| "identity_mismatch"
	| "state_unknown"
	| "effect_unverified"
	| "duplicate_unverified"
	| "order_unverified"
	| "state_conflict"
	| "blob_unavailable"
	| "blob_integrity"
	| "queue_full";

export interface FileChangeReversalStep {
	effectId: string;
	mutationId: string;
	scopeRevision: number;
	method: "restore_before" | "restore_snapshot" | "merge" | "already_before" | "no_change";
}

export type FileChangeReversalResult =
	| {
			ok: true;
			identity: FileChangeIdentity;
			expected: KnownFileChangeState;
			desired: KnownFileChangeState;
			changed: boolean;
			steps: FileChangeReversalStep[];
			/** Unique blob bytes across input evidence and private calculated merge outputs. */
			evidenceBytes: number;
			/** Explicit output accounting, independent of input reference multiplicity. */
			intermediateBytes: number;
			/** Metadata only; intermediate bodies are never retained in a history cache. */
			outputRefs: FileChangeBlobRef[];
	  }
	| { ok: false; reason: FileChangeReversalFailure; effectId?: string };

class Refusal extends Error {
	constructor(
		readonly reason: FileChangeReversalFailure,
		readonly effectId?: string,
	) {
		super(`File-change reversal refused: ${reason}`);
	}
}

/**
 * Calculation only. No DB/service initialization, authorization expansion, workspace
 * read/write, history mutation, or fallback. Reuse ONE instance per planner to share
 * the concurrency/queue limits. The caller owns selection completeness, plan-wide
 * multi-file evidence budgets, live identity verification, ACL and journal pinning.
 */
export class FileChangeReversalCalculator {
	private readonly admission = new Admission();
	private readonly timeoutMs: number;
	private readonly maxProcessedBytes: number;

	constructor(private readonly dependencies: FileChangeReversalDependencies) {
		// Four passes allow verification, rereads and merge processing, but remain finite.
		this.maxProcessedBytes =
			dependencies.maxProcessedBytes ?? 4 * FILE_CHANGE_LIMITS.operationEvidenceBytes;
		if (
			!Number.isSafeInteger(this.maxProcessedBytes) ||
			this.maxProcessedBytes < 1 ||
			this.maxProcessedBytes > 4 * FILE_CHANGE_LIMITS.operationEvidenceBytes
		)
			throw new Refusal("invalid_input");
		this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (
			!Number.isSafeInteger(this.timeoutMs) ||
			this.timeoutMs < 1 ||
			this.timeoutMs > FILE_CHANGE_LIMITS.planLifetimeMs
		) {
			throw new Refusal("invalid_input");
		}
	}

	async calculate(input: FileChangeReversalInput): Promise<FileChangeReversalResult> {
		const budget = new Budget(input.signal, this.timeoutMs, this.maxProcessedBytes);
		let release: (() => void) | undefined;
		try {
			budget.check();
			// No caller-owned metadata survives the first await, including queue wait.
			const snapshot = snapshotInput(input);
			fileChangeIdentityKey(snapshot.identity);
			const scope = JSON.stringify([
				snapshot.identity.sourceInstanceId,
				snapshot.identity.deviceId,
				snapshot.identity.workspaceInstanceId,
				snapshot.identity.scopeId,
			]);
			release = await this.admission.acquire(scope, budget.signal);
			budget.check();
			return await this.compute(snapshot, budget);
		} catch (error) {
			const failure = budget.failure ?? error;
			if (failure instanceof Refusal) {
				return {
					ok: false,
					reason: failure.reason,
					...(failure.effectId ? { effectId: failure.effectId } : {}),
				};
			}
			if (failure instanceof FileChangeMergeError) return { ok: false, reason: failure.reason };
			return { ok: false, reason: "invalid_input" };
		} finally {
			// Returning a timeout is not proof that a provider stopped its private IO.
			budget.close(release);
		}
	}

	private async compute(
		input: FileChangeReversalInput,
		budget: Budget,
	): Promise<FileChangeReversalResult> {
		const prepared = await prepare(input, budget);
		// Check every selected effect and EVERY required object before a shortcut or merge.
		// Verification discards bytes rather than retaining an entire 256 MiB history.
		for (const ref of prepared.refs.values()) await this.read(ref, budget);
		const steps: FileChangeReversalStep[] = [];
		let desired = prepared.current;
		let calculatedBytes: Uint8Array | undefined;
		let evidenceBytes = prepared.evidenceBytes;
		const outputRefs = new Map<string, FileChangeBlobRef>();
		for (const effect of prepared.effects) {
			budget.check();
			let method: FileChangeReversalStep["method"];
			if (effect.outcome === "no_change") {
				method = "no_change";
			} else if (input.recoveryMode === "snapshot") {
				// Effects are ordered newest to oldest by durable scope revision. Every
				// changed effect contributes its own measured before, including absence/mode.
				desired = known(effect.before);
				method = "restore_snapshot";
			} else if (fileChangeStatesEqual(desired, effect.before)) {
				method = "already_before";
			} else if (fileChangeStatesEqual(desired, effect.observedAfter)) {
				// No bytes/object/mode drift: restore the original raw state, including absence.
				desired = known(effect.before);
				calculatedBytes = undefined;
				method = "restore_before";
			} else {
				const before = effect.before;
				const after = effect.observedAfter;
				if (
					desired.kind !== "regular" ||
					before.kind !== "regular" ||
					after.kind !== "regular" ||
					before.mode !== after.mode
				) {
					throw new Refusal("state_conflict", effect.id);
				}
				const currentBytes = calculatedBytes ?? (await this.read(desired.blob, budget));
				const afterBytes = await this.read(after.blob, budget);
				const beforeBytes = await this.read(before.blob, budget);
				for (const bytes of [currentBytes, afterBytes, beforeBytes]) {
					if (await isBinary(bytes, budget)) throw new Refusal("state_conflict", effect.id);
				}
				const inputBytes = currentBytes.byteLength + afterBytes.byteLength + beforeBytes.byteLength;
				budget.process(inputBytes);
				this.dependencies.processMergeBytes?.(inputBytes);
				let merged: Uint8Array;
				try {
					merged = await mergeFileChangeBytes(currentBytes, afterBytes, beforeBytes, {
						...this.dependencies.mergeOptions,
						maxOutputBytes: Math.min(
							this.dependencies.mergeOptions?.maxOutputBytes ?? FILE_CHANGE_LIMITS.blobBytes,
							FILE_CHANGE_LIMITS.operationEvidenceBytes - evidenceBytes,
						),
						signal: budget.signal,
					});
				} catch (error) {
					if (error instanceof FileChangeMergeError) throw new Refusal(error.reason, effect.id);
					throw new Refusal("merge_failed", effect.id);
				}
				budget.check();
				budget.process(merged.byteLength);
				this.dependencies.processMergeBytes?.(merged.byteLength);
				const ref = await hashBytes(merged, budget);
				const prior = prepared.refs.get(ref.digest);
				if (prior && !refsEqual(prior, ref)) throw new Refusal("blob_integrity");
				if (!prior) {
					evidenceBytes += ref.sizeBytes;
					prepared.refs.set(ref.digest, ref);
				}
				outputRefs.set(ref.digest, ref);
				// Intermediate blobs remain private memory; publish only the final successful state.
				desired = { kind: "regular", blob: ref, mode: desired.mode };
				calculatedBytes = merged;
				method = "merge";
			}
			steps.push({
				effectId: effect.id,
				mutationId: effect.mutationId,
				scopeRevision: effect.scopeRevision,
				method,
			});
			if (steps.length % FILE_CHANGE_LIMITS.historyPageItems === 0) await yieldToEventLoop();
		}
		const changed = !fileChangeStatesEqual(prepared.current, desired);
		if (calculatedBytes && changed && desired.kind === "regular") {
			budget.check();
			let published: FileChangeBlobRef;
			try {
				published = await budget.wait(
					this.dependencies.publishBlob(calculatedBytes, {
						signal: budget.signal,
						expectedSize: desired.blob.sizeBytes,
						expectedDigest: desired.blob.digest,
					}),
				);
			} catch {
				budget.check();
				throw new Refusal("blob_unavailable");
			}
			const returned = cloneRef(published);
			if (!refsEqual(returned, desired.blob)) throw new Refusal("blob_integrity");
			await this.read(returned, budget);
			desired = { ...desired, blob: returned };
		}
		budget.check();
		return {
			ok: true,
			identity: prepared.identity,
			expected: prepared.current,
			desired,
			changed,
			steps,
			evidenceBytes,
			intermediateBytes: evidenceBytes - prepared.evidenceBytes,
			outputRefs: [...outputRefs.values()],
		};
	}

	private async read(ref: FileChangeBlobRef, budget: Budget): Promise<Uint8Array> {
		budget.check();
		budget.process(ref.sizeBytes);
		let bytes: Uint8Array;
		try {
			bytes = await budget.wait(
				this.dependencies.readBlob(
					{ ...ref },
					{
						signal: budget.signal,
						maxBytes: FILE_CHANGE_LIMITS.blobBytes,
					},
				),
			);
		} catch {
			budget.check();
			throw new Refusal("blob_unavailable");
		}
		if (!(bytes instanceof Uint8Array) || bytes.byteLength !== ref.sizeBytes)
			throw new Refusal("blob_integrity");
		// Never continue using a producer-owned view while later async IO may mutate it.
		const copy = new Uint8Array(bytes.byteLength);
		const hash = createHash("sha256");
		for (let offset = 0; offset < bytes.byteLength; offset += FILE_CHANGE_LIMITS.streamChunkBytes) {
			budget.check();
			const end = Math.min(bytes.byteLength, offset + FILE_CHANGE_LIMITS.streamChunkBytes);
			copy.set(bytes.subarray(offset, end), offset);
			hash.update(copy.subarray(offset, end));
			await yieldToEventLoop();
		}
		budget.check();
		if (hash.digest("hex") !== ref.digest) throw new Refusal("blob_integrity");
		return copy;
	}
}

/** Fixed-shape structural snapshot only: bounded item count, immutable string
 * references and scalar values. No full-history JSON/string encoding/hash here;
 * that potentially 80 MiB work stays in the yielding prepare pass below. */
function snapshotInput(input: FileChangeReversalInput): FileChangeReversalInput {
	if (input.recoveryMode !== undefined && input.recoveryMode !== "snapshot")
		throw new Refusal("invalid_input");
	if (!Array.isArray(input.effects)) throw new Refusal("invalid_input");
	// Check the complete input, BEFORE deduplication. Never consume a truncated prefix.
	if (input.effects.length > FILE_CHANGE_LIMITS.historyToolRelatedChanges)
		throw new Refusal("budget_exceeded");
	const identity = cloneIdentity(input.identity);
	const current = cloneState(input.current);
	const effects = new Array<FileChangeReversalEffect>(input.effects.length);
	const copies = new Map<FileChangeReversalEffect, FileChangeReversalEffect>();
	for (let index = 0; index < effects.length; index++) {
		const original = input.effects[index];
		if (!original) throw new Refusal("invalid_input");
		let copy = copies.get(original);
		if (!copy) {
			copy = snapshotEffect(original);
			copies.set(original, copy);
		}
		effects[index] = copy;
	}
	return {
		identity,
		current,
		effects,
		...(input.recoveryMode === undefined ? {} : { recoveryMode: input.recoveryMode }),
	};
}

function cloneIdentity(identity: FileChangeIdentity): FileChangeIdentity {
	for (const value of [
		identity.sourceInstanceId,
		identity.deviceId,
		identity.workspaceInstanceId,
		identity.scopeId,
		identity.pathFlavor,
		identity.objectRole,
		identity.canonicalPath,
		identity.lexicalPath,
		identity.displayPath,
	]) {
		if (typeof value !== "string" || value.length > FILE_CHANGE_LIMITS.metadataBytes)
			throw new Refusal("invalid_input");
	}
	return {
		sourceInstanceId: identity.sourceInstanceId,
		deviceId: identity.deviceId,
		workspaceInstanceId: identity.workspaceInstanceId,
		scopeId: identity.scopeId,
		pathFlavor: identity.pathFlavor,
		objectRole: identity.objectRole,
		canonicalPath: identity.canonicalPath,
		lexicalPath: identity.lexicalPath,
		displayPath: identity.displayPath,
	};
}

async function prepare(input: FileChangeReversalInput, budget: Budget) {
	const identity = input.identity;
	const identityKey = fileChangeIdentityKey(identity);
	const current = known(cloneState(input.current));
	const refs = new Map<string, FileChangeBlobRef>();
	let evidenceBytes = 0;
	const addState = (state: FileChangeState) => {
		const ref =
			state.kind === "regular" ? state.blob : state.kind === "symlink" ? state.target : null;
		if (!ref) return;
		const prior = refs.get(ref.digest);
		if (prior && !refsEqual(prior, ref)) throw new Refusal("blob_integrity");
		if (prior) return;
		evidenceBytes += ref.sizeBytes;
		if (evidenceBytes > FILE_CHANGE_LIMITS.operationEvidenceBytes)
			throw new Refusal("budget_exceeded");
		refs.set(ref.digest, ref);
	};
	addState(current);
	const ids = new Map<string, { effect: FileChangeReversalEffect; serialized: string }>();
	const mutations = new Map<string, string>();
	const revisions = new Set<number>();
	let processed = 0;
	for (const effect of input.effects) {
		if (processed++ % FILE_CHANGE_LIMITS.historyPageItems === 0) await yieldToEventLoop();
		budget.check();
		validateEffect(effect);
		if (
			fileChangeIdentityKey(effect.identity) !== identityKey ||
			effect.identity.scopeId !== identity.scopeId
		) {
			throw new Refusal("identity_mismatch", effect.id);
		}
		const receipt = effect.executionReceipt;
		if (
			!receipt?.receiptId ||
			!fileChangeExecutionBindingMatches(receipt.executionBinding, receipt.executionBinding)
		) {
			throw new Refusal("effect_unverified", effect.id);
		}
		const noDispatch = hasConfirmedNoFileChange(effect);
		// These shared predicates include the original bound execution receipt; no
		// current/intended byte comparison may fabricate a missing acknowledgement.
		if (!noDispatch && !hasSettledMeasuredFileEffect(effect)) {
			throw new Refusal("effect_unverified", effect.id);
		}
		const serialized = JSON.stringify(effect);
		if (Buffer.byteLength(serialized) > FILE_CHANGE_LIMITS.metadataBytes)
			throw new Refusal("budget_exceeded", effect.id);
		const previous = ids.get(effect.id);
		if (previous) {
			if (previous.serialized !== serialized) throw new Refusal("duplicate_unverified", effect.id);
			continue;
		}
		if (mutations.has(effect.mutationId)) throw new Refusal("duplicate_unverified", effect.id);
		mutations.set(effect.mutationId, effect.id);
		ids.set(effect.id, { effect, serialized });
		if (effect.outcome === "changed") {
			if (revisions.has(effect.scopeRevision)) throw new Refusal("order_unverified", effect.id);
			revisions.add(effect.scopeRevision);
		}
		if (!noDispatch) {
			addState(effect.before);
			addState(effect.intendedAfter);
			addState(effect.observedAfter);
			if (effect.executionReceipt) addState(effect.executionReceipt.observedAfter);
		}
	}
	const effects = Array.from(ids.values(), ({ effect }) => effect).sort(
		(a, b) => b.scopeRevision - a.scopeRevision,
	);
	return { identity, current, refs, effects, evidenceBytes };
}

function validateEffect(effect: FileChangeReversalEffect): void {
	for (const value of [effect.id, effect.operationId, effect.mutationId, effect.requestDigest])
		assertString(value);
	if (
		!DIGEST.test(effect.requestDigest) ||
		!Number.isSafeInteger(effect.attempt) ||
		effect.attempt < 1
	)
		throw new Refusal("invalid_input", effect.id);
	if (!Number.isSafeInteger(effect.scopeRevision) || effect.scopeRevision < 0)
		throw new Refusal("order_unverified", effect.id);
	if (effect.phase !== "apply" && effect.phase !== "compensate")
		throw new Refusal("effect_unverified", effect.id);
	if (
		effect.attribution !== "measured" &&
		effect.attribution !== "observed_ambiguous" &&
		effect.attribution !== "unknown"
	) {
		throw new Refusal("invalid_input", effect.id);
	}
	for (const lines of [effect.linesAdded, effect.linesRemoved]) {
		if (lines !== null && (!Number.isSafeInteger(lines) || lines < 0))
			throw new Refusal("invalid_input", effect.id);
	}
	const receipt = effect.executionReceipt;
	if (receipt) {
		for (const value of [
			receipt.receiptId,
			receipt.mutationId,
			receipt.requestDigest,
			receipt.executionBinding?.deviceId,
			receipt.executionBinding?.runtimeEpoch,
		])
			assertString(value);
		cloneState(receipt.observedAfter);
	}
	cloneState(effect.before);
	cloneState(effect.intendedAfter);
	cloneState(effect.observedAfter);
}

function snapshotEffect(effect: FileChangeReversalEffect): FileChangeReversalEffect {
	const receipt = effect.executionReceipt;
	return {
		id: effect.id,
		operationId: effect.operationId,
		attempt: effect.attempt,
		mutationId: effect.mutationId,
		requestDigest: effect.requestDigest,
		phase: effect.phase,
		identity: cloneIdentity(effect.identity),
		scopeRevision: effect.scopeRevision,
		before: snapshotState(effect.before),
		intendedAfter: snapshotState(effect.intendedAfter),
		observedAfter: snapshotState(effect.observedAfter),
		outcome: effect.outcome,
		settlement: effect.settlement,
		attribution: effect.attribution,
		executionConfirmed: effect.executionConfirmed,
		executionReceipt: receipt
			? {
					receiptId: receipt.receiptId,
					mutationId: receipt.mutationId,
					requestDigest: receipt.requestDigest,
					executionBinding: {
						deviceId: receipt.executionBinding.deviceId,
						runtimeEpoch: receipt.executionBinding.runtimeEpoch,
						runtimeGeneration: receipt.executionBinding.runtimeGeneration,
						fencingToken: receipt.executionBinding.fencingToken,
					},
					confirmed: receipt.confirmed,
					observedAfter: snapshotState(receipt.observedAfter),
					outcome: receipt.outcome,
				}
			: null,
		linesAdded: effect.linesAdded,
		linesRemoved: effect.linesRemoved,
	};
}

function snapshotState(state: FileChangeState): FileChangeState {
	if (state.kind === "absent") return { kind: "absent" };
	if (state.kind === "unknown") return { kind: "unknown", reason: state.reason };
	if (state.kind !== "regular" && state.kind !== "symlink") throw new Refusal("invalid_input");
	const ref = state.kind === "regular" ? state.blob : state.target;
	const copy = { algorithm: ref.algorithm, digest: ref.digest, sizeBytes: ref.sizeBytes };
	return state.kind === "regular"
		? { kind: "regular", blob: copy, mode: state.mode }
		: { kind: "symlink", target: copy, mode: state.mode };
}

function assertString(value: string): void {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 256 ||
		value.includes("\0") ||
		Buffer.byteLength(value) > 256
	)
		throw new Refusal("invalid_input");
}

function cloneState(state: FileChangeState): FileChangeState {
	if (state.kind === "absent") return { kind: "absent" };
	if (state.kind === "unknown") {
		assertString(state.reason);
		return { kind: "unknown", reason: state.reason };
	}
	if (state.kind !== "regular" && state.kind !== "symlink") throw new Refusal("invalid_input");
	if (
		state.mode !== null &&
		(!Number.isSafeInteger(state.mode) || state.mode < 0 || state.mode > 0xffff)
	)
		throw new Refusal("invalid_input");
	return state.kind === "regular"
		? { kind: "regular", blob: cloneRef(state.blob), mode: state.mode }
		: { kind: "symlink", target: cloneRef(state.target), mode: state.mode };
}

function cloneRef(ref: FileChangeBlobRef): FileChangeBlobRef {
	if (
		!ref ||
		ref.algorithm !== "sha256" ||
		typeof ref.digest !== "string" ||
		!DIGEST.test(ref.digest) ||
		!Number.isSafeInteger(ref.sizeBytes) ||
		ref.sizeBytes < 0
	)
		throw new Refusal("blob_integrity");
	if (ref.sizeBytes > FILE_CHANGE_LIMITS.blobBytes) throw new Refusal("budget_exceeded");
	return { algorithm: "sha256", digest: ref.digest, sizeBytes: ref.sizeBytes };
}

function refsEqual(a: FileChangeBlobRef, b: FileChangeBlobRef): boolean {
	return a.algorithm === b.algorithm && a.digest === b.digest && a.sizeBytes === b.sizeBytes;
}

function known(state: FileChangeState): KnownFileChangeState {
	if (state.kind === "unknown") throw new Refusal("state_unknown");
	return state;
}

async function hashBytes(bytes: Uint8Array, budget: Budget): Promise<FileChangeBlobRef> {
	const hash = createHash("sha256");
	for (let offset = 0; offset < bytes.byteLength; offset += FILE_CHANGE_LIMITS.streamChunkBytes) {
		budget.check();
		hash.update(bytes.subarray(offset, offset + FILE_CHANGE_LIMITS.streamChunkBytes));
		await yieldToEventLoop();
	}
	budget.check();
	return { algorithm: "sha256", digest: hash.digest("hex"), sizeBytes: bytes.byteLength };
}

/** NUL anywhere (not just Git's initial probe), and binary control bytes. High
 * bytes are deliberately allowed: CRLF/GBK/invalid UTF-8 need no text decoding. */
async function isBinary(bytes: Uint8Array, budget: Budget): Promise<boolean> {
	for (let offset = 0; offset < bytes.byteLength; offset += FILE_CHANGE_LIMITS.streamChunkBytes) {
		budget.check();
		const end = Math.min(bytes.byteLength, offset + FILE_CHANGE_LIMITS.streamChunkBytes);
		for (let index = offset; index < end; index++) {
			const byte = bytes[index];
			if (
				byte !== undefined &&
				(byte === 127 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))
			)
				return true;
		}
		await yieldToEventLoop();
	}
	return false;
}

class Budget {
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	failure: Refusal | undefined;
	private readonly timer: ReturnType<typeof setTimeout>;
	private readonly onAbort = () => this.abort("cancelled");
	private readonly pending = new Set<Promise<unknown>>();
	private release: (() => void) | undefined;
	private processedBytes = 0;

	process(bytes: number): void {
		this.check();
		if (
			!Number.isSafeInteger(bytes) ||
			bytes < 0 ||
			bytes > this.maxProcessedBytes - this.processedBytes
		)
			throw new Refusal("budget_exceeded");
		this.processedBytes += bytes;
	}

	constructor(
		private readonly external: AbortSignal | undefined,
		timeoutMs: number,
		private readonly maxProcessedBytes: number,
	) {
		external?.addEventListener("abort", this.onAbort, { once: true });
		if (external?.aborted) this.onAbort();
		this.timer = setTimeout(() => this.abort("timeout"), timeoutMs);
	}

	check(): void {
		if (this.failure) throw this.failure;
	}

	private abort(reason: "cancelled" | "timeout"): void {
		this.failure ??= new Refusal(reason);
		this.controller.abort(this.failure);
	}

	/** Return promptly on cancellation, but track actual provider settlement. A late
	 * blob-only publication is unreferenced evidence, not a released IO permit. */
	wait<T>(promise: Promise<T>): Promise<T> {
		const operation = Promise.resolve(promise);
		this.pending.add(operation);
		return new Promise((resolve, reject) => {
			const abort = () => reject(this.failure ?? new Refusal("cancelled"));
			const settled = () => {
				this.signal.removeEventListener("abort", abort);
				this.pending.delete(operation);
				this.releaseIfIdle();
			};
			this.signal.addEventListener("abort", abort, { once: true });
			if (this.signal.aborted) abort();
			operation.then(
				(value) => {
					settled();
					resolve(value);
				},
				(error) => {
					settled();
					reject(error);
				},
			);
		});
	}

	close(release?: () => void): void {
		clearTimeout(this.timer);
		this.external?.removeEventListener("abort", this.onAbort);
		this.release = release;
		this.releaseIfIdle();
	}

	private releaseIfIdle(): void {
		if (this.pending.size !== 0 || !this.release) return;
		const release = this.release;
		this.release = undefined;
		release();
	}
}

interface Waiter {
	scope: string;
	signal: AbortSignal;
	resolve: (release: () => void) => void;
	reject: (error: Refusal) => void;
	abort: () => void;
}

class Admission {
	private readonly active = new Set<string>();
	private readonly queue: Waiter[] = [];

	acquire(scope: string, signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) return Promise.reject(new Refusal("cancelled"));
		if (this.active.size < FILE_CHANGE_LIMITS.captureConcurrency && !this.active.has(scope)) {
			return Promise.resolve(this.start(scope));
		}
		if (this.queue.length >= FILE_CHANGE_LIMITS.captureQueueItems)
			return Promise.reject(new Refusal("queue_full"));
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				scope,
				signal,
				resolve,
				reject,
				abort: () => {
					const index = this.queue.indexOf(waiter);
					if (index !== -1) this.queue.splice(index, 1);
					signal.removeEventListener("abort", waiter.abort);
					reject(new Refusal("cancelled"));
				},
			};
			this.queue.push(waiter);
			signal.addEventListener("abort", waiter.abort, { once: true });
			if (signal.aborted) waiter.abort();
		});
	}

	private start(scope: string): () => void {
		this.active.add(scope);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active.delete(scope);
			for (
				let index = 0;
				index < this.queue.length && this.active.size < FILE_CHANGE_LIMITS.captureConcurrency;
			) {
				const waiter = this.queue[index];
				if (!waiter || this.active.has(waiter.scope)) {
					index++;
					continue;
				}
				this.queue.splice(index, 1);
				waiter.signal.removeEventListener("abort", waiter.abort);
				if (waiter.signal.aborted) waiter.reject(new Refusal("cancelled"));
				else waiter.resolve(this.start(waiter.scope));
			}
		};
	}
}
