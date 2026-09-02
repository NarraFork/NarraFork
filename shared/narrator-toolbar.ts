/**
 * Single source of truth for the customizable narrator-header toolbar ids.
 *
 * Mirrors `shared/nav-layout.ts` deliberately: the frontend registry
 * (frontend/components/narrator/narrator-toolbar-items.tsx) and the server
 * validator (server/lib/validators/settings.ts) both derive from this list, so
 * they cannot drift. In the nav case an id present on the frontend but missing
 * from the server enum made the layout silently unsavable (PATCH
 * /api/user-preferences rejected it with a Zod `invalid_value`); the same trap
 * applies here.
 *
 * The order below is the DEFAULT order for fresh installs, roughly "how often a
 * reader reaches for it". It is NOT a visibility list — every id starts before
 * the divider (i.e. eligible to be surfaced) and the *host* decides how many
 * actually fit: the desktop header MEASURES its available width and collapses
 * the rest into the overflow menu (see
 * `frontend/components/narrator/narrator-header-toolbar-capacity.ts`), while the
 * mobile header additionally applies the fixed cap below. Earlier the desktop
 * row rendered every surfaced entry and let the title compress instead, which
 * squeezed long titles down to a few characters.
 *
 * Two classes of control are deliberately absent:
 *
 *  - Session configuration (model, reasoning effort, fast mode, permission mode,
 *    path rules, relaxed plan, promote). Those belong to the *status bar* below
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
] as const;

export type NarratorToolbarId = (typeof NARRATOR_TOOLBAR_IDS)[number];

/**
 * Boundary marker inside the flat persisted layout list: every id after it is
 * tucked into the overflow menu regardless of how much room the header has.
 *
 * Same sentinel shape as the nav layout's divider, and for the same reason —
 * visibility is derived from position, never stored as a separate flag that can
 * disagree with the order.
 */
export const NARRATOR_TOOLBAR_DIVIDER_ID = "__divider__";

/** Every id accepted in the persisted layout, including the divider marker. */
export const PERSISTED_NARRATOR_TOOLBAR_IDS = [
	...NARRATOR_TOOLBAR_IDS,
	NARRATOR_TOOLBAR_DIVIDER_ID,
] as const;

const TOOLBAR_ID_SET: ReadonlySet<string> = new Set<string>(NARRATOR_TOOLBAR_IDS);

/** Type guard for ids present in the registry (filters out stale persisted ids). */
export function isNarratorToolbarId(id: string): id is NarratorToolbarId {
	return TOOLBAR_ID_SET.has(id);
}

/**
 * How many entries the mobile header surfaces before the overflow menu.
 *
 * A fixed cap rather than the desktop's width measurement: on a phone the title
 * must keep a readable share of a ~360px row, and a measured layout would let a
 * short title hand its width to buttons and then reflow the moment the title
 * updates (narrator titles are generated asynchronously). Two entries plus the
 * overflow button is what fits beside a truncated title at that width.
 */
export const MOBILE_TOOLBAR_VISIBLE_LIMIT = 2;
