import { IconBook2, IconClock, IconDatabase, IconFolders, IconWand } from "@tabler/icons-react";
import type { ComponentType } from "react";

/**
 * Registry of the customizable secondary navigation entries.
 *
 * The order here is the DEFAULT order for fresh installs. Mandatory entries
 * (dashboard / narrators / settings) are NOT in this list — they are rendered
 * unconditionally and can never be tucked into the overflow menu.
 *
 * When a new entry is added, append it to the end; useNavLayout automatically
 * merges ids that are missing from the user's persisted layout, so no data
 * migration is needed.
 */
export interface NavItemDef {
	/** Stable id persisted in user_preferences.nav_layout. */
	id: string;
	/** i18n key in the "nav" namespace. */
	labelKey: string;
	/** Route target for TanStack Router Link / navigate. */
	to: string;
	icon: ComponentType<{ size?: number | string }>;
	/** Optional path prefix used to compute the active state. */
	activePrefix?: string;
	/**
	 * Which live unread counter (if any) badges this entry. The registry stays a static
	 * data structure — the count itself is resolved by the rendering component through
	 * the matching hook, so this is only the wiring key.
	 */
	badge?: "knowledgeReviewInbox";
}

export const CUSTOMIZABLE_NAV_ITEMS: readonly NavItemDef[] = [
	{
		id: "projects",
		labelKey: "projects",
		to: "/projects",
		icon: IconFolders,
	},
	{
		id: "routines",
		labelKey: "routines",
		to: "/routines",
		icon: IconWand,
	},
	{
		id: "scheduled-tasks",
		labelKey: "scheduledTasks",
		to: "/scheduled-tasks",
		icon: IconClock,
		activePrefix: "/scheduled-tasks",
	},
	{
		id: "learn",
		labelKey: "learning",
		to: "/learn",
		icon: IconBook2,
	},
	{
		id: "knowledge",
		labelKey: "knowledge",
		to: "/knowledge",
		icon: IconDatabase,
		badge: "knowledgeReviewInbox",
	},
];

export type CustomizableNavId = (typeof CUSTOMIZABLE_NAV_ITEMS)[number]["id"];

const NAV_ID_SET = new Set<string>(CUSTOMIZABLE_NAV_ITEMS.map((item) => item.id));

/** Type guard for ids present in the registry (filters out stale persisted ids). */
export function isCustomizableNavId(id: string): id is CustomizableNavId {
	return NAV_ID_SET.has(id);
}
