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

import {
	narratorsApi,
	type ToolCallDetailRef,
	toolCallDetailQueryKey,
} from "@frontend/lib/api/narrators";
import type { AdapterContext } from "@shared/pretext-layout/segment-adapter";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import type { VListDataSource } from "./vlist-data-source";

/** Max detail records fetched concurrently, so one screen cannot storm the API. */
const MAX_CONCURRENT_FETCHES = 6;

/** Cache lifetime — a completed tool call's payload is immutable. */
const DETAIL_CACHE_MS = 10 * 60 * 1000;

export interface VListFullToolPayload {
	inputJson?: unknown;
	outputJson?: unknown;
}

export interface VListToolDetailRequest extends ToolCallDetailRef {
	toolUseId: string;
}

/** Read refs from the adapter's card data, never from measured/display ids. */
export function toolDetailRequestFromData(
	toolUseId: string,
	data: unknown,
): VListToolDetailRequest {
	const source = data as { toolUseId?: string; toolDetailRef?: ToolCallDetailRef } | undefined;
	return { ...source?.toolDetailRef, toolUseId: source?.toolUseId ?? toolUseId };
}

export function sameToolDetailRequests(
	left: readonly VListToolDetailRequest[],
	right: readonly VListToolDetailRequest[],
): boolean {
	return (
		left.length === right.length &&
		left.every(
			(ref, index) =>
				toolDetailIdentityKey(ref.toolUseId, ref) ===
				toolDetailIdentityKey(right[index].toolUseId, right[index]),
		)
	);
}

export type UseVListToolDetailsResult = Required<
	Pick<AdapterContext, "resolveFullToolInput" | "resolveFullToolOutput">
>;

/** Use the same identity for React Query, retention, and adapter lookups. */
export function toolDetailIdentityKey(toolUseId: string, ref?: ToolCallDetailRef): string {
	return JSON.stringify(toolCallDetailQueryKey("", toolUseId, ref));
}

export type ToolDetailQueryResult = {
	data?: { inputJson?: unknown; outputJson?: unknown } | undefined;
};

/**
 * Which exact identity keys currently have a settled payload, as a plain string.
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
	identityKeys: readonly string[],
	results: readonly ToolDetailQueryResult[],
): string {
	const settled = new Set(retainedIds);
	identityKeys.forEach((toolUseId, index) => {
		if (results[index]?.data) settled.add(toolUseId);
	});
	// Sorted so the revision tracks the SET of known payloads, not the order the
	// shell happened to request them in (a scroll reorders the list without
	// changing what is available, and must not move the revision).
	return JSON.stringify([...settled].sort());
}

/**
 * Merge settled payloads into `retained`, keyed by exact row/message/attempt identity.
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
	identityKeys: readonly string[],
	results: readonly ToolDetailQueryResult[],
): ReadonlyMap<string, VListFullToolPayload> {
	let merged: Map<string, VListFullToolPayload> | null = null;
	identityKeys.forEach((toolUseId, index) => {
		const data = results[index]?.data;
		if (!data || retained.has(toolUseId)) return;
		if (!merged) merged = new Map(retained);
		merged.set(toolUseId, { inputJson: data.inputJson, outputJson: data.outputJson });
	});
	return merged ?? retained;
}

/**
 * Fetch visible + expanded + truncated calls by their exact persisted identity.
 * A missing ref remains a legacy request; never borrow a body from a richer ref.
 *
 * `fetchDetail` overrides the transport (the public share page calls its own
 * share-credentialed endpoint); absent → the narrator API.
 */
export function useVListToolDetails(
	narratorId: string,
	requests: readonly VListToolDetailRequest[],
	fetchDetail?: VListDataSource["fetchToolDetail"],
): UseVListToolDetailsResult {
	// Dedupe exact identities before applying the cap, not provider tool-use ids.
	const wanted = useMemo(() => {
		const unique = new Map<string, VListToolDetailRequest>();
		for (const request of requests) {
			unique.set(toolDetailIdentityKey(request.toolUseId, request), request);
		}
		return [...unique.values()].slice(0, MAX_CONCURRENT_FETCHES);
	}, [requests]);
	const wantedKeys = useMemo(
		() => wanted.map((request) => toolDetailIdentityKey(request.toolUseId, request)),
		[wanted],
	);

	// The store is the DATA channel; combine's plain revision is the CHANGE signal.
	// Capture a separate store per narrator instead of resetting a shared ref: a
	// late combine from the previous narrator must not write into the new store.
	const storeRef = useRef<{
		narratorId: string;
		current: ReadonlyMap<string, VListFullToolPayload>;
	}>({ narratorId, current: new Map() });
	if (storeRef.current.narratorId !== narratorId) {
		storeRef.current = { narratorId, current: new Map() };
	}
	const payloads = storeRef.current;
	const combine = useCallback(
		(results: readonly ToolDetailQueryResult[]) => {
			const merged = mergeToolDetailPayloads(payloads.current, wantedKeys, results);
			payloads.current = merged;
			return buildToolDetailRevision([...merged.keys()], wantedKeys, results);
		},
		[payloads, wantedKeys],
	);

	const revision = useQueries({
		queries: wanted.map((request) => ({
			queryKey: toolCallDetailQueryKey(narratorId, request.toolUseId, request),
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				fetchDetail
					? fetchDetail(narratorId, request.toolUseId, request, signal)
					: narratorsApi.getToolCallDetail(narratorId, request.toolUseId, request, signal),
			enabled: !!narratorId && !!request.toolUseId,
			staleTime: DETAIL_CACHE_MS,
			gcTime: DETAIL_CACHE_MS,
		})),
		combine,
	});

	return useMemo<UseVListToolDetailsResult>(() => {
		// Retain bodies even after their now-untruncated cards leave the wanted set.
		// Only a new settled identity (or narrator) changes these resolver functions.
		void revision;
		return {
			resolveFullToolInput: (toolUseId, ref) =>
				toolUseId
					? payloads.current.get(toolDetailIdentityKey(toolUseId, ref))?.inputJson
					: undefined,
			resolveFullToolOutput: (toolUseId, ref) =>
				toolUseId
					? payloads.current.get(toolDetailIdentityKey(toolUseId, ref))?.outputJson
					: undefined,
		};
	}, [payloads, revision]);
}
