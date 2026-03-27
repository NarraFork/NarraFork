import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "narrafork_nav_width";
const DEFAULT_WIDTH = 250;
const EXPANDED_MIN = 180;
const COLLAPSED_WIDTH = 60;
const COLLAPSE_THRESHOLD = 72;
const MAX_WIDTH = 480;

export function useResizableNav() {
	const [width, setWidth] = useState(() => {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			const n = Number(saved);
			if (n >= COLLAPSED_WIDTH && n <= MAX_WIDTH) return n;
		}
		return DEFAULT_WIDTH;
	});

	const collapsed = width < COLLAPSE_THRESHOLD;

	const isDragging = useRef(false);
	const startX = useRef(0);
	const startWidth = useRef(0);
	const startedCollapsed = useRef(false);
	const latestWidth = useRef(width);

	useEffect(() => {
		latestWidth.current = width;
	}, [width]);

	const onDragStart = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			isDragging.current = true;
			startX.current = e.clientX;
			startWidth.current = width;
			startedCollapsed.current = width < COLLAPSE_THRESHOLD;
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
		},
		[width],
	);

	useEffect(() => {
		const onMouseMove = (e: MouseEvent) => {
			if (!isDragging.current) return;
			const delta = e.clientX - startX.current;
			const raw = startWidth.current + delta;
			const newWidth = Math.min(MAX_WIDTH, Math.max(COLLAPSED_WIDTH, raw));
			setWidth(newWidth);
		};

		const onMouseUp = () => {
			if (!isDragging.current) return;
			isDragging.current = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			// Snap logic depends on whether drag started from collapsed state
			const w = latestWidth.current;
			let snapped: number;
			if (startedCollapsed.current) {
				// Started collapsed: any drag beyond threshold → expand to min
				snapped = w >= COLLAPSE_THRESHOLD ? Math.max(EXPANDED_MIN, w) : COLLAPSED_WIDTH;
			} else {
				// Started expanded: below expanded min → collapse
				snapped = w < EXPANDED_MIN ? COLLAPSED_WIDTH : w;
			}
			setWidth(snapped);
			localStorage.setItem(STORAGE_KEY, String(snapped));
		};

		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
		return () => {
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
		};
	}, []);

	// Remember the last expanded width so toggle can restore it
	const lastExpandedWidth = useRef(width >= COLLAPSE_THRESHOLD ? width : DEFAULT_WIDTH);

	useEffect(() => {
		if (width >= COLLAPSE_THRESHOLD) {
			lastExpandedWidth.current = width;
		}
	}, [width]);

	const toggleCollapsed = useCallback(() => {
		const next = collapsed ? lastExpandedWidth.current : COLLAPSED_WIDTH;
		setWidth(next);
		localStorage.setItem(STORAGE_KEY, String(next));
	}, [collapsed]);

	return { width, collapsed, onDragStart, toggleCollapsed };
}
