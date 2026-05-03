import {
	forwardRef,
	type ReactNode,
	type RefObject,
	startTransition,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { RenderLodCtx } from "./RenderLodCtx";

/** Gap between items — matches the previous Stack gap="sm" = 12px */
const ITEM_GAP = 12;

/**
 * Fixed-height sentinel divs placed above and below all content.
 * Keeps scrollTop away from 0 / scrollHeight so the browser never enters
 * native overscroll / pull-to-refresh / rubber-band state.
 *
 * This value is **constant** — changing it at runtime would shift
 * scrollHeight and trigger scroll events, creating feedback loops.
 */
export const SLIDING_WINDOW_SENTINEL = 1500;
const SENTINEL = SLIDING_WINDOW_SENTINEL;

export function getSlidingWindowScrollBounds(scroller: HTMLElement) {
	const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
	const lower = Math.min(SENTINEL, maxScroll);
	const upper = Math.max(lower, maxScroll - SENTINEL);
	return { lower, upper };
}

export function getSlidingWindowScrollBottom(scroller: HTMLElement) {
	return getSlidingWindowScrollBounds(scroller).upper;
}

export function getSlidingWindowDistanceFromBottom(scroller: HTMLElement) {
	return getSlidingWindowScrollBottom(scroller) - scroller.scrollTop;
}

// ---------------------------------------------------------------------------
// Scroll velocity tracking
// ---------------------------------------------------------------------------

/** Speed thresholds (px/ms). Above FAST, overscan shrinks to minimum. */
const VELOCITY_FAST = 3;
/** Below this, treat as idle — use full overscan. */
const VELOCITY_SLOW = 0.5;
/** Minimum overscan used during fast scrolling. */
const MIN_OVERSCAN = 8;
/** How long (ms) after last scroll event to consider scrolling "settled". */
const SETTLE_DELAY = 120;
/** Extra lightweight preview elements kept around the full-render window. */
const DEFAULT_SHELL_OVERSCAN = 160;

// ---------------------------------------------------------------------------
// Public handle — drop-in replacement for BroadMessageListHandle
// ---------------------------------------------------------------------------

export interface SlidingWindowListHandle {
	/** Scroll to a specific element index */
	scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" }) => void;
	/** Get current scroll size (total content height) */
	getTotalSize: () => number;
	/** Find the index of an element by its key */
	findIndexByKey: (key: string) => number;
	/** Get current scroll offset */
	readonly scrollOffset: number;
	/** Get current viewport size */
	readonly viewportSize: number;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SlidingWindowListProps {
	/** Flat array of rendered message elements (oldest first, newest last) */
	elements: ReactNode[];
	/** Stable keys for each element (must match elements.length) */
	elementKeys: string[];
	/**
	 * Ref to the scroll container.
	 * Can be a RefObject or a callback ref.
	 */
	scrollRef: RefObject<HTMLElement | null> | ((node: HTMLDivElement | null) => void);
	/** Ref to the content wrapper for SelectionPopover / MutationObserver etc. */
	contentRef: RefObject<HTMLDivElement | null>;
	/**
	 * When true, maintain scroll position when items are prepended
	 * (loading older messages). Compensates scrollTop by the height
	 * of newly inserted content so the viewport doesn't jump.
	 */
	shift?: boolean;
	/** Maximum number of items rendered in the DOM at once. Default 96. */
	windowSize?: number;
	/** Extra items rendered above/below the visible area. Default 20. */
	overscan?: number;
	/** Extra lightweight preview elements kept around the full-render window. Default 160. */
	shellOverscan?: number;
	/** Estimated height (px) for items that haven't been measured yet. Default 80. */
	estimatedItemHeight?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sum heights for a range of keys, using cache or estimate. */
function sumHeights(
	keys: string[],
	start: number,
	end: number,
	cache: Map<string, number>,
	estimate: number,
	gap: number,
): number {
	let total = 0;
	for (let i = start; i < end; i++) {
		total += (cache.get(keys[i]) ?? estimate) + gap;
	}
	return total;
}

/**
 * Given scrollTop, viewport height, and per-item heights, compute the visible
 * window range [start, end) with overscan applied.
 */
function computeWindow(
	scrollTop: number,
	viewportHeight: number,
	keys: string[],
	cache: Map<string, number>,
	estimate: number,
	gap: number,
	overscan: number,
	maxWindow: number,
): [number, number] {
	const count = keys.length;
	if (count === 0) return [0, 0];

	// If everything fits in the window, render all
	if (count <= maxWindow) return [0, count];

	// Find the first visible item by accumulating heights
	let accumulated = 0;
	let firstVisible = 0;
	for (let i = 0; i < count; i++) {
		const h = (cache.get(keys[i]) ?? estimate) + gap;
		if (accumulated + h > scrollTop) {
			firstVisible = i;
			break;
		}
		accumulated += h;
		if (i === count - 1) firstVisible = count - 1;
	}

	// Find the last visible item
	let lastVisible = firstVisible;
	let visibleAccum = accumulated; // top of firstVisible
	for (let i = firstVisible; i < count; i++) {
		lastVisible = i;
		visibleAccum += (cache.get(keys[i]) ?? estimate) + gap;
		if (visibleAccum >= scrollTop + viewportHeight) break;
	}

	// Apply overscan
	let start = Math.max(0, firstVisible - overscan);
	let end = Math.min(count, lastVisible + 1 + overscan);

	// Clamp to maxWindow
	if (end - start > maxWindow) {
		// Keep the window centered around the visible area
		const center = Math.floor((firstVisible + lastVisible) / 2);
		const half = Math.floor(maxWindow / 2);
		start = Math.max(0, center - half);
		end = Math.min(count, start + maxWindow);
		if (end === count) start = Math.max(0, end - maxWindow);
	}

	return [start, end];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SlidingWindowList = forwardRef<SlidingWindowListHandle, SlidingWindowListProps>(
	function SlidingWindowList(
		{
			elements,
			elementKeys,
			scrollRef,
			contentRef,
			shift,
			windowSize = 96,
			overscan = 20,
			shellOverscan = DEFAULT_SHELL_OVERSCAN,
			estimatedItemHeight = 80,
		},
		ref,
	) {
		const scrollerRef = useRef<HTMLDivElement>(null);
		const contentWrapperRef = useRef<HTMLDivElement>(null);
		const heightCacheRef = useRef(new Map<string, number>());
		const resizeObserverRef = useRef<ResizeObserver | null>(null);
		const observedElementsRef = useRef(new Set<Element>());

		// Window state: [start, end) indices into elements array.
		// This is internal state — changes here only re-render SlidingWindowList,
		// NOT the parent (NarratorPanel). React does not propagate child state
		// changes upward.
		const [winStart, setWinStart] = useState(0);
		const [winEnd, setWinEnd] = useState(() => Math.min(elements.length, windowSize));
		const [measurementVersion, setMeasurementVersion] = useState(0);
		const lastRequestedWindowRef = useRef<[number, number]>([
			0,
			Math.min(elements.length, windowSize),
		]);

		// Track whether we're in a programmatic scroll (to avoid re-triggering window recalc)
		const isProgrammaticScrollRef = useRef(false);

		// Refs for shift (prepend compensation)
		const prevItemCountRef = useRef(0);
		const prevFirstKeyRef = useRef<string | null>(null);
		const shiftRef = useRef(shift);
		shiftRef.current = shift;

		// Pending scrollToIndex request (set before window adjustment, executed after render)
		const pendingScrollRef = useRef<{
			index: number;
			align: "start" | "center" | "end";
		} | null>(null);

		// -----------------------------------------------------------------------
		// Recalculate window based on current scroll position
		// -----------------------------------------------------------------------

		const commitWindow = useCallback(
			(newStart: number, newEnd: number, mode: "sync" | "transition") => {
				const last = lastRequestedWindowRef.current;
				if (last[0] === newStart && last[1] === newEnd) return;
				lastRequestedWindowRef.current = [newStart, newEnd];

				const apply = () => {
					setWinStart((prev) => (prev !== newStart ? newStart : prev));
					setWinEnd((prev) => (prev !== newEnd ? newEnd : prev));
				};

				if (mode === "transition") {
					startTransition(apply);
				} else {
					apply();
				}
			},
			[],
		);

		const recalcWindow = useCallback(
			(effectiveOverscan?: number, mode: "sync" | "transition" = "sync") => {
				const scroller = scrollerRef.current;
				if (!scroller) return;

				// Subtract sentinel — items start after the top sentinel
				const adjustedScrollTop = Math.max(0, scroller.scrollTop - SENTINEL);

				const [newStart, newEnd] = computeWindow(
					adjustedScrollTop,
					scroller.clientHeight,
					elementKeys,
					heightCacheRef.current,
					estimatedItemHeight,
					ITEM_GAP,
					effectiveOverscan ?? overscan,
					windowSize,
				);

				commitWindow(newStart, newEnd, mode);
			},
			[elementKeys, estimatedItemHeight, overscan, windowSize, commitWindow],
		);

		// -----------------------------------------------------------------------
		// Velocity-aware scroll handler
		// -----------------------------------------------------------------------

		const rafIdRef = useRef(0);
		const settleTimerRef = useRef(0);
		const lastScrollTopRef = useRef(0);
		const lastScrollTimeRef = useRef(0);

		const handleScroll = useCallback(() => {
			if (isProgrammaticScrollRef.current) return;

			const scroller = scrollerRef.current;
			if (!scroller) return;

			// Clamp scrollTop so it never truly touches the sentinel edges.
			// This prevents the browser from entering overscroll state. If the
			// content is shorter than both sentinels plus the viewport, collapse the
			// safe range to a single value instead of bouncing between edges.
			const { lower, upper } = getSlidingWindowScrollBounds(scroller);
			if (scroller.scrollTop < lower) {
				scroller.scrollTop = lower;
				return; // the assignment fires another scroll event — handle it there
			}
			if (scroller.scrollTop > upper) {
				scroller.scrollTop = upper;
				return;
			}

			const now = performance.now();
			const dt = now - lastScrollTimeRef.current;
			const dy = Math.abs(scroller.scrollTop - lastScrollTopRef.current);
			lastScrollTopRef.current = scroller.scrollTop;
			lastScrollTimeRef.current = now;

			// Compute velocity (px/ms). Guard against dt=0.
			const velocity = dt > 0 ? dy / dt : 0;

			// Map velocity to effective overscan:
			//   >= FAST  → MIN_OVERSCAN
			//   <= SLOW  → full overscan
			//   between  → linear interpolation
			let effectiveOverscan: number;
			if (velocity >= VELOCITY_FAST) {
				effectiveOverscan = MIN_OVERSCAN;
			} else if (velocity <= VELOCITY_SLOW) {
				effectiveOverscan = overscan;
			} else {
				const t = (velocity - VELOCITY_SLOW) / (VELOCITY_FAST - VELOCITY_SLOW);
				effectiveOverscan = Math.round(overscan - t * (overscan - MIN_OVERSCAN));
			}

			cancelAnimationFrame(rafIdRef.current);
			rafIdRef.current = requestAnimationFrame(() => recalcWindow(effectiveOverscan, "transition"));

			// Schedule a "settled" recalc with full overscan after scrolling stops
			clearTimeout(settleTimerRef.current);
			settleTimerRef.current = window.setTimeout(() => {
				recalcWindow(overscan, "transition");
			}, SETTLE_DELAY);
		}, [recalcWindow, overscan]);

		// -----------------------------------------------------------------------
		// ResizeObserver — measure item heights
		// -----------------------------------------------------------------------

		const setupResizeObserver = useCallback(() => {
			if (resizeObserverRef.current) return;

			resizeObserverRef.current = new ResizeObserver((entries) => {
				const cache = heightCacheRef.current;
				let changed = false;

				for (const entry of entries) {
					const el = entry.target as HTMLElement;
					const key = el.dataset.swlKey;
					if (!key) continue;

					const height = el.offsetHeight;
					if (cache.get(key) !== height) {
						cache.set(key, height);
						changed = true;
					}
				}

				// Height changes affect placeholder sizing. Bump a dedicated version so
				// React performs a real re-render even when the visible window is unchanged.
				if (changed) {
					queueMicrotask(() => setMeasurementVersion((version) => version + 1));
				}
			});
		}, []);

		// -----------------------------------------------------------------------
		// Observe/unobserve rendered items
		// -----------------------------------------------------------------------

		const observeItems = useCallback(() => {
			const wrapper = contentWrapperRef.current;
			const ro = resizeObserverRef.current;
			if (!wrapper || !ro) return;

			const currentItems = wrapper.querySelectorAll<HTMLElement>("[data-swl-key]");
			const nextObserved = new Set<Element>();

			for (const el of currentItems) {
				nextObserved.add(el);
				if (!observedElementsRef.current.has(el)) {
					ro.observe(el);
				}
			}

			// Unobserve items that left the window
			for (const el of observedElementsRef.current) {
				if (!nextObserved.has(el)) {
					ro.unobserve(el);
				}
			}

			observedElementsRef.current = nextObserved;
		}, []);

		// -----------------------------------------------------------------------
		// Sync external scrollRef
		// -----------------------------------------------------------------------

		useEffect(() => {
			const node = scrollerRef.current;
			if (typeof scrollRef === "function") {
				scrollRef(node);
			} else if (scrollRef) {
				(scrollRef as React.MutableRefObject<HTMLElement | null>).current = node;
			}
			return () => {
				if (typeof scrollRef === "function") {
					scrollRef(null);
				} else if (scrollRef) {
					(scrollRef as React.MutableRefObject<HTMLElement | null>).current = null;
				}
			};
		}, [scrollRef]);

		// Sync external contentRef
		useEffect(() => {
			const node = contentWrapperRef.current;
			if (contentRef) {
				(contentRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
			}
		}, [contentRef]);

		// -----------------------------------------------------------------------
		// Mount / unmount
		// -----------------------------------------------------------------------

		useEffect(() => {
			setupResizeObserver();
			const scroller = scrollerRef.current;
			if (scroller) {
				// Not passive — we need to synchronously clamp scrollTop at sentinel edges
				scroller.addEventListener("scroll", handleScroll);
				// Ensure we don't start at the true top (behind the sentinel)
				const { lower, upper } = getSlidingWindowScrollBounds(scroller);
				if (scroller.scrollTop < lower) {
					scroller.scrollTop = lower;
				} else if (scroller.scrollTop > upper) {
					scroller.scrollTop = upper;
				}
			}
			return () => {
				cancelAnimationFrame(rafIdRef.current);
				clearTimeout(settleTimerRef.current);
				if (scroller) {
					scroller.removeEventListener("scroll", handleScroll);
				}
				if (resizeObserverRef.current) {
					resizeObserverRef.current.disconnect();
					resizeObserverRef.current = null;
				}
				observedElementsRef.current.clear();
			};
		}, [setupResizeObserver, handleScroll]);

		// -----------------------------------------------------------------------
		// When elements change, adjust window
		// -----------------------------------------------------------------------

		useEffect(() => {
			const count = elements.length;
			const clampedEnd = Math.min(lastRequestedWindowRef.current[1], count);
			if (lastRequestedWindowRef.current[1] !== clampedEnd) {
				lastRequestedWindowRef.current = [lastRequestedWindowRef.current[0], clampedEnd];
			}
			// If the window end exceeds the new count, clamp it
			setWinEnd((prev) => Math.min(prev, count));
			// If all items fit, show all
			if (count <= windowSize) {
				commitWindow(0, count, "sync");
			} else {
				// Recalculate based on current scroll position
				recalcWindow(undefined, "sync");
			}
		}, [elements.length, windowSize, recalcWindow, commitWindow]);

		// -----------------------------------------------------------------------
		// After render: observe new items + handle pending scrollToIndex
		// -----------------------------------------------------------------------

		useEffect(() => {
			observeItems();
		});

		// Handle pending scrollToIndex after the window has been adjusted and rendered
		useLayoutEffect(() => {
			const pending = pendingScrollRef.current;
			if (!pending) return;
			pendingScrollRef.current = null;

			const scroller = scrollerRef.current;
			if (!scroller) return;

			const cache = heightCacheRef.current;
			const { index, align } = pending;

			// Calculate target scroll position by summing heights (offset by sentinel)
			let targetTop =
				SENTINEL + sumHeights(elementKeys, 0, index, cache, estimatedItemHeight, ITEM_GAP);

			const itemHeight = cache.get(elementKeys[index]) ?? estimatedItemHeight;
			const vpHeight = scroller.clientHeight;

			if (align === "center") {
				targetTop = targetTop - vpHeight / 2 + itemHeight / 2;
			} else if (align === "end") {
				targetTop = targetTop - vpHeight + itemHeight + ITEM_GAP;
			}

			const { lower, upper } = getSlidingWindowScrollBounds(scroller);
			targetTop = Math.max(lower, Math.min(targetTop, upper));

			isProgrammaticScrollRef.current = true;
			scroller.scrollTo({ top: targetTop, behavior: "smooth" });

			// Release the programmatic scroll flag after scrolling settles
			const releaseFlag = () => {
				isProgrammaticScrollRef.current = false;
				scroller.removeEventListener("scrollend", releaseFlag);
			};
			scroller.addEventListener("scrollend", releaseFlag, { once: true });
			// Fallback timeout in case scrollend doesn't fire (e.g. already at position)
			setTimeout(() => {
				isProgrammaticScrollRef.current = false;
				scroller.removeEventListener("scrollend", releaseFlag);
			}, 500);
		});

		// -----------------------------------------------------------------------
		// Shift: preserve scroll position when items are prepended
		// -----------------------------------------------------------------------

		useLayoutEffect(() => {
			const count = elements.length;
			const firstKey = elementKeys[0] ?? null;
			const prevCount = prevItemCountRef.current;
			const prevFirstKey = prevFirstKeyRef.current;

			prevItemCountRef.current = count;
			prevFirstKeyRef.current = firstKey;

			// Detect prepend: item count grew AND the first key changed
			if (shiftRef.current && prevCount > 0 && count > prevCount && firstKey !== prevFirstKey) {
				const scroller = scrollerRef.current;
				if (!scroller) return;

				// The new items have been added to the DOM. We need to compensate
				// scrollTop by the height of the prepended items so the viewport
				// doesn't jump.
				const prependedCount = count - prevCount;
				const prependedHeight = sumHeights(
					elementKeys,
					0,
					prependedCount,
					heightCacheRef.current,
					estimatedItemHeight,
					ITEM_GAP,
				);

				scroller.scrollTop += prependedHeight;
			}
		}, [elements.length, elementKeys, estimatedItemHeight]);

		// -----------------------------------------------------------------------
		// Imperative handle
		// -----------------------------------------------------------------------

		useImperativeHandle(
			ref,
			() => ({
				scrollToIndex: (index, options) => {
					if (index < 0 || index >= elements.length) return;
					const align = options?.align ?? "start";

					// If the target is within the current window, scroll directly
					if (index >= winStart && index < winEnd) {
						const scroller = scrollerRef.current;
						if (!scroller) return;

						const cache = heightCacheRef.current;
						let targetTop =
							SENTINEL + sumHeights(elementKeys, 0, index, cache, estimatedItemHeight, ITEM_GAP);
						const itemHeight = cache.get(elementKeys[index]) ?? estimatedItemHeight;
						const vpHeight = scroller.clientHeight;

						if (align === "center") {
							targetTop = targetTop - vpHeight / 2 + itemHeight / 2;
						} else if (align === "end") {
							targetTop = targetTop - vpHeight + itemHeight + ITEM_GAP;
						}

						const { lower, upper } = getSlidingWindowScrollBounds(scroller);
						targetTop = Math.max(lower, Math.min(targetTop, upper));

						isProgrammaticScrollRef.current = true;
						scroller.scrollTo({ top: targetTop, behavior: "smooth" });

						const releaseFlag = () => {
							isProgrammaticScrollRef.current = false;
							scroller.removeEventListener("scrollend", releaseFlag);
						};
						scroller.addEventListener("scrollend", releaseFlag, { once: true });
						setTimeout(() => {
							isProgrammaticScrollRef.current = false;
							scroller.removeEventListener("scrollend", releaseFlag);
						}, 500);
						return;
					}

					// Target is outside the window — adjust window first, then scroll
					// after the next render.
					pendingScrollRef.current = { index, align };

					const half = Math.floor(windowSize / 2);
					const newStart = Math.max(0, index - half);
					const newEnd = Math.min(elements.length, newStart + windowSize);
					commitWindow(newStart, newEnd, "sync");
				},

				getTotalSize: () => {
					return scrollerRef.current?.scrollHeight ?? 0;
				},

				findIndexByKey: (key: string) => {
					return elementKeys.indexOf(key);
				},

				get scrollOffset() {
					return scrollerRef.current?.scrollTop ?? 0;
				},

				get viewportSize() {
					return scrollerRef.current?.clientHeight ?? 0;
				},
			}),
			[
				elements.length,
				elementKeys,
				winStart,
				winEnd,
				estimatedItemHeight,
				windowSize,
				commitWindow,
			],
		);

		// -----------------------------------------------------------------------
		// Compute LOD preview window + far-field placeholder heights
		// -----------------------------------------------------------------------

		const shellStart = Math.max(0, winStart - shellOverscan);
		const shellEnd = Math.min(elementKeys.length, winEnd + shellOverscan);

		const topPlaceholderHeight = useMemo(() => {
			void measurementVersion;
			return sumHeights(
				elementKeys,
				0,
				shellStart,
				heightCacheRef.current,
				estimatedItemHeight,
				ITEM_GAP,
			);
		}, [elementKeys, shellStart, estimatedItemHeight, measurementVersion]);

		const bottomPlaceholderHeight = useMemo(() => {
			void measurementVersion;
			return sumHeights(
				elementKeys,
				shellEnd,
				elementKeys.length,
				heightCacheRef.current,
				estimatedItemHeight,
				ITEM_GAP,
			);
		}, [elementKeys, shellEnd, estimatedItemHeight, measurementVersion]);

		// -----------------------------------------------------------------------
		// Build the rendered slice
		// -----------------------------------------------------------------------

		const renderedSlice = useMemo(() => {
			void measurementVersion;
			const slice: ReactNode[] = [];
			for (let i = shellStart; i < shellEnd && i < elements.length; i++) {
				const key = elementKeys[i] ?? `idx-${i}`;
				const isFull = i >= winStart && i < winEnd;
				slice.push(
					<div
						key={key}
						data-swl-key={isFull ? key : undefined}
						data-swl-lod={isFull ? "full" : "preview"}
						style={{
							paddingBottom: ITEM_GAP,
							...(isFull
								? undefined
								: {
										contentVisibility: "auto",
										containIntrinsicSize: `${
											heightCacheRef.current.get(key) ?? estimatedItemHeight
										}px`,
										pointerEvents: "none",
										userSelect: "none",
										opacity: 0.82,
									}),
						}}
					>
						<RenderLodCtx.Provider value={isFull ? "full" : "preview"}>
							{elements[i]}
						</RenderLodCtx.Provider>
					</div>,
				);
			}
			return slice;
		}, [
			elements,
			elementKeys,
			winStart,
			winEnd,
			shellStart,
			shellEnd,
			estimatedItemHeight,
			measurementVersion,
		]);

		// -----------------------------------------------------------------------
		// Render
		// -----------------------------------------------------------------------

		return (
			<div
				ref={scrollerRef}
				className="sliding-window-list"
				style={{
					height: "100%",
					overflow: "auto",
					overflowX: "hidden",
					overscrollBehavior: "contain",
				}}
			>
				<div
					ref={contentWrapperRef}
					className="sliding-window-list-inner"
					style={{
						padding: "var(--mantine-spacing-md) var(--mantine-spacing-md) 0",
					}}
				>
					{/* Top sentinel — prevents scrollTop from reaching 0 */}
					<div style={{ height: SENTINEL }} aria-hidden />
					{topPlaceholderHeight > 0 && <div style={{ height: topPlaceholderHeight }} aria-hidden />}
					{renderedSlice}
					{bottomPlaceholderHeight > 0 && (
						<div style={{ height: bottomPlaceholderHeight }} aria-hidden />
					)}
					{/* Bottom sentinel — prevents scrollTop from reaching scrollHeight */}
					<div style={{ height: SENTINEL }} aria-hidden />
				</div>
			</div>
		);
	},
);
