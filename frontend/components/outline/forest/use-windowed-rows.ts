/**
 * Draw only the rows near the viewport of a long flat list (the forest's rows of one space).
 *
 * The list lies in the document flow of whatever scrolls it (the app's page, a dock panel):
 * no scroll container of its own, so several lists share one scroller and the browser's own
 * scrolling, find-on-page position and scroll anchoring keep working. Rows have their real
 * heights (a block's text wraps, a closed row has a preview line): each drawn row is measured
 * (`ResizeObserver`), an undrawn one counts as the estimate, and the rows above and below the
 * window are two spacers.
 *
 * COST: a scroll event is one `getBoundingClientRect` and a binary search over prefix sums;
 * React renders only when the window's first or last row changes. The prefix sums are rebuilt
 * (one pass, a float per row) when rows change or measurements arrive, batched per frame.
 * The DOM holds the window plus {@link OVERSCAN_PX} on each side, whatever the list's length.
 *
 * Without layout (a test's DOM, a hidden tab) the viewport has no height: the first
 * {@link NO_LAYOUT_ROWS} rows are drawn.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export const OVERSCAN_PX = 600;
export const NO_LAYOUT_ROWS = 200;
const DEFAULT_ESTIMATE_PX = 28;

export interface WindowedRows {
	/** Rows `[start, end)` are drawn. */
	start: number;
	end: number;
	padTop: number;
	padBottom: number;
	/** Rows on screen (without the overscan); `-1, -1` before layout. */
	visibleStart: number;
	visibleEnd: number;
	/** The list's element: the spacers and the drawn rows are its children. */
	listRef: (element: HTMLElement | null) => void;
	/** Ref of a drawn row's element (it is measured while mounted). */
	rowRef: (key: string) => (element: HTMLElement | null) => void;
	/** Scroll so the row is in the middle of the viewport. */
	scrollToIndex: (index: number) => void;
}

function scrollerOf(element: HTMLElement): HTMLElement | null {
	for (let at = element.parentElement; at; at = at.parentElement) {
		const overflow = getComputedStyle(at).overflowY;
		if (overflow === "auto" || overflow === "scroll") return at;
	}
	return null;
}

/** The row at `y` pixels from the list's top (the first whose bottom is below it). */
function indexAt(sums: Float64Array, count: number, y: number): number {
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((sums[mid + 1] as number) <= y) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export function useWindowedRows(
	keys: readonly string[],
	estimatePx: number = DEFAULT_ESTIMATE_PX,
): WindowedRows {
	const heights = useRef(new Map<string, number>());
	const list = useRef<HTMLElement | null>(null);
	const [measured, bump] = useState(0);
	const [range, setRange] = useState({ start: 0, end: Math.min(keys.length, 40), vs: -1, ve: -1 });

	// biome-ignore lint/correctness/useExhaustiveDependencies: `measured` says heights changed
	const offsets = useMemo(() => {
		const out = new Float64Array(keys.length + 1);
		const known = heights.current;
		for (let i = 0; i < keys.length; i++) {
			out[i + 1] = (out[i] as number) + (known.get(keys[i] as string) ?? estimatePx);
		}
		return out;
	}, [keys, estimatePx, measured]);
	const latest = useRef({ offsets, count: keys.length });
	latest.current = { offsets, count: keys.length };

	const update = useCallback(() => {
		const element = list.current;
		const { offsets: sums, count } = latest.current;
		if (!element) return;
		const scroller = scrollerOf(element);
		const view = scroller
			? scroller.getBoundingClientRect()
			: { top: 0, height: window.innerHeight };
		const top = view.top - element.getBoundingClientRect().top;
		let next: { start: number; end: number; vs: number; ve: number };
		if (!(view.height > 0) || element.offsetParent === null) {
			next = { start: 0, end: Math.min(count, NO_LAYOUT_ROWS), vs: -1, ve: -1 };
		} else {
			const vs = indexAt(sums, count, Math.max(0, top));
			const ve = Math.min(count, indexAt(sums, count, Math.max(0, top + view.height)) + 1);
			next = {
				start: indexAt(sums, count, Math.max(0, top - OVERSCAN_PX)),
				end: Math.min(
					count,
					indexAt(sums, count, Math.max(0, top + view.height + OVERSCAN_PX)) + 1,
				),
				vs,
				ve,
			};
		}
		setRange((now) =>
			now.start === next.start && now.end === next.end && now.vs === next.vs && now.ve === next.ve
				? now
				: next,
		);
	}, []);

	// Scrolls of anything above the list (scroll events do not bubble: captured at the document),
	// and the window's size.
	useEffect(() => {
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				update();
			});
		};
		document.addEventListener("scroll", schedule, { capture: true, passive: true });
		window.addEventListener("resize", schedule);
		return () => {
			if (frame) cancelAnimationFrame(frame);
			document.removeEventListener("scroll", schedule, { capture: true });
			window.removeEventListener("resize", schedule);
		};
	}, [update]);
	// Rows changed, or were measured: the window may hold other rows now.
	// biome-ignore lint/correctness/useExhaustiveDependencies: recomputed with the prefix sums
	useLayoutEffect(update, [offsets, update]);

	const pending = useRef(0);
	const observer = useMemo(() => {
		if (typeof ResizeObserver === "undefined") return null;
		return new ResizeObserver((entries) => {
			let changed = false;
			for (const entry of entries) {
				const key = (entry.target as HTMLElement).dataset.forestKey;
				const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
				if (!key || !(height > 0)) continue;
				if (Math.abs((heights.current.get(key) ?? -1) - height) < 0.5) continue;
				heights.current.set(key, height);
				changed = true;
			}
			if (changed && !pending.current) {
				pending.current = requestAnimationFrame(() => {
					pending.current = 0;
					bump((n) => n + 1);
				});
			}
		});
	}, []);
	useEffect(
		() => () => {
			observer?.disconnect();
			if (pending.current) cancelAnimationFrame(pending.current);
		},
		[observer],
	);
	// Heights of rows that are gone are dropped once they outnumber the rows there are.
	useEffect(() => {
		if (heights.current.size <= keys.length * 2 + 1000) return;
		const live = new Set(keys);
		for (const key of [...heights.current.keys()]) if (!live.has(key)) heights.current.delete(key);
	}, [keys]);

	const refs = useRef(new Map<string, (element: HTMLElement | null) => void>());
	const elements = useRef(new Map<string, HTMLElement>());
	const rowRef = useCallback(
		(key: string) => {
			let ref = refs.current.get(key);
			if (!ref) {
				ref = (element) => {
					const was = elements.current.get(key);
					if (was && was !== element) observer?.unobserve(was);
					if (element) {
						element.dataset.forestKey = key;
						elements.current.set(key, element);
						observer?.observe(element);
					} else {
						elements.current.delete(key);
						refs.current.delete(key);
					}
				};
				refs.current.set(key, ref);
			}
			return ref;
		},
		[observer],
	);

	const listRef = useCallback(
		(element: HTMLElement | null) => {
			list.current = element;
			if (element) update();
		},
		[update],
	);

	const scrollToIndex = useCallback((index: number) => {
		const element = list.current;
		if (!element) return;
		const { offsets: sums, count } = latest.current;
		const at = Math.max(0, Math.min(count - 1, index));
		const scroller = scrollerOf(element);
		const view = scroller
			? scroller.getBoundingClientRect()
			: { top: 0, height: window.innerHeight };
		const rowTop = element.getBoundingClientRect().top + (sums[at] as number);
		const delta =
			rowTop - view.top - view.height / 2 + ((sums[at + 1] as number) - (sums[at] as number)) / 2;
		if (scroller) scroller.scrollTop += delta;
		else window.scrollBy(0, delta);
	}, []);

	const start = Math.min(range.start, keys.length);
	const end = Math.min(Math.max(range.end, start), keys.length);
	return {
		start,
		end,
		padTop: offsets[start] as number,
		padBottom: (offsets[keys.length] as number) - (offsets[end] as number),
		visibleStart: range.vs,
		visibleEnd: range.ve,
		listRef,
		rowRef,
		scrollToIndex,
	};
}
