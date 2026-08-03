import { isNugCachedModelAvailable } from "./nug-model-cache";
import { getNugProviderConfig } from "./settings";

/**
 * Pre-flight check for a NUG model that the local catalog already knows is
 * unavailable.
 *
 * The recovery machinery (agent loop → `model_unavailable` → availability
 * poller) is driven by an actual failed request. That is the only way to learn
 * about an outage that starts mid-session, but it is wasteful when the outage is
 * already recorded: sending the whole conversation history just to be refused
 * costs a full upload, and it makes the wait depend on the gateway's error text
 * matching `MODEL_UNAVAILABLE_PATTERNS`. Callers use this to enter the same
 * suspend-and-wait path before issuing the first request instead.
 */

export interface KnownUnavailableNugModel {
	/** Configured NUG provider id, which the availability poller is keyed by. */
	providerId: string;
	/** Provider prefix as it appears in the model value. */
	providerPrefix: string;
	/** `channel:bareModel` id as it appears in `/v1/models`. */
	nugModelId: string;
	/** The full model value (`prefix:channel:bareModel`) that was checked. */
	model: string;
}

/**
 * Resolve a model to its recorded NUG unavailability, or null when it is usable
 * as far as the local catalog knows.
 *
 * Deliberately pessimistic in one direction only: a model is reported unavailable
 * ONLY when the cache explicitly says `available: false`. An unknown model
 * (`undefined` — never fetched, hand-typed id, or a gateway that does not send
 * the flag) counts as available, because suspending on "not in the catalog"
 * would strand models that actually work.
 *
 * @param model Fully resolved model value, i.e. `prefix:channel:bareModel`.
 * @param provider Resolved provider prefix for that model.
 */
export function resolveKnownUnavailableNugModel(
	model: string | null | undefined,
	provider: string | null | undefined,
): KnownUnavailableNugModel | null {
	const trimmedModel = model?.trim();
	const trimmedProvider = provider?.trim();
	if (!trimmedModel || !trimmedProvider) return null;

	// Only enabled NUG providers resolve; a disabled/removed one fails elsewhere
	// with a clear configuration error, which must not be masked as a wait.
	const config = getNugProviderConfig(trimmedProvider);
	if (!config) return null;

	// Mirror the agent loop: strip the provider prefix only when it is actually
	// present, so a value that already is a bare `channel:bareModel` id is not
	// mangled into `bareModel`.
	const prefixToken = `${config.prefix}:`;
	const nugModelId = trimmedModel.startsWith(prefixToken)
		? trimmedModel.slice(prefixToken.length)
		: trimmedModel;
	if (!nugModelId) return null;

	if (isNugCachedModelAvailable(config.id, nugModelId) !== false) return null;

	return {
		providerId: config.id,
		providerPrefix: config.prefix,
		nugModelId,
		model: trimmedModel,
	};
}
