import { describe, expect, it } from "bun:test";
import { showHeaderLeadingChrome } from "./header-leading-chrome";

describe("showHeaderLeadingChrome", () => {
	it("shows for standalone narrators without onBack (fallback chain)", () => {
		expect(showHeaderLeadingChrome({ isWorkspacePreview: false })).toBe(true);
	});

	it("hides for chapter-bound narrators without onBack (ChapterBar owns navigation)", () => {
		expect(showHeaderLeadingChrome({ isWorkspacePreview: false, chapterId: "ch1" })).toBe(false);
	});

	it("shows for chapter-bound subagents when the host provides onBack", () => {
		// Regression: subagents inherit the parent's chapterId server-side, so
		// gating on chapterId alone removed the only way back to the parent.
		expect(
			showHeaderLeadingChrome({
				isWorkspacePreview: false,
				chapterId: "ch1",
				onBack: () => {},
			}),
		).toBe(true);
	});

	it("shows for chapter-bound workspace-origin views (onBack returns to the workspace)", () => {
		expect(
			showHeaderLeadingChrome({
				isWorkspacePreview: false,
				chapterId: "ch1",
				onBack: () => {},
			}),
		).toBe(true);
	});

	it("always hides in workspace previews", () => {
		expect(
			showHeaderLeadingChrome({
				isWorkspacePreview: true,
				onBack: () => {},
			}),
		).toBe(false);
	});

	it("always hides when onMinimize is set (graph origin owns the leading slot)", () => {
		expect(
			showHeaderLeadingChrome({
				isWorkspacePreview: false,
				onMinimize: () => {},
				onBack: () => {},
			}),
		).toBe(false);
	});
});
