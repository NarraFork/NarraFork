import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import {
	canonicalWindowsFirstCaptureBytes,
	WINDOWS_FIRST_CAPTURE_FEATURE,
	WINDOWS_FIRST_CAPTURE_LIMITS,
	type WindowsMetadataCaptureResultPayload,
	windowsFirstCaptureHttpSchema,
} from "@shared/windows-first-capture";
import { canonicalWindowsIoJson } from "@shared/windows-io-authority";
import { eq } from "drizzle-orm";
import { workspaceWriteLeases } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { loadWindowsFirstCaptureDeployment } from "../lib/windows-io-authority-first-capture-config";
import {
	type FirstCaptureIssuedTicket,
	firstCaptureIssuedTicket,
	type VerifiedFirstCapturePreauthorization,
	verifyFirstCaptureCompletion,
	verifyFirstCapturePreauthorization,
} from "../lib/windows-io-authority-first-capture-proof";
import {
	getDeviceMetadataSession,
	hasDeviceProtocolFeature,
	type SendRpcOptions,
	type WindowsFirstCapturePendingContext,
} from "./device-connection-service";
import { loadNarratorForAccess } from "./narrator-acl";
import {
	assertRemoteEditorSessionOrigin,
	currentRemoteRecoveryAuthProvenance,
	requireRemoteEditorSessionOrigin,
} from "./remote-history-recovery-auth";
import {
	authorizeRemoteHistoryTarget,
	getRemoteWorkspaceHistoryRuntime,
	type RemoteHistoryActor,
	type RemoteHistoryTarget,
} from "./remote-workspace-history-runtime";
import { bindWindowsFirstCaptureReadAuthority } from "./windows-first-capture-read-authority";
import { WindowsFirstCaptureReadIntents } from "./windows-first-capture-read-intents";
import { createWindowsIoAuthority } from "./windows-io-authority";
import { registerAdmission } from "./windows-metadata-admission";
import { workspaceContextService } from "./workspace-context-service";

type CaptureBackend = ExecutionBackend & {
	supportsWindowsFirstCapture: boolean;
	windowsFirstCapture(
		method: "history.metadataPreauthorize" | "history.metadataCapture",
		params:
			| import("@shared/windows-first-capture").WindowsMetadataPreauthorizeParams
			| import("@shared/windows-first-capture").WindowsMetadataCaptureParams,
		options: NonNullable<SendRpcOptions["windowsFirstCapture"]>,
		control?: Pick<SendRpcOptions, "signal" | "windowsMetadataAdmission">,
	): Promise<unknown>;
};
const intents = new WindowsFirstCaptureReadIntents();
const queued: Array<{ run(): void; signal: AbortSignal; cancel(): void }> = [];
let active = 0;
function pump() {
	while (active < WINDOWS_FIRST_CAPTURE_LIMITS.workers && queued.length) {
		const next = queued.shift();
		next?.run();
	}
}
function enqueue<T>(signal: AbortSignal, body: () => Promise<T>): Promise<T> {
	if (queued.length + active >= WINDOWS_FIRST_CAPTURE_LIMITS.queue)
		return Promise.reject(new Error("WINDOWS_FIRST_CAPTURE_READ_QUEUE_FULL"));
	const snapshot = AsyncLocalStorage.snapshot();
	return new Promise<T>((resolve, reject) => {
		const entry = {
			signal,
			cancel() {
				const index = queued.indexOf(entry);
				if (index >= 0) {
					queued.splice(index, 1);
					signal.removeEventListener("abort", entry.cancel);
					reject(signal.reason);
				}
			},
			run() {
				signal.removeEventListener("abort", entry.cancel);
				active++;
				void snapshot(async () => {
					try {
						signal.throwIfAborted();
						resolve(await body());
					} catch (error) {
						reject(error);
					} finally {
						active--;
						pump();
					}
				});
			},
		};
		signal.addEventListener("abort", entry.cancel, { once: true });
		queued.push(entry);
		if (signal.aborted) entry.cancel();
		pump();
	});
}
/** Genuine proof-only production composition. No positive test/config resolver or
 * fallback signer exists; an ordinary mutable worktree remains unavailable. */
export async function captureWindowsMetadataForHttpSession(input: {
	userId: string;
	narratorId: string;
	request: unknown;
	signal: AbortSignal;
}): Promise<WindowsMetadataCaptureResultPayload> {
	const request = windowsFirstCaptureHttpSchema.parse(input.request);
	const originRef = requireRemoteEditorSessionOrigin(input.userId);
	const originalRequest = AsyncLocalStorage.snapshot();
	const deadline = AbortSignal.any([
		input.signal,
		AbortSignal.timeout(WINDOWS_FIRST_CAPTURE_LIMITS.rpcTimeoutMs),
	]);
	const started = performance.now();
	let phase = "queue";
	return enqueue(deadline, async () => {
		phase = "configuration";
		const registry = await getRemoteWorkspaceHistoryRuntime();
		const principal = assertRemoteEditorSessionOrigin(registry, originRef, input.userId, deadline);
		await loadNarratorForAccess(input.narratorId, principal, "read");
		const provenance = currentRemoteRecoveryAuthProvenance(input.userId);
		if (!provenance || provenance.authentication !== "session")
			throw new Error("WINDOWS_FIRST_CAPTURE_SESSION_ORIGIN_MISSING");
		const deployment = await loadWindowsFirstCaptureDeployment(deadline);
		const enrolled = deployment.enrollment;
		const workspace = await workspaceContextService.get(input.narratorId, { userId: input.userId });
		const deviceId = request.deviceId ?? workspace.deviceId;
		if (
			deviceId !== workspace.deviceId ||
			deviceId !== enrolled.deviceId ||
			workspace.pathFlavor !== "windows"
		)
			throw new Error("WINDOWS_FIRST_CAPTURE_ORIGINAL_WORKSPACE_NOT_ENROLLED");
		const backend = registry.options.backend(deviceId) as CaptureBackend;
		if (
			backend.kind !== "remote" ||
			!backend.supportsWindowsFirstCapture ||
			typeof backend.windowsFirstCapture !== "function" ||
			!hasDeviceProtocolFeature(deviceId, WINDOWS_FIRST_CAPTURE_FEATURE)
		)
			throw new Error("WINDOWS_FIRST_CAPTURE_EXECUTOR_UPGRADE_REQUIRED");
		const session = getDeviceMetadataSession(deviceId);
		if (
			!session ||
			canonicalWindowsIoJson(session) !== canonicalWindowsIoJson(enrolled.session) ||
			backend.runtimeGeneration !== session.runtimeGeneration
		)
			throw new Error("WINDOWS_FIRST_CAPTURE_SESSION_NOT_ADMIN_ENROLLED");
		const path = backend.paths.resolve(workspace.cwd, request.path);
		const actor: RemoteHistoryActor = Object.freeze({
			userId: input.userId,
			narratorId: input.narratorId,
			projectId: workspace.contextProjectId ?? null,
			kind: "human",
		});
		const target: RemoteHistoryTarget = Object.freeze({
			deviceId,
			cwd: workspace.cwd,
			lexicalPath: path,
			canonicalPath: path,
			runtimeGeneration: session.runtimeGeneration,
		});
		let approvedTarget: Readonly<RemoteHistoryTarget> = target;
		await authorizeRemoteHistoryTarget(actor, target, "read", deadline);
		// Scope/open establishes source-qualified history identity, NOT v2 enrollment or SD evidence.
		const endpoint = await registry.resolve(actor, target, "read", deadline);
		if (
			endpoint.scope.sourceInstanceId !== enrolled.executorSourceId ||
			!backend.paths.equals(endpoint.scope.canonicalRoot, enrolled.root.pathKey)
		)
			throw new Error("WINDOWS_FIRST_CAPTURE_SCOPE_OUTSIDE_ENROLLED_SOURCE_ROOT");
		const requestDigest = createHash("sha256")
			.update(
				canonicalWindowsFirstCaptureBytes({
					version: 1,
					requestId: request.requestId,
					userId: input.userId,
					narratorId: input.narratorId,
					deviceId,
					source: enrolled.executorSourceId,
					scopeId: endpoint.scope.id,
					path,
				}),
			)
			.digest("hex");
		const operationId = `first-capture:${input.narratorId}:${input.userId}:${request.requestId}`;
		const intentKey = canonicalWindowsIoJson([
			deviceId,
			enrolled.executorSourceId,
			endpoint.scope.id,
			operationId,
		]);
		const intent = intents.reserve(intentKey, session.connectionId, Date.now());
		let sent = false;
		try {
			const runtime = registry.runtimeBinding(deviceId);
			if (!runtime) throw new Error("WINDOWS_FIRST_CAPTURE_RUNTIME_MISSING");
			return await registry.coordinator.withWrite(
				{
					scope: endpoint.scope,
					runtime,
					signal: deadline,
					executionClass: "unknown",
					ranges: [{ canonicalPath: endpoint.scope.canonicalRoot, kind: "subtree" }],
				},
				async (lease) => {
					lease.assertCurrent();
					const held = registry.options.db
						.select({
							leaseId: workspaceWriteLeases.leaseId,
							scopeId: workspaceWriteLeases.scopeId,
							deviceId: workspaceWriteLeases.deviceId,
							pathFlavor: workspaceWriteLeases.pathFlavor,
							ownerEpoch: workspaceWriteLeases.ownerEpoch,
							runtimeEpoch: workspaceWriteLeases.runtimeEpoch,
							runtimeGeneration: workspaceWriteLeases.runtimeGeneration,
							fence: workspaceWriteLeases.fencingToken,
							revision: workspaceWriteLeases.scopeRevision,
							status: workspaceWriteLeases.status,
						})
						.from(workspaceWriteLeases)
						.where(eq(workspaceWriteLeases.leaseId, lease.leaseId))
						.get();
					if (
						!held ||
						held.status !== "executing" ||
						held.scopeId !== endpoint.scope.id ||
						held.deviceId !== deviceId ||
						held.pathFlavor !== "windows" ||
						held.fence !== lease.executionBinding.fencingToken ||
						held.runtimeEpoch !== lease.executionBinding.runtimeEpoch ||
						held.runtimeGeneration !== session.runtimeGeneration ||
						held.revision !== lease.scopeRevision
					)
						throw new Error("WINDOWS_FIRST_CAPTURE_DURABLE_RESERVATION_MISSING");
					Object.freeze(held);
					const readAuthority = bindWindowsFirstCaptureReadAuthority({
						registry,
						origin: originRef,
						userId: input.userId,
						actor,
						target: () => approvedTarget,
					});
					const assertCurrent = (signal: AbortSignal) =>
						originalRequest(async () => {
							await readAuthority(signal);
							await deployment.assertCurrent(signal);
							// Probe may have awaited OS/file/process work: never reuse its earlier auth result.
							const readStamp = await readAuthority(signal);
							const live = getDeviceMetadataSession(deviceId);
							if (
								!live ||
								canonicalWindowsIoJson(live) !== canonicalWindowsIoJson(session) ||
								registry.options.backend(deviceId).runtimeGeneration !== session.runtimeGeneration
							)
								throw new Error("WINDOWS_FIRST_CAPTURE_ORIGINAL_CONNECTION_CHANGED");
							lease.assertCurrent();
							const currentLease = registry.options.db
								.select({
									leaseId: workspaceWriteLeases.leaseId,
									scopeId: workspaceWriteLeases.scopeId,
									deviceId: workspaceWriteLeases.deviceId,
									pathFlavor: workspaceWriteLeases.pathFlavor,
									ownerEpoch: workspaceWriteLeases.ownerEpoch,
									runtimeEpoch: workspaceWriteLeases.runtimeEpoch,
									runtimeGeneration: workspaceWriteLeases.runtimeGeneration,
									fence: workspaceWriteLeases.fencingToken,
									revision: workspaceWriteLeases.scopeRevision,
									status: workspaceWriteLeases.status,
								})
								.from(workspaceWriteLeases)
								.where(eq(workspaceWriteLeases.leaseId, held.leaseId))
								.get();
							const scope = registry.evidence.getScope(held.scopeId);
							if (
								canonicalWindowsIoJson(currentLease ?? null) !== canonicalWindowsIoJson(held) ||
								!scope ||
								scope.activeLeaseId !== held.leaseId ||
								scope.status !== "active" ||
								scope.sourceInstanceId !== enrolled.executorSourceId ||
								scope.workspaceInstanceId !== endpoint.scope.workspaceInstanceId ||
								scope.canonicalRoot !== endpoint.scope.canonicalRoot ||
								scope.rootIdentityJson?.object !== endpoint.scope.rootIdentityJson?.object ||
								scope.activeMutationCount !== 0 ||
								scope.fencingToken !== held.fence ||
								scope.revision !== held.revision
							)
								throw new Error("WINDOWS_FIRST_CAPTURE_ORIGINAL_PK_SCOPE_LEASE_CHANGED");
							if (preauthorization && preauthorization.payload.expiresAt <= Date.now())
								throw new Error("WINDOWS_FIRST_CAPTURE_PREAUTH_EXPIRED");
							assertRemoteEditorSessionOrigin(registry, originRef, input.userId, signal);
							if (readStamp.expiresAt <= Date.now())
								throw new Error("WINDOWS_FIRST_CAPTURE_READ_STAMP_EXPIRED");
							signal.throwIfAborted();
							return readStamp;
						});
					const seed = {
						version: 1 as const,
						deviceId,
						executorSourceId: enrolled.executorSourceId,
						scopeId: endpoint.scope.id,
						root: enrolled.root,
						helperInstanceId: enrolled.helperInstanceId,
						helperKeyEpoch: enrolled.helperKeyEpoch,
						operationId,
						requestDigest,
						leaseId: held.leaseId,
						fence: held.fence,
						connectionId: session.connectionId,
						sessionId: session.sessionId,
						runtimeGeneration: session.runtimeGeneration,
						action: "capture_exact" as const,
					};
					let preauthorization: VerifiedFirstCapturePreauthorization | undefined;
					let capturePending: WindowsFirstCapturePendingContext | undefined;
					let issued: FirstCaptureIssuedTicket | undefined;
					let authorizedChallenge: string | undefined;
					const preauthNonce = randomBytes(24).toString("base64url");
					try {
						await assertCurrent(deadline);
						phase = "preauthorize";
						await backend.windowsFirstCapture(
							"history.metadataPreauthorize",
							{ version: 1, path, nonce: preauthNonce },
							{
								origin: { ...seed, phase: "preauthorize" },
								onDispatch: () => {
									sent = true;
								},
								async verifyResult(value, pending) {
									await assertCurrent(pending.signal);
									preauthorization = verifyFirstCapturePreauthorization(value, {
										origin: pending.origin,
										nonce: preauthNonce,
										enrollment: enrolled,
										now: Date.now(),
									});
									approvedTarget = Object.freeze({
										...target,
										canonicalPath: preauthorization.payload.descriptors.target.pathKey,
									});
									if (
										!backend.paths.contains(
											endpoint.scope.canonicalRoot,
											approvedTarget.canonicalPath,
										)
									)
										throw new Error("WINDOWS_FIRST_CAPTURE_SIGNED_TARGET_ESCAPED_ENROLLED_ROOT");
									await assertCurrent(pending.signal);
									return preauthorization.payload;
								},
							},
							{ signal: deadline },
						);
						if (!preauthorization) throw new Error("WINDOWS_FIRST_CAPTURE_PREAUTH_PROOF_MISSING");
						const frozen = preauthorization;
						const original = {
							deviceId,
							executorSourceId: enrolled.executorSourceId,
							helperInstanceId: enrolled.helperInstanceId,
							connectionId: session.connectionId,
							sessionId: session.sessionId,
							runtimeGeneration: session.runtimeGeneration,
							budgetClass: "metadata" as const,
							scopeId: endpoint.scope.id,
							...frozen.payload.descriptors,
							operationId,
							requestDigest,
							leaseId: held.leaseId,
							fence: held.fence,
							expectedCurrentMetadataHash: null,
							expectedCurrentContentHash: null,
							captureProofId: null,
							preparedObjectId: null,
							recoveryOriginal: null,
						};
						const originRefHash = createHash("sha256")
							.update(canonicalWindowsFirstCaptureBytes(provenance))
							.digest("hex");
						const authority = createWindowsIoAuthority({
							signer: deployment.signer,
							async readCurrentActorOrigin(signal) {
								await assertCurrent(signal);
								return {
									source: "http",
									userId: input.userId,
									actorSubjectKey: `human:${input.userId}`,
									narratorId: input.narratorId,
									projectId: actor.projectId,
									originRefHash,
									credentialRef: originRef,
								};
							},
							async revalidateActor(saved, signal) {
								if (saved.credentialRef !== originRef || saved.userId !== input.userId)
									throw new Error("WINDOWS_FIRST_CAPTURE_BORROWED_ORIGIN");
								const stamp = await assertCurrent(signal);
								return canonicalWindowsIoJson([
									[stamp.policyRevision, stamp.aclDigest, stamp.targetDigest],
									deployment.enrollmentDigest,
									deployment.configurationDigest,
									held,
									provenance,
								]);
							},
							async authorizeOperation(saved, requested, signal) {
								await assertCurrent(signal);
								if (
									saved.credentialRef !== originRef ||
									!capturePending?.isPending() ||
									requested.action !== "capture_exact" ||
									issued
								)
									throw new Error("WINDOWS_FIRST_CAPTURE_OPERATION_UNAUTHORIZED");
								if (authorizedChallenge && authorizedChallenge !== requested.challengeNonce)
									throw new Error("WINDOWS_FIRST_CAPTURE_SECOND_TICKET_FORBIDDEN");
								authorizedChallenge = requested.challengeNonce;
								const { action: _action, challengeNonce: _nonce, ...tuple } = requested;
								if (canonicalWindowsIoJson(tuple) !== canonicalWindowsIoJson(original))
									throw new Error("WINDOWS_FIRST_CAPTURE_ORIGINAL_TUPLE_CHANGED");
								return requested;
							},
						});
						const actorProof = await authority.captureTrustedActor(deadline);
						const admission = await registerAdmission({
							authority,
							actor: actorProof,
							credentialRef: originRef,
							phase: "capture_readonly",
							original,
							signal: deadline,
							scopeProof: {
								version: 2,
								matrix: enrolled.matrix,
								deviceId,
								executorSourceId: enrolled.executorSourceId,
								scopeId: endpoint.scope.id,
								root: enrolled.root,
								helperInstanceId: enrolled.helperInstanceId,
								helperKeyEpoch: enrolled.helperKeyEpoch,
								helperPublicKey: enrolled.helperPublicKey,
							},
							async freshAuthorize(context, signal) {
								const stamp = await assertCurrent(signal);
								if (
									context.credentialRef !== originRef ||
									canonicalWindowsIoJson(context.original) !== canonicalWindowsIoJson(original)
								)
									throw new Error("WINDOWS_FIRST_CAPTURE_ORIGIN_MISMATCH");
								return canonicalWindowsIoJson([
									held,
									deployment.enrollmentDigest,
									provenance,
									[stamp.policyRevision, stamp.aclDigest, stamp.targetDigest],
								]);
							},
							async onTicketIssued(ticket, _callback, signal) {
								if (issued) throw new Error("WINDOWS_FIRST_CAPTURE_SECOND_TICKET_FORBIDDEN");
								await assertCurrent(signal);
								if (!capturePending?.isPending())
									throw new Error("WINDOWS_FIRST_CAPTURE_PENDING_GONE");
								issued = firstCaptureIssuedTicket(ticket);
							},
						});
						const captureNonce = randomBytes(24).toString("base64url");
						intent.state = "capturing";
						phase = "capture";
						const result = await backend.windowsFirstCapture(
							"history.metadataCapture",
							{
								version: 1,
								token: frozen.token,
								preauthRpcId: frozen.payload.origin.outerRpcId,
								preauthNonce,
								captureNonce,
							},
							{
								origin: { ...seed, phase: "capture" },
								onAllocated: (pending) => {
									capturePending = pending;
								},
								onDispatch: () => {
									sent = true;
								},
								async verifyResult(value, pending) {
									await assertCurrent(pending.signal);
									if (!issued) throw new Error("WINDOWS_FIRST_CAPTURE_ACTUAL_TICKET_MISSING");
									const completed = verifyFirstCaptureCompletion(value, {
										origin: pending.origin,
										preauthorization: frozen,
										captureNonce,
										ticket: issued,
										enrollment: enrolled,
										isPending: pending.isPending,
									});
									await assertCurrent(pending.signal);
									return completed;
								},
							},
							{ signal: deadline, windowsMetadataAdmission: admission },
						);
						await assertCurrent(deadline);
						intent.state = "captured";
						phase = "captured";
						return result as WindowsMetadataCaptureResultPayload;
					} catch (error) {
						if (sent) {
							intent.state = "unknown";
							phase = "unknown";
							lease.markUncertain();
						}
						throw error;
					}
				},
			);
		} catch (error) {
			if (!sent) intents.discardBeforeDispatch(intentKey, intent);
			throw error;
		}
	}).finally(() => {
		const durationMs = Math.round(performance.now() - started);
		if (durationMs >= 1000)
			logger.warn("Slow Windows proof-only capture", {
				phase,
				reason: deadline.aborted ? "original_deadline_or_cancel" : "settled",
				durationMs,
			});
	});
}
export function firstCaptureUnavailable(error: unknown): AppError {
	if (error instanceof AppError) return error;
	const message = error instanceof Error ? error.message : "";
	const reason = /^(WINDOWS_(?:FIRST_CAPTURE|IO)_[A-Z0-9_]+|EDITOR_SESSION_[A-Z0-9_]+)$/.test(
		message,
	)
		? message
		: "WINDOWS_FIRST_CAPTURE_UNPROVEN_OR_UNAVAILABLE";
	return new AppError(
		`Windows proof-only first capture is unavailable (${reason}); no original completion is accepted`,
		503,
		reason,
	);
}
