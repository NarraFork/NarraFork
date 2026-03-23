import BidirectionalList, { type BidirectionalListRef } from "broad-infinite-list/react";
import {
	forwardRef,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";

/** Gap between items — matches the previous Stack gap="sm" = 12px */
const ITEM_GAP = 12;

// Inject styles for the broad-message-list
if (typeof document !== "undefined") {
	const id = "broad-message-list-styles";
	if (!document.getElementById(id)) {
		const style = document.createElement("style");
		style.id = id;
		style.textContent = `.broad-message-list-inner { padding: var(--mantine-spacing-md) var(--mantine-spacing-md) 0; }`;
		document.head.appendChild(style);
	}
}

export interface BroadMessageListHandle {
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

interface BroadMessageListProps {
	/** Flat array of rendered message elements (oldest first, newest last) */
	elements: ReactNode[];
	/** Stable keys for each element (must match elements.length) */
	elementKeys: string[];
	/**
	 * Ref to the scroll container. broad-infinite-list manages its own
	 * scroll container, but we expose the inner ref for external listeners.
	 * Can be a RefObject or a callback ref.
	 */
	scrollRef: RefObject<HTMLElement | null> | ((node: HTMLDivElement | null) => void);
	/** Ref to the content wrapper for SelectionPopover etc. */
	contentRef: RefObject<HTMLDivElement | null>;
	/**
	 * When true, maintain scroll position when items are prepended
	 * (loading older messages). Compensates scrollTop by the height
	 * of newly inserted content so the viewport doesn't jump.
	 */
	shift?: boolean;
}

/** Wrapper item that pairs a ReactNode with its key for broad-infinite-list */
interface VirtualItem {
	key: string;
	index: number;
	element: ReactNode;
}

// No-op load function — data loading is managed externally by TanStack Query
const NOOP_LOAD = async () => [] as VirtualItem[];

export const BroadMessageList = forwardRef<
	BroadMessageListHandle,
	BroadMessageListProps & { advancedAnim?: boolean }
>(function BroadMessageList(
	{ elements, elementKeys, scrollRef, contentRef, shift, advancedAnim },
	ref,
) {
	const listRef = useRef<BidirectionalListRef<VirtualItem>>(null);

	// Convert elements + keys into VirtualItem array for broad-infinite-list
	const items = useMemo<VirtualItem[]>(() => {
		const result: VirtualItem[] = [];
		for (let i = 0; i < elements.length; i++) {
			result.push({
				key: elementKeys[i] ?? `idx-${i}`,
				index: i,
				element: elements[i],
			});
		}
		return result;
	}, [elements, elementKeys]);

	const itemKey = useCallback((item: VirtualItem) => item.key, []);

	const renderItem = useCallback(
		(item: VirtualItem) => (
			<div
				style={{ paddingBottom: ITEM_GAP }}
				className={advancedAnim ? "blur-anim-item blur-anim-active" : undefined}
			>
				{item.element}
			</div>
		),
		[advancedAnim],
	);

	// --- Shift: preserve scroll position when older messages are prepended ---
	// broad-infinite-list doesn't have built-in prepend scroll compensation.
	// When `shift` is true and items are prepended (count grows, first key
	// changes), we snapshot scrollHeight before React commits the DOM update
	// and adjust scrollTop by the delta afterwards.
	const prevItemCountRef = useRef(0);
	const prevFirstKeyRef = useRef<string | null>(null);
	const shiftRef = useRef(shift);
	shiftRef.current = shift;

	useLayoutEffect(() => {
		const count = items.length;
		const firstKey = items[0]?.key ?? null;
		const prevCount = prevItemCountRef.current;
		const prevFirstKey = prevFirstKeyRef.current;

		prevItemCountRef.current = count;
		prevFirstKeyRef.current = firstKey;

		// Detect prepend: item count grew AND the first key changed
		if (shiftRef.current && prevCount > 0 && count > prevCount && firstKey !== prevFirstKey) {
			const scroller = listRef.current?.scrollViewRef?.current;
			if (scroller) {
				// After this layout effect, the DOM has been updated but not
				// yet painted. The new items are in the DOM, so scrollHeight
				// already includes them. We need to find the element that was
				// previously at the top and scroll to maintain its position.
				// Use scrollToKey to anchor on the previous first item.
				if (prevFirstKey) {
					listRef.current?.scrollToKey(prevFirstKey, "instant", "start");
				}
			}
		}
	}, [items]);

	// Sync the external scrollRef with broad-infinite-list's internal scroll container.
	// Intentionally has no dependency array — broad-infinite-list may mount its
	// scroll container asynchronously, so we check on every render until it appears.
	const prevScrollElRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const inner = listRef.current?.scrollViewRef?.current ?? null;
		if (inner === prevScrollElRef.current) return;
		prevScrollElRef.current = inner;
		if (typeof scrollRef === "function") {
			scrollRef(inner as HTMLDivElement | null);
		} else if (scrollRef) {
			(scrollRef as React.MutableRefObject<HTMLElement | null>).current = inner;
		}
	});

	// Expose the content wrapper ref — point to the list wrapper element
	// which contains all rendered items. This is observed by MutationObserver
	// in NarratorPanel to detect content growth and trigger auto-scroll.
	// Intentionally has no dependency array — same reason as scrollRef sync above.
	useEffect(() => {
		const inner = listRef.current?.scrollViewRef?.current;
		if (inner && contentRef) {
			// Find the list wrapper by its className
			const listWrapper = inner.querySelector(".broad-message-list-inner") as HTMLDivElement | null;
			if (listWrapper) {
				(contentRef as React.MutableRefObject<HTMLDivElement | null>).current = listWrapper;
			}
		}
	});

	// Imperative handle — compatible with VirtualMessageListHandle
	useImperativeHandle(
		ref,
		() => ({
			scrollToIndex: (index, options) => {
				const item = items[index];
				if (!item || !listRef.current) return;
				const align = options?.align ?? "start";
				listRef.current.scrollToKey(item.key, "smooth", align);
			},
			getTotalSize: () => {
				const el = listRef.current?.scrollViewRef?.current;
				return el?.scrollHeight ?? 0;
			},
			findIndexByKey: (key: string) => {
				return elementKeys.indexOf(key);
			},
			get scrollOffset() {
				const el = listRef.current?.scrollViewRef?.current;
				return el?.scrollTop ?? 0;
			},
			get viewportSize() {
				const el = listRef.current?.scrollViewRef?.current;
				return el?.clientHeight ?? 0;
			},
		}),
		[items, elementKeys],
	);

	// Apply overscroll-behavior to the scroll container after mount.
	// Intentionally has no dependency array — same reason as scrollRef sync above.
	useEffect(() => {
		const inner = listRef.current?.scrollViewRef?.current;
		if (inner) {
			inner.style.overscrollBehavior = "contain";
		}
	});

	return (
		<BidirectionalList<VirtualItem>
			ref={listRef}
			items={items}
			itemKey={itemKey}
			renderItem={renderItem}
			onLoadMore={NOOP_LOAD}
			hasPrevious={false}
			hasNext={false}
			disable
			viewCount={items.length}
			className="broad-message-list"
			listClassName="broad-message-list-inner"
		/>
	);
});
