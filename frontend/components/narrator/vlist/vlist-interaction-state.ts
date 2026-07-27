import type { RenderLod } from "./prepared-block";

export interface VListInteractionState {
	lod: RenderLod;
	/** Normal card/reasoning preference; survives LOD changes. */
	expanded: ReadonlyMap<string, boolean>;
	/** Temporary force-open state for L4 / old-L5 cards; reset on LOD change. */
	lodUserOverrides: ReadonlySet<string>;
	showEarlier: ReadonlySet<string>;
	expandedRows: ReadonlyMap<string, ReadonlySet<number>>;
	/**
	 * Keys whose translated body is currently switched back to the ORIGINAL text.
	 *
	 * A translated reasoning run displays its translation by default (the chunked
	 * ReasoningBlock does the same), so this set tracks the exception rather than
	 * the rule. It is a CONTENT preference, not a fold state, so it survives an
	 * LOD change like `expanded` does.
	 */
	showOriginal: ReadonlySet<string>;
}

export function createVListInteractionState(lod: RenderLod): VListInteractionState {
	return {
		lod,
		expanded: new Map(),
		lodUserOverrides: new Set(),
		showEarlier: new Set(),
		expandedRows: new Map(),
		showOriginal: new Set(),
	};
}

export function resetVListInteractionStateForLod(
	state: VListInteractionState,
	lod: RenderLod,
): VListInteractionState {
	if (state.lod === lod) return state;
	return {
		...createVListInteractionState(lod),
		expanded: state.expanded,
		showOriginal: state.showOriginal,
	};
}

export function setVListExpanded(
	state: VListInteractionState,
	key: string,
	expanded: boolean,
): VListInteractionState {
	const next = new Map(state.expanded);
	next.set(key, expanded);
	return { ...state, expanded: next };
}

export function toggleVListLodUserOverride(
	state: VListInteractionState,
	key: string,
): VListInteractionState {
	const next = new Set(state.lodUserOverrides);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return { ...state, lodUserOverrides: next };
}

export function toggleVListShowEarlier(
	state: VListInteractionState,
	key: string,
): VListInteractionState {
	const next = new Set(state.showEarlier);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return { ...state, showEarlier: next };
}

/**
 * Flip a translated body between its translation (default) and the original.
 *
 * Keyed by spec.key like every other per-element preference, so a fork/reload
 * that keeps the same key keeps the reader's choice.
 */
export function toggleVListShowOriginal(
	state: VListInteractionState,
	key: string,
): VListInteractionState {
	const next = new Set(state.showOriginal);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return { ...state, showOriginal: next };
}

/**
 * True when the USER explicitly opened this row (rather than it being opened by
 * `computeDefaultOpen` / the LOD).
 *
 * This gates the on-demand full-payload fetch: growing a row after paint is only
 * acceptable when a click caused it. Auto-expanded rows get their body prefetched
 * before the layout is built instead, so their first height is already final.
 *
 * Both channels count as an explicit action: `expanded` (the normal toggle) and
 * `lodUserOverrides` (force-open at an LOD that otherwise collapses).
 */
export function isUserExpandedRow(state: VListInteractionState, key: string): boolean {
	return state.expanded.get(key) === true || state.lodUserOverrides.has(key);
}

export function toggleVListRow(
	state: VListInteractionState,
	key: string,
	itemIndex: number,
): VListInteractionState {
	const nextRows = new Map(state.expandedRows);
	const rows = new Set(nextRows.get(key) ?? []);
	if (rows.has(itemIndex)) rows.delete(itemIndex);
	else rows.add(itemIndex);
	if (rows.size === 0) nextRows.delete(key);
	else nextRows.set(key, rows);
	return { ...state, expandedRows: nextRows };
}
