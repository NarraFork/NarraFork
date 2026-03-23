/**
 * Global narrator drag state — enables cross-component drag from sidebar
 * recent tabs into workspace split panels.
 *
 * Two entry points:
 * 1. Icon pointerdown → startNarratorDrag (registers document pointer listeners)
 * 2. @dnd-kit DndContext callbacks → startNarratorDragManual / moveNarratorDrag / endNarratorDrag
 *    (no document listeners — @dnd-kit owns the pointer)
 */

export interface NarratorDragState {
	narratorId: string;
	title: string;
	x: number;
	y: number;
	/** When drag originates from a workspace leaf panel, this is the leaf id. */
	sourceLeafId?: string;
}

type MoveListener = (state: NarratorDragState) => void;
type EndListener = (state: NarratorDragState | null) => void;

let _current: NarratorDragState | null = null;
/** Whether the drag was started via document pointer listeners (icon drag). */
let _ownsPointer = false;
const _moveListeners = new Set<MoveListener>();
const _endListeners = new Set<EndListener>();

export function getNarratorDrag(): NarratorDragState | null {
	return _current;
}

// ── Entry point 1: icon pointerdown (registers document listeners) ──

export function startNarratorDrag(
	narratorId: string,
	title: string,
	x: number,
	y: number,
	sourceLeafId?: string,
) {
	_current = { narratorId, title, x, y, sourceLeafId };
	_ownsPointer = true;
	document.addEventListener("pointermove", onDocPointerMove, true);
	document.addEventListener("pointerup", onDocPointerUp, true);
	document.body.style.userSelect = "none";
	document.body.style.cursor = "grabbing";
	emit();
}

function onDocPointerMove(e: PointerEvent) {
	if (!_current) return;
	_current = { ..._current, x: e.clientX, y: e.clientY };
	emit();
}

function onDocPointerUp() {
	document.removeEventListener("pointermove", onDocPointerMove, true);
	document.removeEventListener("pointerup", onDocPointerUp, true);
	document.body.style.userSelect = "";
	document.body.style.cursor = "";
	_ownsPointer = false;
	const final = _current;
	_current = null;
	for (const fn of _endListeners) fn(final);
}

// ── Entry point 2: @dnd-kit managed drag (no document listeners) ──

export function startNarratorDragManual(narratorId: string, title: string, x: number, y: number) {
	_current = { narratorId, title, x, y };
	_ownsPointer = false;
	emit();
}

export function moveNarratorDrag(x: number, y: number) {
	if (!_current) return;
	_current = { ..._current, x, y };
	emit();
}

export function endNarratorDrag(): NarratorDragState | null {
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

export function onNarratorDragMove(fn: MoveListener): () => void {
	_moveListeners.add(fn);
	return () => _moveListeners.delete(fn);
}

export function onNarratorDragEnd(fn: EndListener): () => void {
	_endListeners.add(fn);
	return () => _endListeners.delete(fn);
}
