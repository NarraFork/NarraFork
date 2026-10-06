import {
	CUSTOMIZABLE_NAV_IDS,
	type CustomizableNavId,
	isCustomizableNavId,
} from "@shared/nav-layout";
import {
	IconBook2,
	IconClock,
	IconDatabase,
	IconFolders,
	IconMessages,
	IconWand,
} from "@tabler/icons-react";
import type { ComponentType } from "react";

/**
 * Registry of the customizable secondary navigation entries.
 *
 * The order here is the DEFAULT order for fresh installs. Mandatory entries
 * (dashboard / narrators / settings) are NOT in this list — they are rendered
 * unconditionally and can never be tucked into the overflow menu.
 *
 * The set of ids lives in @shared/nav-layout so the server validator accepts
 * exactly what this registry renders. Adding an entry means appending its id
 * there and its presentation here; useNavLayout automatically merges ids that
 * are missing from the user's persisted layout, so no data migration is needed.
 */
export interface NavItemDef {
	/** Stable id persisted in user_preferences.nav_layout. */
	id: CustomizableNavId;
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
	badge?: "knowledgeReviewInbox" | "chatUnread";
	/**
	 * Start life BELOW the divider, i.e. in the "More" menu rather than the rail.
	 *
	 * The sidebar's vertical budget is shared with the recent-tabs list, which is
	 * where the reader actually works; every entry pinned to the rail takes a row
	 * from it permanently. So the default is "surfaced" only for entries a reader
	 * navigates to repeatedly — the rest are one click away in the overflow menu,
	 * which is also where the customization UI lives, so they stay discoverable.
	 *
	 * This is a DEFAULT, not a policy: it applies to an id the reader has never
	 * positioned. Once an id appears in the persisted layout, its stored position
	 * wins, so flipping this flag never moves an entry out from under someone.
	 */
	defaultTucked?: boolean;
}

/**
 * Presentation details per id. Typed as a total record so a new id in
 * @shared/nav-layout fails to compile until its details are filled in here —
 * otherwise the server would accept an id that renders as nothing.
 */
const NAV_ITEM_DETAILS: Record<CustomizableNavId, Omit<NavItemDef, "id">> = {
	projects: {
		labelKey: "projects",
		to: "/projects",
		icon: IconFolders,
	},
	messages: {
		labelKey: "messages",
		to: "/messages",
		icon: IconMessages,
		activePrefix: "/messages",
		badge: "chatUnread",
	},
	routines: {
		labelKey: "routines",
		to: "/routines",
		icon: IconWand,
	},
	"scheduled-tasks": {
		labelKey: "scheduledTasks",
		to: "/scheduled-tasks",
		icon: IconClock,
		activePrefix: "/scheduled-tasks",
	},
	learn: {
		labelKey: "learning",
		to: "/learn",
		icon: IconBook2,
		defaultTucked: true,
	},
	knowledge: {
		labelKey: "knowledge",
		to: "/knowledge",
		icon: IconDatabase,
		badge: "knowledgeReviewInbox",
	},
};

/** Default display order for fresh installs, driven by the shared id order. */
export const CUSTOMIZABLE_NAV_ITEMS: readonly NavItemDef[] = CUSTOMIZABLE_NAV_IDS.map((id) => ({
	id,
	...NAV_ITEM_DETAILS[id],
}));

export { CUSTOMIZABLE_NAV_IDS, type CustomizableNavId, isCustomizableNavId };
