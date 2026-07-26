import type { RenderLod } from "./prepared-block";

export interface VListInteractionState {
	lod: RenderLod;
	/** Normal card/reasoning preference; survives LOD changes. */
	expanded: ReadonlyMap<string, boolean>;
	/** Temporary force-open state for L4 / old-L5 cards; reset on LOD change. */
	lodUserOverrides: ReadonlySet<string>;
	showEarlier: ReadonlySet<string>;
	expandedRows: ReadonlyMap<string, ReadonlySet<number>>;
}

export function createVListInteractionState(lod: RenderLod): VListInteractionState {
	return {
		lod,
		expanded: new Map(),
		lodUserOverrides: new Set(),
		showEarlier: new Set(),
		expandedRows: new Map(),
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
