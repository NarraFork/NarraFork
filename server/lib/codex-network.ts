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
import type { UserAgentMode } from "./user-agent";

type WithNetwork = { network?: CredentialNetwork } | undefined;

/** Resolved proxy URL; undefined means direct. */
export function codexProxy(credential?: WithNetwork): string | undefined {
	const own = credential?.network?.proxy;
	return resolveOverride(own && own.mode !== "default" ? own : settings.codex?.proxy);
}

/** Client fingerprint settings; the Codex client is presented unless configured otherwise. */
export function codexFingerprintConfig(credential?: WithNetwork): {
	userAgentMode: UserAgentMode;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
} {
	const own = credential?.network;
	const codex = settings.codex;
	const extraHeaders = { ...codex?.extraHeaders, ...own?.extraHeaders };
	return {
		userAgentMode: own?.userAgentMode ?? codex?.userAgentMode ?? "codex",
		customUserAgent: own?.userAgentMode ? own.customUserAgent : codex?.customUserAgent,
		...(Object.keys(extraHeaders).length ? { extraHeaders } : {}),
	};
}

/** The installation id sent in `client_metadata`: the credential's own, or the instance's. */
export function codexInstallationId(credential?: WithNetwork): string {
	return credential?.network?.deviceId ?? getInstallationId();
}
