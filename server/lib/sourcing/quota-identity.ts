import type { CredentialNetwork } from "@shared/credential-network";

/**
 * The effective connection fields after withProviderKey has composed a credential's network.
 * Include them even when a dedicated billing endpoint uses fewer fields than inference:
 * routing must not reuse a previous connection's allowance after its network identity changes.
 * Only server-side identities consume this; it can contain secrets and must never be exposed.
 */
export function quotaNetworkIdentity(config: object, globalProxy: unknown): string {
	const network = config as Omit<CredentialNetwork, "userAgentMode"> & {
		userAgentMode?: string;
		tlsRejectUnauthorized?: boolean;
	};
	return JSON.stringify([
		network.proxy,
		network.tlsRejectUnauthorized,
		network.userAgentMode,
		network.customUserAgent,
		Object.entries(network.extraHeaders ?? {}).sort(([a], [b]) => a.localeCompare(b)),
		globalProxy,
	]);
}
