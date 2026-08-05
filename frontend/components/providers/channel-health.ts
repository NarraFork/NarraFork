/**
 * NUG channel health helpers.
 *
 * The upstream `/v1/channels/health` endpoint returns one entry per channel
 * *instance*, so multiple entries can share the same `channelType` (e.g. several
 * openai-compatible channels). The response order is also non-deterministic
 * across refreshes, so rows must be keyed by instance identity and sorted
 * deterministically before rendering.
 */

export interface ChannelHealth {
	/** Channel instance name; several instances may share one channelType. */
	channel?: string;
	channelType: string;
	healthy?: boolean;
	availabilityRate: number;
	totalCredentials?: number;
	availableCredentials?: number;
	disabledCredentials?: number;
	currentConcurrency?: number;
	maxConcurrency?: number;
	queueDepth?: number;
}

/** Stable React key / identity for a channel health row. */
export function channelHealthKey(ch: ChannelHealth): string {
	return `${ch.channel ?? ""}::${ch.channelType}`;
}

/**
 * Code-point comparison, NOT `localeCompare`.
 *
 * The values ordered here are technical identifiers (`openai`, `anthropic`,
 * `dongplus`, `tjcn`), never display text. `localeCompare` resolves against the
 * runtime's locale, which reorders exactly these characters in real locales — `i`
 * against `ı` under `tr`, `w` against `v` under `sv` — so two users refreshing the
 * same endpoint would see the rows in different orders. That defeats the only
 * reason this function exists: upstream order is non-deterministic, so the order
 * has to come from the data alone.
 */
function compareIdentifiers(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

/** Drop malformed entries, dedupe by instance identity, sort deterministically. */
export function normalizeChannelHealth(channels: ChannelHealth[] | undefined): ChannelHealth[] {
	const byKey = new Map<string, ChannelHealth>();
	for (const ch of channels ?? []) {
		if (!ch || typeof ch.channelType !== "string" || ch.channelType.length === 0) continue;
		byKey.set(channelHealthKey(ch), ch);
	}
	return Array.from(byKey.values()).sort((a, b) => {
		const byType = compareIdentifiers(a.channelType, b.channelType);
		if (byType !== 0) return byType;
		return compareIdentifiers(a.channel ?? "", b.channel ?? "");
	});
}
