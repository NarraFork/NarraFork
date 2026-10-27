import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { invalidateOutlineSpace, outlineKeys } from "./useOutline";

test("a change re-reads the space's current views, never its views as of a commit", () => {
	const client = new QueryClient();
	const keys = {
		current: outlineKeys.block("s1", "b1", null, "facts"),
		asOf: outlineKeys.block("s1", "b1", 4, "facts"),
		otherSpace: outlineKeys.block("s2", "b1", null, "facts"),
		timeline: outlineKeys.timeline("s1", "p1"),
		history: outlineKeys.history("s1", "b1"),
		backlinks: outlineKeys.backlinks("s1", "b1"),
		pages: outlineKeys.pages("s1"),
		space: outlineKeys.space("s1"),
		otherTimeline: outlineKeys.timeline("s2", "p1"),
	};
	for (const key of Object.values(keys)) client.setQueryData(key, { cached: true });
	invalidateOutlineSpace(client, "s1");
	const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
	expect(stale(keys.current)).toBe(true);
	expect(stale(keys.asOf)).toBe(false);
	expect(stale(keys.otherSpace)).toBe(false);
	expect(stale(keys.timeline)).toBe(true);
	expect(stale(keys.history)).toBe(true);
	expect(stale(keys.backlinks)).toBe(true);
	expect(stale(keys.pages)).toBe(true);
	expect(stale(keys.space)).toBe(true);
	expect(stale(keys.otherTimeline)).toBe(false);
});
