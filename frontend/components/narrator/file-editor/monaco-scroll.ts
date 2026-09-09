import type { editor, IPosition } from "monaco-editor/editor/editor.api";

export interface MonacoVisibleBounds {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

/** Never forces visibility: hidden dock parents own this even when visible prop is true. */
export function monacoHostVisible(host: HTMLElement): boolean {
	const win = host.ownerDocument.defaultView;
	return (
		!!win &&
		host.clientWidth > 0 &&
		host.clientHeight > 0 &&
		win.getComputedStyle(host).visibility === "visible" &&
		host.getClientRects().length > 0
	);
}

export function monacoClippedBounds(host: HTMLElement): MonacoVisibleBounds {
	const rect = host.getBoundingClientRect();
	const win = host.ownerDocument.defaultView;
	const viewport = win?.visualViewport;
	const bounds = {
		top: Math.max(rect.top, viewport?.offsetTop ?? 0),
		bottom: Math.min(
			rect.bottom,
			(viewport?.offsetTop ?? 0) + (viewport?.height ?? win?.innerHeight ?? rect.bottom),
		),
		left: Math.max(rect.left, viewport?.offsetLeft ?? 0),
		right: Math.min(
			rect.right,
			(viewport?.offsetLeft ?? 0) + (viewport?.width ?? win?.innerWidth ?? rect.right),
		),
	};
	let parent = host.assignedSlot ?? host.parentElement;
	for (let depth = 0; parent && win && depth < 64; depth++) {
		const style = win.getComputedStyle(parent);
		const clipX = /^(hidden|clip|auto|scroll)$/.test(style.overflowX);
		const clipY = /^(hidden|clip|auto|scroll)$/.test(style.overflowY);
		if (clipX || clipY) {
			const parentRect = parent.getBoundingClientRect();
			const sx = parent.offsetWidth ? parentRect.width / parent.offsetWidth : 1;
			const sy = parent.offsetHeight ? parentRect.height / parent.offsetHeight : 1;
			const left = parentRect.left + parent.clientLeft * sx;
			const top = parentRect.top + parent.clientTop * sy;
			if (clipX) {
				bounds.left = Math.max(bounds.left, left);
				bounds.right = Math.min(bounds.right, left + parent.clientWidth * sx);
			}
			if (clipY) {
				bounds.top = Math.max(bounds.top, top);
				bounds.bottom = Math.min(bounds.bottom, top + parent.clientHeight * sy);
			}
		}
		const ancestor =
			parent.assignedSlot ?? parent.parentElement ?? (parent.getRootNode() as ShadowRoot).host;
		parent = ancestor instanceof HTMLElement ? ancestor : null;
	}
	return bounds;
}

/** Monaco reveal APIs only scroll its own viewport; refine for clipped dock ancestors. */
export function revealMonacoPosition(
	editor: editor.IStandaloneCodeEditor,
	host: HTMLElement,
	position: IPosition,
): boolean {
	if (!monacoHostVisible(host)) return false;
	editor.revealPositionInCenter(position, 1 /* Immediate */);
	const visible = monacoClippedBounds(host);
	const rect = host.getBoundingClientRect();
	if (visible.bottom <= visible.top || visible.right <= visible.left) return true;
	const sy = host.offsetHeight ? rect.height / host.offsetHeight : 1;
	const sx = host.offsetWidth ? rect.width / host.offsetWidth : 1;
	const geometry = editor.getScrolledVisiblePosition(position);
	if (!geometry) return false;
	const targetY = rect.top + (geometry.top + geometry.height / 2) * sy;
	editor.setScrollTop(
		editor.getScrollTop() + (targetY - (visible.top + visible.bottom) / 2) / sy,
		1,
	);
	const targetX = rect.left + geometry.left * sx;
	if (targetX < visible.left + 12)
		editor.setScrollLeft(editor.getScrollLeft() + (targetX - visible.left - 12) / sx, 1);
	else if (targetX > visible.right - 12)
		editor.setScrollLeft(editor.getScrollLeft() + (targetX - visible.right + 12) / sx, 1);
	return true;
}

/** Prevent wheel/touch bubbling to the dock without disabling Monaco's default handling. */
export function installMonacoScrollBoundary(host: HTMLElement): () => void {
	const stop = (event: Event) => event.stopPropagation();
	host.addEventListener("wheel", stop, { passive: true });
	host.addEventListener("touchmove", stop, { passive: true });
	return () => {
		host.removeEventListener("wheel", stop);
		host.removeEventListener("touchmove", stop);
	};
}
