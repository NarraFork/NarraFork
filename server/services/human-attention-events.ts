import { eventBus } from "../lib/event-bus";

/** Data-free invalidation; observers refetch under their own, current ACL. */
export function notifyHumanAttentionChanged(): void {
	eventBus.emit({ type: "human_attention:changed" });
}
