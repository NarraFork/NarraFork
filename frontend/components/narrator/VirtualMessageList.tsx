import {
	forwardRef,
	memo,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

/** Gap between virtual items — matches the previous Stack gap="sm" = 12px */
const ITEM_GAP = 12;

/** Pixels of extra content to render above/below the visible viewport */
const BUFFER_PX = 400;

/** Default estimated height for items that haven't been measured yet */
const DEFAULT_ITEM_SIZE = 80;

export interface VirtualMessageListHandle {
	/** Scroll to a specific element index */
	scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" }) => void;
	/** Get current scroll size (total content height) */
	getTotalSize: () => number;
	/** Find the index of an element by its key */
	findIndexByKey: (key: string) => number;
	/** Get current scroll offset (0 = at bottom in column-reverse) */
	readonly scrollOffset: number;
	/** Get current viewport size */
	readonly viewportSize: number;
}

interface VirtualMessageListProps {
	/** Flat array of rendered message elements (oldest first, newest last) */
	elements: ReactNode[];
	/** Stable keys for each element (must match elements.length) */
	elementKeys: string[];
	/**
	 * Ref to the scroll container (Mantine ScrollArea viewport).
	 * The container MUST have `flex-direction: column-reverse` and `overflow-y: auto`.
	 */
	scrollRef: RefObject<HTMLElement | null>;
	/** Ref to the content wrapper for SelectionPopover etc. */
	contentRef: RefObject<HTMLDivElement | null>;
	/**
	 * When true, maintain scroll position from the bottom when items are
	 * prepended (loading older messages). In column-reverse, prepended items
	 * appear at the visual top — this flag adjusts scrollTop to compensate.
	 */
	shift?: boolean;
	/** Callback invoked on every scroll offset change */
	onScroll?: (offset: number) => void;
	/** Callback invoked when scrolling stops */
	onScrollEnd?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Binary search: find the index of the first item whose cumulative bottom
 * edge is > offset. i.e. the item that contains `offset` in its range.
 */
function findIndexAtOffset(offsets: Float64Array, offset: number, count: number): number {
	let lo = 0;
	let hi = count - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		if (offsets[mid] <= offset) {
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return lo;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const VirtualMessageList = memo(
	forwardRef<VirtualMessageListHandle, VirtualMessageListProps>(function VirtualMessageList(
		{ elements, elementKeys, scrollRef, contentRef, shift, onScroll, onScrollEnd },
		ref,
	) {
		// ---- Sizing state (stored in refs for perf — no React re-render on scroll) ----
		const itemCount = elements.length;

		// Per-item measured heights. -1 = not yet measured.
		const sizesRef = useRef<Float64Array>(new Float64Array(0));
		// Cumulative offsets: offsets[i] = sum of sizes[0..i] (bottom edge of item i).
		// Items are laid out from index 0 (oldest, visual top) to last (newest, visual bottom).
		const offsetsRef = useRef<Float64Array>(new Float64Array(0));
		const totalSizeRef = useRef(0);
		const viewportSizeRef = useRef(0);

		// Visible range
		const [visibleRange, setVisibleRange] = useState<[number, number]>([0, 0]);

		// ResizeObserver for items
		const itemObserverRef = useRef<ResizeObserver | null>(null);
		const itemElMapRef = useRef(new Map<Element, number>()); // element → index

		// Track previous item count for shift adjustment
		const prevItemCountRef = useRef(0);
		const shiftRef = useRef(shift);
		shiftRef.current = shift;

		// Pending shift correction: after prepend, we adjust scrollTop by an
		// estimated height. Once the new items are actually measured by the
		// ResizeObserver, we correct the drift.
		const pendingShiftCorrectionRef = useRef<{
			count: number;
			estimatedHeight: number;
		} | null>(null);

		// ---- Ensure size arrays match item count ----
		const ensureArrays = useCallback((count: number) => {
			const sizes = sizesRef.current;
			if (sizes.length >= count) return;
			const newSizes = new Float64Array(count);
			newSizes.set(sizes);
			// Fill new entries with -1 (unmeasured)
			for (let i = sizes.length; i < count; i++) {
				newSizes[i] = -1;
			}
			sizesRef.current = newSizes;
			const newOffsets = new Float64Array(count);
			newOffsets.set(offsetsRef.current);
			offsetsRef.current = newOffsets;
		}, []);

		// ---- Recompute cumulative offsets from sizes ----
		const recomputeOffsets = useCallback(() => {
			const sizes = sizesRef.current;
			const offsets = offsetsRef.current;
			const count = Math.min(sizes.length, offsets.length);
			let cum = 0;
			for (let i = 0; i < count; i++) {
				const s = sizes[i] < 0 ? DEFAULT_ITEM_SIZE : sizes[i];
				cum += s;
				offsets[i] = cum;
			}
			totalSizeRef.current = cum;
		}, []);

		// ---- Compute visible range from scroll position ----
		const computeRange = useCallback(() => {
			const scroller = scrollRef.current;
			if (!scroller) return;

			const count = elements.length;
			if (count === 0) {
				setVisibleRange([0, 0]);
				return;
			}

			ensureArrays(count);
			recomputeOffsets();

			const total = totalSizeRef.current;
			const vpSize = scroller.clientHeight;
			viewportSizeRef.current = vpSize;

			// In column-reverse: scrollTop=0 means at bottom (newest).
			// scrollTop increases as user scrolls up (toward older messages).
			const st = scroller.scrollTop;

			// The visible window in the "normal" coordinate system (0 = oldest at top):
			// visibleBottom = total - st
			// visibleTop = total - st - vpSize
			const visibleBottom = total - st;
			const visibleTop = visibleBottom - vpSize;

			const rangeTop = Math.max(0, visibleTop - BUFFER_PX);
			const rangeBottom = Math.min(total, visibleBottom + BUFFER_PX);

			const offsets = offsetsRef.current;
			const startIdx = Math.max(0, findIndexAtOffset(offsets, rangeTop, count));
			const endIdx = Math.min(count - 1, findIndexAtOffset(offsets, rangeBottom, count));

			setVisibleRange((prev) => {
				if (prev[0] === startIdx && prev[1] === endIdx) return prev;
				return [startIdx, endIdx];
			});
		}, [elements.length, scrollRef, ensureArrays, recomputeOffsets]);

		// ---- Handle item size changes from ResizeObserver ----
		// Store the resize handler in a ref so the ResizeObserver (created once)
		// always calls the latest version without needing to be recreated.
		const computeRangeRef = useRef(computeRange);
		computeRangeRef.current = computeRange;

		// ---- Setup ResizeObserver (stable — created once, never recreated) ----
		// biome-ignore lint/correctness/useExhaustiveDependencies: scrollRef is a stable RefObject — we intentionally read .current inside the callback, not as a reactive dependency
		useLayoutEffect(() => {
			const observer = new ResizeObserver((entries) => {
				let changed = false;
				const sizes = sizesRef.current;
				for (const entry of entries) {
					const idx = itemElMapRef.current.get(entry.target);
					if (idx == null || idx >= sizes.length) continue;
					const h = entry.contentRect.height + ITEM_GAP;
					if (Math.abs(sizes[idx] - h) > 0.5) {
						sizes[idx] = h;
						changed = true;
					}
				}
				if (changed) {
					// Correct scrollTop after shift: when prepended items are first
					// measured, the estimated height used for the initial scrollTop
					// adjustment may differ from the actual height. Fix the drift.
					const correction = pendingShiftCorrectionRef.current;
					if (correction) {
						let actualHeight = 0;
						let allMeasured = true;
						for (let i = 0; i < correction.count; i++) {
							if (i < sizes.length && sizes[i] >= 0) {
								actualHeight += sizes[i];
							} else {
								allMeasured = false;
								break;
							}
						}
						if (allMeasured) {
							pendingShiftCorrectionRef.current = null;
							const drift = actualHeight - correction.estimatedHeight;
							if (Math.abs(drift) > 1) {
								const scroller = scrollRef.current;
								if (scroller) scroller.scrollTop += drift;
							}
						}
					}
					computeRangeRef.current();
				}
			});
			itemObserverRef.current = observer;
			return () => {
				observer.disconnect();
				itemObserverRef.current = null;
			};
		}, []);

		// ---- Observe/unobserve item elements ----
		const observeItem = useCallback((el: HTMLElement | null, index: number) => {
			if (!el) return;
			const observer = itemObserverRef.current;
			if (!observer) return;
			itemElMapRef.current.set(el, index);
			observer.observe(el);
		}, []);

		const unobserveItem = useCallback((el: HTMLElement | null) => {
			if (!el) return;
			const observer = itemObserverRef.current;
			if (observer) observer.unobserve(el);
			itemElMapRef.current.delete(el);
		}, []);

		// ---- Scroll event listener ----
		useLayoutEffect(() => {
			const scroller = scrollRef.current;
			if (!scroller) return;

			let scrollEndTimer = 0;
			const handleScroll = () => {
				computeRange();
				onScroll?.(scroller.scrollTop);

				// Debounced scroll-end
				if (scrollEndTimer) cancelAnimationFrame(scrollEndTimer);
				scrollEndTimer = requestAnimationFrame(() => {
					onScrollEnd?.();
				});
			};

			scroller.addEventListener("scroll", handleScroll, { passive: true });
			return () => {
				scroller.removeEventListener("scroll", handleScroll);
				if (scrollEndTimer) cancelAnimationFrame(scrollEndTimer);
			};
		}, [scrollRef, computeRange, onScroll, onScrollEnd]);

		// ---- Viewport resize ----
		useLayoutEffect(() => {
			const scroller = scrollRef.current;
			if (!scroller) return;
			const ro = new ResizeObserver(() => {
				viewportSizeRef.current = scroller.clientHeight;
				computeRange();
			});
			ro.observe(scroller);
			return () => ro.disconnect();
		}, [scrollRef, computeRange]);

		// ---- Handle item count changes (shift / prepend) ----
		useLayoutEffect(() => {
			const prevCount = prevItemCountRef.current;
			const newCount = elements.length;
			prevItemCountRef.current = newCount;

			if (prevCount === 0 || newCount <= prevCount) {
				// Initial load or items removed — just recompute
				ensureArrays(newCount);
				recomputeOffsets();
				computeRange();
				return;
			}

			const added = newCount - prevCount;
			ensureArrays(newCount);

			if (shiftRef.current) {
				// Items were prepended (older messages loaded).
				// Shift size array: move existing entries to the right by `added`.
				const sizes = sizesRef.current;
				// Copy from end to avoid overlap
				for (let i = newCount - 1; i >= added; i--) {
					sizes[i] = sizes[i - added];
				}
				// Mark new entries as unmeasured
				for (let i = 0; i < added; i++) {
					sizes[i] = -1;
				}

				// Also shift the element→index map
				const newMap = new Map<Element, number>();
				for (const [el, idx] of itemElMapRef.current) {
					newMap.set(el, idx + added);
				}
				itemElMapRef.current = newMap;

				recomputeOffsets();

				// Adjust scrollTop to compensate for prepended content.
				// The prepended items add height at the visual top (high scrollTop end).
				// We need to increase scrollTop by the estimated height of new items.
				// The ResizeObserver will later correct any drift once items are measured.
				const scroller = scrollRef.current;
				if (scroller) {
					let addedHeight = 0;
					for (let i = 0; i < added; i++) {
						addedHeight += sizes[i] < 0 ? DEFAULT_ITEM_SIZE : sizes[i];
					}
					scroller.scrollTop += addedHeight;
					// Record for post-measurement correction
					pendingShiftCorrectionRef.current = {
						count: added,
						estimatedHeight: addedHeight,
					};
				}
			} else {
				// Items appended (new messages) — no scroll adjustment needed.
				// column-reverse naturally keeps scroll at bottom.
				recomputeOffsets();
			}

			computeRange();
		}, [elements.length, scrollRef, ensureArrays, recomputeOffsets, computeRange]);

		// ---- Initial range computation ----
		useLayoutEffect(() => {
			ensureArrays(elements.length);
			recomputeOffsets();
			computeRange();
		}, [ensureArrays, recomputeOffsets, computeRange, elements.length]);

		// ---- Imperative handle ----
		useImperativeHandle(
			ref,
			() => ({
				scrollToIndex: (index, options) => {
					const scroller = scrollRef.current;
					if (!scroller) return;
					const count = elements.length;
					const clampedIdx = Math.max(0, Math.min(index, count - 1));

					ensureArrays(count);
					recomputeOffsets();

					const offsets = offsetsRef.current;
					const sizes = sizesRef.current;
					const total = totalSizeRef.current;
					const vpSize = scroller.clientHeight;

					// Item top edge in normal coords (0 = top of oldest)
					const itemTop = clampedIdx > 0 ? offsets[clampedIdx - 1] : 0;
					const itemSize = sizes[clampedIdx] < 0 ? DEFAULT_ITEM_SIZE : sizes[clampedIdx];

					// Convert to column-reverse scrollTop
					// scrollTop = total - visibleBottom
					// For align="end": visibleBottom = itemTop + itemSize → scrollTop = total - itemTop - itemSize
					// For align="start": visibleTop = itemTop → visibleBottom = itemTop + vpSize → scrollTop = total - itemTop - vpSize
					// For align="center": center the item in viewport
					const align = options?.align ?? "start";
					let targetScrollTop: number;
					if (align === "end") {
						targetScrollTop = total - itemTop - itemSize;
					} else if (align === "center") {
						const center = itemTop + itemSize / 2;
						targetScrollTop = total - center - vpSize / 2;
					} else {
						// "start"
						targetScrollTop = total - itemTop - vpSize;
					}

					scroller.scrollTop = Math.max(0, targetScrollTop);
				},
				getTotalSize: () => totalSizeRef.current,
				findIndexByKey: (key: string) => elementKeys.indexOf(key),
				get scrollOffset() {
					return scrollRef.current?.scrollTop ?? 0;
				},
				get viewportSize() {
					return viewportSizeRef.current;
				},
			}),
			[elementKeys, elements.length, scrollRef, ensureArrays, recomputeOffsets],
		);

		// ---- Cleanup observer entries on unmount ----
		useEffect(() => {
			return () => {
				itemElMapRef.current.clear();
				pendingShiftCorrectionRef.current = null;
			};
		}, []);

		// ---- Render ----
		const [startIdx, endIdx] = visibleRange;

		// Compute spacer sizes for items outside the visible range.
		// In column-reverse, the DOM order is reversed visually:
		// - First DOM child appears at visual bottom
		// - Last DOM child appears at visual top
		//
		// We render items in normal order (oldest→newest) inside a column-reverse
		// container, so the newest item (last in array) appears at visual bottom.
		//
		// Spacers:
		// - "before" spacer: height of items [0..startIdx) — appears at visual top
		// - "after" spacer: height of items (endIdx..count) — appears at visual bottom
		//
		// In column-reverse DOM order, we need:
		// - afterSpacer first (visual bottom = DOM first child)
		// - visible items in reverse order
		// - beforeSpacer last (visual top = DOM last child)

		const offsets = offsetsRef.current;
		const beforeHeight = startIdx > 0 && offsets.length > 0 ? offsets[startIdx - 1] : 0;
		const afterHeight =
			endIdx < itemCount - 1 && offsets.length >= itemCount
				? totalSizeRef.current - offsets[endIdx]
				: 0;

		// Build visible items — in column-reverse, DOM order is reversed visually,
		// so we render items from endIdx down to startIdx to get correct visual order
		// (oldest at top, newest at bottom).
		const visibleItems: ReactNode[] = [];
		for (let i = endIdx; i >= startIdx; i--) {
			visibleItems.push(
				<VirtualItem
					key={elementKeys[i] ?? i}
					index={i}
					isFirst={i === 0}
					observe={observeItem}
					unobserve={unobserveItem}
				>
					{elements[i]}
				</VirtualItem>,
			);
		}

		return (
			<div
				ref={contentRef}
				style={{
					display: "flex",
					flexDirection: "column-reverse",
					minHeight: "100%",
				}}
			>
				{/* After spacer — items below visible range (newer, visual bottom = DOM first) */}
				{afterHeight > 0 && <div style={{ height: afterHeight, flexShrink: 0 }} />}

				{/* Visible items (rendered newest→oldest in DOM = oldest→newest visually) */}
				{visibleItems}

				{/* Before spacer — items above visible range (older, visual top = DOM last) */}
				{beforeHeight > 0 && <div style={{ height: beforeHeight, flexShrink: 0 }} />}
			</div>
		);
	}),
);

// ---------------------------------------------------------------------------
// VirtualItem — wrapper that observes its own size
// ---------------------------------------------------------------------------

interface VirtualItemProps {
	index: number;
	isFirst: boolean;
	observe: (el: HTMLElement | null, index: number) => void;
	unobserve: (el: HTMLElement | null) => void;
	children: ReactNode;
}

const VirtualItem = memo(function VirtualItem({
	index,
	isFirst,
	observe,
	unobserve,
	children,
}: VirtualItemProps) {
	const elRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		observe(elRef.current, index);
		const el = elRef.current;
		return () => {
			unobserve(el);
		};
	}, [observe, unobserve, index]);

	return (
		<div
			ref={elRef}
			style={
				isFirst ? { paddingTop: ITEM_GAP, paddingBottom: ITEM_GAP } : { paddingBottom: ITEM_GAP }
			}
		>
			{children}
		</div>
	);
});
