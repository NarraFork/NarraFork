/**
 * Single source of truth for the customizable sidebar navigation ids.
 *
 * The frontend registry (frontend/components/nav/nav-items.tsx) and the server
 * validator (server/lib/validators/settings.ts) both derive from this list. They
 * used to keep independent copies, which silently drifted: adding a nav entry on
 * the frontend made the layout unsavable (PATCH /api/user-preferences rejected
 * the unknown id with a Zod invalid_value error) until someone remembered to
 * update the server enum too.
 *
 * When adding a navigation entry, append its id here and add the presentation
 * details to the frontend registry — useNavLayout merges ids missing from a
 * user's persisted layout, so no data migration is needed.
 */
export const CUSTOMIZABLE_NAV_IDS = [
	"projects",
	"messages",
	"routines",
	"scheduled-tasks",
	"learn",
	"knowledge",
] as const;

export type CustomizableNavId = (typeof CUSTOMIZABLE_NAV_IDS)[number];

/**
 * Boundary marker inside the flat persisted layout list: every id after it is
 * tucked into the "More" overflow menu.
 */
export const NAV_DIVIDER_ID = "__divider__";

/** Every id accepted in the persisted layout, including the divider marker. */
export const PERSISTED_NAV_IDS = [...CUSTOMIZABLE_NAV_IDS, NAV_DIVIDER_ID] as const;

const NAV_ID_SET: ReadonlySet<string> = new Set<string>(CUSTOMIZABLE_NAV_IDS);

/** Type guard for ids present in the registry (filters out stale persisted ids). */
export function isCustomizableNavId(id: string): id is CustomizableNavId {
	return NAV_ID_SET.has(id);
}
