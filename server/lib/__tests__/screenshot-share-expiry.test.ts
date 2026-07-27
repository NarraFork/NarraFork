/**
 * screenshot-share-expiry.test.ts — A screenshot preview must outlive the hour.
 *
 * THE BUG
 *
 * Browser / WebFetch screenshots are shown through `/api/shares/<id>/preview`, and
 * both tools created that share with `expiryHours: 1`. But unlike a "temporary
 * download link", this URL is PERSISTED inside the tool call and stays part of the
 * conversation forever. One hour later the share was deleted, the URL started
 * returning 404, and every screenshot the user scrolled back to rendered as an
 * empty reserved box — with the server running normally the whole time.
 *
 * WHY THIS TEST AND NOT A RENDER TEST
 *
 * End-to-end render tests pass in the broken state: given a `previewUrl` the card
 * does produce a correct `<img src=...>`. The defect is that the URL stops
 * RESOLVING, which only a lifetime assertion catches. So this pins the policy:
 * a screenshot share must be created with a lifetime long enough to replay a
 * session, and must NOT use the 1-hour temporary-download expiry.
 */

import { describe, expect, it } from "bun:test";
import { isDurablePreviewExpiry, SCREENSHOT_PREVIEW_EXPIRY_HOURS } from "../shares";

/** The value that shipped, and that made old screenshots disappear. */
const BROKEN_EXPIRY_HOURS = 1;

describe("isDurablePreviewExpiry", () => {
	it("REJECTS the 1-hour expiry that made old screenshots 404", () => {
		// The regression itself, asserted directly on the policy rather than by
		// mutating the module: this is the value that shipped.
		expect(isDurablePreviewExpiry(BROKEN_EXPIRY_HOURS)).toBe(false);
	});

	it("rejects anything shorter than a full day", () => {
		for (const hours of [2, 6, 12, 23]) {
			expect(isDurablePreviewExpiry(hours)).toBe(false);
		}
	});

	it("accepts a day and a week", () => {
		expect(isDurablePreviewExpiry(24)).toBe(true);
		expect(isDurablePreviewExpiry(24 * 7)).toBe(true);
	});

	it("rejects an effectively unbounded lifetime", () => {
		// Guards the other direction: nothing else prunes these files while the
		// server stays up, so a year-long share would grow ~/.narrafork without limit.
		expect(isDurablePreviewExpiry(24 * 365)).toBe(false);
	});
});

describe("SCREENSHOT_PREVIEW_EXPIRY_HOURS", () => {
	it("satisfies the durable-preview policy", () => {
		expect(isDurablePreviewExpiry(SCREENSHOT_PREVIEW_EXPIRY_HOURS)).toBe(true);
	});
});

describe("screenshot tools use the shared expiry constant", () => {
	// A source assertion is the right tool here: the value is passed at a call site
	// deep inside an action that needs a live browser / network fetch to reach, and
	// the invariant IS "these two call sites must not hardcode their own expiry".
	const callSiteFiles = [
		`${import.meta.dir}/../agent/tools/browser.ts`,
		`${import.meta.dir}/../agent/tools/web-fetch.ts`,
	];

	/**
	 * Every `expiryHours:` value a file passes, as written.
	 *
	 * Reading the actual values (rather than grepping for one bad literal) is what
	 * makes this hold for ANY too-short number: a numeric literal is run through
	 * the policy predicate, so `expiryHours: 2` fails exactly like the original 1.
	 */
	function expiryArguments(src: string): string[] {
		return [...src.matchAll(/expiryHours:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
	}

	it("passes a durable expiry at every screenshot call site", async () => {
		for (const file of callSiteFiles) {
			const src = await Bun.file(file).text();
			const values = expiryArguments(src);
			expect(values.length).toBeGreaterThan(0);
			for (const value of values) {
				// Evaluate anything made only of numbers and arithmetic (covers `1`, `24 * 7`)
				// so a computed literal is judged by the policy rather than by its spelling.
				const numeric = /^[\d\s*/+\-.()_]+$/.test(value)
					? Number(new Function(`return (${value})`)())
					: Number.NaN;
				if (Number.isFinite(numeric)) {
					expect(isDurablePreviewExpiry(numeric)).toBe(true);
				} else {
					// Otherwise it must be the shared constant, which is policy-checked above.
					expect(value).toBe("SCREENSHOT_PREVIEW_EXPIRY_HOURS");
				}
			}
		}
	});
});
