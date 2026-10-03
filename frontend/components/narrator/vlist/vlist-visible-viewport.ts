import type { PretextDocumentView } from "./usePretextDocument";
import { getDistanceFromBottom, getScrollBottomTarget } from "./vlist-exact-scroll";

type ViewportNode = Pick<
	HTMLElement,
	"offsetWidth" | "clientHeight" | "scrollHeight" | "scrollTop"
>;
type View = Omit<PretextDocumentView, "focusOffset">;

/** display:none parking is not a zero-sized reading viewport. */
export function hasVisibleVListGeometry(node: ViewportNode | null): node is ViewportNode {
	return node != null && node.offsetWidth > 0 && node.clientHeight > 0;
}

/**
 * Keep the reader's last usable geometry while the stable chat is parked. Anchored
 * commits still advance the logical view, even though the browser cannot accept a
 * scroll write yet. Otherwise a second hidden patch would anchor on the OLD canvas.
 */
export function createVListVisibleViewport() {
	let lastView: View | null = null;
	let suspended = false;
	let correction: { top: number; kind: "bottom" | "item" } | null = null;

	return {
		isVisible(node: ViewportNode | null): node is ViewportNode {
			if (hasVisibleVListGeometry(node)) return true;
			suspended = true;
			return false;
		},
		read(node: ViewportNode | null, fallback: View, following: boolean): View {
			const visible = hasVisibleVListGeometry(node);
			if (!visible) suspended = true;
			if (visible && !suspended) {
				lastView = {
					scrollTop: node.scrollTop,
					viewportHeight: node.clientHeight,
					pinnedToBottom: getDistanceFromBottom(node) <= 1 || following,
				};
				return lastView;
			}
			return lastView ?? fallback;
		},
		/** Explicit reader intent is valid even while its DOM box is parked. */
		setPinned(pinnedToBottom: boolean) {
			if (lastView) lastView = { ...lastView, pinnedToBottom };
		},
		deferCorrection(top: number, kind: "bottom" | "item", fallback: View) {
			suspended = true;
			correction = { top: Math.max(0, top), kind };
			const view = lastView ?? fallback;
			lastView = {
				...view,
				// Bottom anchors do not use scrollTop. Retain the reader's last
				// position in case explicit intent detaches before reappearance.
				scrollTop: kind === "item" ? correction.top : view.scrollTop,
				pinnedToBottom: fallback.pinnedToBottom,
			};
		},
		recordScrollTop(top: number) {
			if (lastView) lastView = { ...lastView, scrollTop: top };
		},
		/** Called before resize preview / scroll-frame classification on reappearance. */
		resume(node: ViewportNode, pinnedToBottom: boolean, write: (top: number) => void) {
			if (!hasVisibleVListGeometry(node) || !suspended) return;
			const pending = correction;
			correction = null;
			suspended = false;
			if (!lastView && !pending) return;
			// Bottom targets must be derived from the RESTORED box, including its
			// current footer. Item corrections are already in canvas coordinates.
			const top =
				(pending?.kind === "bottom" && pinnedToBottom) || (!pending && pinnedToBottom)
					? getScrollBottomTarget(node)
					: pending?.kind === "item"
						? pending.top
						: (lastView?.scrollTop ?? 0);
			write(top);
			lastView = { scrollTop: node.scrollTop, viewportHeight: node.clientHeight, pinnedToBottom };
		},
	};
}
