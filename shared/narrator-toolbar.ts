/**
 * Single source of truth for the customizable narrator-header toolbar ids.
 *
 * Mirrors `shared/nav-layout.ts` deliberately: the frontend registry
 * (frontend/components/narrator/header/narrator-toolbar-items.tsx) and the server
 * validator (server/lib/validators/settings.ts) both derive from this list, so
 * they cannot drift. In the nav case an id present on the frontend but missing
 * from the server enum made the layout silently unsavable (PATCH
 * /api/user-preferences rejected it with a Zod `invalid_value`); the same trap
 * applies here.
 *
 * The order below is the DEFAULT order for fresh installs, roughly "how often a
 * reader reaches for it". It is NOT a visibility list — the layout assigns ids
 * to header/menu/bottom zones and the *host* decides how many actually fit:
 * the header MEASURES its available width on every viewport (including mobile)
 * and collapses the rest into the overflow menu (see
 * `frontend/components/narrator/header/narrator-header-toolbar-capacity.ts`).
 * There is no fixed mobile count cap — a wider phone simply fits more icons
 * after the title floor. Earlier the desktop row rendered every surfaced entry
 * and let the title compress instead, which squeezed long titles down to a few
 * characters.
 *
 * Two classes of control are deliberately absent:
 *
 *  - Session configuration (model, reasoning effort, fast mode, permission mode,
 *    relaxed plan, promote). Those belong to the *status bar* below
 *    the conversation, next to the state they modify, not to the tool-entry row.
 *  - Destructive or window-level actions (archive, close panel). Archive is
 *    pinned to the bottom of the overflow menu and must never be draggable into
 *    the always-visible row: it is not a panel toggle and a mis-tap is not
 *    symmetric with one. Close is always the rightmost control.
 *
 * `lodlevel` is a deliberate exception to the first class: the detail level is
 * render configuration (not per-session state), and its historic only entry
 * point — Alt — is a user-configurable gesture that can be turned off entirely
 * in Settings, so the toolbar menu is the entry point that survives that.
 */
export const NARRATOR_TOOLBAR_IDS = [
	"tasks",
	"filemod",
	"filetree",
	"details",
	"terminal",
	"spec",
	"git",
	"search",
	"browser",
	"userchat",
	"appearance",
	"lodlevel",
	"device",
	"plugins",
	"path-rules",
] as const;

export type NarratorToolbarId = (typeof NARRATOR_TOOLBAR_IDS)[number];

/**
 * Boundary marker inside the flat persisted layout list: ids after it and before
 * the bottom marker stay in the overflow menu regardless of header width.
 *
 * Same sentinel shape as the nav layout's divider, and for the same reason —
 * visibility is derived from position, never stored as a separate flag that can
 * disagree with the order.
 */
export const NARRATOR_TOOLBAR_DIVIDER_ID = "__divider__";

/** Starts the bottom toolbar zone; the preceding divider starts the menu zone. */
export const NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID = "__bottom__";

/** Every id accepted in the persisted layout, including both boundary markers. */
export const PERSISTED_NARRATOR_TOOLBAR_IDS = [
	...NARRATOR_TOOLBAR_IDS,
	NARRATOR_TOOLBAR_DIVIDER_ID,
	NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID,
] as const;

const TOOLBAR_ID_SET: ReadonlySet<string> = new Set<string>(NARRATOR_TOOLBAR_IDS);

/** Type guard for ids present in the registry (filters out stale persisted ids). */
export function isNarratorToolbarId(id: string): id is NarratorToolbarId {
	return TOOLBAR_ID_SET.has(id);
}
