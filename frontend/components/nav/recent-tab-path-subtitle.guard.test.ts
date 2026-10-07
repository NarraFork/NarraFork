/**
 * Guards the recentTabs cwd subtitle against the leading-slash bidi bug.
 *
 * The sidebar shows working directories with `direction: rtl` so long paths
 * ellipsize from the LEFT (keeping the tail that identifies the directory).
 * A bare RTL container reorders the leading `/` — Unicode Bidi treats it as a
 * neutral — so the path looks like `home/user/repo` with the root slash gone.
 * The fix is LTR isolation (`<bdo dir="ltr">` inside `LeftTruncatedPathText`).
 *
 * Asserted against the source because RecentTabs is not unit-mountable here
 * (drag sensors, router, query cache), matching sibling source-guard suites.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RECENT_TABS = readFileSync(join(import.meta.dir, "RecentTabs.tsx"), "utf8");
const DIRECTORY_ROW = readFileSync(join(import.meta.dir, "RecentTabDirectoryRow.tsx"), "utf8");
const PATH_TEXT = readFileSync(join(import.meta.dir, "../common/TruncatedPath.tsx"), "utf8");

describe("recentTabs working-directory subtitles", () => {
	it("renders cwd through LeftTruncatedPathText (LTR-isolated left-ellipsis)", () => {
		expect(RECENT_TABS).toContain("<LeftTruncatedPathText path={tab.subtitle}");
		expect(DIRECTORY_ROW).toContain("<LeftTruncatedPathText path={path}");
	});

	it("keeps the LTR isolation unit inside the shared path text", () => {
		// The bdo is what stops the leading "/" from being bidi-reordered away.
		expect(PATH_TEXT).toContain('<bdo dir="ltr">');
		expect(PATH_TEXT).toContain('direction: "rtl"');
	});

	it("no longer drops a raw subtitle into a bare rtl Text", () => {
		// The exact shape of the regression: rtl styles with the path as direct content.
		// Non-path subtitles (chapter titles) may still use a plain truncated Text.
		expect(RECENT_TABS).not.toMatch(/direction:\s*tab\.type === "narrator" \? "rtl" : undefined/);
		expect(RECENT_TABS).not.toMatch(/direction:\s*"rtl"[\s\S]{0,80}\{tab\.subtitle\}/);
		expect(DIRECTORY_ROW).not.toMatch(/direction:\s*"rtl"[\s\S]{0,80}\{path\}/);
	});

	it("still left-truncates non-path subtitles as plain text", () => {
		// Chapter titles etc. are not paths; they must not go through the path component.
		expect(RECENT_TABS).toContain("hasDirectorySubtitle(tab)");
	});
});
