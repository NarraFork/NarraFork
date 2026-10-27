/**
 * The outline page's dock layout, remembered per person in this browser (localStorage): which
 * sessions and outline panels sit beside the page, and where. The main panel shows whatever
 * page the URL names, so it carries no identity of its own in the layout; the panels beside it
 * keep theirs (a session's id, an outline panel's place).
 *
 * Best effort and bounded: storage can be missing, full or blocked (every access is wrapped),
 * a layout over the size budget is not written, and one that does not restore with its main
 * panel is dropped in favour of the default (the page alone).
 */
import type { DockviewApi, SerializedDockview } from "dockview-react";
import { stripNavigationFromLayout } from "../narrator/panels/layout-envelope";

export const OUTLINE_PAGE_DOCK_VERSION = 1 as const;
const STORAGE_PREFIX = "narrafork_outline_dock_v1:";
/** Layouts beyond this many UTF-16 units are not remembered. */
export const OUTLINE_PAGE_DOCK_MAX_CHARS = 256 * 1024;

/** Dockview ids and component names of the outline page's dock. */
export const OUTLINE_PAGE_MAIN_ID = "outline-main";
export const OUTLINE_PAGE_COMPONENTS = {
	main: "outline-main",
	outline: "outline",
	narrator: "narrator",
} as const;

interface Envelope {
	version: typeof OUTLINE_PAGE_DOCK_VERSION;
	layout: SerializedDockview;
}

export function outlinePageDockKey(userId: string): string {
	return `${STORAGE_PREFIX}${userId}`;
}

/**
 * The layout to remember: navigation requests and outline titles dropped, the main panel's
 * params and title emptied (it shows whatever the URL names).
 */
export function serializeOutlinePageDock(layout: SerializedDockview): string | null {
	const stripped = stripNavigationFromLayout(layout);
	const panels = (
		stripped as { panels?: Record<string, { params?: Record<string, unknown>; title?: string }> }
	).panels;
	const main = panels?.[OUTLINE_PAGE_MAIN_ID];
	if (main) {
		main.params = { panelType: OUTLINE_PAGE_COMPONENTS.main };
		delete main.title;
	}
	const envelope: Envelope = { version: OUTLINE_PAGE_DOCK_VERSION, layout: stripped };
	const text = JSON.stringify(envelope);
	return text.length <= OUTLINE_PAGE_DOCK_MAX_CHARS ? text : null;
}

/** A remembered layout, or null when there is none or it is not usable. */
export function parseOutlinePageDock(text: string | null): SerializedDockview | null {
	if (!text || text.length > OUTLINE_PAGE_DOCK_MAX_CHARS) return null;
	try {
		const value = JSON.parse(text) as Partial<Envelope> | null;
		if (value?.version !== OUTLINE_PAGE_DOCK_VERSION) return null;
		const layout = value.layout as SerializedDockview | undefined;
		const panels = (layout as { panels?: Record<string, unknown> } | undefined)?.panels;
		if (!layout || !panels?.[OUTLINE_PAGE_MAIN_ID]) return null;
		return layout;
	} catch {
		return null;
	}
}

export function saveOutlinePageDock(api: DockviewApi, userId: string): void {
	try {
		const text = serializeOutlinePageDock(api.toJSON());
		if (text) localStorage.setItem(outlinePageDockKey(userId), text);
	} catch {
		// Not remembered this time.
	}
}

function loadOutlinePageDock(userId: string): SerializedDockview | null {
	try {
		return parseOutlinePageDock(localStorage.getItem(outlinePageDockKey(userId)));
	} catch {
		return null;
	}
}

/**
 * Restore the remembered layout into a fresh dock, or lay out the default (the page alone).
 * The main panel always exists afterwards. Returns whether a remembered layout was used.
 */
export function applyOutlinePageDock(api: DockviewApi, userId: string | null): boolean {
	const layout = userId ? loadOutlinePageDock(userId) : null;
	if (layout) {
		try {
			api.fromJSON(layout);
			if (api.getPanel(OUTLINE_PAGE_MAIN_ID)) return true;
		} catch {
			// Fall through to the default.
		}
		api.clear();
	}
	api.addPanel({
		id: OUTLINE_PAGE_MAIN_ID,
		component: OUTLINE_PAGE_COMPONENTS.main,
		tabComponent: OUTLINE_PAGE_COMPONENTS.main,
		params: { panelType: OUTLINE_PAGE_COMPONENTS.main },
	});
	return false;
}
