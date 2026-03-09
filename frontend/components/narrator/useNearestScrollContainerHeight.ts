import { type RefObject, useLayoutEffect, useState } from "react";

export function useNearestScrollContainerHeight(
	ref: RefObject<HTMLElement | null>,
	ratio: number,
	enabled = true,
): number | undefined {
	const [height, setHeight] = useState<number | undefined>();

	useLayoutEffect(() => {
		if (!enabled) {
			setHeight(undefined);
			return;
		}

		const node = ref.current;
		if (!node) return;

		let scrollEl: HTMLElement | null = node.parentElement;
		while (scrollEl) {
			const overflowY = getComputedStyle(scrollEl).overflowY;
			if (overflowY === "scroll" || overflowY === "auto") {
				const update = () => setHeight(scrollEl ? scrollEl.clientHeight * ratio : undefined);
				update();

				if (typeof ResizeObserver === "undefined") {
					return undefined;
				}

				const resizeObserver = new ResizeObserver(update);
				resizeObserver.observe(scrollEl);
				return () => resizeObserver.disconnect();
			}
			scrollEl = scrollEl.parentElement;
		}

		setHeight(undefined);
	}, [enabled, ratio, ref]);

	return height;
}
