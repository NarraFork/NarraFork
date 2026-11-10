/**
 * Guards the recentTabs working-directory display against the leading-slash bidi bug.
 *
 * Rows used to show the cwd with `direction: rtl` so long paths ellipsized from the LEFT.
 * A bare RTL container reorders the leading `/` (Unicode Bidi treats it as a neutral), so
 * the path read `home/user/repo` with the root slash gone; the fix was LTR isolation
 * (`<bdo dir="ltr">` inside `LeftTruncatedPathText`).
 *
 * Rows are one line by default. An appearance preference restores the cwd line using
 * the shared left-truncating path component. The details card and touch menu still
 * show the full, wrapped cwd as plain LTR text.
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
const APPEARANCE = readFileSync(join(import.meta.dir, "../settings/AppearanceSection.tsx"), "utf8");

describe("recentTabs working-directory display", () => {
	it("restores only directory subtitles behind the appearance preference", () => {
		expect(RECENT_TABS).toContain(
			"const showDirectory = userPrefs?.recentTabsShowDirectory ?? false",
		);
		expect(RECENT_TABS).toContain("showDirectory && hasDirectorySubtitle(tab) && tab.subtitle");
		expect(RECENT_TABS).toContain(
			'<LeftTruncatedPathText path={tab.subtitle} size="xs" c="dimmed" />',
		);
		expect(DETAILS).toContain("{tab.subtitle}");
	});

	it("reads and writes the account preference rather than browser-local storage", () => {
		expect(APPEARANCE).toContain("checked={userPrefs?.recentTabsShowDirectory ?? false}");
		expect(APPEARANCE).toContain(
			"updateUserPref.mutate({ recentTabsShowDirectory: e.currentTarget.checked })",
		);
		expect(APPEARANCE).not.toContain("narrafork_recent_tabs_show_directory");
		expect(RECENT_TABS).not.toContain("narrafork_recent_tabs_show_directory");
	});

	it("uses the same title and optional directory in rows and drag overlays", () => {
		expect(RECENT_TABS.match(/label=\{<RecentTabTitle tab=\{tab\} \/>\}/g)).toHaveLength(2);
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
