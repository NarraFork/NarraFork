/**
 * What an outline dock panel shows, as panel params that survive layout serialization, and
 * which panel a request to open a place belongs to. Pure: no React, no dockview.
 *
 * STATE
 * -----
 * `spaceId` + `blockId` say what is shown (no space: the outline home; no block: the space's
 * pages), `view` and `asOf` how. `pageId` (the page the focused block is on) is learned when the
 * panel loads and kept, so a restored layout knows its panels' identity before reading.
 *
 * Titles are never stored: a layout can outlive the person who made it in a shared browser (a
 * session's dock layout is kept per session and device), and a page title is content. A tab is
 * named after what its panel loaded, and is the generic name until then or when nothing loads.
 *
 * IDENTITY
 * --------
 * One panel per (space, page) per surface: opening a block of a page that already has a panel
 * reuses that panel and navigates it there; a space's page list and the home have one each.
 * Ctrl/Cmd-click opens a new panel regardless, so two panels may show one page (they share its
 * live session; folding and scrolling stay per panel).
 */
import type { OutlineTarget } from "../components/outline/outline-nav";

export interface OutlinePanelState {
	spaceId?: string;
	blockId?: string;
	/** The page `blockId` is on, once known. */
	pageId?: string;
	view?: "all";
	asOf?: number;
	/**
	 * A title already known when a place is opened (a resolved reference names it), to name a new
	 * panel's tab at once. Never written to params (`normalizeOutlinePanelState` drops it).
	 */
	title?: string;
}

/** Ids are nanoids or short ids; anything else in stored params is dropped. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const OUTLINE_PANEL_TITLE_MAX = 200;

function id(value: unknown): string | undefined {
	return typeof value === "string" && ID.test(value) ? value : undefined;
}

/** A title as shown on a tab: trimmed, bounded, or nothing. */
export function outlinePanelTitle(value: unknown): string | undefined {
	return typeof value === "string" && value.trim()
		? value.trim().slice(0, OUTLINE_PANEL_TITLE_MAX)
		: undefined;
}

/** The outline part of stored panel params, keeping only well-formed fields (no title). */
export function normalizeOutlinePanelState(raw: unknown): OutlinePanelState {
	if (!raw || typeof raw !== "object") return {};
	const value = raw as Record<string, unknown>;
	const spaceId = id(value.spaceId);
	if (!spaceId) return {};
	const blockId = id(value.blockId);
	const pageId = blockId ? id(value.pageId) : undefined;
	const asOf =
		blockId && typeof value.asOf === "number" && Number.isSafeInteger(value.asOf) && value.asOf >= 0
			? value.asOf
			: undefined;
	return {
		spaceId,
		...(blockId ? { blockId } : {}),
		...(pageId ? { pageId } : {}),
		...(blockId && value.view === "all" ? { view: "all" as const } : {}),
		...(asOf !== undefined ? { asOf } : {}),
	};
}

/** What the surface shows for a panel state. */
export function outlinePanelTarget(state: OutlinePanelState): OutlineTarget {
	if (!state.spaceId) return { kind: "home" };
	if (!state.blockId) return { kind: "space", spaceId: state.spaceId };
	return {
		kind: "block",
		spaceId: state.spaceId,
		blockId: state.blockId,
		...(state.view === "all" ? { view: "all" as const } : {}),
		...(state.asOf !== undefined ? { asOf: state.asOf } : {}),
	};
}

/**
 * The state after navigating to `to` inside a panel. The page stays known when the focus stays
 * (a view or time change) or moves to the page itself; otherwise it is learned again on load.
 */
export function outlinePanelStateFor(
	to: OutlineTarget,
	previous: OutlinePanelState = {},
): OutlinePanelState {
	if (to.kind === "home") return {};
	if (to.kind === "space") return { spaceId: to.spaceId };
	const samePage =
		previous.spaceId === to.spaceId &&
		(previous.pageId === to.blockId || previous.blockId === to.blockId);
	return normalizeOutlinePanelState({
		spaceId: to.spaceId,
		blockId: to.blockId,
		view: to.view,
		asOf: to.asOf,
		...(samePage ? { pageId: previous.pageId } : {}),
	});
}

/** A panel's identity: the home, a space's page list, or a page of a space. */
export function outlinePanelIdentity(state: OutlinePanelState): string {
	if (!state.spaceId) return "home";
	if (!state.blockId) return `space:${state.spaceId}`;
	return `page:${state.spaceId}/${state.pageId ?? state.blockId}`;
}

/**
 * Whether the panel showing `current` is the one to open `request` in: the same identity, or —
 * when one side does not know its page yet — the request's block is the panel's page or block.
 */
export function isSameOutlinePanel(
	current: OutlinePanelState,
	request: OutlinePanelState,
): boolean {
	if (outlinePanelIdentity(current) === outlinePanelIdentity(request)) return true;
	if (!current.spaceId || current.spaceId !== request.spaceId) return false;
	if (!current.blockId || !request.blockId) return false;
	const currentPage = current.pageId ?? current.blockId;
	const requestPage = request.pageId ?? request.blockId;
	return (
		currentPage === requestPage ||
		(!request.pageId && (request.blockId === current.pageId || request.blockId === current.blockId))
	);
}

let panelSeq = 0;
/** A fresh dockview panel id (one per panel; identity lives in the params, not the id). */
export function nextOutlinePanelId(prefix: string): string {
	panelSeq += 1;
	return `${prefix}${Date.now().toString(36)}${panelSeq.toString(36)}`;
}

/** Whether two states show the same thing the same way (to skip no-op param writes). */
export function sameOutlinePanelState(a: OutlinePanelState, b: OutlinePanelState): boolean {
	return (
		a.spaceId === b.spaceId &&
		a.blockId === b.blockId &&
		a.pageId === b.pageId &&
		a.view === b.view &&
		a.asOf === b.asOf
	);
}
