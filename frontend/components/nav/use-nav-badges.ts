/**
 * use-nav-badges.ts — Resolves every navigation badge in ONE place.
 *
 * `NavItemDef.badge` is only a wiring key; the count lives behind a hook. Both
 * surfaces that paint the secondary nav (the rail in `AppRootLayout` and the
 * overflow menu) used to resolve it with their own inline
 * `def.badge === "knowledgeReviewInbox" ? … : 0` expression, so adding a second
 * badge key meant remembering two unrelated files — and a miss is silent: the
 * entry simply never shows a count.
 *
 * This hook returns a resolver for all keys at once, so a new badge is wired by
 * adding it here and nowhere else.
 */

import { useCallback } from "react";
import { useChatUnread } from "../../hooks/useChat";
import { useReviewInboxCount } from "../../hooks/useKnowledge";
import type { NavItemDef } from "./nav-items";

export interface NavBadgeValue {
	count: number;
	/** Display string, already "99+"-capped where the source reports a ceiling. */
	label: string;
}

const EMPTY: NavBadgeValue = { count: 0, label: "" };

/** Above this a badge reads "99+" instead of an exact number. */
const BADGE_DISPLAY_MAX = 99;

function formatBadge(count: number, capped: boolean): NavBadgeValue {
	if (count <= 0) return EMPTY;
	const label = capped || count > BADGE_DISPLAY_MAX ? `${BADGE_DISPLAY_MAX}+` : String(count);
	return { count, label };
}

export function useNavBadges(): (badge: NavItemDef["badge"]) => NavBadgeValue {
	const knowledgeInbox = useReviewInboxCount();
	const chatUnread = useChatUnread();

	const knowledgeCount = knowledgeInbox.data?.count ?? 0;
	const knowledgeCapped = knowledgeInbox.data?.capped ?? false;
	const chatCount = chatUnread.data?.dmTotal ?? 0;
	const chatCapped = chatUnread.data?.dmTotalCapped ?? false;

	return useCallback(
		(badge: NavItemDef["badge"]): NavBadgeValue => {
			switch (badge) {
				case "knowledgeReviewInbox":
					return formatBadge(knowledgeCount, knowledgeCapped);
				case "chatUnread":
					return formatBadge(chatCount, chatCapped);
				default:
					return EMPTY;
			}
		},
		[chatCapped, chatCount, knowledgeCapped, knowledgeCount],
	);
}
