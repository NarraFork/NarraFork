export interface DocumentSelection {
	anchor: number;
	focus: number;
}
export function selectionRange(selection: DocumentSelection): { start: number; end: number } {
	return {
		start: Math.min(selection.anchor, selection.focus),
		end: Math.max(selection.anchor, selection.focus),
	};
}
export function selectOffset(
	previous: DocumentSelection,
	offset: number,
	extend: boolean,
	length: number,
): DocumentSelection {
	const focus = Math.max(0, Math.min(length, offset));
	return { anchor: extend ? Math.min(length, previous.anchor) : focus, focus };
}
export function moveSelection(
	previous: DocumentSelection,
	delta: number,
	extend: boolean,
	length: number,
): DocumentSelection {
	const range = selectionRange(previous);
	if (!extend && range.start !== range.end)
		return selectOffset(previous, delta < 0 ? range.start : range.end, false, length);
	return selectOffset(previous, previous.focus + delta, extend, length);
}
export function moveSelectionOnBoundaries(
	previous: DocumentSelection,
	direction: -1 | 1,
	extend: boolean,
	length: number,
	boundaries: Iterable<number>,
): DocumentSelection | undefined {
	const range = selectionRange(previous);
	if (!extend && range.start !== range.end)
		return selectOffset(previous, direction < 0 ? range.start : range.end, false, length);
	let next: number | undefined;
	for (const offset of boundaries) {
		if (direction > 0 && offset > previous.focus && (next === undefined || offset < next))
			next = offset;
		if (direction < 0 && offset < previous.focus && (next === undefined || offset > next))
			next = offset;
	}
	return next === undefined ? undefined : selectOffset(previous, next, extend, length);
}

export function documentAutoscroll(pointer: number, top: number, height: number): number {
	const margin = Math.min(28, height / 4);
	if (pointer < top + margin) return -Math.min(36, Math.max(2, (top + margin - pointer) / 2));
	if (pointer > top + height - margin)
		return Math.min(36, Math.max(2, (pointer - top - height + margin) / 2));
	return 0;
}

/** Paint only the requested source interval; neither copy nor find consumes painted text. */
export function markedIntervals(
	start: number,
	end: number,
	selection: DocumentSelection,
	match?: { start: number; end: number } | null,
): Array<{ start: number; end: number; selected: boolean; found: boolean }> {
	const range = selectionRange(selection);
	const boundaries = [start, end, range.start, range.end, match?.start, match?.end].filter(
		(point): point is number => point !== undefined && point >= start && point <= end,
	);
	const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
	return sorted.slice(0, -1).map((point, i) => ({
		start: point,
		end: sorted[i + 1],
		selected: point >= range.start && point < range.end,
		found: !!match && point >= match.start && point < match.end,
	}));
}
