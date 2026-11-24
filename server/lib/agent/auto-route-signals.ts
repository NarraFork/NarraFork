/** Live auto-router facts and picker previews. Templates own policy; reads are memory-only. */
import { getCodexManager } from "../codex-manager";
import { getProviderKeyStore } from "../provider-keys";
import { registerAutoSourceProbe } from "../settings";
import { getSourceGroupByPrefix } from "../sourcing/source-groups";
import { getServiceTemplate } from "../sourcing/templates";

/** NUG's value can be a full prefix:model or an upstream channel:model. */
export function autoSourceFacts(
	provider: string,
	now = Date.now(),
	value?: string,
): { available: boolean; subscription: boolean } {
	const group = getSourceGroupByPrefix(provider);
	// Unknown prefixes still reach the lower-level resolver's configuration error.
	if (!group) return { available: true, subscription: false };
	const template = getServiceTemplate(group.templateId);
	return {
		available:
			!group.disabled &&
			template.isModelAvailable?.(group, value) !== false &&
			template.hasAvailableCredentials?.(group, now) !== false,
		subscription: template.subscription,
	};
}

/** Global preview, not a session-affinity pick. Never creates an adapter or restores quota. */
export function autoSourcePreview(
	provider: string,
	now = Date.now(),
): { label?: string; resetsAt?: number; rotating?: boolean } | null {
	const group = getSourceGroupByPrefix(provider);
	if (!group || group.disabled) return null;
	return getServiceTemplate(group.templateId).routingPreview?.(group, now) ?? null;
}

let installed = false;
/** Warm credential stores once at startup, outside the routing hot path. */
export function installAutoRouteSignals(): void {
	if (installed) return;
	getProviderKeyStore();
	getCodexManager();
	installed = true;
	registerAutoSourceProbe((provider, value) => autoSourceFacts(provider, Date.now(), value));
}
