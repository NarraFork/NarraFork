import type { CredentialNetwork } from "@shared/credential-network";

/**
 * The effective connection fields after withProviderKey has composed a credential's network.
 * Include them even when a dedicated billing endpoint uses fewer fields than inference:
 * routing must not reuse a previous connection's allowance after its network identity changes.
 * Only server-side identities consume this; it can contain secrets and must never be exposed.
 */
type QuotaNetwork = Omit<CredentialNetwork, "userAgentMode"> & {
	userAgentMode?: string;
	tlsRejectUnauthorized?: boolean;
};

export function quotaNetworkIdentity(config: object, globalProxy: unknown): string {
	const network = config as QuotaNetwork;
	return JSON.stringify([
		network.proxy,
		network.tlsRejectUnauthorized,
		network.userAgentMode,
		network.customUserAgent,
		Object.entries(network.extraHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b)),
		globalProxy,
	]);
}

/** A legacy fingerprint cannot establish fields its old serializer never recorded. */
export function legacyQuotaNetworkCompatible(
	config: object,
	options: {
		proxyAndTlsCovered?: boolean;
		globalProxy?: unknown;
		defaultUserAgentMode?: string;
	} = {},
): boolean {
	const network = config as QuotaNetwork;
	if (
		(network.userAgentMode !== undefined &&
			network.userAgentMode !== options.defaultUserAgentMode) ||
		network.customUserAgent !== undefined ||
		Object.keys(network.extraHeaders ?? {}).length > 0
	) {
		return false;
	}
	if (options.proxyAndTlsCovered !== false) return true;
	// TokenDance's legacy serializer had no transport fields at all. Only the original
	// direct/default-TLS connection is compatible; an unrecorded custom egress is unknown.
	const proxyMode = network.proxy?.mode ?? "default";
	const globalMode = (options.globalProxy as { mode?: string } | undefined)?.mode ?? "direct";
	return (
		network.tlsRejectUnauthorized !== false &&
		(proxyMode === "direct" || (proxyMode === "default" && globalMode === "direct"))
	);
}
