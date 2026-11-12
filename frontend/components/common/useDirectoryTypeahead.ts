/**
 * Keyboard cursor + type-ahead for a flat list of directories.
 *
 * The list is not a combobox: rows are ordinary buttons inside a Modal, so nothing
 * focuses them for you. This hook turns the enclosing element into the keyboard
 * surface — arrows move the highlight, typing jumps it to the first directory whose
 * name starts with what was typed, Enter asks the caller what that row means.
 *
 * It deliberately never moves focus: the surrounding Modal owns focus, and an inline
 * path box may legitimately hold it. Keys typed into an editable element are ignored.
 */

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { isEditableTarget, isTypeaheadCharacter, typeaheadStep } from "./directory-typeahead";

/** How long a typed prefix survives without another keystroke. */
const TYPEAHEAD_RESET_MS = 700;

export interface DirectoryTypeaheadResult {
	/** Highlighted row, or `-1` for "no cursor yet". */
	cursorIndex: number;
	/** Attach to the element wrapping the rows; rows must carry `data-dir-index`. */
	onKeyDown: (event: React.KeyboardEvent) => void;
	containerRef: RefObject<HTMLDivElement | null>;
	/** Clicking a row can adopt it as the cursor, so typing continues from there. */
	setCursorIndex: (index: number) => void;
}

export function useDirectoryTypeahead({
	names,
	onActivate,
	resetKey,
}: {
	/** Directory names in display order. */
	names: readonly string[];
	/** What Enter does to the row at that index. */
	onActivate?: (index: number) => void;
	/** Browsing somewhere else (a new path) clears both cursor and prefix. */
	resetKey?: unknown;
}): DirectoryTypeaheadResult {
	const [cursorIndex, setCursorState] = useState(-1);
	const prefixRef = useRef("");
	const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);

	const clearPrefix = useCallback(() => {
		if (resetTimerRef.current !== null) {
			clearTimeout(resetTimerRef.current);
			resetTimerRef.current = null;
		}
		prefixRef.current = "";
	}, []);

	const setCursorIndex = useCallback((index: number) => {
		setCursorState(index);
	}, []);

	// Another directory is a different list: an old prefix or an old row index would
	// point at entries the user is no longer looking at.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the signal itself — only its identity change matters
	useEffect(() => {
		setCursorState(-1);
		clearPrefix();
	}, [resetKey, clearPrefix]);

	useEffect(() => clearPrefix, [clearPrefix]);

	// Entries can shrink under the cursor (refresh, hidden toggle, shorter listing).
	useEffect(() => {
		setCursorState((current) => (current >= names.length ? names.length - 1 : current));
	}, [names.length]);

	// The highlight has to be visible: the row may be far down a scrolled listing.
	useEffect(() => {
		if (cursorIndex < 0) return;
		const row = containerRef.current?.querySelector<HTMLElement>(
			`[data-dir-index="${cursorIndex}"]`,
		);
		row?.scrollIntoView?.({ block: "nearest" });
	}, [cursorIndex]);

	const move = useCallback(
		(next: number) => {
			if (names.length === 0) return;
			setCursorState(((next % names.length) + names.length) % names.length);
		},
		[names.length],
	);

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (isEditableTarget(event.target as EventTarget | null)) return;
			switch (event.key) {
				case "ArrowDown":
					event.preventDefault();
					move(cursorIndex + 1);
					return;
				case "ArrowUp":
					event.preventDefault();
					move(cursorIndex - 1);
					return;
				case "Home":
					event.preventDefault();
					move(0);
					return;
				case "End":
					event.preventDefault();
					move(names.length - 1);
					return;
				case "Enter":
					// Suppress the focused row's own click: `onActivate` is the one
					// definition of what Enter means here, so Enter cannot act twice.
					if (cursorIndex >= 0 && onActivate) {
						event.preventDefault();
						onActivate(cursorIndex);
					}
					return;
				default:
					break;
			}
			if (!isTypeaheadCharacter(event)) return;
			const step = typeaheadStep({
				names,
				buffer: prefixRef.current,
				char: event.key,
				cursor: cursorIndex,
			});
			prefixRef.current = step.buffer;
			if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
			resetTimerRef.current = setTimeout(() => {
				prefixRef.current = "";
				resetTimerRef.current = null;
			}, TYPEAHEAD_RESET_MS);
			if (step.index < 0) return;
			event.preventDefault();
			setCursorState(step.index);
		},
		[cursorIndex, move, names, onActivate],
	);

	return { cursorIndex, onKeyDown, containerRef, setCursorIndex };
}
