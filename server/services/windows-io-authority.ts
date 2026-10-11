import { randomBytes } from "node:crypto";
import {
	canonicalWindowsIoJson,
	WINDOWS_IO_AUTHORITY_LIMITS,
	type WindowsIoAuthorizationRequest,
	type WindowsIoSignedTicket,
	type WindowsIoTicketPayload,
	windowsIoAuthorizationRequestSchema,
	windowsIoTicketSignedBytes,
} from "@shared/windows-io-authority";
import {
	productionDefaultWindowsIoSigner,
	type WindowsIoAuthorityReadiness,
	type WindowsIoAuthoritySigner,
} from "../lib/windows-io-authority-broker-client";
import { runWindowsIoBounded } from "../lib/windows-io-authority-budget";
import {
	encodeWindowsIoSignedTicket,
	verifyWindowsIoSignedTicket,
} from "../lib/windows-io-authority-crypto";

declare const trustedActorBrand: unique symbol;
/** Runtime WeakMap identity, not a client JSON claim, PID, bearer or TypeScript cast. */
export type WindowsIoTrustedActor = Readonly<{ [trustedActorBrand]: true }>;
export interface WindowsIoActorOrigin {
	source: "http" | "agent" | "recovery";
	userId: string;
	actorSubjectKey: string;
	narratorId: string | null;
	projectId: string | null;
	originRefHash: string;
	/** Server-owned original session/OAuth provenance, never supplied from request body. */
	credentialRef: object;
}
export type { WindowsIoAuthorizationRequest } from "@shared/windows-io-authority";
export interface WindowsIoAuthorityDependencies {
	/** Read authenticated HTTP context/agent launch metadata/original recovery provenance.
	 * NO actor fields are accepted by captureTrustedActor(). Missing context must throw. */
	readCurrentActorOrigin(signal: AbortSignal): Promise<WindowsIoActorOrigin>;
	/** Freshly resolve current user role, ORIGINAL credential/session/grant validity and
	 * narrator/project/device OAuth ACL. Return a live policy revision, not cached approval. */
	revalidateActor(origin: Readonly<WindowsIoActorOrigin>, signal: AbortSignal): Promise<string>;
	/** Resolve original operation/root/volume/lease/fence, helper challenge/instance,
	 * current connection/generation and native path deny-hole policy from SERVER stores.
	 * Validate captured/prepared proof ownership and allowed single action, not client SD.
	 * Return the exact authorized binding; a client's naked source/scope is not a grant. */
	authorizeOperation(
		origin: Readonly<WindowsIoActorOrigin>,
		requested: Readonly<WindowsIoAuthorizationRequest>,
		signal: AbortSignal,
	): Promise<WindowsIoAuthorizationRequest>;
	signer?: WindowsIoAuthoritySigner | null;
	now?: () => number;
}
export interface WindowsIoAuthority {
	readiness(signal: AbortSignal): Promise<WindowsIoAuthorityReadiness>;
	captureTrustedActor(signal: AbortSignal): Promise<WindowsIoTrustedActor>;
	issueTicket(
		actor: WindowsIoTrustedActor,
		request: WindowsIoAuthorizationRequest,
		signal: AbortSignal,
	): Promise<WindowsIoSignedTicket>;
}
function createAuthority(
	deps: WindowsIoAuthorityDependencies,
	unitTestOnly: boolean,
): WindowsIoAuthority {
	const signer = deps.signer ?? productionDefaultWindowsIoSigner();
	const now = deps.now ?? Date.now;
	const actors = new WeakMap<object, Readonly<WindowsIoActorOrigin>>();
	let queued = 0;
	function permittedSigner(): WindowsIoAuthoritySigner {
		if (!signer || (signer.kind !== "external_os_custody" && !unitTestOnly))
			throw new Error("WINDOWS_IO_EXTERNAL_KEY_CUSTODY_NOT_CONFIGURED");
		return signer;
	}
	return {
		async readiness(signal) {
			try {
				return await permittedSigner().readiness(signal);
			} catch {
				return { ready: false, reason: "WINDOWS_IO_EXTERNAL_KEY_CUSTODY_NOT_CONFIGURED" };
			}
		},
		async captureTrustedActor(signal) {
			signal.throwIfAborted();
			const origin = await deps.readCurrentActorOrigin(signal);
			if (
				!origin.userId ||
				!origin.credentialRef ||
				typeof origin.credentialRef !== "object" ||
				!["http", "agent", "recovery"].includes(origin.source) ||
				!origin.actorSubjectKey ||
				!/^[a-f0-9]{64}$/.test(origin.originRefHash)
			)
				throw new Error("Missing trusted server actor origin");
			// Keep exact credential reference, not a deserialized or borrowed owner.
			const saved = Object.freeze({ ...origin });
			const revision = await deps.revalidateActor(saved, signal);
			if (typeof revision !== "string" || revision.length === 0 || revision.length > 4096)
				throw new Error("Actor permission revision unavailable");
			signal.throwIfAborted();
			const actor = Object.freeze({}) as WindowsIoTrustedActor;
			actors.set(actor, saved);
			return actor;
		},
		async issueTicket(actor, request, signal) {
			const origin = actor && typeof actor === "object" ? actors.get(actor) : undefined;
			if (!origin)
				throw new Error("Windows IO requires authentic service actor proof, not claim body");
			signal.throwIfAborted();
			if (queued >= WINDOWS_IO_AUTHORITY_LIMITS.queue)
				throw new Error("Windows IO authorization queue full");
			queued++;
			const bounded = AbortSignal.any([
				signal,
				AbortSignal.timeout(WINDOWS_IO_AUTHORITY_LIMITS.signingTimeoutMs),
			]);
			return runWindowsIoBounded(bounded, async () => {
				try {
					bounded.throwIfAborted();
					const activeSigner = permittedSigner();
					if (!(await activeSigner.readiness(bounded)).ready)
						throw new Error("Windows IO signing custody not ready");
					const requested = windowsIoAuthorizationRequestSchema.parse(request);
					const before = await deps.revalidateActor(origin, bounded);
					if (typeof before !== "string" || before.length === 0 || before.length > 4096)
						throw new Error("Current actor authority unavailable");
					const grant = windowsIoAuthorizationRequestSchema.parse(
						await deps.authorizeOperation(origin, requested, bounded),
					);
					if (canonicalWindowsIoJson(grant) !== canonicalWindowsIoJson(requested))
						throw new Error("Server original-operation grant does not match requested binding");
					const issuedAt = now();
					const payload: WindowsIoTicketPayload = {
						...grant,
						version: 1,
						issuer: activeSigner.pin.issuer,
						serviceId: activeSigner.pin.serviceId,
						keyEpoch: activeSigner.pin.keyEpoch,
						actorSubjectKey: origin.actorSubjectKey,
						narratorId: origin.narratorId,
						projectId: origin.projectId,
						originRefHash: origin.originRefHash,
						issuedAt,
						expiresAt: issuedAt + WINDOWS_IO_AUTHORITY_LIMITS[`${grant.budgetClass}TtlMs`],
						nonce: randomBytes(24).toString("base64url"),
					};
					const wirePayload = payload;
					const bytes = windowsIoTicketSignedBytes(wirePayload);
					const signature = await activeSigner.signAuthorizedPayload(wirePayload, bounded);
					bounded.throwIfAborted();
					// No cached approval survives async broker/queue delay or revocation.
					if (
						(await deps.revalidateActor(origin, bounded)) !== before ||
						canonicalWindowsIoJson(await deps.authorizeOperation(origin, requested, bounded)) !==
							canonicalWindowsIoJson(grant)
					)
						throw new Error("Actor/operation authority changed while signing");
					if (!(await activeSigner.readiness(bounded)).ready)
						throw new Error("Signer custody changed");
					bounded.throwIfAborted();
					const ticket = encodeWindowsIoSignedTicket(bytes, signature);
					verifyWindowsIoSignedTicket(ticket, [activeSigner.pin], now(), wirePayload);
					return Object.freeze(ticket);
				} finally {
					queued--;
				}
			});
		},
	};
}
export function createWindowsIoAuthority(deps: WindowsIoAuthorityDependencies): WindowsIoAuthority {
	return createAuthority(deps, false);
}
/** Explicit test dependency; never native-ready or accepted by production factory. */
export function createWindowsIoAuthorityForUnitTests(
	deps: WindowsIoAuthorityDependencies,
): WindowsIoAuthority {
	if (deps.signer?.kind !== "unit_test_only_not_native")
		throw new Error("Unit tests require explicit non-native signer");
	return createAuthority(deps, true);
}
