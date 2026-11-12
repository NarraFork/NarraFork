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
/**
 * What each view last asked for, before clipping.
 *
 * The snapshot only holds the clipped (applied) rectangle, so clipping it again on every
 * resize would be lossy: shrink the window and grow it back, and the hit region would
 * stay at the shrunken size until the plugin happened to report again. Keeping the
 * request lets every resize re-derive the applied rectangle from the source, including
 * restoring a region that was fully off-screen while the window was small.
 */
const requested = new Map<string, PluginOverlayBounds>();
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

function hasArea(bounds: PluginOverlayBounds): boolean {
	return bounds.width > 0 && bounds.height > 0;
}

/** Replace one entry of the applied snapshot; returns whether anything changed. */
function applyEntry(panelInstanceId: string, applied: PluginOverlayBounds): boolean {
	if (hasArea(applied)) {
		if (sameBounds(snapshot[panelInstanceId], applied)) return false;
		snapshot = Object.freeze({ ...snapshot, [panelInstanceId]: Object.freeze({ ...applied }) });
		return true;
	}
	if (!(panelInstanceId in snapshot)) return false;
	const next = { ...snapshot };
	delete next[panelInstanceId];
	snapshot = Object.freeze(next);
	return true;
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
	 * Record one view's requested rectangle and publish its viewport-clipped form.
	 *
	 * Returns the applied rectangle (what the hit region really covers). A no-op for
	 * subscribers when the applied rectangle did not change, which matters because a view
	 * that follows the pointer reports every frame: rebuilding the snapshot each time
	 * would re-render the overlay host sixty times a second for no reason.
	 *
	 * A zero-area *request* withdraws the region entirely. A non-empty request that is
	 * merely off-screen right now is remembered, so it reappears when the viewport grows.
	 */
	set(
		panelInstanceId: string,
		bounds: PluginOverlayBounds,
		viewportWidth: number,
		viewportHeight: number,
	): PluginOverlayBounds {
		const applied = clipOverlayBounds(bounds, viewportWidth, viewportHeight);
		if (!hasArea(bounds)) {
			this.clear(panelInstanceId);
			return applied;
		}
		requested.set(panelInstanceId, Object.freeze({ ...bounds }));
		if (applyEntry(panelInstanceId, applied)) emit();
		return applied;
	},

	/** Re-derive every applied rectangle from its request; one notification at most. */
	clipToViewport(viewportWidth: number, viewportHeight: number): void {
		let changed = false;
		for (const [id, bounds] of requested) {
			if (applyEntry(id, clipOverlayBounds(bounds, viewportWidth, viewportHeight))) {
				changed = true;
			}
		}
		if (changed) emit();
	},

	/** Drop a view's rectangle when its session goes away, so the hit region disappears. */
	clear(panelInstanceId: string): void {
		requested.delete(panelInstanceId);
		if (applyEntry(panelInstanceId, { x: 0, y: 0, width: 0, height: 0 })) emit();
	},
};
