import { useLayoutEffect, useRef } from "react";
import { ExactRow, type ExactRowProps } from "./ExactRow";
import {
	buildWindowRowElementFrame,
	type WindowRowElementFrame,
	type WindowRowProjection,
} from "./vlist-window-row-reuse";

function createExactRowElement(key: string, props: ExactRowProps) {
	return <ExactRow key={key} {...props} />;
}

/** A disposable optimization: props remain the sole source of rendered content. */
export function useVListWindowRows(owner: string, rows: readonly WindowRowProjection[]) {
	const committed = useRef<WindowRowElementFrame | null>(null);
	const frame = buildWindowRowElementFrame(committed.current, owner, rows, createExactRowElement);
	// A speculative/suspended render must not publish its cache or evict the rows
	// still on screen. No React state updates, DOM reads, or geometry writes here.
	useLayoutEffect(() => {
		committed.current = frame;
	}, [frame]);
	return frame.elements;
}
