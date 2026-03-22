import { useVirtualizer } from "@tanstack/react-virtual";
import { forwardRef, memo, type ReactNode, useImperativeHandle } from "react";

/** Gap between virtual items (matches the previous Stack gap="sm" = 12px) */
const ITEM_GAP = 12;

export interface VirtualMessageListHandle {
	/** Scroll to a specific element index */
	scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" }) => void;
	/** Get the virtualizer's total size */
	getTotalSize: () => number;
	/** Find the index of an element by its key */
	findIndexByKey: (key: string) => number;
}

interface VirtualMessageListProps {
	/** Flat array of rendered message elements */
	elements: ReactNode[];
	/** Stable keys for each element (must match elements.length) */
	elementKeys: string[];
	/** The scroll container element ref (Mantine ScrollArea viewport) */
	scrollElementRef: React.RefObject<HTMLDivElement | null>;
	/** Ref to the content wrapper for SelectionPopover etc. */
	contentRef: React.RefObject<HTMLDivElement | null>;
	/** Trailing content rendered after the virtual list (StreamingBubble, streaming chunks) */
	trailing?: ReactNode;
	/** Padding applied inside the scroll container */
	paddingY?: number;
}

export const VirtualMessageList = memo(
	forwardRef<VirtualMessageListHandle, VirtualMessageListProps>(function VirtualMessageList(
		{ elements, elementKeys, scrollElementRef, contentRef, trailing, paddingY = 0 },
		ref,
	) {
		const virtualizer = useVirtualizer({
			count: elements.length,
			getScrollElement: () => scrollElementRef.current,
			estimateSize: () => 100,
			overscan: 8,
			gap: ITEM_GAP,
			// Use paddingStart/paddingEnd to account for the py="sm" on ScrollArea
			paddingStart: paddingY,
			paddingEnd: paddingY,
		});

		// Expose imperative methods
		useImperativeHandle(
			ref,
			() => ({
				scrollToIndex: (index, options) => {
					virtualizer.scrollToIndex(index, options);
				},
				getTotalSize: () => virtualizer.getTotalSize(),
				findIndexByKey: (key: string) => elementKeys.indexOf(key),
			}),
			[virtualizer, elementKeys],
		);

		const virtualItems = virtualizer.getVirtualItems();

		return (
			<div ref={contentRef} style={{ paddingBottom: paddingY || undefined }}>
				<div
					style={{
						height: virtualizer.getTotalSize(),
						width: "100%",
						position: "relative",
					}}
				>
					{virtualItems.map((virtualItem) => (
						<div
							key={elementKeys[virtualItem.index] ?? virtualItem.index}
							data-index={virtualItem.index}
							ref={virtualizer.measureElement}
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								transform: `translateY(${virtualItem.start}px)`,
							}}
						>
							{elements[virtualItem.index]}
						</div>
					))}
				</div>
				{trailing}
			</div>
		);
	}),
);
