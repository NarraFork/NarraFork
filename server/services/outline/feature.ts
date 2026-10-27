import { settings } from "@server/lib/settings";

/**
 * Whether the outline system is switched on (`outline.enabled`, off by default while it is
 * built). Read on every request and WebSocket frame, so turning it off takes effect at once:
 * routes answer 404, page subscriptions end, navigation hides the entry.
 */
export function isOutlineEnabled(): boolean {
	return settings.outline?.enabled === true;
}
