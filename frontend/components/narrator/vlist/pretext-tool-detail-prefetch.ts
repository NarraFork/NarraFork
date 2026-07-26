/**
 * pretext-tool-detail-prefetch.ts — Full tool payloads resolved BEFORE the first
 * layout build, so an auto-expanded card's first painted height is its final one.
 *
 * WHY A COORDINATOR-OWNED STORE RATHER THAN A REACT HOOK
 *
 * The on-demand hook (`useVListToolDetails`) resolves payloads AFTER a build: its
 * resolver identity changes when a body lands, which invalidates the build options
 * and rebuilds the document with a taller card. That is correct for a card the user
 * just expanded, but for cards that expand BY DEFAULT it means the row grows on its
 * own while the reader is only scrolling.
 *
 * Putting the prefetch here — on the same async boundary that already awaits KaTeX
 * — means the payloads are in hand before `buildLayout` runs, so the arithmetic is
 * right the first time and no rebuild is involved at all.
 *
 * The store is per-narrator and append-only within a narrator: a completed tool
 * call's payload is immutable, so a fetched body stays valid for the whole session
 * and a later page (loadOlder) reuses whatever is already cached.
 */

import { narratorsApi } from "@frontend/lib/api/narrators";

/** Concurrent detail requests. Bounded so one page cannot storm the API. */
const MAX_CONCURRENT_FETCHES = 6;

export interface PrefetchedToolPayload {
	inputJson?: unknown;
	outputJson?: unknown;
}

export type ToolDetailFetcher = (
	narratorId: string,
	toolUseId: string,
) => Promise<{ inputJson?: unknown; outputJson?: unknown }>;

/**
 * Run `worker` over `items` with at most `concurrency` in flight.
 *
 * Individual failures are swallowed by the caller's worker: a payload that cannot
 * be fetched simply keeps its preview (the card is then measured from the preview,
 * which is the pre-existing behaviour) — a failed request must never block the
 * whole document from rendering.
 */
async function mapWithConcurrency<T>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return;
	const limit = Math.max(1, Math.min(concurrency, items.length));
	let cursor = 0;
	const runners: Array<Promise<void>> = [];
	for (let i = 0; i < limit; i++) {
		runners.push(
			(async () => {
				for (;;) {
					const index = cursor++;
					if (index >= items.length) return;
					const item = items[index];
					if (item === undefined) return;
					await worker(item);
				}
			})(),
		);
	}
	await Promise.all(runners);
}

/**
 * Per-narrator cache of full tool payloads, with resolvers shaped for the layout
 * pipeline (`resolveFullToolInput` / `resolveFullToolOutput`).
 *
 * The resolvers are referentially STABLE for the store's lifetime — deliberately.
 * They read the map at call time, and every fetch completes before the build that
 * consumes them, so they never need to signal "something changed" the way the
 * on-demand hook does. That is what keeps the prefetch out of the rebuild path.
 */
export class PretextToolDetailPrefetchStore {
	private narratorId: string | undefined;
	private readonly payloads = new Map<string, PrefetchedToolPayload>();
	/** Ids already attempted (settled or failed), so a failure is not retried. */
	private readonly attempted = new Set<string>();
	private readonly fetcher: ToolDetailFetcher;

	constructor(
		fetcher: ToolDetailFetcher = (id, toolUseId) => narratorsApi.getToolCallDetail(id, toolUseId),
	) {
		this.fetcher = fetcher;
	}

	/** Drop everything when the narrator changes (tool use ids are not shared). */
	private ensureNarrator(narratorId: string): void {
		if (this.narratorId === narratorId) return;
		this.narratorId = narratorId;
		this.payloads.clear();
		this.attempted.clear();
	}

	/**
	 * Fetch every id not already attempted, bounded by MAX_CONCURRENT_FETCHES.
	 * Resolves once all of them have settled, so the caller can build immediately
	 * afterwards knowing the payloads are in place.
	 */
	async prefetch(narratorId: string, toolUseIds: readonly string[]): Promise<void> {
		this.ensureNarrator(narratorId);
		const wanted = toolUseIds.filter((id) => id && !this.attempted.has(id));
		if (wanted.length === 0) return;
		for (const id of wanted) this.attempted.add(id);
		await mapWithConcurrency(wanted, MAX_CONCURRENT_FETCHES, async (toolUseId) => {
			try {
				const detail = await this.fetcher(narratorId, toolUseId);
				this.payloads.set(toolUseId, {
					inputJson: detail?.inputJson,
					outputJson: detail?.outputJson,
				});
			} catch {
				// Keep the preview: a missing payload degrades to the previous (shorter)
				// measurement rather than failing the document.
			}
		});
	}

	/** Full input for a tool use, or undefined when not prefetched. */
	resolveFullToolInput = (toolUseId: string | undefined): unknown =>
		toolUseId ? this.payloads.get(toolUseId)?.inputJson : undefined;

	/** Full output for a tool use, or undefined when not prefetched. */
	resolveFullToolOutput = (toolUseId: string | undefined): unknown =>
		toolUseId ? this.payloads.get(toolUseId)?.outputJson : undefined;

	/** True when this id has a resolved payload (test/diagnostic seam). */
	has(toolUseId: string): boolean {
		return this.payloads.has(toolUseId);
	}

	/** Number of resolved payloads (test/diagnostic seam). */
	get size(): number {
		return this.payloads.size;
	}
}
