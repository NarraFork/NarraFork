import {
	forwardRef,
	memo,
	type ReactNode,
	type RefObject,
	useImperativeHandle,
	useRef,
} from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";

/** Gap between virtual items — matches the previous Stack gap="sm" = 12px */
const ITEM_GAP = 12;

export interface VirtualMessageListHandle {
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

interface VirtualMessageListProps {
	/** Flat array of rendered message elements */
	elements: ReactNode[];
	/** Stable keys for each element (must match elements.length) */
	elementKeys: string[];
	/**
	 * Ref to the scroll container (Mantine ScrollArea viewport).
	 * Passed as a RefObject for virtua's scrollRef prop.
	 */
	scrollRef: RefObject<HTMLElement | null>;
	/** Ref to the content wrapper for SelectionPopover etc. */
	contentRef: RefObject<HTMLDivElement | null>;
	/**
	 * When true, maintain scroll position from the end when items are
	 * prepended (e.g. loading older messages). This is virtua's built-in
	 * scroll anchoring for reverse infinite scroll.
	 */
	shift?: boolean;
	/** Callback invoked on every scroll offset change */
	onScroll?: (offset: number) => void;
	/** Callback invoked when scrolling stops */
	onScrollEnd?: () => void;
}

export const VirtualMessageList = memo(
	forwardRef<VirtualMessageListHandle, VirtualMessageListProps>(function VirtualMessageList(
		{ elements, elementKeys, scrollRef, contentRef, shift, onScroll, onScrollEnd },
		ref,
	) {
		const virtuaRef = useRef<VirtualizerHandle>(null);

		useImperativeHandle(
			ref,
			() => ({
				scrollToIndex: (index, options) => {
					virtuaRef.current?.scrollToIndex(index, {
						align: options?.align,
					});
				},
				getTotalSize: () => virtuaRef.current?.scrollSize ?? 0,
				findIndexByKey: (key: string) => elementKeys.indexOf(key),
				get scrollOffset() {
					return virtuaRef.current?.scrollOffset ?? 0;
				},
				get viewportSize() {
					return virtuaRef.current?.viewportSize ?? 0;
				},
			}),
			[elementKeys],
		);

		return (
			<div ref={contentRef}>
				<Virtualizer
					ref={virtuaRef}
					scrollRef={scrollRef}
					shift={shift}
					onScroll={onScroll}
					onScrollEnd={onScrollEnd}
				>
					{elements.map((el, i) => (
						<div key={elementKeys[i] ?? i} style={{ paddingBottom: ITEM_GAP }}>
							{el}
						</div>
					))}
				</Virtualizer>
			</div>
		);
	}),
);
