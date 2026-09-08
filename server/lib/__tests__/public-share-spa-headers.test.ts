import { describe, expect, test } from "bun:test";
import { spaIndexHeaders } from "../spa-base-href";

describe("public share SPA response headers", () => {
	test("prevents caches, referrers and indexing before React mounts", () => {
		for (const path of ["/shared/narrators", "/shared/narrators/a", "/shared/narrators/invalid/"]) {
			expect(spaIndexHeaders(path)).toEqual({
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Robots-Tag": "noindex, nofollow, noarchive",
			});
		}
	});

	test("keeps the established policy for other pages", () => {
		for (const path of ["/", "/login", "/narrators/a", "/shared/narrators-other"]) {
			expect(spaIndexHeaders(path)).toEqual({
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-cache",
			});
		}
	});
});
