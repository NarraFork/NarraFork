import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "narrafork_nav_width";
const DEFAULT_WIDTH = 250;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;

export function useResizableNav() {
	const [width, setWidth] = useState(() => {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			const n = Number(saved);
			if (n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
		}
		return DEFAULT_WIDTH;
	});

	const isDragging = useRef(false);
	const startX = useRef(0);
	const startWidth = useRef(0);
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
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
		},
		[width],
	);

	useEffect(() => {
		const onMouseMove = (e: MouseEvent) => {
			if (!isDragging.current) return;
			const delta = e.clientX - startX.current;
			const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta));
			setWidth(newWidth);
		};

		const onMouseUp = () => {
			if (!isDragging.current) return;
			isDragging.current = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			localStorage.setItem(STORAGE_KEY, String(latestWidth.current));
		};

		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
		return () => {
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
		};
	}, []);

	return { width, onDragStart };
}
