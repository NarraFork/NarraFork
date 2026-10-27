/**
 * Read-only page subscriptions on `/ws/narrator`: the server tells a subscriber that a page
 * changed, with ids and seqs only, and the client re-reads over HTTP (which checks access
 * again). Notifications are coalesced per subscription, so one frame may stand for several
 * commits.
 */
export type OutlinePageClientMessage =
	| { type: "outline_page_subscribe"; subscriptionId: string; pageId: string }
	| { type: "outline_page_unsubscribe"; subscriptionId: string };

export type OutlinePageErrorCode =
	/** The page does not exist, or the person may not (or may no longer) read its space. */
	| "access_denied"
	/** Too many subscriptions, or the outline is switched off. */
	| "unavailable";

export type OutlinePageServerMessage =
	| {
			type: "outline_page_subscribed";
			subscriptionId: string;
			pageId: string;
			/** The space's last commit seq when the subscription started. */
			seq: number;
	  }
	| {
			type: "outline_page_changed";
			subscriptionId: string;
			pageId: string;
			/** The newest commit seq among the changes this frame stands for. */
			seq: number;
			/** Ids of the commits, oldest first; at most the last few when many landed at once. */
			commitIds: string[];
	  }
	| { type: "outline_page_error"; subscriptionId: string; code: OutlinePageErrorCode };

/** Per-socket and per-page limits of page subscriptions. */
export const OUTLINE_PAGE_SUBSCRIPTION_LIMITS = {
	perSocket: 16,
	perPage: 50,
	/** Commit ids one change frame carries at most. */
	commitIdsPerFrame: 16,
} as const;
