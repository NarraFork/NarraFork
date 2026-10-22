import { describe, expect, it } from "bun:test";
import { showHeaderLeadingChrome } from "./header-leading-chrome";

describe("showHeaderLeadingChrome", () => {
	it("shows for standalone narrators without onBack (fallback chain)", () => {
		expect(showHeaderLeadingChrome({ isWorkspacePreview: false })).toBe(true);
	});

	it("shows when the host provides onBack", () => {
		expect(showHeaderLeadingChrome({ isWorkspacePreview: false, onBack: () => {} })).toBe(true);
	});

	it("always hides in workspace previews", () => {
		expect(
			showHeaderLeadingChrome({
				isWorkspacePreview: true,
				onBack: () => {},
			}),
		).toBe(false);
	});

	it("always hides when onMinimize is set (the host owns the leading slot)", () => {
		expect(
			showHeaderLeadingChrome({
				isWorkspacePreview: false,
				onMinimize: () => {},
				onBack: () => {},
			}),
		).toBe(false);
	});
});
