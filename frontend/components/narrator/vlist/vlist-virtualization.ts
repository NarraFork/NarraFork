/** Compatibility boundary: pure virtualization math now lives in shared. */
export * from "@shared/pretext-layout/vlist-virtualization";

/**
 * Rows that must stay mounted even when the scroll window has moved past them.
 *
 * The exact canvas normally mounts only `[visible.start, visible.end)`. A row
 * hosting the inline message editor must NOT be unmounted while the reader
 * scrolls away — unmounting would destroy the draft text and pending attachments.
 * This returns the extra indices to mount alongside the visible window (empty in
 * the common case, so the shell pays nothing when nothing is pinned).
 *
 * Pure + DOM-free: index arithmetic only, no geometry.
 */
export function resolvePinnedRowIndices(
	visible: { start: number; end: number },
	pinned: number | null | undefined,
): number[] {
	if (pinned == null) return [];
	if (!Number.isInteger(pinned) || pinned < 0) return [];
	if (pinned >= visible.start && pinned < visible.end) return [];
	return [pinned];
}

/**
 * Collapse several independent pin requests into one duplicate-free list.
 *
 * There is more than one reason to pin a row now (the inline editor's row, the
 * touch swipe anchor's row), and they can land on the SAME index — the reader may
 * swipe the very row they are editing. Rendering that index twice would mint two
 * React children with one key, so the pins are merged here rather than spread
 * back to back.
 */
export function mergePinnedRowIndices(...groups: readonly number[][]): number[] {
	const seen = new Set<number>();
	for (const group of groups) {
		for (const index of group) seen.add(index);
	}
	return [...seen];
}
