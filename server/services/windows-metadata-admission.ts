import { AsyncLocalStorage } from "node:async_hooks";
import { createPublicKey, verify } from "node:crypto";
import {
	canonicalWindowsIoJson,
	WINDOWS_IO_AUTHORITY_LIMITS,
	type WindowsIoAction,
	type WindowsIoAuthorizationRequest,
	type WindowsIoSignedTicket,
	windowsIoAuthorizationRequestSchema,
	windowsIoNativeDescriptorSchema,
} from "@shared/windows-io-authority";
import {
	parseWindowsMetadataCallback,
	WINDOWS_METADATA_CALLBACK_LIMITS,
	type WindowsMetadataCallback,
	type WindowsMetadataCallbackResult,
	windowsMetadataCallbackResultSchema,
	windowsMetadataHelperChallengeSignedBytes,
} from "@shared/windows-metadata-callback";
import { z } from "zod";
import { runWindowsIoBounded } from "../lib/windows-io-authority-budget";
import { decodeWindowsIoBase64url } from "../lib/windows-io-authority-crypto";
import type { WindowsIoAuthority, WindowsIoTrustedActor } from "./windows-io-authority";

export type WindowsMetadataPhase =
	| "capture_readonly"
	| "capture_predispatch"
	| "prepare"
	| "apply"
	| "seal"
	| "cleanup"
	| "recovery";
const phaseActions: Readonly<Record<WindowsMetadataPhase, readonly WindowsIoAction[]>> =
	Object.freeze({
		capture_readonly: ["capture_exact"],
		capture_predispatch: ["capture_exact"],
		prepare: ["capture_exact", "prepare_owned", "status_original"],
		apply: ["restore_original", "status_original"],
		seal: ["seal_owned", "unseal_original", "status_original"],
		cleanup: ["cleanup_created"],
		recovery: ["status_original", "restore_original", "unseal_original"],
	});
const originalSchema = windowsIoAuthorizationRequestSchema.omit({
	action: true,
	challengeNonce: true,
});
export type WindowsMetadataOriginalOperation = z.infer<typeof originalSchema>;
const scopeProofSchema = z.strictObject({
	version: z.literal(2),
	matrix: z.literal("ordinary-file-v2"),
	deviceId: originalSchema.shape.deviceId,
	executorSourceId: originalSchema.shape.executorSourceId,
	scopeId: originalSchema.shape.scopeId,
	root: windowsIoNativeDescriptorSchema,
	helperInstanceId: originalSchema.shape.helperInstanceId,
	helperKeyEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	helperPublicKey: z.string().length(43),
});
/** Produced from live administrator-enrolled native root/helper material, NOT legacy
 * rootIdentity strings or a current metadata projection. Fresh authorization verifies provenance. */
export type WindowsMetadataScopeProof = z.infer<typeof scopeProofSchema>;
declare const admissionBrand: unique symbol;
export type WindowsMetadataAdmission = Readonly<{ [admissionBrand]: true }>;
export interface WindowsMetadataAuthorizationContext {
	readonly actor: WindowsIoTrustedActor;
	readonly credentialRef: object;
	readonly scopeProof: Readonly<WindowsMetadataScopeProof>;
	readonly original: Readonly<WindowsMetadataOriginalOperation>;
	readonly phase: WindowsMetadataPhase;
	readonly callback: Readonly<WindowsMetadataCallback> | null;
}
export interface WindowsMetadataAdmissionInput {
	authority: WindowsIoAuthority;
	actor: WindowsIoTrustedActor;
	/** Exact original server credential/provenance reference; never a body claim. */
	credentialRef: object;
	scopeProof: WindowsMetadataScopeProof;
	original: WindowsMetadataOriginalOperation;
	phase: WindowsMetadataPhase;
	signal: AbortSignal;
	/** Live original credential, actor/op ownership, source/root/lease/fence, path and
	 * stage/proof checks. MUST verify credentialRef and scopeProof provenance from server
	 * stores. Return a current revision, not cached boolean approval. */
	freshAuthorize(
		context: WindowsMetadataAuthorizationContext,
		signal: AbortSignal,
	): Promise<string>;
	/** First-capture result correlation observer. Called only after actual authority
	 * success and fresh checks; it cannot authorize an action or alter requestFor. */
	onTicketIssued?(
		ticket: WindowsIoSignedTicket,
		callback: Readonly<WindowsMetadataCallback>,
		signal: AbortSignal,
	): Promise<void>;
	ttlMs?: number;
}
interface AdmissionState extends WindowsMetadataAuthorizationContext {
	authority: WindowsIoAuthority;
	freshAuthorize: WindowsMetadataAdmissionInput["freshAuthorize"];
	onTicketIssued?: WindowsMetadataAdmissionInput["onTicketIssued"];
	signal: AbortSignal;
	withdrawn: AbortController;
	expiresAt: number;
	outerRpcId: string | null;
	steps: Set<string>;
}
const admissions = new WeakMap<object, AdmissionState>();
const admissionContext = new AsyncLocalStorage<WindowsMetadataAdmission>();
const replay = new Map<string, number>();
function immutable<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) immutable(child);
		Object.freeze(value);
	}
	return value;
}
function same(left: unknown, right: unknown): boolean {
	return canonicalWindowsIoJson(left) === canonicalWindowsIoJson(right);
}
function stateOf(admission: WindowsMetadataAdmission): AdmissionState {
	const state = admission && typeof admission === "object" ? admissions.get(admission) : undefined;
	if (!state) throw new Error("Authentic non-wire metadata admission required");
	state.signal.throwIfAborted();
	state.withdrawn.signal.throwIfAborted();
	if (Date.now() >= state.expiresAt) throw new Error("Metadata admission expired");
	return state;
}
function contextOf(
	state: AdmissionState,
	callback: WindowsMetadataCallback | null,
): WindowsMetadataAuthorizationContext {
	return Object.freeze({
		actor: state.actor,
		credentialRef: state.credentialRef,
		scopeProof: state.scopeProof,
		original: state.original,
		phase: state.phase,
		callback,
	});
}
async function fresh(
	state: AdmissionState,
	callback: WindowsMetadataCallback | null,
	signal: AbortSignal,
): Promise<string> {
	const revision = await state.freshAuthorize(contextOf(state, callback), signal);
	if (typeof revision !== "string" || !revision || revision.length > 4096)
		throw new Error("Fresh metadata authorization revision required");
	signal.throwIfAborted();
	return revision;
}
/** Server-only mint. This is admission to ask for a ticket, NEVER native dispatch or
 * completion evidence. The real authority checks its actor WeakMap when issuing tickets. */
export async function registerAdmission(
	input: WindowsMetadataAdmissionInput,
): Promise<WindowsMetadataAdmission> {
	input.signal.throwIfAborted();
	if (
		!input.actor ||
		typeof input.actor !== "object" ||
		!input.credentialRef ||
		typeof input.credentialRef !== "object" ||
		typeof input.freshAuthorize !== "function" ||
		!phaseActions[input.phase]
	)
		throw new Error("Trusted actor, original credential and fresh stage authority required");
	const original = immutable(originalSchema.parse(input.original));
	const scopeProof = immutable(scopeProofSchema.parse(input.scopeProof));
	decodeWindowsIoBase64url(scopeProof.helperPublicKey, 32);
	if (
		scopeProof.deviceId !== original.deviceId ||
		scopeProof.executorSourceId !== original.executorSourceId ||
		scopeProof.scopeId !== original.scopeId ||
		scopeProof.helperInstanceId !== original.helperInstanceId ||
		!same(scopeProof.root, original.root)
	)
		throw new Error("Original native v2 root/scope proof mismatch");
	if (
		(input.phase === "capture_predispatch" || input.phase === "capture_readonly") &&
		(original.captureProofId || original.preparedObjectId || original.recoveryOriginal)
	)
		throw new Error("Capture admission cannot borrow mutation/recovery proofs");
	if (input.phase === "recovery" ? !original.recoveryOriginal : Boolean(original.recoveryOriginal))
		throw new Error("Recovery requires explicit original operation and current reservation");
	if (input.phase === "cleanup" && (original.captureProofId || !original.preparedObjectId))
		throw new Error("Cleanup requires only registered created-object proof");
	const budget = WINDOWS_IO_AUTHORITY_LIMITS[`${original.budgetClass}TtlMs`];
	const ttl = input.ttlMs ?? budget;
	if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > budget)
		throw new Error("Metadata admission lifetime exceeds budget");
	const state: AdmissionState = {
		authority: input.authority,
		actor: input.actor,
		credentialRef: input.credentialRef,
		scopeProof,
		original,
		phase: input.phase,
		callback: null,
		signal: input.signal,
		freshAuthorize: input.freshAuthorize,
		onTicketIssued: input.onTicketIssued,
		withdrawn: new AbortController(),
		expiresAt: Date.now() + ttl,
		outerRpcId: null,
		steps: new Set(),
	};
	const signal = AbortSignal.any([
		input.signal,
		AbortSignal.timeout(WINDOWS_METADATA_CALLBACK_LIMITS.timeoutMs),
	]);
	await runWindowsIoBounded(signal, async () => {
		await fresh(state, null, signal);
	});
	const admission = Object.freeze({}) as WindowsMetadataAdmission;
	admissions.set(admission, state);
	return admission;
}
export function withdrawAdmission(admission: WindowsMetadataAdmission): void {
	const state = admission && typeof admission === "object" ? admissions.get(admission) : undefined;
	if (!state) throw new Error("Authentic metadata admission required");
	state.withdrawn.abort(new Error("Metadata admission withdrawn"));
}
export function withAdmission<T>(admission: WindowsMetadataAdmission, body: () => T): T {
	stateOf(admission);
	return admissionContext.run(admission, body);
}
export function currentMetadataAdmission(): WindowsMetadataAdmission | undefined {
	return admissionContext.getStore();
}
/** Main adds this NON-WIRE property to SendRpcOptions/PendingRpc; never spread it into params. */
export interface WindowsMetadataSendRPCOptions {
	readonly windowsMetadataAdmission: WindowsMetadataAdmission;
}
export function sendRPCOptions(
	admission: WindowsMetadataAdmission | undefined = currentMetadataAdmission(),
): WindowsMetadataSendRPCOptions {
	if (!admission) throw new Error("Metadata RPC has no original admission");
	stateOf(admission);
	return Object.freeze({ windowsMetadataAdmission: admission });
}
export interface WindowsMetadataLiveConnection {
	deviceId: string;
	connectionId: string;
	sessionId: string;
	runtimeGeneration: number;
}
/** Supplied from the ACTUAL server PendingRpc and connection map, not callback JSON. */
export interface WindowsMetadataPendingRpc extends WindowsMetadataSendRPCOptions {
	outerRpcId: string;
	isPending(): boolean;
	liveConnection(): Readonly<WindowsMetadataLiveConnection> | null;
}
function assertPending(
	pending: WindowsMetadataPendingRpc,
	state: AdmissionState,
	callback: WindowsMetadataCallback,
): void {
	const live = pending.liveConnection();
	if (
		pending.isPending() !== true ||
		!live ||
		pending.outerRpcId !== callback.outerRpcId ||
		live.deviceId !== state.original.deviceId ||
		live.connectionId !== state.original.connectionId ||
		live.sessionId !== state.original.sessionId ||
		live.runtimeGeneration !== state.original.runtimeGeneration
	)
		throw new Error("Metadata callback does not belong to the current original pending RPC");
	if (state.outerRpcId !== null && state.outerRpcId !== pending.outerRpcId)
		throw new Error("Metadata admission cannot be borrowed by another RPC");
	state.outerRpcId = pending.outerRpcId;
}
function requestFor(
	state: AdmissionState,
	callback: WindowsMetadataCallback,
): WindowsIoAuthorizationRequest {
	if (!phaseActions[state.phase].includes(callback.action))
		throw new Error("Metadata action outside admitted stage");
	const challenge = callback.helperChallenge;
	if (
		challenge.helperInstanceId !== state.scopeProof.helperInstanceId ||
		challenge.keyEpoch !== state.scopeProof.helperKeyEpoch ||
		challenge.connectionId !== state.original.connectionId ||
		challenge.sessionId !== state.original.sessionId ||
		challenge.runtimeGeneration !== state.original.runtimeGeneration ||
		!same(callback.descriptors.root, state.original.root) ||
		!same(callback.descriptors.parent, state.original.parent) ||
		!same(callback.descriptors.target, state.original.target) ||
		callback.expectedCurrent.metadataHash !== state.original.expectedCurrentMetadataHash ||
		callback.expectedCurrent.contentHash !== state.original.expectedCurrentContentHash
	)
		throw new Error(
			"Metadata challenge differs from original helper/root/target/current-state binding",
		);
	const owned = callback.action === "prepare_owned" || callback.action === "cleanup_created";
	const capture = callback.action === "capture_exact";
	const captureProofId = owned || capture ? null : state.original.captureProofId;
	const preparedObjectId = capture ? null : state.original.preparedObjectId;
	if (
		callback.proofIds.captureProofId !== captureProofId ||
		callback.proofIds.preparedObjectId !== preparedObjectId
	)
		throw new Error("Metadata callback cannot replace original helper proof IDs");
	if (
		!["capture_exact", "status_original"].includes(callback.action) &&
		(!state.original.expectedCurrentMetadataHash || !state.original.expectedCurrentContentHash)
	)
		throw new Error("Mutation requires exact original expected-current hashes");
	const raw = decodeWindowsIoBase64url(state.scopeProof.helperPublicKey, 32);
	const key = createPublicKey({
		key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
		format: "der",
		type: "spki",
	});
	if (
		!verify(
			null,
			windowsMetadataHelperChallengeSignedBytes(callback, state.original),
			key,
			decodeWindowsIoBase64url(challenge.signature, 64),
		)
	)
		throw new Error("Untrusted native helper challenge");
	return windowsIoAuthorizationRequestSchema.parse({
		...state.original,
		action: callback.action,
		challengeNonce: challenge.challengeNonce,
		captureProofId,
		preparedObjectId,
	});
}
interface Job {
	signal: AbortSignal;
	run(): Promise<WindowsMetadataCallbackResult>;
	resolve(value: WindowsMetadataCallbackResult): void;
	reject(reason: unknown): void;
	started: boolean;
	abort(): void;
}
/** Independent metadata control queue: no general history RPC scheduler dependency. */
export function createWindowsMetadataCallbackController() {
	const queue: Job[] = [];
	let active = 0;
	let outstanding = 0;
	function pump() {
		while (active < WINDOWS_METADATA_CALLBACK_LIMITS.workers && queue.length) {
			const job = queue.shift();
			if (!job) break;
			job.started = true;
			active++;
			Promise.resolve()
				.then(job.run)
				.then(job.resolve, job.reject)
				.finally(() => {
					job.signal.removeEventListener("abort", job.abort);
					active--;
					outstanding--;
					pump();
				});
		}
	}
	return {
		async handle(
			raw: string | Uint8Array,
			pending: WindowsMetadataPendingRpc,
			signal: AbortSignal,
		): Promise<WindowsMetadataCallbackResult> {
			signal.throwIfAborted();
			const callback = immutable(parseWindowsMetadataCallback(raw));
			const state = stateOf(pending.windowsMetadataAdmission);
			assertPending(pending, state, callback);
			const request = requestFor(state, callback);
			if (outstanding >= WINDOWS_METADATA_CALLBACK_LIMITS.queue)
				throw new Error("Metadata control queue full");
			const now = Date.now();
			for (const [key, expires] of replay) if (expires <= now) replay.delete(key);
			const nonceKey = canonicalWindowsIoJson([
				"callback_nonce_v1",
				state.original.deviceId,
				state.original.executorSourceId,
				state.original.connectionId,
				state.original.sessionId,
				callback.nonce,
			]);
			const challengeKey = canonicalWindowsIoJson([
				"helper_challenge_v1",
				state.original.deviceId,
				state.original.executorSourceId,
				state.original.helperInstanceId,
				state.original.sessionId,
				callback.helperChallenge.challengeNonce,
			]);
			if (state.steps.has(callback.stepId) || replay.has(nonceKey) || replay.has(challengeKey))
				throw new Error("Metadata callback nonce/step/challenge replay");
			if (
				state.steps.size >= WINDOWS_METADATA_CALLBACK_LIMITS.stepsPerAdmission ||
				replay.size + 2 > WINDOWS_METADATA_CALLBACK_LIMITS.replayEntries
			)
				throw new Error("Metadata callback replay ledger budget exceeded");
			state.steps.add(callback.stepId);
			replay.set(nonceKey, state.expiresAt);
			replay.set(challengeKey, state.expiresAt);
			const bounded = AbortSignal.any([
				signal,
				state.signal,
				state.withdrawn.signal,
				AbortSignal.timeout(
					Math.min(WINDOWS_METADATA_CALLBACK_LIMITS.timeoutMs, state.expiresAt - now),
				),
			]);
			outstanding++;
			return new Promise<WindowsMetadataCallbackResult>((resolve, reject) => {
				const job: Job = {
					signal: bounded,
					resolve,
					reject,
					started: false,
					abort() {
						reject(bounded.reason);
						if (!job.started) {
							const index = queue.indexOf(job);
							if (index >= 0) {
								queue.splice(index, 1);
								outstanding--;
							}
							bounded.removeEventListener("abort", job.abort);
						}
					},
					async run() {
						// Bound the ENTIRE worker, including a misbehaving fresh ACL/DB callback.
						// Late continuations remain observed and hit abort barriers before signing.
						return runWindowsIoBounded(bounded, async () => {
							bounded.throwIfAborted();
							stateOf(pending.windowsMetadataAdmission);
							assertPending(pending, state, callback);
							const revision = await fresh(state, callback, bounded);
							if (!(await state.authority.readiness(bounded)).ready)
								throw new Error("Metadata signing broker not ready");
							assertPending(pending, state, callback);
							bounded.throwIfAborted();
							const ticket = await state.authority.issueTicket(state.actor, request, bounded);
							if ((await fresh(state, callback, bounded)) !== revision)
								throw new Error("Metadata original authority changed while signing");
							stateOf(pending.windowsMetadataAdmission);
							assertPending(pending, state, callback);
							bounded.throwIfAborted();
							await state.onTicketIssued?.(ticket, callback, bounded);
							if (state.onTicketIssued && (await fresh(state, callback, bounded)) !== revision)
								throw new Error("Metadata authority changed during issued-ticket observation");
							stateOf(pending.windowsMetadataAdmission);
							assertPending(pending, state, callback);
							bounded.throwIfAborted();
							const result = windowsMetadataCallbackResultSchema.parse({
								type: "windows_metadata_callback_result",
								version: 1,
								outerRpcId: callback.outerRpcId,
								stepId: callback.stepId,
								nonce: callback.nonce,
								ticket,
							});
							if (
								Buffer.byteLength(canonicalWindowsIoJson(result)) >
								WINDOWS_METADATA_CALLBACK_LIMITS.responseBytes
							)
								throw new Error("Metadata callback response exceeds byte budget");
							return Object.freeze(result);
						});
					},
				};
				bounded.addEventListener("abort", job.abort, { once: true });
				queue.push(job);
				if (bounded.aborted) job.abort();
				pump();
			});
		},
	};
}
