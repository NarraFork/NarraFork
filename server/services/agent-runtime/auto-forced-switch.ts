/**
 * Forced source switch for `auto:<model>` sessions (docs/PROVIDER-SOURCING-DESIGN.md §4.3).
 *
 * When the source a turn used is out of allowance or down, an `auto:` session moves to
 * another source that can serve the same model instead of parking on a long wait. A wait is
 * still preferred when it is short: within that window the upstream cache may still be warm,
 * and switching services discards it (and opens a new prefix epoch). Past it the cache is cold
 * anyway, so moving costs nothing extra.
 *
 * `<prefix>:<model>` values never switch here: naming a service means staying on it (§4.1).
 */
import { isAutoModelValue } from "@shared/auto-model";
import { parseModelId, resolveEffectiveModel } from "../../lib/settings";

/** Waits up to this long are taken instead of switching; about the reach of upstream caches. */
export const AUTO_SWITCH_WAIT_THRESHOLD_MS = 15 * 60_000;

/** Source switches per run; past it the turn waits or reports like a named service. */
export const MAX_AUTO_SWITCHES_PER_RUN = 3;

export interface AutoForcedSwitchInput {
	/** The narrator's model reference for this turn (`auto:<model>`, `<prefix>:<model>`, …). */
	modelRef: string | undefined;
	/** The provider the failed request went to. */
	provider: string;
	/** When the wait would end (epoch ms); undefined when unknown or not a timed wait. */
	resumeAt?: number;
	now?: number;
	/** Resolution hook, for tests. */
	resolve?: (modelRef: string, stickyProvider: string) => string;
}

/**
 * The concrete `<prefix>:<model>` to move to, or null to keep the current behaviour (wait
 * or report). Never throws: a resolution failure means there is nowhere to go.
 */
export function autoForcedSwitchTarget(input: AutoForcedSwitchInput): string | null {
	const { modelRef, provider } = input;
	if (!modelRef || !isAutoModelValue(modelRef)) return null;
	const now = input.now ?? Date.now();
	if (input.resumeAt !== undefined && input.resumeAt - now <= AUTO_SWITCH_WAIT_THRESHOLD_MS) {
		return null;
	}
	let next: string;
	try {
		// The failed provider is passed as sticky: if it still counts as able to serve, routing
		// keeps it and there is no better place to go.
		next = (input.resolve ?? resolveEffectiveModel)(modelRef, provider);
	} catch {
		return null;
	}
	return parseModelId(next).provider === provider ? null : next;
}
