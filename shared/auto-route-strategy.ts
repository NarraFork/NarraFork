/**
 * Ordering of `auto:<model>` candidates (docs/PROVIDER-SOURCING-DESIGN.md §4.2).
 *
 * This first cut implements the "use subscriptions first" rule the 2026-11-05 decision
 * asked for; the full strategy presets (§4.2) come later:
 *
 * 1. Unavailable candidates go last: every account or key resting, quota used up, or
 *    otherwise unable to serve. They stay in the list so a request can still report the
 *    upstream's own error when nothing else is left.
 * 2. Subscription candidates (Codex, Kimi Code, OpenCode Go …) before pay-per-use ones:
 *    within its window a subscription costs nothing extra.
 * 3. Within a group, the lower reference price first; an unknown price after a known one.
 * 4. Remaining ties keep provider order, so the order the user arranged still decides.
 *
 * Personal versus team sources (§5) come with P4; until then every source is a team source
 * and the tier step is a no-op. The sticky provider is applied by the caller, before this
 * ordering, so a running session never hops while its source can still serve it.
 */

export interface AutoRouteSignals {
	value: string;
	/** Some account or key of this source can serve a request right now. */
	available: boolean;
	/** A flat-rate plan with an allowance window, rather than pay-per-use. */
	subscription: boolean;
	/** Reference input + output price per million tokens, when the catalog knows it. */
	referencePrice?: number;
}

export function orderAutoCandidates(candidates: readonly AutoRouteSignals[]): string[] {
	return candidates
		.map((candidate, index) => ({ candidate, index }))
		.sort((a, b) => {
			const x = a.candidate;
			const y = b.candidate;
			if (x.available !== y.available) return x.available ? -1 : 1;
			if (x.subscription !== y.subscription) return x.subscription ? -1 : 1;
			const px = x.referencePrice;
			const py = y.referencePrice;
			if (px !== undefined && py !== undefined && px !== py) return px - py;
			if ((px === undefined) !== (py === undefined)) return px === undefined ? 1 : -1;
			return a.index - b.index;
		})
		.map(({ candidate }) => candidate.value);
}
