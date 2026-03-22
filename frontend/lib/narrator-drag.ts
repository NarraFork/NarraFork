/**
 * Global narrator drag state — enables cross-component drag from sidebar
 * recent tabs into workspace split panels.
 *
 * Uses pointer events on document (capture phase) so they work even when
 * @dnd-kit has captured pointer on another element.
 */

export interface NarratorDragState {
	narratorId: string;
	title: string;
	x: number;
	y: number;
}

type MoveListener = (state: NarratorDragState) => void;
type EndListener = (state: NarratorDragState | null) => void;

let _current: NarratorDragState | null = null;
const _moveListeners = new Set<MoveListener>();
const _endListeners = new Set<EndListener>();

export function getNarratorDrag(): NarratorDragState | null {
	return _current;
}

export function startNarratorDrag(narratorId: string, title: string, x: number, y: number) {
	_current = { narratorId, title, x, y };
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
	const final = _current;
	_current = null;
	for (const fn of _endListeners) fn(final);
}

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
