/**
 * How the folding controls of an outline take the pointer and the keyboard, in one place: an
 * outline plan's tree (`plan/OutlinePlanTree.tsx`), the read-only tree (`OutlineBlockTree.tsx`)
 * and the live editor's frames (`editor/view.ts`, native DOM) behave alike.
 *
 *   - A click with Ctrl, Cmd or Shift is not a toggle (a selection, a new tab); Alt is the
 *     control's own modifier (everything inside).
 *   - Enter and Space on a control are its own: their default is prevented and the key never
 *     reaches the window (where a session's permission shortcut listens), nor an editor around
 *     the control. A held key repeats: one toggle per press.
 */
import type React from "react";

interface Modifiers {
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
}

/** A modified click (Ctrl/Cmd/Shift) is not a toggle. */
export function plainClick(e: Modifiers): boolean {
	return !(e.metaKey || e.ctrlKey || e.shiftKey);
}

interface FoldKey {
	key: string;
	code: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	repeat: boolean;
	target: EventTarget | null;
	currentTarget: EventTarget | null;
	preventDefault(): void;
	stopPropagation(): void;
}

/**
 * Take Enter or Space pressed on the control itself: true when the key was the control's (it is
 * consumed), and `activate` ran unless the key was a repeat. `activate` gets Alt.
 */
export function takeFoldKey(e: FoldKey, activate: (alt: boolean) => void): boolean {
	const space = e.code === "Space" || e.key === " " || e.key === "Spacebar";
	if (e.key !== "Enter" && !space) return false;
	if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey) return false;
	e.preventDefault();
	e.stopPropagation();
	// A held key repeats: one toggle per press.
	if (!e.repeat) activate(e.altKey);
	return true;
}

/** Enter and Space on a React control: its own, never the window's. `activate` gets Alt. */
export function ownKeys(activate: (alt: boolean) => void) {
	return (e: React.KeyboardEvent) => {
		takeFoldKey(e, activate);
	};
}

/** A label without its trailing arrow (an accessible name says what, not "▸"). */
export function spokenLabel(label: string): string {
	return label.replace(/\s*[▸▾▴►]\s*$/u, "");
}
