/**
 * Live facts the `auto:` router orders sources by (settings/provider.ts → AutoSourceProbe).
 *
 * - Codex: a subscription; available while some enabled account is not resting on a used-up
 *   window.
 * - Custom API providers with keys (Kimi Code, OpenCode Go and other relays): available while
 *   some enabled key is not cooling down after a failure or a used-up window; a subscription
 *   when it is a Kimi Code or OpenCode Go plan.
 * - Everything else: available, pay-per-use. Their own errors still surface on the request.
 *
 * All reads are in memory; nothing here touches the network or the database.
 */
import { getCodexManager } from "../codex-manager";
import { isKimiCustomApiProvider } from "../kimi-usage-cache";
import { isOpencodeCustomApiProvider } from "../opencode-usage-cache";
import { registerAutoSourceProbe, settings } from "../settings";
import { keyCooldown, usableProviderKeys } from "./pooled-provider";

export function autoSourceFacts(
	provider: string,
	now = Date.now(),
): { available: boolean; subscription: boolean } {
	if (provider === "codex") {
		// `availableCount` is a pure in-memory read; `hasAvailableCredentials` may revive
		// accounts and rewrite the credentials file, which must not happen while routing.
		return { available: getCodexManager().availableCount > 0, subscription: true };
	}
	const config = settings.customApiProviders?.find((p) => p.prefix === provider);
	if (!config) return { available: true, subscription: false };
	const subscription = isKimiCustomApiProvider(config) || isOpencodeCustomApiProvider(config);
	const keys = usableProviderKeys(config.id);
	// No stored keys yet (pre-migration file): the provider's own key is all we know about.
	const available =
		keys.length === 0 ? !!config.apiKey : keys.some((key) => !keyCooldown(key.id, now));
	return { available, subscription };
}

let installed = false;
/** Called once at startup; tests may install it themselves. */
export function installAutoRouteSignals(): void {
	if (installed) return;
	installed = true;
	registerAutoSourceProbe((provider) => autoSourceFacts(provider));
}
