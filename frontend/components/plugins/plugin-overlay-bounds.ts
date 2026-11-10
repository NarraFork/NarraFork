/**
 * Interactive rectangles reported by `overlay` plugin views.
 *
 * The overlay layer itself is a full-viewport iframe with `pointer-events: none`,
 * because an iframe that accepts pointers swallows every click on the app beneath
 * it. A view therefore announces the one rectangle where it *does* want input (for
 * a draggable widget: the widget's own bounds), and `PluginOverlayHost` renders a
 * transparent hit region there.
 *
 * This lives outside React because the writer is the host-local router (a plain
 * function invoked by the bridge), while the reader is a component. The shape
 * mirrors `PluginContributionStore`: a module-level snapshot that only changes
 * identity when the data changes, so `useSyncExternalStore` can subscribe to it
 * without tearing.
 */

export interface PluginOverlayBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Intersect, rather than relocate, a rectangle with the layout viewport. */
export function clipOverlayBounds(
	bounds: PluginOverlayBounds,
	viewportWidth: number,
	viewportHeight: number,
): PluginOverlayBounds {
	const x = Math.min(Math.max(bounds.x, 0), viewportWidth);
	const y = Math.min(Math.max(bounds.y, 0), viewportHeight);
	return {
		x,
		y,
		width: Math.max(0, Math.min(bounds.x + bounds.width, viewportWidth) - x),
		height: Math.max(0, Math.min(bounds.y + bounds.height, viewportHeight) - y),
	};
}
export type PluginOverlayBoundsSnapshot = Readonly<Record<string, PluginOverlayBounds>>;

const EMPTY: PluginOverlayBoundsSnapshot = Object.freeze({});

let snapshot: PluginOverlayBoundsSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			// A broken subscriber must not stop the others from being notified.
		}
	}
}

function sameBounds(a: PluginOverlayBounds | undefined, b: PluginOverlayBounds): boolean {
	return (
		a !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
	);
}

export const pluginOverlayBoundsStore = {
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},

	getSnapshot(): PluginOverlayBoundsSnapshot {
		return snapshot;
	},

	/**
	 * Publish one view's rectangle. A no-op when nothing changed, which matters
	 * because a view that follows the pointer reports every frame: rebuilding the
	 * snapshot each time would re-render the overlay host sixty times a second for no
	 * reason.
	 */
	set(panelInstanceId: string, bounds: PluginOverlayBounds): void {
		if (bounds.width <= 0 || bounds.height <= 0) {
			this.clear(panelInstanceId);
			return;
		}
		if (sameBounds(snapshot[panelInstanceId], bounds)) return;
		snapshot = Object.freeze({ ...snapshot, [panelInstanceId]: Object.freeze({ ...bounds }) });
		emit();
	},

	/** Resize can invalidate bounds even when the plugin stops responding. */
	clipToViewport(viewportWidth: number, viewportHeight: number): void {
		const next: Record<string, PluginOverlayBounds> = {};
		let changed = false;
		for (const [id, bounds] of Object.entries(snapshot)) {
			const clipped = clipOverlayBounds(bounds, viewportWidth, viewportHeight);
			if (clipped.width > 0 && clipped.height > 0) next[id] = Object.freeze(clipped);
			else changed = true;
			if (!sameBounds(bounds, clipped)) changed = true;
		}
		if (!changed) return;
		snapshot = Object.freeze(next);
		emit();
	},

	/** Drop a view's rectangle when its session goes away, so the hit region disappears. */
	clear(panelInstanceId: string): void {
		if (!(panelInstanceId in snapshot)) return;
		const next = { ...snapshot };
		delete next[panelInstanceId];
		snapshot = Object.freeze(next);
		emit();
	},
};
