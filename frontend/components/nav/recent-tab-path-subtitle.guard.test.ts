/**
 * Guards the recentTabs working-directory display against the leading-slash bidi bug.
 *
 * Rows used to show the cwd with `direction: rtl` so long paths ellipsized from the LEFT.
 * A bare RTL container reorders the leading `/` (Unicode Bidi treats it as a neutral), so
 * the path read `home/user/repo` with the root slash gone; the fix was LTR isolation
 * (`<bdo dir="ltr">` inside `LeftTruncatedPathText`).
 *
 * Rows are now one line and the cwd lives in the details card (hover) and the touch menu
 * header, shown in full and wrapped. Plain LTR text needs no isolation, so the guard is
 * that no RTL trick comes back around the subtitle on either surface.
 *
 * Asserted against the source because RecentTabs is not unit-mountable here
 * (drag sensors, router, query cache), matching sibling source-guard suites.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RECENT_TABS = readFileSync(join(import.meta.dir, "RecentTabs.tsx"), "utf8");
const DETAILS = readFileSync(join(import.meta.dir, "RecentTabDetailCard.tsx"), "utf8");
const PATH_TEXT = readFileSync(join(import.meta.dir, "../common/TruncatedPath.tsx"), "utf8");

describe("recentTabs working-directory display", () => {
	it("rows no longer render the subtitle; the details do", () => {
		expect(RECENT_TABS).not.toContain("{tab.subtitle}");
		expect(DETAILS).toContain("{tab.subtitle}");
	});

	it("the details show the path as plain LTR text, never through a bare rtl box", () => {
		expect(DETAILS).not.toMatch(/direction:\s*"rtl"/);
		expect(RECENT_TABS).not.toMatch(/direction:\s*"rtl"[\s\S]{0,80}\{tab\.subtitle\}/);
	});

	it("keeps the LTR isolation unit inside the shared path text for other callers", () => {
		expect(PATH_TEXT).toContain('<bdo dir="ltr">');
		expect(PATH_TEXT).toContain('direction: "rtl"');
	});
});
