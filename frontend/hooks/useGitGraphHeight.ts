import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { GitTarget } from "../lib/api/git";
import { gitTargetKey } from "../lib/api/git";

/**
 * Persisted height (px) of the Git panel commit-graph body.
 *
 * Keyed by workspace like the collapse flag: two worktrees can prefer
 * different chart depths without fighting. Stored as a number map in
 * localStorage — durable layout chrome, not ephemeral scroll position.
 */
export const GIT_GRAPH_HEIGHT_KEY = "narrafork_git_graph_height";

export const GIT_GRAPH_HEIGHT_DEFAULT = 240;
export const GIT_GRAPH_HEIGHT_MIN = 120;
export const GIT_GRAPH_HEIGHT_MAX = 560;

export type GitGraphHeightPrefs = Record<string, number>;

export function clampGitGraphHeight(value: number): number {
	if (!Number.isFinite(value)) return GIT_GRAPH_HEIGHT_DEFAULT;
	return Math.min(GIT_GRAPH_HEIGHT_MAX, Math.max(GIT_GRAPH_HEIGHT_MIN, Math.round(value)));
}

function parseHeightPrefs(raw: string | null): GitGraphHeightPrefs {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const result: GitGraphHeightPrefs = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === "number" && Number.isFinite(value)) {
			result[key] = clampGitGraphHeight(value);
		}
	}
	return result;
}

function readHeight(prefs: GitGraphHeightPrefs, key: string): number {
	const stored = prefs[key];
	return stored == null ? GIT_GRAPH_HEIGHT_DEFAULT : clampGitGraphHeight(stored);
}

const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

function notify() {
	for (const listener of listeners) listener();
}

let cachedRaw: string | null = null;
let cachedPrefs: GitGraphHeightPrefs = parseHeightPrefs(null);
let cacheInitialized = false;

function readRaw(): string | null {
	try {
		return localStorage.getItem(GIT_GRAPH_HEIGHT_KEY);
	} catch {
		return null;
	}
}

function getSnapshot() {
	const raw = readRaw();
	if (!cacheInitialized || raw !== cachedRaw) {
		cachedRaw = raw;
		cachedPrefs = parseHeightPrefs(raw);
		cacheInitialized = true;
	}
	return cachedPrefs;
}

const EMPTY_PREFS = parseHeightPrefs(null);
function getServerSnapshot() {
	return EMPTY_PREFS;
}

function persist(next: GitGraphHeightPrefs) {
	try {
		localStorage.setItem(GIT_GRAPH_HEIGHT_KEY, JSON.stringify(next));
	} catch {
		// Height is optional chrome; blocked storage must not break the panel.
	}
	notify();
}

/** Test hook: forget the memoized parse so a stubbed storage is re-read. */
export function __resetGitGraphHeightCache() {
	cachedRaw = null;
	cachedPrefs = parseHeightPrefs(null);
	cacheInitialized = false;
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		listeners.clear();
		__resetGitGraphHeightCache();
	});
}

export function useGitGraphHeight(target: GitTarget | null | undefined): {
	height: number;
	setHeight: (value: number) => void;
} {
	const workspaceKey = gitTargetKey(target) ?? "";
	const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	const height = useMemo(
		() => (workspaceKey ? readHeight(prefs, workspaceKey) : GIT_GRAPH_HEIGHT_DEFAULT),
		[prefs, workspaceKey],
	);
	const setHeight = useCallback(
		(value: number) => {
			if (!workspaceKey) return;
			const clamped = clampGitGraphHeight(value);
			const snapshot = getSnapshot();
			if (readHeight(snapshot, workspaceKey) === clamped) return;
			persist({ ...snapshot, [workspaceKey]: clamped });
		},
		[workspaceKey],
	);
	return { height, setHeight };
}

type DragState = {
	workspaceKey: string;
	startY: number;
	startHeight: number;
	pointerId: number;
	setHeight: (value: number) => void;
	/**
	 * Ceiling imposed by the HOST, below the global max.
	 *
	 * Without it a drag keeps accepting input past the height the panel can
	 * actually show: the handle follows the cursor, the chart does not grow, and
	 * the stored preference ends up describing a size the user never saw.
	 */
	maxHeight: number;
};

let drag: DragState | null = null;

function onPointerMove(event: PointerEvent): void {
	if (!drag || event.pointerId !== drag.pointerId) return;
	// Dragging the handle UP grows the chart (content is below the handle).
	const raw = drag.startHeight + (drag.startY - event.clientY);
	drag.setHeight(Math.min(clampGitGraphHeight(raw), drag.maxHeight));
}

function removeDragListeners(): void {
	if (typeof window !== "undefined") {
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", endDrag);
		window.removeEventListener("pointercancel", endDrag);
		window.removeEventListener("blur", onWindowBlur);
	}
	if (typeof document !== "undefined") {
		document.removeEventListener("visibilitychange", onVisibilityChange);
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
	}
}

function endDrag(event?: PointerEvent): void {
	if (!drag || (event && event.pointerId !== drag.pointerId)) return;
	drag = null;
	removeDragListeners();
}

function onVisibilityChange(): void {
	if (document.visibilityState === "hidden") endDrag();
}

function onWindowBlur(): void {
	endDrag();
}

/**
 * Start a vertical resize drag for the graph body.
 * `setHeight` should come from {@link useGitGraphHeight} for the same target.
 *
 * `maxHeight` is the caller's host-imposed ceiling (measured from the flex
 * parent); omit it to allow the global maximum.
 */
export function startGitGraphHeightResize(
	event: {
		clientY: number;
		pointerId: number;
		preventDefault: () => void;
	},
	opts: {
		workspaceKey: string;
		startHeight: number;
		setHeight: (value: number) => void;
		maxHeight?: number;
	},
): void {
	event.preventDefault();
	if (!opts.workspaceKey) return;
	if (drag) endDrag();
	const maxHeight = Math.max(
		GIT_GRAPH_HEIGHT_MIN,
		Math.min(GIT_GRAPH_HEIGHT_MAX, opts.maxHeight ?? GIT_GRAPH_HEIGHT_MAX),
	);
	drag = {
		workspaceKey: opts.workspaceKey,
		startY: event.clientY,
		startHeight: Math.min(clampGitGraphHeight(opts.startHeight), maxHeight),
		pointerId: event.pointerId,
		setHeight: opts.setHeight,
		maxHeight,
	};
	document.body.style.cursor = "ns-resize";
	document.body.style.userSelect = "none";
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", endDrag);
	window.addEventListener("pointercancel", endDrag);
	window.addEventListener("blur", onWindowBlur);
	document.addEventListener("visibilitychange", onVisibilityChange);
}
