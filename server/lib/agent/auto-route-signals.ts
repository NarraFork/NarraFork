/**
 * Live facts the `auto:` router orders sources by (settings/provider.ts → AutoSourceProbe).
 *
 * - Codex: a subscription; available while some enabled account is not resting on a used-up
 *   window.
 * - Custom API providers with keys (Kimi Code, OpenCode Go and other relays): available while
 *   some enabled key is neither out of allowance nor resting after a 403; a short 429 rest does
 *   not count. A subscription when it is a Kimi Code or OpenCode Go plan.
 * - NUG: unavailable while the gateway model is recorded as down (nug-model-availability).
 * - Everything else: available, pay-per-use. Their own errors still surface on the request.
 *
 * All reads are in memory; nothing here touches the network or the database.
 */
import { getCodexManager } from "../codex-manager";
import { isKimiCustomApiProvider } from "../kimi-usage-cache";
import { resolveKnownUnavailableNugModel } from "../nug-model-availability";
import { isOpencodeCustomApiProvider } from "../opencode-usage-cache";
import { getProviderKeyStore } from "../provider-keys";
import { registerAutoSourceProbe, settings } from "../settings";
import { keyCooldown, usableProviderKeys } from "./pooled-provider";

/** A short rate-limit rest still counts as able to serve; quota and 403 rests do not. */
function keyCanServe(keyId: string, now: number): boolean {
	const reason = keyCooldown(keyId, now)?.reason;
	return reason === undefined || reason === "rate_limited";
}

/**
 * @param value The full `<prefix>:<model>` value, when known. NUG availability is per gateway
 *   model (one channel can be down while another serves), so without it NUG counts as able.
 */
export function autoSourceFacts(
	provider: string,
	now = Date.now(),
	value?: string,
): { available: boolean; subscription: boolean } {
	if (value && resolveKnownUnavailableNugModel(value, provider)) {
		return { available: false, subscription: false };
	}
	if (provider === "codex") {
		// `availableCount` is a pure in-memory read; `hasAvailableCredentials` may revive
		// accounts and rewrite the credentials file, which must not happen while routing.
		return { available: getCodexManager().availableCount > 0, subscription: true };
	}
	const config = settings.customApiProviders?.find((p) => p.prefix === provider);
	if (!config) return { available: true, subscription: false };
	const subscription = isKimiCustomApiProvider(config) || isOpencodeCustomApiProvider(config);
	const stored = getProviderKeyStore().list(config.id);
	const keys = usableProviderKeys(config.id);
	// No stored keys at all (unreadable key file): the provider's own key is all we know about.
	// Stored keys that are all disabled mean it cannot serve, even though settings still shows
	// the first (rejected) one.
	// A short rate-limit rest is not "cannot serve": moving a session to another service for a
	// one-minute 429 would cost its cache and then keep it there. Only a used-up allowance, a
	// 403 rest, or a key the upstream rejected (disabled, so not in `keys`) count.
	const available =
		stored.length === 0 ? !!config.apiKey : keys.some((key) => keyCanServe(key.id, now));
	return { available, subscription };
}

let installed = false;
/** Called once at startup; tests may install it themselves. */
export function installAutoRouteSignals(): void {
	if (installed) return;
	installed = true;
	registerAutoSourceProbe((provider, value) => autoSourceFacts(provider, Date.now(), value));
}
