/**
 * The network identity a Codex request goes out with: the credential's own settings
 * where it has them, the Codex provider settings otherwise. Token refresh, usage reads
 * and model requests for one account all resolve through here, so an account keeps one
 * egress IP and one device id across everything it does.
 */
import type { CredentialNetwork } from "@shared/credential-network";
import { getInstallationId } from "./installation-id";
import { resolveOverride } from "./net/proxy";
import { settings } from "./settings";
import type { ProxyOverride } from "./settings/types";
import type { UserAgentMode } from "./user-agent";

type WithNetwork = { network?: CredentialNetwork } | undefined;

/**
 * 实例自己的网络配置。平台实例化之后，同一个平台上可以有多个实例，各自有代理与指纹；
 * 它取代原先唯一的 `settings.codex`，作为凭据未指定时的回退源。
 */
export interface CodexNetworkFallback {
	proxy?: ProxyOverride;
	userAgentMode?: UserAgentMode;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
}

/** Resolved proxy URL; undefined means direct. */
export function codexProxy(
	credential?: WithNetwork,
	fallback?: CodexNetworkFallback,
): string | undefined {
	const own = credential?.network?.proxy;
	const base = fallback ?? settings.codex;
	return resolveOverride(own && own.mode !== "default" ? own : base?.proxy);
}

/** Client fingerprint settings; the Codex client is presented unless configured otherwise. */
export function codexFingerprintConfig(
	credential?: WithNetwork,
	fallback?: CodexNetworkFallback,
): {
	userAgentMode: UserAgentMode;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
} {
	const own = credential?.network;
	const base = fallback ?? settings.codex;
	const extraHeaders = { ...base?.extraHeaders, ...own?.extraHeaders };
	return {
		userAgentMode: own?.userAgentMode ?? base?.userAgentMode ?? "codex",
		customUserAgent: own?.userAgentMode ? own.customUserAgent : base?.customUserAgent,
		...(Object.keys(extraHeaders).length ? { extraHeaders } : {}),
	};
}

/** The installation id sent in `client_metadata`: the credential's own, or the instance's. */
export function codexInstallationId(credential?: WithNetwork): string {
	return credential?.network?.deviceId ?? getInstallationId();
}
