import { describe, expect, it } from "bun:test";
import { fileBaseName, HEADER_FIXED_STYLE, HEADER_FLEXIBLE_STYLE } from "./FileViewerContent";

/**
 * The file panel's header layout.
 *
 * The reported bug: opening an API-request dump
 * (`api-request-2026-08-17T14-00-52-612Z-ic7g26Qn3W8I_06EhyQ0c.json`, 58 chars)
 * pushed the mode switch and the copy/reload buttons out of the panel entirely,
 * because the filename could not shrink. In a `wrap="nowrap"` row this comes down
 * to two properties, and both halves are easy to half-fix:
 *
 *   - `flex: 1` alone still overflows, because a flex item's automatic minimum
 *     size is its content width — `minWidth: 0` is what unlocks the shrink;
 *   - `minWidth: 0` alone leaves the name at its natural width with no claim on
 *     the leftover space.
 *
 * Neither omission throws or warns; the panel just quietly loses its buttons
 * again for long names, which is why these are asserted rather than eyeballed.
 */
describe("file viewer header flex roles", () => {
	it("lets the filename both grow into and shrink out of the leftover space", () => {
		expect(HEADER_FLEXIBLE_STYLE.flex).toBe(1);
		// The half that actually permits truncation.
		expect(HEADER_FLEXIBLE_STYLE.minWidth).toBe(0);
	});

	it("keeps the controls at their natural size", () => {
		// A shrunk SegmentedControl is unreadable and its options unclickable, so the
		// name is the side that must give way.
		expect(HEADER_FIXED_STYLE.flexShrink).toBe(0);
	});

	// The two roles are mutually exclusive: giving the flexible item flexShrink: 0
	// is exactly the original bug.
	it("does not let the flexible item opt out of shrinking", () => {
		expect(HEADER_FLEXIBLE_STYLE).not.toHaveProperty("flexShrink", 0);
	});
});

describe("header title text", () => {
	// The header shows the basename (the path goes in the tooltip), so the string
	// under test is what the flex row has to fit.
	it("shows the basename of a deep path, for both separators", () => {
		expect(fileBaseName("/repo/.narrafork/dumps/api-request-2026-08-17.json")).toBe(
			"api-request-2026-08-17.json",
		);
		expect(fileBaseName("C:\\repo\\dumps\\api-request-2026-08-17.json")).toBe(
			"api-request-2026-08-17.json",
		);
	});

	it("falls back to the whole string when there is no separator", () => {
		expect(fileBaseName("notes.txt")).toBe("notes.txt");
	});
});
