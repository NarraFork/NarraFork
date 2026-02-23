import { useCallback, useEffect, useRef, useState } from "react";
import { getGlobalCloseSwipe, setGlobalCloseSwipe } from "../components/narrator/swipeState";

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
		setTimeout(() => setSwipeClosing(false), DEFAULT_CLOSE_DURATION);
	}, []);

	// --- Global coordination ---
	useEffect(() => {
		if (swipeRevealed) setGlobalCloseSwipe(closeSwipe);
		return () => {
			if (getGlobalCloseSwipe() === closeSwipe) setGlobalCloseSwipe(null);
		};
	}, [swipeRevealed, closeSwipe]);

	// --- Touch handlers ---
	// biome-ignore lint/correctness/useExhaustiveDependencies: ref.current is intentionally not a dependency
	useEffect(() => {
		if (!enabled) return;
		const node = swipeBoxRef.current;
		if (!node) return;

		const matchesExclude = (el: HTMLElement) => excludeSelectors.some((sel) => el.closest?.(sel));

		const onTouchStart = (e: TouchEvent) => {
			if (matchesExclude(e.target as HTMLElement)) return;
			const cur = getGlobalCloseSwipe();
			if (cur && cur !== closeSwipe) {
				cur();
				swipeRef.current = null;
				return;
			}
			if (swipeRevealed) {
				closeSwipe();
				swipeRef.current = null;
				return;
			}
			const touch = e.touches[0];
			swipeRef.current = { startX: touch.clientX, startY: touch.clientY, dir: null };
			setSwipeY(touch.clientY);
			setSwipeInitialRight(node.getBoundingClientRect().right);
		};

		const onTouchMove = (e: TouchEvent) => {
			const s = swipeRef.current;
			if (!s || swipeRevealed) return;
			const touch = e.touches[0];
			const dx = s.startX - touch.clientX;
			const dy = Math.abs(touch.clientY - s.startY);
			if (!s.dir) {
				if (Math.abs(dx) > 10 || dy > 10) s.dir = Math.abs(dx) > dy ? "h" : "v";
				return;
			}
			if (s.dir === "v") return;
			const offset = Math.max(0, Math.min(dx, swipeRevealWidth));
			swipeOffsetRef.current = offset;
			setSwipeOffset(offset);
		};

		const onTouchEnd = () => {
			const s = swipeRef.current;
			swipeRef.current = null;
			if (!s || s.dir !== "h") return;
			if (swipeOffsetRef.current >= swipeThreshold) {
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
	}, [enabled, swipeRevealed, closeSwipe, swipeThreshold, swipeRevealWidth, excludeSelectors]);

	// --- Outside-touch close ---
	// biome-ignore lint/correctness/useExhaustiveDependencies: ref.current is intentionally not a dependency
	useEffect(() => {
		if (!swipeRevealed) return;
		const onTouch = (e: TouchEvent) => {
			const tgt = e.target as Node;
			if (swipeBoxRef.current?.contains(tgt) || swipeMenuRef.current?.contains(tgt)) return;
			closeSwipe();
		};
		document.addEventListener("touchstart", onTouch, { passive: true });
		return () => document.removeEventListener("touchstart", onTouch);
	}, [swipeRevealed, closeSwipe]);

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
