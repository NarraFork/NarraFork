/**
 * useResizableBottomSpacing — NarratorInteractionBar bottom spacing.
 *
 * Similar to useResizableNav but for vertical spacing. The drag handle sits at the
 * top edge of the interaction bar, and dragging up/down adjusts the total height
 * (input area + bottom spacing).
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "narrafork_narrator_bottom_spacing";
const DEFAULT_SPACING = 40;
const MIN_SPACING = 10; // Match var(--mantine-spacing-xs) for visual consistency
const MAX_SPACING = 200;

/**
 * Read persisted spacing, falling back to default on storage failures.
 */
function readStoredSpacing(): number {
	try {
		if (typeof localStorage === "undefined") return DEFAULT_SPACING;
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			const n = Number(saved);
			if (n >= MIN_SPACING && n <= MAX_SPACING) return n;
		}
	} catch {
		// Storage unavailable (private mode, quota, blocked): use default.
	}
	return DEFAULT_SPACING;
}

/**
 * Persist spacing, ignoring storage failures.
 */
function persist(spacing: number): void {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(STORAGE_KEY, String(spacing));
	} catch {
		// Storage unavailable: spacing still applies for this session.
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

let currentSpacing: number | null = null;
const listeners = new Set<() => void>();

function getSpacing(): number {
	if (currentSpacing === null) {
		currentSpacing = readStoredSpacing();
	}
	return currentSpacing;
}

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function writeSpacing(next: number): void {
	const previous = getSpacing();
	if (previous === next) return;
	currentSpacing = next;
	emit();
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag
// ─────────────────────────────────────────────────────────────────────────────

interface DragState {
	startY: number;
	startSpacing: number;
}

let drag: DragState | null = null;

function onMouseMove(event: MouseEvent): void {
	if (!drag) return;
	// Dragging UP (negative delta) increases spacing, DOWN decreases
	const raw = drag.startSpacing + (drag.startY - event.clientY);
	const clamped = Math.min(MAX_SPACING, Math.max(MIN_SPACING, raw));
	writeSpacing(clamped);
}

function endDrag(): void {
	if (!drag) return;
	drag = null;
	document.body.style.cursor = "";
	document.body.style.userSelect = "";
	window.removeEventListener("mousemove", onMouseMove);
	window.removeEventListener("mouseup", endDrag);
	window.removeEventListener("blur", endDrag);
	window.removeEventListener("pointercancel", endDrag);
	document.removeEventListener("visibilitychange", onVisibilityChange);

	persist(getSpacing());
}

function onVisibilityChange(): void {
	if (document.visibilityState === "hidden") endDrag();
}

/** Begin a resize drag. Stable identity. */
export function startBottomSpacingResize(event: {
	clientY: number;
	preventDefault: () => void;
}): void {
	event.preventDefault();
	drag = {
		startY: event.clientY,
		startSpacing: getSpacing(),
	};
	document.body.style.cursor = "ns-resize";
	document.body.style.userSelect = "none";
	window.addEventListener("mousemove", onMouseMove);
	window.addEventListener("mouseup", endDrag);
	window.addEventListener("blur", endDrag);
	window.addEventListener("pointercancel", endDrag);
	document.addEventListener("visibilitychange", onVisibilityChange);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The current bottom spacing in px.
 */
export function useBottomSpacing(): number {
	return useSyncExternalStore(subscribe, getSpacing, getSpacing);
}

/** Test seam: reset the module store. */
export function resetBottomSpacingStoreForTest(spacing = DEFAULT_SPACING): void {
	drag = null;
	currentSpacing = spacing;
	emit();
}

export const BOTTOM_SPACING_CONSTANTS = {
	DEFAULT_SPACING,
	MIN_SPACING,
	MAX_SPACING,
} as const;
