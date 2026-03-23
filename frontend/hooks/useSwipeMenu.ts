import { useCallback, useEffect, useRef, useState } from "react";
import {
	getGlobalCloseSwipe,
	getGlobalOnSelectionRange,
	getGlobalSwipeAnchor,
	setGlobalCloseSwipe,
	setGlobalSwipeAnchor,
} from "../components/narrator/swipeState";

const DEFAULT_THRESHOLD = 60;
const DEFAULT_REVEAL_WIDTH = 180;
const DEFAULT_CLOSE_DURATION = 220;

interface UseSwipeMenuOptions {
	/** Whether swipe/context-menu interactions are enabled. */
	enabled: boolean;
	/** Minimum swipe distance to reveal the menu. Default: 60 */
	swipeThreshold?: number;
	/** Width of the revealed menu area. Default: 180 */
	swipeRevealWidth?: number;
	/** CSS selectors — touch events originating from matching elements are ignored. */
	excludeSelectors?: string[];
	/** Optional external ref for the swipe target element. If provided, the hook uses it instead of creating its own. */
	externalBoxRef?: React.RefObject<HTMLDivElement | null>;
	/**
	 * Stable block ID for this swipeable element.
	 * Used for multi-select: when a second swipe occurs while one is already
	 * revealed, the system selects all blocks between the anchor and this block.
	 */
	blockId?: string;
	/** Called when a right-swipe gesture completes (e.g. to deselect a selected block). */
	onSwipeRight?: () => void;
}

export interface SwipeMenuState {
	// Refs
	swipeBoxRef: React.RefObject<HTMLDivElement | null>;
	swipeMenuRef: React.RefObject<HTMLDivElement | null>;

	// Swipe state
	swipeOffset: number;
	swipeRevealed: boolean;
	swipeClosing: boolean;
	closeSwipe: () => void;

	// Context menu state
	ctxMenuOpened: boolean;
	setCtxMenuOpened: (v: boolean) => void;
	ctxMenuPos: { x: number; y: number; flipY: boolean };
	setCtxMenuPos: (pos: { x: number; y: number; flipY: boolean }) => void;
	handleContextMenu: (e: React.MouseEvent) => void;

	// Computed styles
	swipeStyle: React.CSSProperties;
	swipeTransition: string;
	swipeMenuTransition: string;

	/** Compute the fixed-position {left, top} for the swipe-revealed menu. */
	getSwipeMenuPosition: (menuHeight?: number) => { left: number; top: number };
}

export function useSwipeMenu(opts: UseSwipeMenuOptions): SwipeMenuState {
	const {
		enabled,
		swipeThreshold = DEFAULT_THRESHOLD,
		swipeRevealWidth = DEFAULT_REVEAL_WIDTH,
		excludeSelectors = ["[data-content-block]", ".mantine-Menu-dropdown"],
		externalBoxRef,
		blockId,
		onSwipeRight,
	} = opts;

	const internalBoxRef = useRef<HTMLDivElement>(null);
	const swipeBoxRef = externalBoxRef ?? internalBoxRef;
	const swipeMenuRef = useRef<HTMLDivElement>(null);
	const [swipeOffset, setSwipeOffset] = useState(0);
	const swipeOffsetRef = useRef(0);
	const [swipeRevealed, setSwipeRevealed] = useState(false);
	const [swipeClosing, setSwipeClosing] = useState(false);
	const [swipeY, setSwipeY] = useState(0);
	const [swipeInitialRight, setSwipeInitialRight] = useState(0);
	const swipeRef = useRef<{
		startX: number;
		startY: number;
		dir: "h" | "v" | null;
		/** True when another block's swipe was already open at touchstart. */
		rangeCandidate: boolean;
		/** Raw dx (startX - clientX) at last touchmove. Positive = left, negative = right. */
		lastDx: number;
	} | null>(null);
	const [ctxMenuOpened, setCtxMenuOpened] = useState(false);
	const [ctxMenuPos, setCtxMenuPos] = useState({ x: 0, y: 0, flipY: false });

	// --- Close ---
	const closeSwipe = useCallback(() => {
		setSwipeClosing(true);
		swipeOffsetRef.current = 0;
		setSwipeOffset(0);
		setSwipeRevealed(false);
		setGlobalCloseSwipe(null);
		// Clear anchor when the swipe that set it is closed
		if (blockId && getGlobalSwipeAnchor() === blockId) {
			setGlobalSwipeAnchor(null);
		}
		setTimeout(() => setSwipeClosing(false), DEFAULT_CLOSE_DURATION);
	}, [blockId]);

	// --- Global coordination ---
	useEffect(() => {
		if (swipeRevealed) {
			setGlobalCloseSwipe(closeSwipe);
			// Record this block as the anchor for potential multi-select
			if (blockId) {
				setGlobalSwipeAnchor(blockId);
			}
		}
		return () => {
			if (getGlobalCloseSwipe() === closeSwipe) setGlobalCloseSwipe(null);
		};
	}, [swipeRevealed, closeSwipe, blockId]);

	// --- Touch handlers ---
	// biome-ignore lint/correctness/useExhaustiveDependencies: ref.current is intentionally not a dependency
	useEffect(() => {
		if (!enabled) return;
		const node = swipeBoxRef.current;
		if (!node) return;

		const matchesExclude = (el: HTMLElement) => excludeSelectors.some((sel) => el.closest?.(sel));

		const onTouchStart = (e: TouchEvent) => {
			if (matchesExclude(e.target as HTMLElement)) return;

			// Don't initiate swipe when text is selected — let the user interact
			// with the native selection handles / copy menu instead.
			const sel = window.getSelection();
			if (sel && sel.toString().trim().length > 0) return;

			const curClose = getGlobalCloseSwipe();
			const curAnchor = getGlobalSwipeAnchor();

			// Another block's swipe is already open — this *might* be a range-select,
			// but we don't know yet. Record the touch start and let onTouchMove
			// determine whether it's a horizontal swipe or a vertical scroll.
			if (curClose && curClose !== closeSwipe) {
				if (blockId && curAnchor && curAnchor !== blockId) {
					const touch = e.touches[0];
					swipeRef.current = {
						startX: touch.clientX,
						startY: touch.clientY,
						dir: null,
						rangeCandidate: true,
						lastDx: 0,
					};
					setSwipeY(touch.clientY);
					setSwipeInitialRight(node.getBoundingClientRect().right);
					return;
				}
				// Same block or no blockId — just ignore (let user scroll)
				swipeRef.current = null;
				return;
			}

			if (swipeRevealed) {
				// Already revealed — allow right-swipe to close the menu.
				const touch = e.touches[0];
				swipeRef.current = {
					startX: touch.clientX,
					startY: touch.clientY,
					dir: null,
					rangeCandidate: false,
					lastDx: 0,
				};
				return;
			}

			const touch = e.touches[0];
			swipeRef.current = {
				startX: touch.clientX,
				startY: touch.clientY,
				dir: null,
				rangeCandidate: false,
				lastDx: 0,
			};
			setSwipeY(touch.clientY);
			setSwipeInitialRight(node.getBoundingClientRect().right);
		};

		const onTouchMove = (e: TouchEvent) => {
			const s = swipeRef.current;
			if (!s) return;

			const touch = e.touches[0];
			const dx = s.startX - touch.clientX;
			const dy = Math.abs(touch.clientY - s.startY);

			if (!s.dir) {
				if (Math.abs(dx) > 10 || dy > 10) {
					s.dir = Math.abs(dx) > dy ? "h" : "v";
				}
				return;
			}
			if (s.dir === "v") return;

			s.lastDx = dx;

			if (swipeRevealed && !s.rangeCandidate) {
				// Already open — right-swipe (dx < 0) to close
				// Map dx from [0 .. -swipeRevealWidth] to offset [swipeRevealWidth .. 0]
				const offset = Math.max(0, Math.min(swipeRevealWidth + dx, swipeRevealWidth));
				swipeOffsetRef.current = offset;
				setSwipeOffset(offset);
				return;
			}

			// Horizontal swipe detected — track offset (left-swipe only, dx > 0)
			const offset = Math.max(0, Math.min(dx, swipeRevealWidth));
			swipeOffsetRef.current = offset;
			setSwipeOffset(offset);
		};

		const onTouchEnd = () => {
			const s = swipeRef.current;
			swipeRef.current = null;
			if (!s || s.dir !== "h") return;

			const didSwipe = swipeOffsetRef.current >= swipeThreshold;

			// Range-select: user completed a horizontal swipe on a different block
			// while another block's swipe was already open.
			if (s.rangeCandidate && didSwipe) {
				const curAnchor = getGlobalSwipeAnchor();
				const curClose = getGlobalCloseSwipe();
				if (blockId && curAnchor && curAnchor !== blockId) {
					const onRange = getGlobalOnSelectionRange();
					if (onRange) {
						onRange(curAnchor, blockId);
					}
					// Close the anchor's swipe menu
					if (curClose) curClose();
				}
				// Reset our own offset (we don't reveal our own menu)
				swipeOffsetRef.current = 0;
				setSwipeOffset(0);
				return;
			}

			// Right-swipe to close: was revealed, now offset dropped below threshold
			if (swipeRevealed && !didSwipe) {
				closeSwipe();
				return;
			}

			// Right-swipe but not enough — snap back to fully open
			if (swipeRevealed && didSwipe) {
				swipeOffsetRef.current = swipeRevealWidth;
				setSwipeOffset(swipeRevealWidth);
				return;
			}

			// Right-swipe callback (e.g. deselect a selected block)
			if (!swipeRevealed && onSwipeRight && s.lastDx < -swipeThreshold) {
				onSwipeRight();
				swipeOffsetRef.current = 0;
				setSwipeOffset(0);
				return;
			}

			// Normal swipe on this block
			if (didSwipe) {
				swipeOffsetRef.current = swipeRevealWidth;
				setSwipeOffset(swipeRevealWidth);
				setSwipeRevealed(true);
			} else {
				swipeOffsetRef.current = 0;
				setSwipeOffset(0);
				setSwipeRevealed(false);
			}
		};

		node.addEventListener("touchstart", onTouchStart, { passive: true });
		node.addEventListener("touchmove", onTouchMove, { passive: true });
		node.addEventListener("touchend", onTouchEnd, { passive: true });
		return () => {
			node.removeEventListener("touchstart", onTouchStart);
			node.removeEventListener("touchmove", onTouchMove);
			node.removeEventListener("touchend", onTouchEnd);
		};
	}, [
		enabled,
		swipeRevealed,
		closeSwipe,
		swipeThreshold,
		swipeRevealWidth,
		excludeSelectors,
		blockId,
		onSwipeRight,
	]);

	// --- Outside-touch close ---
	// REMOVED: We no longer auto-close on outside touch. The swipe stays open
	// so the user can scroll freely and swipe a second block for range selection.
	// The swipe is closed only by:
	// 1. Clicking a menu action item (explicit closeSwipe() calls in ContentViewer/ToolCallCard)
	// 2. Exiting selection mode (via the floating toolbar)

	// --- Context menu ---
	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			if (!enabled) return;
			const el = e.target as HTMLElement;
			if (excludeSelectors.some((sel) => el.closest?.(sel))) return;
			const sel = window.getSelection();
			if (sel && sel.toString().trim().length > 0) return;
			e.preventDefault();
			e.stopPropagation();
			const x = Math.min(e.clientX, window.innerWidth - 200);
			const flipY = e.clientY > window.innerHeight - 300;
			setCtxMenuPos({ x, y: e.clientY, flipY });
			setCtxMenuOpened(true);
		},
		[enabled, excludeSelectors],
	);

	// --- Computed ---
	const isSwiping = !!swipeRef.current;
	const swipeTransition = isSwiping ? "none" : "transform 200ms ease";
	const swipeMenuTransition = isSwiping ? "none" : "left 200ms ease, transform 200ms ease";

	const swipeStyle: React.CSSProperties =
		swipeOffset > 0
			? { transform: `translateX(-${swipeOffset}px)`, transition: swipeTransition }
			: { transition: swipeTransition };

	// biome-ignore lint/correctness/useExhaustiveDependencies: ref.current is intentionally not a dependency
	const getSwipeMenuPosition = useCallback(
		(menuHeight = 120) => {
			const menuLeft = swipeInitialRight - swipeOffset;
			const boxRect = swipeBoxRef.current?.getBoundingClientRect();
			let menuTop = swipeY;
			if (boxRect && boxRect.height > menuHeight) {
				const minTop = boxRect.top + menuHeight / 2;
				const maxTop = boxRect.bottom - menuHeight / 2;
				menuTop = Math.max(minTop, Math.min(swipeY, maxTop));
			}
			// Clamp to viewport so the menu never overflows off-screen
			const half = menuHeight / 2;
			menuTop = Math.max(half, Math.min(menuTop, window.innerHeight - half));
			return { left: menuLeft, top: menuTop };
		},
		[swipeInitialRight, swipeOffset, swipeY],
	);

	return {
		swipeBoxRef,
		swipeMenuRef,
		swipeOffset,
		swipeRevealed,
		swipeClosing,
		closeSwipe,
		ctxMenuOpened,
		setCtxMenuOpened,
		ctxMenuPos,
		setCtxMenuPos,
		handleContextMenu,
		swipeStyle,
		swipeTransition,
		swipeMenuTransition,
		getSwipeMenuPosition,
	};
}
