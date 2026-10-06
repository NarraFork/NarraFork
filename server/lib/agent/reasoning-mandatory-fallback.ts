import { logger } from "../logger";
import { isReasoningMandatoryError } from "./error-handling";
import type { GenerateOptions } from "./provider";

/**
 * Endpoints that refuse `reasoningEffort: "none"`.
 *
 * Auxiliary calls (titles, compact summaries, reflections) deliberately disable
 * reasoning: they are short, frequent, and pay for thinking tokens nobody reads.
 * Some gateways only serve reasoning-enabled traffic and answer that with a hard
 * `400 ... Reasoning is mandatory for this endpoint and cannot be disabled`, so
 * the whole feature (e.g. a session title) fails while the model itself is fine.
 *
 * The fallback re-sends the request WITHOUT any reasoning preference, letting the
 * endpoint apply its own default. It deliberately does not substitute a tier:
 * this path is reached exactly when we know nothing about which tiers the
 * upstream accepts, and naming one could 400 for a second, unrelated reason.
 *
 * The learned set is per-process and in-memory on purpose. It only ever saves a
 * wasted first attempt, so losing it on restart costs one extra request, while
 * persisting it would keep suppressing the user's "none" long after the gateway
 * (or the model routing behind it) changed.
 */
const reasoningMandatoryModels = new Set<string>();

/**
 * Bound the learned set. It is keyed by the fully-prefixed model id, which is
 * caller-supplied, so an unbounded set is a slow leak in a long-lived process.
 */
const MAX_REMEMBERED_MODELS = 200;

/** Whether this model already rejected a reasoning-disabled request. */
export function modelRequiresReasoning(model: string): boolean {
	return reasoningMandatoryModels.has(model);
}

/** Test seam: forget everything learned so far. */
export function resetReasoningMandatoryModels(): void {
	reasoningMandatoryModels.clear();
}

function rememberReasoningMandatory(model: string): void {
	if (reasoningMandatoryModels.size >= MAX_REMEMBERED_MODELS) {
		// Drop the oldest insertion (Set preserves insertion order) rather than
		// clearing everything, so the busiest models keep their learned state.
		const oldest = reasoningMandatoryModels.values().next();
		if (!oldest.done) reasoningMandatoryModels.delete(oldest.value);
	}
	reasoningMandatoryModels.add(model);
}

/** Options with the reasoning preference removed (endpoint default applies). */
function withoutReasoningPreference(options: GenerateOptions | undefined): GenerateOptions {
	if (!options) return {};
	const { reasoningEffort: _dropped, ...rest } = options;
	return rest;
}

/**
 * Run a one-shot generate call, transparently recovering from an endpoint that
 * forbids disabling reasoning.
 *
 * Only requests that asked for `reasoningEffort: "none"` are affected: any other
 * value is the caller's explicit choice and is never rewritten. A model already
 * known to require reasoning skips the doomed first attempt entirely.
 */
export async function withReasoningMandatoryFallback<T>(
	model: string,
	options: GenerateOptions | undefined,
	run: (options: GenerateOptions | undefined) => Promise<T>,
): Promise<T> {
	if (options?.reasoningEffort !== "none") return run(options);

	if (modelRequiresReasoning(model)) {
		return run(withoutReasoningPreference(options));
	}

	try {
		return await run(options);
	} catch (err) {
		if (!isReasoningMandatoryError(err)) throw err;
		rememberReasoningMandatory(model);
		logger.warn("Endpoint requires reasoning; retrying without a reasoning preference", {
			model,
			error: err instanceof Error ? err.message : String(err),
		});
		return run(withoutReasoningPreference(options));
	}
}
