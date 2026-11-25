/**
 * Live facts the `auto:` router orders sources by (settings/provider.ts → AutoSourceProbe).
 *
 * - Codex: a subscription; available while some enabled account is not resting on a used-up
 *   window.
 * - Managed API key pools (custom APIs, TokenDance, Command Code and NUG): available while
 *   some enabled key is neither out of allowance nor resting after a 403; a short 429 rest does
 *   not count. Custom APIs are subscriptions for Kimi Code or OpenCode Go plans.
 * - NUG: unavailable while the gateway model is recorded as down (nug-model-availability).
 * - Everything else: available, pay-per-use. Their own errors still surface on the request.
 *
 * All reads are in memory; nothing here touches the network or the database.
 */
import { getCodexManager } from "../codex-manager";
import { isKimiCustomApiProvider } from "../kimi-usage-cache";
import { resolveKnownUnavailableNugModel } from "../nug-model-availability";
import { isOpencodeCustomApiProvider } from "../opencode-usage-cache";
import {
	COMMAND_CODE_KEY_OWNER,
	getProviderKeyStore,
	nugKeyOwner,
	TOKENDANCE_KEY_OWNER,
} from "../provider-keys";
import { registerAutoSourceProbe, settings } from "../settings";
import { keyCooldown, selectProviderKey, usableProviderKeys } from "./pooled-provider";

/** A short rate-limit rest still counts as able to serve; quota and 403 rests do not. */
function keyCanServe(keyId: string, now: number): boolean {
	const reason = keyCooldown(keyId, now)?.reason;
	return reason === undefined || reason === "rate_limited";
}

/** A stored but disabled/exhausted pool must not fall back to a projected key or CLI auth. */
function poolCanServe(owner: string, fallback: boolean, now: number): boolean {
	return getProviderKeyStore().list(owner).length === 0
		? fallback
		: usableProviderKeys(owner).some((key) => keyCanServe(key.id, now));
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
	if (provider === "tokendance") {
		return {
			available: poolCanServe(TOKENDANCE_KEY_OWNER, !!settings.tokendance?.apiKey, now),
			subscription: false,
		};
	}
	if (provider === "CommandCode") {
		// Only a connection with no managed credentials may use its existing CLI-auth path.
		return { available: poolCanServe(COMMAND_CODE_KEY_OWNER, true, now), subscription: false };
	}
	const nug = settings.nugProviders?.find((p) => p.prefix === provider);
	if (nug) {
		return { available: poolCanServe(nugKeyOwner(nug.id), !!nug.apiKey, now), subscription: false };
	}
	const config = settings.customApiProviders?.find((p) => p.prefix === provider);
	if (!config) return { available: true, subscription: false };
	const subscription = isKimiCustomApiProvider(config) || isOpencodeCustomApiProvider(config);
	// No stored keys at all (unreadable key file): the provider's own key is all we know about.
	// Stored keys that are all disabled mean it cannot serve, even though settings still shows
	// the first (rejected) one.
	// A short rate-limit rest is not "cannot serve": moving a session to another service for a
	// one-minute 429 would cost its cache and then keep it there. Only a used-up allowance, a
	// 403 rest, or a key the upstream rejected (disabled, so not in `keys`) count.
	const available = poolCanServe(config.id, !!config.apiKey, now);
	return { available, subscription };
}

/**
 * What the picker's source rows show: the credential a new request would use, and when this
 * source comes back if it cannot serve now. Global, not per session: the source menu is not
 * tied to one conversation, so the pool's session-affinity choice is not represented here.
 * In-memory reads only.
 */
export function autoSourcePreview(
	provider: string,
): { label?: string; resetsAt?: number; rotating?: boolean } | null {
	if (provider === "codex") return getCodexManager().routingPreview;
	const config = settings.customApiProviders?.find((p) => p.prefix === provider);
	if (!config) return null;
	const chosen = selectProviderKey(config.id);
	const blocked = usableProviderKeys(config.id)
		.map((key) => keyCooldown(key.id)?.until)
		.filter((t): t is number => typeof t === "number" && t > Date.now())
		.sort((a, b) => a - b)[0];
	return {
		...(chosen?.label ? { label: chosen.label } : {}),
		...(!chosen && blocked ? { resetsAt: blocked } : {}),
	};
}

let installed = false;
/** Called once at startup; tests may install it themselves. */
export function installAutoRouteSignals(): void {
	if (installed) return;
	installed = true;
	registerAutoSourceProbe((provider, value) => autoSourceFacts(provider, Date.now(), value));
}
