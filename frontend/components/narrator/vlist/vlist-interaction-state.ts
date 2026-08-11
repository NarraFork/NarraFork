import type { RenderLod } from "./prepared-block";

export interface VListInteractionState {
	lod: RenderLod;
	/** Normal card/reasoning preference; survives LOD changes. */
	expanded: ReadonlyMap<string, boolean>;
	/** Temporary force-open state for L4 / old-L5 cards; reset on LOD change. */
	lodUserOverrides: ReadonlySet<string>;
	showEarlier: ReadonlySet<string>;
	/**
	 * INDEX-addressed per-row state, for lists whose row ORDINALS are stable:
	 * the subagent-recovery card's checkboxes (where the set means "deselected"),
	 * and a `reasoning-steps` element's step rows.
	 *
	 * ⚠️ NOT for the two traces that fold a live row list. See `expandedTraceRows`
	 * and `traceRowFoldChannel`.
	 */
	expandedRows: ReadonlyMap<string, ReadonlySet<number>>;
	/**
	 * KEY-addressed drill-down state for the two traces that fold a LIVE row list:
	 * trace key → set of ROW KEYS. See `traceRowFoldChannel` for which kinds these
	 * are and why the rest stay on `expandedRows`.
	 *
	 * A separate channel from `expandedRows` because a trace row's ORDINAL is not
	 * stable while a turn streams. The activity fold emits one row per reasoning
	 * STEP, so the moment the model writes another `**title**` every row below it
	 * shifts down by one — and an index recorded at click time then addresses a
	 * different tool. The reader watched the card they opened fold shut while a
	 * neighbour opened in its place, which is also a height change with no user
	 * action behind it.
	 *
	 * Row keys are stable across exactly those frames: `tool-<toolUseId>` is
	 * identical live and persisted, and a reasoning row keys on its run ordinal
	 * within the unit.
	 */
	expandedTraceRows: ReadonlyMap<string, ReadonlySet<string>>;
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
		expandedTraceRows: new Map(),
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

/**
 * Trace kinds whose row fold is addressed by ROW KEY (`expandedTraceRows`).
 *
 * ONLY these two, because only these two can have a row INSERTED above an
 * existing one mid-stream: they fold reasoning rows and tool rows into one list,
 * and a live reasoning run grows by a row per step. Every other trace appends
 * only — a `reasoning-steps` element numbers step N as row N however many steps
 * follow — so its ordinals are
 * already stable and they stay on the index channel their adapter reads.
 */
const KEY_ADDRESSED_TRACE_KINDS = new Set(["activity-trace", "tool-run-summary"]);

/**
 * Which interaction channel one trace kind's row fold belongs in.
 *
 * The shell MUST route by this rather than hand every trace the same handler: the
 * two channels are read by different adapter paths (`ctx.isRowExpanded` vs
 * `ctx.expandedRows`), so writing a key for an index-addressed kind stores the
 * reader's fold where nothing looks for it and the row silently stops opening.
 */
export function traceRowFoldChannel(kind: string): "key" | "index" {
	return KEY_ADDRESSED_TRACE_KINDS.has(kind) ? "key" : "index";
}

/**
 * Drill into (or back out of) ONE row of a folded trace, addressed by its ROW KEY.
 *
 * The trace counterpart of `toggleVListRow`. Keyed rather than indexed because a
 * live turn re-numbers the rows under the reader — see `expandedTraceRows`.
 */
export function toggleVListTraceRow(
	state: VListInteractionState,
	traceKey: string,
	rowKey: string,
): VListInteractionState {
	const next = new Map(state.expandedTraceRows);
	const rows = new Set(next.get(traceKey) ?? []);
	if (rows.has(rowKey)) rows.delete(rowKey);
	else rows.add(rowKey);
	if (rows.size === 0) next.delete(traceKey);
	else next.set(traceKey, rows);
	return { ...state, expandedTraceRows: next };
}

/** True when this trace row is drilled in. */
export function isTraceRowExpanded(
	state: VListInteractionState,
	traceKey: string,
	rowKey: string,
): boolean {
	return state.expandedTraceRows.get(traceKey)?.has(rowKey) === true;
}
