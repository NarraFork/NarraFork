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
	/**
	 * Rows where the user explicitly asked for the UN-TRUNCATED payload.
	 *
	 * A THIRD channel, deliberately separate from `expanded`: "show me this card's
	 * body" and "fetch the full payload behind it" are different requests, and
	 * conflating them is what made every auto-expanded card grow after paint. Only
	 * this set may trigger a fetch, so a height change always has a click behind it.
	 *
	 * Grow-only — a fetched payload is immutable, so there is no "un-request".
	 */
	fullPayloadRequested: ReadonlySet<string>;
	/**
	 * Subagent cards whose PROMPT body is open.
	 *
	 * A FOURTH channel, separate from `expanded`, because the subagent card has two
	 * independent folds: the card body (`expanded`) and the prompt block inside it
	 * (this set). Sharing one key would make opening the card also unfold the
	 * prompt — the chunked SubagentCard keeps them separate too (`showPrompt`).
	 *
	 * Height-affecting, so it is resolved during adaptation like `expanded`, and it
	 * is what gates the on-demand fetch of a truncated prompt.
	 */
	promptOpen: ReadonlySet<string>;
}

export function createVListInteractionState(lod: RenderLod): VListInteractionState {
	return {
		lod,
		expanded: new Map(),
		lodUserOverrides: new Set(),
		showEarlier: new Set(),
		expandedRows: new Map(),
		showOriginal: new Set(),
		fullPayloadRequested: new Set(),
		promptOpen: new Set(),
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
		// A CONTENT preference, like `expanded`/`showOriginal`, not a fold state:
		// after an LOD change the reader still wants that full payload, and dropping
		// it would re-request the same bytes.
		fullPayloadRequested: state.fullPayloadRequested,
		// Survives an LOD change for the same reason `expanded` does: the reader
		// asked to see this prompt, and an LOD step is not a request to re-fold it.
		promptOpen: state.promptOpen,
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
 * Record that the user asked for this row's un-truncated payload.
 *
 * Grow-only by design (see `fullPayloadRequested`): the payload is immutable, so
 * once fetched it stays valid for the session.
 */
export function markVListFullPayloadRequested(
	state: VListInteractionState,
	key: string,
): VListInteractionState {
	if (state.fullPayloadRequested.has(key)) return state;
	const next = new Set(state.fullPayloadRequested);
	next.add(key);
	return { ...state, fullPayloadRequested: next };
}

/** True when the user asked for this row's un-truncated payload. */
export function isFullPayloadRequestedRow(state: VListInteractionState, key: string): boolean {
	return state.fullPayloadRequested.has(key);
}

/**
 * Fold / unfold a subagent card's prompt body.
 *
 * Keyed by spec.key like every other per-element preference. Opening it is also
 * the ONLY trigger for fetching a truncated prompt (see the shell's
 * `promptExpandedToolUseIds`), so a prompt is never fetched for a card the reader
 * merely scrolled past.
 */
export function toggleVListPromptOpen(
	state: VListInteractionState,
	key: string,
): VListInteractionState {
	const next = new Set(state.promptOpen);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return { ...state, promptOpen: next };
}

/** True when this subagent card's prompt body is open. */
export function isPromptOpenRow(state: VListInteractionState, key: string): boolean {
	return state.promptOpen.has(key);
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
