/**
 * Global panel drag state — a framework-agnostic pointer-drag singleton used to
 * drag "something" onto a Dockview surface: a sidebar recent tab (to create /
 * focus a panel) or an existing panel header (to move / swap it).
 *
 * Two entry points:
 * 1. Icon / header pointerdown → startPointerDrag / startPanelDrag
 *    (registers document pointer listeners; the singleton owns the pointer)
 * 2. @dnd-kit DndContext callbacks → startDragManual / moveDrag / endDrag
 *    (no document listeners — @dnd-kit owns the pointer)
 */

/**
 * What kind of thing is being dragged. Consumers use this instead of parsing
 * the subject id to decide behaviour:
 *   - `narrator`: a real narrator (sidebar tab or a chat panel header). Only
 *     these may seed a new workspace / be materialised as a narrator panel.
 *   - `tool`: a resource/tool panel (spec/terminal/browser/git/…/webview) being
 *     rearranged inside a surface. Never creates a workspace or a narrator panel.
 */
export type PanelDragSubjectKind = "narrator" | "tool";

export interface PanelDragState {
	/**
	 * The dragged subject id. For a sidebar tab this is the narrator id (or a
	 * synthetic marker like `__terminal__` / `__webview__`); consumers that
	 * create panels key off it. For an existing-panel drag, `panelId` is the
	 * authoritative live panel id and this mirrors the subject.
	 */
	id: string;
	/**
	 * Explicit classification of the subject (set at drag start where the
	 * semantic is known). Preferred over `isSyntheticSubjectId(id)` string
	 * parsing. Optional for backward compatibility; when absent, consumers may
	 * fall back to `isSyntheticSubjectId`.
	 */
	subjectKind?: PanelDragSubjectKind;
	title: string;
	x: number;
	y: number;
	/** When drag originates from a workspace leaf panel, this is the leaf id. */
	sourceLeafId?: string;
	/**
	 * When dragging an *existing* dockview panel (not a sidebar tab), this is
	 * the live panel id. Consumers use it to move/swap the panel in place
	 * instead of creating a new one.
	 */
	panelId?: string;
	/** The dockview group id the dragged panel currently belongs to. */
	sourceGroupId?: string;
	/**
	 * Which dockview surface this drag started on.
	 *
	 * Load-bearing once several surfaces coexist (one per expanded graph node):
	 * every surface subscribes to this singleton, and panel ids are GLOBAL
	 * (`ndock-terminal` and friends). Without this field a surface receiving a
	 * drop would look up `panelId` in its OWN api and move an unrelated panel of
	 * the same kind. Consumers must only treat a drag as an in-surface panel move
	 * when this matches their own surface id (see `useDockviewDnd`).
	 *
	 * Absent for drags that have no live panel at all (sidebar tabs, detached
	 * canvas panels), and for surfaces that opt out of passing an id — those keep
	 * the historical behaviour.
	 */
	surfaceId?: string;
	/**
	 * The panel kind being dragged (`terminal`, `browser`, …), when known.
	 *
	 * Supplied so consumers never have to parse `panelId`: its `ndock-<kind>`
	 * shape is an implementation detail of `dockPanelId()`, and reading it here
	 * would turn that string format into an implicit cross-module contract that
	 * breaks silently if the prefix ever changes.
	 */
	toolKind?: string;
	/**
	 * Resource identity for multi-instance panels — a subagent's narrator id, a
	 * file viewer's path. Needed to rebuild the same panel elsewhere; singleton
	 * panels leave it unset.
	 */
	resourceId?: string;
	/** Panel-local loading state, separate from the drag's resource identity. */
	largeFileConfirmed?: boolean;
}

type MoveListener = (state: PanelDragState) => void;
type EndListener = (state: PanelDragState | null) => void;

let _current: PanelDragState | null = null;
/** Whether the drag was started via document pointer listeners (icon drag). */
let _ownsPointer = false;
const _moveListeners = new Set<MoveListener>();
const _endListeners = new Set<EndListener>();

/**
 * Movement (px) the pointer must travel after pointerdown before a drag is
 * actually activated. Below this, a pointerup is treated as a plain click, so
 * clicking a draggable header (or its close button) never gets swallowed by an
 * accidental zero-distance "drag".
 */
const DRAG_THRESHOLD_PX = 5;

/** A pending, not-yet-activated pointer drag (armed on pointerdown). */
interface PendingDrag {
	state: PanelDragState;
	startX: number;
	startY: number;
}
let _pending: PendingDrag | null = null;

export function getPanelDrag(): PanelDragState | null {
	return _current;
}

/**
 * Whether a drag subject id is a SYNTHETIC panel marker (e.g. `__terminal__`,
 * `__spec__`, `__git__`) rather than a real narrator id.
 *
 * Synthetic ids identify tool panels being rearranged inside a dock surface.
 * Consumers that only care about *narrators* being dragged in (e.g. the narrator
 * page's drag-to-split "create workspace" drop zone) must ignore these, or they
 * would create a bogus workspace leaf referencing a non-existent narrator.
 */
export function isSyntheticSubjectId(id: string): boolean {
	return id.startsWith("__") && id.endsWith("__") && id.length >= 4;
}

/**
 * Whether a drag state represents a real narrator (vs a tool/resource panel).
 * Prefers the explicit `subjectKind` set at drag start; falls back to id-shape
 * inference for any drag started without a classification.
 *
 * Consumers that only act on narrators (create-workspace drop zone, sidebar
 * narrator materialisation) should gate on this instead of parsing ids.
 */
export function isNarratorSubject(state: PanelDragState): boolean {
	if (state.subjectKind) return state.subjectKind === "narrator";
	return !isSyntheticSubjectId(state.id);
}

// ── Entry point 1: pointerdown (registers document listeners) ──

/**
 * Arm a pointer drag WITHOUT activating it yet. Document listeners are added so
 * we can watch for movement; the drag only becomes "live" (cursor changes,
 * listeners are notified) once the pointer moves past DRAG_THRESHOLD_PX. If the
 * pointer is released before then, it is a click — no drag, no drop.
 */
function beginPointerDrag(state: PanelDragState) {
	// Clear any stale pending/live drag first.
	teardownPointerListeners();
	_pending = { state, startX: state.x, startY: state.y };
	_current = null;
	_ownsPointer = true;
	document.addEventListener("pointermove", onDocPointerMove, true);
	document.addEventListener("pointerup", onDocPointerUp, true);
	// A browser interruption must release the cursor/listeners WITHOUT committing
	// the last hover target as a drop.
	document.addEventListener("pointercancel", cancelDrag, true);
}

/** Promote the pending drag to a live drag (first time the threshold is crossed). */
function activatePendingDrag(x: number, y: number) {
	if (!_pending) return;
	_current = { ..._pending.state, x, y };
	_pending = null;
	document.body.style.userSelect = "none";
	document.body.style.cursor = "grabbing";
	emit();
}

function teardownPointerListeners() {
	document.removeEventListener("pointermove", onDocPointerMove, true);
	document.removeEventListener("pointerup", onDocPointerUp, true);
	document.removeEventListener("pointercancel", cancelDrag, true);
}

/**
 * Start a pointer-driven drag of a subject (e.g. a sidebar recent tab). The
 * singleton registers document listeners and owns the pointer until pointerup.
 * Sidebar tabs are always narrators, so this defaults `subjectKind` to
 * `"narrator"`.
 */
export function startPointerDrag(
	id: string,
	title: string,
	x: number,
	y: number,
	sourceLeafId?: string,
) {
	beginPointerDrag({ id, title, x, y, sourceLeafId, subjectKind: "narrator" });
}

/**
 * Start dragging an existing dockview panel (identified by its live panel id).
 * `id` may be a real narrator id or a synthetic marker for tool/webview panels;
 * consumers key off `panelId` for move/swap. Pass `subjectKind` explicitly so
 * consumers don't have to parse the id.
 */
export function startPanelDrag(args: {
	panelId: string;
	id: string;
	title: string;
	sourceGroupId?: string;
	subjectKind?: PanelDragSubjectKind;
	/** The surface this panel lives on; see `PanelDragState.surfaceId`. */
	surfaceId?: string;
	toolKind?: string;
	resourceId?: string;
	/** Panel-local loading state, separate from the drag's resource identity. */
	largeFileConfirmed?: boolean;
	x: number;
	y: number;
}) {
	beginPointerDrag({
		id: args.id,
		title: args.title,
		x: args.x,
		y: args.y,
		panelId: args.panelId,
		sourceGroupId: args.sourceGroupId,
		...(args.surfaceId ? { surfaceId: args.surfaceId } : {}),
		...(args.toolKind ? { toolKind: args.toolKind } : {}),
		...(args.resourceId ? { resourceId: args.resourceId } : {}),
		...(args.largeFileConfirmed === true ? { largeFileConfirmed: true } : {}),
		// Fall back to id-shape inference when the caller didn't classify.
		subjectKind: args.subjectKind ?? (isSyntheticSubjectId(args.id) ? "tool" : "narrator"),
	});
}

/**
 * Start dragging a panel that is NOT a live dockview panel — a tool panel that
 * has been torn out onto the story-network canvas as its own node.
 *
 * Deliberately sets no `panelId` and no `surfaceId`. `useDockviewDnd` routes a
 * drag with a `panelId` to `dropExistingPanel` (an in-surface move), so a
 * detached panel dragged back into a dock MUST arrive without one or it would be
 * mistaken for a rearrangement of a same-kind panel already there, and the merge
 * would silently do nothing.
 *
 * `subjectKind` is pinned to `"tool"` so the consumers that only act on real
 * narrators (the narrator page's create-workspace drop zone, the workspace's
 * narrator materialisation) keep ignoring it.
 */
export function startDetachedPanelDrag(args: {
	/** The detached canvas node's id; used to remove it once it lands in a dock. */
	id: string;
	title: string;
	/**
	 * The panel kind, when the drag denotes ONE panel. Omitted when the whole node
	 * is being dragged: a node may hold several panels, so no single kind describes
	 * it. Receiving surfaces bail on a missing/unknown kind, which is what leaves
	 * whole-node drops to the canvas — the only consumer that can move every panel.
	 */
	toolKind?: string;
	resourceId?: string;
	/** Panel-local loading state, separate from the drag's resource identity. */
	largeFileConfirmed?: boolean;
	x: number;
	y: number;
}) {
	beginPointerDrag({
		id: args.id,
		title: args.title,
		x: args.x,
		y: args.y,
		...(args.toolKind ? { toolKind: args.toolKind } : {}),
		...(args.resourceId ? { resourceId: args.resourceId } : {}),
		...(args.largeFileConfirmed === true ? { largeFileConfirmed: true } : {}),
		subjectKind: "tool",
	});
}

function onDocPointerMove(e: PointerEvent) {
	// Still pending: activate only once the pointer travels past the threshold.
	if (_pending) {
		const dx = e.clientX - _pending.startX;
		const dy = e.clientY - _pending.startY;
		if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
		activatePendingDrag(e.clientX, e.clientY);
		return;
	}
	if (!_current) return;
	_current = { ..._current, x: e.clientX, y: e.clientY };
	emit();
}

function onDocPointerUp(event: PointerEvent) {
	teardownPointerListeners();
	_ownsPointer = false;
	// Released before crossing the threshold → this was a click, not a drag.
	// Drop the pending drag silently so the native click can proceed.
	if (_pending) {
		_pending = null;
		_current = null;
		return;
	}
	document.body.style.userSelect = "";
	document.body.style.cursor = "";
	// The release can cross a group/zone boundary without a final pointermove.
	const final = _current ? { ..._current, x: event.clientX, y: event.clientY } : null;
	_current = null;
	for (const fn of _endListeners) fn(final);
}

// ── Entry point 2: @dnd-kit managed drag (no document listeners) ──

export function startDragManual(id: string, title: string, x: number, y: number) {
	_current = { id, title, x, y };
	_ownsPointer = false;
	emit();
}

export function moveDrag(x: number, y: number) {
	if (!_current) return;
	_current = { ..._current, x, y };
	emit();
}

/**
 * Cancel without committing a drop. Live drags notify end listeners with null;
 * pending pointer drags are discarded silently. Repeated cancellation is a no-op.
 * Manual drags need no document, while pointer drags also release their listeners
 * and cursor styles. State is cleared before notifying consumers.
 */
export function cancelDrag(): void {
	const wasActive = _current !== null;
	if (_ownsPointer) {
		teardownPointerListeners();
		document.body.style.userSelect = "";
		document.body.style.cursor = "";
	}
	_pending = null;
	_current = null;
	_ownsPointer = false;
	if (wasActive) {
		for (const fn of _endListeners) fn(null);
	}
}

export function endDrag(): PanelDragState | null {
	if (_ownsPointer) return null; // let document listener handle it
	const final = _current;
	_current = null;
	for (const fn of _endListeners) fn(final);
	return final;
}

// ── Shared ──

function emit() {
	if (!_current) return;
	for (const fn of _moveListeners) fn(_current);
}

export function onPanelDragMove(fn: MoveListener): () => void {
	_moveListeners.add(fn);
	return () => _moveListeners.delete(fn);
}

export function onPanelDragEnd(fn: EndListener): () => void {
	_endListeners.add(fn);
	return () => _endListeners.delete(fn);
}
