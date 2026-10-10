/**
 * Regression tests for `applyNarratorListEvent`.
 *
 * The archived branch is the one that matters: a status-only patch used to leave an
 * archived narrator in the active list, because the paginated query excludes archived
 * rows and the following `invalidateQueries` refetch dropped it from the server's
 * answer while the WS patch wrote `status: "archived"` back into the cache.
 */

import { describe, expect, test } from "bun:test";
import type { NarratorListItem } from "./NarratorListCard";
import { applyNarratorListEvent, type NarratorsInfiniteData } from "./narrator-list-utils";

/** Minimal list row; the reducer only reads `id` unless it is patching. */
function item(id: string, extra: Partial<NarratorListItem> = {}): NarratorListItem {
	return {
		id,
		title: `title-${id}`,
		status: "active",
		createdAt: "2026-01-01",
		...extra,
	} as NarratorListItem;
}

function page(ids: string[], extra: Record<string, unknown> = {}) {
	return { items: ids.map((id) => item(id)), ...extra };
}

function cacheOf(...pages: ReturnType<typeof page>[]): NarratorsInfiniteData {
	return { pages, pageParams: pages.map(() => undefined) } as NarratorsInfiniteData;
}

describe("applyNarratorListEvent — archived", () => {
	test("removes a row that exists on a single page", () => {
		const old = cacheOf(page(["a", "b", "c"]));

		const next = applyNarratorListEvent(old, "b", { status: "archived" });

		expect(next).not.toBe(old);
		expect(next?.pages[0].items.map((i) => i.id)).toEqual(["a", "c"]);
	});

	test("removes every copy of the row across pages", () => {
		// Cursor pagination can surface the same id twice once the sort key shifts, so
		// archiving has to clear all of them — not just the first match.
		const old = cacheOf(page(["a", "b"]), page(["b", "c"]));

		const next = applyNarratorListEvent(old, "b", { status: "archived" });

		expect(next?.pages[0].items.map((i) => i.id)).toEqual(["a"]);
		expect(next?.pages[1].items.map((i) => i.id)).toEqual(["c"]);
	});

	test("keeps pages and pageParams the same length when a page empties", () => {
		// The infinite query is not configured with `maxPages`, so `pageParams` indexes
		// must keep matching `pages`. Dropping the emptied page would misalign them and
		// corrupt the next fetchNextPage cursor, which is why the row is filtered out of
		// the page's items instead.
		const old = cacheOf(page(["a"]), page(["b"]), page(["c"]));
		const pageCountBefore = old.pages.length;
		const pageParamsBefore = (old as unknown as { pageParams: unknown[] }).pageParams.length;

		const next = applyNarratorListEvent(old, "b", { status: "archived" });

		expect(next?.pages).toHaveLength(pageCountBefore);
		expect((next as unknown as { pageParams: unknown[] }).pageParams).toHaveLength(
			pageParamsBefore,
		);
		// The emptied page is still present, just empty.
		expect(next?.pages[1].items).toEqual([]);
	});

	test("returns the same reference when the row is not in the cache", () => {
		// A row already refetched away (or paged out) must not force subscribers to
		// re-render: React Query skips notification when the identity is unchanged.
		const old = cacheOf(page(["a", "b"]));

		const next = applyNarratorListEvent(old, "zzz", { status: "archived" });

		expect(next).toBe(old);
	});

	test("returns undefined for a cache that was never populated", () => {
		expect(applyNarratorListEvent(undefined, "a", { status: "archived" })).toBeUndefined();
	});
});

describe("applyNarratorListEvent — patching", () => {
	test("merges provided fields and stamps updatedAt", () => {
		const old = cacheOf(page(["a", "b"]));

		const next = applyNarratorListEvent(old, "b", {
			status: "working",
			substatus: ["running"],
			title: "renamed",
		});

		const patched = next?.pages[0].items.find((i) => i.id === "b");
		expect(patched).toMatchObject({
			status: "working",
			substatus: ["running"],
			title: "renamed",
		});
		// `updatedAt` is written by the reducer but is not part of `NarratorListItem`,
		// hence the widened read.
		expect(typeof (patched as Record<string, unknown> | undefined)?.updatedAt).toBe("string");
	});

	test("leaves absent fields alone instead of clearing them", () => {
		// A status-only event must not wipe the title or substatus the row already has.
		const old = cacheOf(page(["a"]));
		old.pages[0].items[0] = item("a", { title: "kept", substatus: ["old"] });

		const next = applyNarratorListEvent(old, "a", { status: "idle" });

		expect(next?.pages[0].items[0]).toMatchObject({
			title: "kept",
			substatus: ["old"],
			status: "idle",
		});
	});

	test("returns the same reference when nothing matched", () => {
		const old = cacheOf(page(["a"]));

		expect(applyNarratorListEvent(old, "zzz", { status: "idle" })).toBe(old);
	});

	test("does not treat a non-archived status as a removal", () => {
		// Only the literal "archived" removes. An event carrying an unrelated status
		// must go through the patch path, or every status broadcast would drop the row.
		const old = cacheOf(page(["a", "b"]));

		const next = applyNarratorListEvent(old, "a", { status: "idle" });

		expect(next?.pages[0].items.map((i) => i.id)).toEqual(["a", "b"]);
		expect(next?.pages[0].items[0].status).toBe("idle");
	});
});
