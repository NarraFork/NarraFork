/**
 * Live dockview surfaces on the story-network canvas, keyed by SURFACE id.
 *
 * Two kinds of surface register here:
 *
 *  - an expanded chapter node's dock, whose surface id IS its chapter id;
 *  - a detached panel node, whose surface id is the canvas node's id.
 *
 * Keyed by surface rather than by chapter because dockview panel ids are GLOBAL
 * (`ndock-terminal` and friends): a lookup has to name the surface it means, or it
 * would resolve a panel against the wrong api and silently act on a same-kind
 * panel elsewhere. One chapter can now own several surfaces (its dock plus any
 * number of detached nodes), so chapter id alone is no longer a key.
 *
 * Three consumers need to reach INTO a surface they do not render:
 *
 *  1. Tearing a panel out. `NarraFlow` owns the drag subscription but holds no
 *     `DockviewApi`, so it looks the source surface up here to close the panel it
 *     is about to place on the canvas. Without this the panel would be copied
 *     rather than moved.
 *  2. Identifying a native tab drag (`resolveTabDetachSubject`), which asks each
 *     candidate surface whether it holds the dragged panel id.
 *  3. A detached panel's cross-panel actions. The search panel's "jump to message"
 *     and the tasks panel's "open subagent session" are chat-side operations; a
 *     detached surface forwards them to its chapter's dock, and disables the
 *     control when that dock is no longer mounted.
 *
 * A module-level registry rather than React context because the consumers are not
 * descendants of the surface: `NarraFlow` is an ancestor, and a detached node is a
 * sibling.
 */

import type { NarratorDockContextValue } from "../../narrator/dock/NarratorDockContext";

interface Entry {
	value: NarratorDockContextValue;
	/** Chapter that owns this surface; equals `surfaceId` for a chapter dock. */
	chapterId: string;
	/** True for a detached canvas node, false for an expanded chapter's dock. */
	detached: boolean;
}

const registry = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit(): void {
	for (const fn of listeners) fn();
}

/**
 * Register a mounted surface. Returns the unregister function; callers must invoke
 * it on unmount or a collapsed node would keep advertising a dead surface (and a
 * tear-out would try to close a panel on a disposed api).
 */
function register(
	surfaceId: string,
	chapterId: string,
	value: NarratorDockContextValue,
	detached: boolean,
): () => void {
	const entry: Entry = { value, chapterId, detached };
	registry.set(surfaceId, entry);
	emit();
	return () => {
		// Only delete if we are still the current entry: a remount registers the new
		// value before the old effect's cleanup runs, and an unconditional delete
		// would drop the live surface.
		if (registry.get(surfaceId) === entry) {
			registry.delete(surfaceId);
			emit();
		}
	};
}

/** Register an expanded chapter node's dock. Its surface id is the chapter id. */
export function registerChapterDock(
	chapterId: string,
	value: NarratorDockContextValue,
): () => void {
	return register(chapterId, chapterId, value, false);
}

/** Register a detached panel node's surface. */
export function registerDetachedDock(
	nodeId: string,
	chapterId: string,
	value: NarratorDockContextValue,
): () => void {
	return register(nodeId, chapterId, value, true);
}

/** The surface for an id, or undefined when it is not mounted. */
export function getChapterDock(
	surfaceId: string | undefined,
): NarratorDockContextValue | undefined {
	if (!surfaceId) return undefined;
	return registry.get(surfaceId)?.value;
}

/** Whether a surface is currently mounted. */
export function hasChapterDock(surfaceId: string | undefined): boolean {
	return !!surfaceId && registry.has(surfaceId);
}

/**
 * Whether this surface belongs to a DETACHED canvas node rather than an expanded
 * chapter's dock.
 *
 * Load-bearing for `ChapterNodeDock.handleDropSubject`: a drag carrying a live
 * `panelId` from another CHAPTER's dock must be refused (moving it would mean
 * closing a panel on a surface we do not own), but the same drag from a detached
 * node is safe to accept, because the canvas owns that surface and can close it.
 * Without this distinction one of those two cases silently does the wrong thing.
 */
export function isDetachedSurface(surfaceId: string | undefined): boolean {
	return !!surfaceId && registry.get(surfaceId)?.detached === true;
}

/** The chapter owning a surface, or undefined when it is not mounted. */
export function getSurfaceChapterId(surfaceId: string | undefined): string | undefined {
	if (!surfaceId) return undefined;
	return registry.get(surfaceId)?.chapterId;
}

/** Ids of every mounted surface, for consumers that must scan all of them. */
export function listSurfaceIds(): string[] {
	return [...registry.keys()];
}

/**
 * Subscribe to registration changes, for `useSyncExternalStore`. A detached panel
 * uses this to re-render when its source node expands or collapses, so its
 * forwarded actions become enabled / disabled at the right moment.
 */
export function subscribeChapterDocks(cb: () => void): () => void {
	listeners.add(cb);
	return () => {
		listeners.delete(cb);
	};
}

/** Test-only reset; production code never clears the whole registry. */
export function __resetChapterDockRegistry(): void {
	registry.clear();
	listeners.clear();
}
