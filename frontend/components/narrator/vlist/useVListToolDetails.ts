/**
 * useVListToolDetails.ts — On-demand full tool payloads for the exact vlist.
 *
 * Large tool inputs/outputs reach the client as `{_truncated:true, preview, …}`
 * wrappers. The chunked card fetches the full record when the user expands it
 * (`LazyDetailRenderer` → `useToolCallDetail`); the vlist had no equivalent, so an
 * expanded card could only ever show the preview — a whole file read or a long
 * shell output looked cut off with no way to see the rest.
 *
 * This hook is that fetch, shaped for a pure-adapter pipeline:
 *
 *   1. The shell reports which VISIBLE rows are expanded and truncated.
 *   2. Each such tool use is fetched once (bounded concurrency, React Query cache).
 *   3. The resolved payloads land in a Map exposed through two resolvers whose
 *      identity changes ONLY when the settled set changes.
 *   4. Those resolvers feed `resolveFullToolInput` / `resolveFullToolOutput`, so the
 *      adapter re-classifies with the real body and the measure cache — which keys
 *      on body length — re-measures the taller card instead of serving a stale
 *      height.
 *
 * Fetching is deliberately demand-driven: a narrator can hold thousands of
 * truncated tool calls, and pre-fetching them would defeat the truncation.
 */

import { narratorsApi } from "@frontend/lib/api/narrators";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";

/** Max detail records fetched concurrently, so one screen cannot storm the API. */
const MAX_CONCURRENT_FETCHES = 6;

/** Cache lifetime — a completed tool call's payload is immutable. */
const DETAIL_CACHE_MS = 10 * 60 * 1000;

export interface VListFullToolPayload {
	inputJson?: unknown;
	outputJson?: unknown;
}

export interface UseVListToolDetailsResult {
	/** `resolveFullToolInput` for the layout pipeline. */
	resolveFullToolInput: (toolUseId: string | undefined) => unknown;
	/** `resolveFullToolOutput` for the layout pipeline. */
	resolveFullToolOutput: (toolUseId: string | undefined) => unknown;
}

export type ToolDetailQueryResult = {
	data?: { inputJson?: unknown; outputJson?: unknown } | undefined;
};

/**
 * Which of `toolUseIds` currently have a settled payload, as a plain string.
 *
 * This is what `combine` returns, and it must contain NO functions and no fresh
 * object identities. React Query stabilizes a combined result with
 * `replaceEqualDeep`, which only structurally compares plain objects/arrays — a
 * function value is always treated as changed. Returning the resolvers straight
 * out of `combine` therefore handed the shell two brand-new function identities
 * on EVERY render, which invalidated the layout `buildOptions` memo, which
 * rebuilt the pretext document, which emitted a coordinator snapshot, which
 * re-rendered: the "Maximum update depth exceeded" loop reported through
 * `PretextLayoutCoordinator.emit` → `forceStoreRerender`.
 *
 * A revision string collapses to `a === b` inside `replaceEqualDeep`, so the
 * observer stays quiet until a payload actually lands. Comparing ids (rather
 * than the bodies) also keeps this O(ids) instead of deep-comparing the very
 * payloads that were too large to inline in the first place.
 */
export function buildToolDetailRevision(
	retainedIds: readonly string[],
	toolUseIds: readonly string[],
	results: readonly ToolDetailQueryResult[],
): string {
	const settled = new Set(retainedIds);
	toolUseIds.forEach((toolUseId, index) => {
		if (results[index]?.data) settled.add(toolUseId);
	});
	// Sorted so the revision tracks the SET of known payloads, not the order the
	// shell happened to request them in (a scroll reorders the list without
	// changing what is available, and must not move the revision).
	return [...settled].sort().join(",");
}

/**
 * Merge the settled payloads into `retained`, keyed by tool use id.
 *
 * Retention is load-bearing, not an optimization. Once a body lands, the adapter
 * clears the card's `hasTruncatedPayload`, so the shell legitimately drops that
 * id from the requested list. Forgetting the payload at that moment sent the
 * resolver back to `undefined`, the card re-rendered as truncated, the id
 * re-entered the list, and the request set oscillated `[] ↔ [id]` forever — the
 * cached body makes each turn complete within the same tick, so this is the
 * second, independent path to "Maximum update depth exceeded".
 *
 * Returns `retained` itself when nothing changed, so a caller can use identity
 * to detect a real update.
 */
export function mergeToolDetailPayloads(
	retained: ReadonlyMap<string, VListFullToolPayload>,
	toolUseIds: readonly string[],
	results: readonly ToolDetailQueryResult[],
): ReadonlyMap<string, VListFullToolPayload> {
	let merged: Map<string, VListFullToolPayload> | null = null;
	toolUseIds.forEach((toolUseId, index) => {
		const data = results[index]?.data;
		if (!data || retained.has(toolUseId)) return;
		if (!merged) merged = new Map(retained);
		merged.set(toolUseId, { inputJson: data.inputJson, outputJson: data.outputJson });
	});
	return merged ?? retained;
}

/**
 * Fetch the full payloads for `toolUseIds` (already filtered by the caller to the
 * visible + expanded + truncated rows) and expose them as adapter resolvers.
 */
export function useVListToolDetails(
	narratorId: string,
	toolUseIds: readonly string[],
): UseVListToolDetailsResult {
	// Bound the in-flight set: extra ids simply wait for a later render once the
	// user scrolls / collapses something.
	const wanted = useMemo(() => toolUseIds.slice(0, MAX_CONCURRENT_FETCHES), [toolUseIds]);

	// The payload map travels through a ref so the resolvers below can stay
	// referentially stable: the ref is the DATA channel, the combined revision is
	// the CHANGE signal. Writing it from `combine` only ever ADDS settled bodies
	// (see mergeToolDetailPayloads), so it is idempotent under React's
	// double-invoke and unaffected by the order combine happens to run in.
	const payloadsRef = useRef<ReadonlyMap<string, VListFullToolPayload>>(new Map());
	// Retained payloads belong to one narrator. Switching narrators must drop them
	// (tool use ids are not shared, and holding them would leak memory across a
	// long session), which also resets the revision to "".
	const payloadsNarratorRef = useRef(narratorId);
	if (payloadsNarratorRef.current !== narratorId) {
		payloadsNarratorRef.current = narratorId;
		payloadsRef.current = new Map();
	}

	// Stable `combine` identity: QueriesObserver re-runs a combine it has not seen
	// before, so an inline arrow would recompute on every render even when nothing
	// settled.
	const combine = useCallback(
		(results: readonly ToolDetailQueryResult[]) => {
			const merged = mergeToolDetailPayloads(payloadsRef.current, wanted, results);
			payloadsRef.current = merged;
			return buildToolDetailRevision([...merged.keys()], wanted, results);
		},
		[wanted],
	);

	const revision = useQueries({
		queries: wanted.map((toolUseId) => ({
			queryKey: ["narrators", narratorId, "tool-calls", toolUseId],
			queryFn: () => narratorsApi.getToolCallDetail(narratorId, toolUseId),
			enabled: !!narratorId && !!toolUseId,
			staleTime: DETAIL_CACHE_MS,
			gcTime: DETAIL_CACHE_MS,
		})),
		combine,
	});

	return useMemo<UseVListToolDetailsResult>(() => {
		// `revision` is the sole dependency by design: it changes exactly when a new
		// payload settles, which is what must give these resolvers a new identity so
		// the document rebuilds and the now-taller card re-measures. The bodies read
		// the ref, so they always see the newest map.
		void revision;
		return {
			resolveFullToolInput: (toolUseId) =>
				toolUseId ? payloadsRef.current.get(toolUseId)?.inputJson : undefined,
			resolveFullToolOutput: (toolUseId) =>
				toolUseId ? payloadsRef.current.get(toolUseId)?.outputJson : undefined,
		};
	}, [revision]);
}
