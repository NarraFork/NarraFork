import {
	WINDOWS_IO_AUTHORITY_LIMITS,
	type WindowsIoTicketPayload,
	windowsIoTicketSignedBytes,
} from "@shared/windows-io-authority";
import { runWindowsIoBounded } from "./windows-io-authority-budget";
import { decodeWindowsIoBase64url, type WindowsIoPublicPin } from "./windows-io-authority-crypto";

export type WindowsIoKeyCustodyModel = "hardware_nonexportable" | "os_isolated_software";
export interface WindowsIoAuthorityReadiness {
	ready: boolean;
	reason: string;
}
export interface WindowsIoAuthoritySigner {
	readonly kind: "external_os_custody" | "unit_test_only_not_native";
	readonly pin: WindowsIoPublicPin;
	readiness(signal: AbortSignal): Promise<WindowsIoAuthorityReadiness>;
	signAuthorizedPayload(payload: WindowsIoTicketPayload, signal: AbortSignal): Promise<Uint8Array>;
}
/**
 * Native deployment adapter: inspect actual peer/token/ACL/key custody. NEVER construct this
 * evidence from HTTP/helper claims, workspace JSON, argv, environment, or PID/image alone.
 * Hardware keys remain nonexportable. Software keys remain within the isolated broker
 * account and are NEVER described as nonexportable; no controller JS key path is accepted.
 */
export interface WindowsIoKeyCustodyAdapter {
	inspectSecurityContext(signal: AbortSignal): Promise<{
		brokerServiceId: string;
		brokerPrincipal: string;
		authServicePrincipal: string;
		toolWorkerPrincipals: readonly string[];
		custodyModel: WindowsIoKeyCustodyModel;
		/** Live administrator-protected broker policy, covered by native probe evidence. */
		allowedCustodyModels: readonly WindowsIoKeyCustodyModel[];
		/** Actual hardware/nonexportability fact; MUST be false for software custody. */
		keyNonExportable: boolean;
		/** Actual PID/start-time/registered executable AND administrator-protected code. */
		brokerProcessBound: boolean;
		authServiceProcessBound: boolean;
		signingContractValidated: boolean;
		signerRestrictsRootAndAction: boolean;
		singleActionGrantRequired: boolean;
		durableReplayProtection: boolean;
		keyAclAdminAndBrokerOnly: boolean;
		configAclAdminOnly: boolean;
		callerAclAuthServiceOnly: boolean;
		workerCannotImpersonateAuthService: boolean;
		peerAuthenticatedByOs: boolean;
		brokerRestrictsWindowsIoContract: boolean;
	}>;
	/** Bounded authenticated IPC, using an OS-owned credential handle, not env/argv secrets. */
	exchange(
		request: Uint8Array,
		signal: AbortSignal,
		responseByteLimit: number,
	): Promise<Uint8Array>;
}
export interface WindowsIoExternalBrokerConfig {
	pin: WindowsIoPublicPin;
	brokerServiceId: string;
	authServicePrincipal: string;
	brokerPrincipal: string;
	/** Administrator policy only, never a request flag. Omitted means hardware-only. */
	allowedCustodyModels?: readonly WindowsIoKeyCustodyModel[];
}
function inspect(
	config: WindowsIoExternalBrokerConfig,
	state: Awaited<ReturnType<WindowsIoKeyCustodyAdapter["inspectSecurityContext"]>>,
): WindowsIoAuthorityReadiness {
	if (
		!config.authServicePrincipal ||
		!config.brokerPrincipal ||
		!config.brokerServiceId ||
		state.brokerServiceId !== config.brokerServiceId ||
		state.brokerPrincipal !== config.brokerPrincipal ||
		state.authServicePrincipal !== config.authServicePrincipal ||
		state.brokerPrincipal === state.authServicePrincipal ||
		state.toolWorkerPrincipals.length === 0 ||
		state.toolWorkerPrincipals.includes(state.authServicePrincipal) ||
		state.toolWorkerPrincipals.includes(state.brokerPrincipal) ||
		state.toolWorkerPrincipals.length > 64 ||
		state.toolWorkerPrincipals.some((principal) => typeof principal !== "string" || !principal) ||
		state.brokerProcessBound !== true ||
		state.authServiceProcessBound !== true ||
		state.signingContractValidated !== true ||
		state.signerRestrictsRootAndAction !== true ||
		state.singleActionGrantRequired !== true ||
		state.durableReplayProtection !== true ||
		state.keyAclAdminAndBrokerOnly !== true ||
		state.configAclAdminOnly !== true ||
		state.callerAclAuthServiceOnly !== true ||
		state.workerCannotImpersonateAuthService !== true ||
		state.peerAuthenticatedByOs !== true ||
		state.brokerRestrictsWindowsIoContract !== true
	)
		return { ready: false, reason: "WINDOWS_IO_KEY_CUSTODY_OS_ISOLATION_UNPROVEN" };
	const allowed = config.allowedCustodyModels ?? ["hardware_nonexportable"];
	if (
		!allowed.includes(state.custodyModel) ||
		!state.allowedCustodyModels.includes(state.custodyModel)
	)
		return { ready: false, reason: "WINDOWS_IO_CUSTODY_MODEL_NOT_ADMIN_ALLOWED" };
	if (state.custodyModel === "hardware_nonexportable" && state.keyNonExportable === true)
		return { ready: true, reason: "hardware_nonexportable_custody_verified" };
	if (state.custodyModel === "os_isolated_software" && state.keyNonExportable === false)
		return { ready: true, reason: "admin_allowed_os_isolated_software_custody_verified" };
	return { ready: false, reason: "WINDOWS_IO_CUSTODY_MODEL_FACT_MISMATCH" };
}
/** No bundled signing daemon, private key generation, fallback in-memory key or TOFU. */
export function createWindowsIoExternalBrokerSigner(
	config: WindowsIoExternalBrokerConfig,
	adapter: WindowsIoKeyCustodyAdapter,
): WindowsIoAuthoritySigner {
	// Validate a public administrator pin; no secret is loaded into the controller process.
	if (decodeWindowsIoBase64url(config.pin.publicKey, 32).byteLength !== 32)
		throw new Error("Invalid administrator signer pin");
	const frozen = structuredClone(config);
	let inFlight = 0;
	return {
		kind: "external_os_custody",
		pin: Object.freeze({ ...frozen.pin }),
		async readiness(signal) {
			signal.throwIfAborted();
			if (inFlight >= WINDOWS_IO_AUTHORITY_LIMITS.queue)
				return { ready: false, reason: "WINDOWS_IO_SIGNING_QUEUE_FULL" };
			inFlight++;
			const bounded = AbortSignal.any([
				signal,
				AbortSignal.timeout(WINDOWS_IO_AUTHORITY_LIMITS.signingTimeoutMs),
			]);
			try {
				return await runWindowsIoBounded(bounded, async () => {
					try {
						return inspect(frozen, await adapter.inspectSecurityContext(bounded));
					} finally {
						inFlight--;
					}
				});
			} catch {
				return { ready: false, reason: "WINDOWS_IO_SIGNING_BROKER_UNAVAILABLE" };
			}
		},
		async signAuthorizedPayload(payload, signal) {
			signal.throwIfAborted();
			if (inFlight >= WINDOWS_IO_AUTHORITY_LIMITS.queue)
				throw new Error("Windows IO signer queue full");
			inFlight++;
			const boundedSignal = AbortSignal.any([
				signal,
				AbortSignal.timeout(WINDOWS_IO_AUTHORITY_LIMITS.signingTimeoutMs),
			]);
			return runWindowsIoBounded(boundedSignal, async () => {
				try {
					boundedSignal.throwIfAborted();
					if (!inspect(frozen, await adapter.inspectSecurityContext(boundedSignal)).ready)
						throw new Error("Windows IO custody not ready");
					if (
						payload.issuer !== frozen.pin.issuer ||
						payload.serviceId !== frozen.pin.serviceId ||
						payload.keyEpoch !== frozen.pin.keyEpoch
					)
						throw new Error("Signing broker issuer mismatch");
					// Broker independently validates this exact contract and OS caller security context;
					// it MUST NOT expose a generic sign(arbitrary bytes) command to ordinary Shells.
					const bytes = windowsIoTicketSignedBytes(payload);
					const request = new TextEncoder().encode(
						JSON.stringify({
							version: 1,
							method: "sign_windows_io_authorization",
							payload: Buffer.from(bytes).toString("base64url"),
						}),
					);
					const response = await adapter.exchange(request, boundedSignal, 1024);
					boundedSignal.throwIfAborted();
					if (response.byteLength > 1024) throw new Error("Signing broker response too large");
					const raw = new TextDecoder("utf-8", { fatal: true }).decode(response);
					const parsed = JSON.parse(raw) as Record<string, unknown>;
					if (
						Object.keys(parsed).sort().join(",") !== "signature,version" ||
						parsed.version !== 1 ||
						typeof parsed.signature !== "string" ||
						JSON.stringify(parsed) !== raw
					)
						throw new Error("Invalid signing broker response");
					const signature = decodeWindowsIoBase64url(parsed.signature, 64);
					if (signature.byteLength !== 64) throw new Error("Invalid broker signature size");
					if (!inspect(frozen, await adapter.inspectSecurityContext(boundedSignal)).ready)
						throw new Error("Signing custody changed while queued");
					return signature;
				} finally {
					inFlight--;
				}
			});
		},
	};
}
/** Default deliberately cannot sign until an operator supplies a proven OS-native broker adapter. */
export function productionDefaultWindowsIoSigner(): null {
	return null;
}
export function windowsIoProductionSignerReadiness(
	signer: WindowsIoAuthoritySigner | null,
): WindowsIoAuthorityReadiness {
	return signer?.kind === "external_os_custody"
		? { ready: false, reason: "WINDOWS_IO_SIGNER_REQUIRES_LIVE_OS_CHECK" }
		: { ready: false, reason: "WINDOWS_IO_EXTERNAL_KEY_CUSTODY_NOT_CONFIGURED" };
}
