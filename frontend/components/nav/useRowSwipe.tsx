/**
 * Touch swipe on a sidebar row: right closes it, left opens its context menu.
 *
 * Shared by tab rows and folder headers so both feel identical. Touch has no right-click
 * (long-press is the drag gesture, and the `contextmenu` it fires is suppressed), so the
 * left swipe is the only way to reach the menu on a phone.
 *
 * Handlers belong on the INNER moving element: the outer wrapper carries dnd-kit's touch
 * listeners, and spreading both on one element would replace them.
 */

import { Group, Text } from "@mantine/core";
import { IconDots } from "@tabler/icons-react";
import { useCallback, useRef, useState } from "react";
import { clampSwipeTravel, classifySwipeRelease, SWIPE_THRESHOLD } from "./recent-tabs-logic";

export interface RowSwipeOptions {
	/** True while dnd-kit drags this row: the swipe must not fight the drag. */
	isDragging: boolean;
	/** Right swipe; omit to disable closing by swipe. */
	onClose?: () => void;
	/** Left swipe, with the release point to anchor the menu at; omit to disable. */
	onMenu?: (x: number, y: number) => void;
}

export function useRowSwipe({ isDragging, onClose, onMenu }: RowSwipeOptions) {
	const start = useRef({ x: 0, y: 0 });
	const last = useRef({ x: 0, y: 0 });
	const tracking = useRef(false);
	const locked = useRef<"horizontal" | "vertical" | null>(null);
	const touching = useRef(false);
	const [swipeX, setSwipeX] = useState(0);
	const [exiting, setExiting] = useState(false);
	const canMenu = !!onMenu;

	const onTouchStart = useCallback((e: React.TouchEvent) => {
		touching.current = true;
		tracking.current = true;
		locked.current = null;
		start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
	}, []);

	const onTouchMove = useCallback(
		(e: React.TouchEvent) => {
			if (!tracking.current || isDragging) return;
			const { clientX, clientY } = e.touches[0];
			last.current = { x: clientX, y: clientY };
			const dx = clientX - start.current.x;
			const dy = clientY - start.current.y;
			if (!locked.current) {
				if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
				locked.current = Math.abs(dy) > Math.abs(dx) ? "vertical" : "horizontal";
			}
			if (locked.current === "vertical") return;
			const travel = clampSwipeTravel(dx, canMenu);
			setSwipeX(onClose ? travel : Math.min(0, travel));
		},
		[isDragging, canMenu, onClose],
	);

	const onTouchEnd = useCallback(() => {
		// Cleared after the synthetic `contextmenu` (fired after touchend) has been seen.
		setTimeout(() => {
			touching.current = false;
		}, 0);
		const wasTracking = tracking.current;
		tracking.current = false;
		if (!wasTracking || isDragging) {
			setSwipeX(0);
			return;
		}
		const release = classifySwipeRelease(swipeX, canMenu);
		if (release === "close" && onClose) {
			setExiting(true);
			setTimeout(onClose, 200);
			return;
		}
		// Every other outcome snaps the row home; the menu opens where the finger lifted.
		setSwipeX(0);
		if (release === "menu") onMenu?.(last.current.x, last.current.y);
	}, [swipeX, isDragging, canMenu, onClose, onMenu]);

	const style: React.CSSProperties = exiting
		? {
				transform: "translateX(100%)",
				opacity: 0,
				transition: "transform 0.2s ease-out, opacity 0.2s ease-out",
			}
		: swipeX !== 0
			? { transform: `translateX(${swipeX}px)`, transition: "none" }
			: // Animate the snap-back so a released half-swipe glides home.
				{ transform: "translateX(0)", transition: "transform 0.15s ease-out" };

	return {
		handlers: { onTouchStart, onTouchMove, onTouchEnd },
		/** Style for the moving element. */
		style,
		swipeX,
		/** True right after a touch: the browser's long-press `contextmenu` must be ignored. */
		touching: () => touching.current,
	};
}

/**
 * The affordance revealed behind a row while it is swiped left. The row itself is what
 * moves, so this sits absolutely in the (clipped, `position: relative`) outer wrapper.
 */
export function SwipeMenuHint({ swipeX, label }: { swipeX: number; label: string }) {
	if (swipeX >= 0) return null;
	return (
		<Group
			gap={4}
			wrap="nowrap"
			justify="flex-end"
			pr="sm"
			style={{
				position: "absolute",
				inset: 0,
				pointerEvents: "none",
				color:
					swipeX < -SWIPE_THRESHOLD
						? "var(--mantine-color-indigo-4)"
						: "var(--mantine-color-dimmed)",
			}}
		>
			<IconDots size={16} />
			<Text size="xs">{label}</Text>
		</Group>
	);
}
