import { describe, expect, test } from "bun:test";
import {
	computeDirectorFrames,
	DEFAULT_DIRECTOR_PRIMARY_RATIO,
	DIRECTOR_PADDING,
	DIRECTOR_SECONDARY_MAX_PORTRAIT,
	DIRECTOR_SECONDARY_TARGET_PORTRAIT_WIDTH,
	type DirectorLeaf,
	directorRailIndexAtX,
	isDirectorRenderablePanel,
	MAX_DIRECTOR_PRIMARY_RATIO,
	MIN_DIRECTOR_PRIMARY_RATIO,
	normalizeDirectorPrimaryRatio,
	previewScaleForWidth,
	resolvePrimaryLeaf,
} from "./director-constants";
import type { WorkspacePanelParams } from "./panel-types";

const narratorParams = (id: string): WorkspacePanelParams => ({
	panelType: "narrator",
	narratorId: id,
});

const leaf = (id: string): DirectorLeaf => ({
	id,
	params: narratorParams(id),
	title: id,
});

describe("isDirectorRenderablePanel", () => {
	test("includes plugin panels as top-level director leaves", () => {
		expect(
			isDirectorRenderablePanel({
				panelType: "plugin",
				schemaVersion: 1,
				pluginId: "com.example.review",
				contributionId: "dashboard",
				panelInstanceId: "pui-review",
				binding: {
					kind: "workspace-narrator",
					workspaceId: "workspace-1",
					ownerNarratorId: "narrator-1",
				},
			}),
		).toBe(true);
	});

	test("excludes narrator tool and subagent resource panels", () => {
		expect(
			isDirectorRenderablePanel({
				panelType: "narrator-tool",
				toolType: "terminal",
				narratorId: "narrator-1",
			}),
		).toBe(false);
		expect(
			isDirectorRenderablePanel({
				panelType: "subagent",
				hostNarratorId: "narrator-1",
				subagentNarratorId: "subagent-1",
			}),
		).toBe(false);
	});
});

describe("normalizeDirectorPrimaryRatio", () => {
	test("clamps below min and above max", () => {
		expect(normalizeDirectorPrimaryRatio(0.1)).toBe(MIN_DIRECTOR_PRIMARY_RATIO);
		expect(normalizeDirectorPrimaryRatio(0.99)).toBe(MAX_DIRECTOR_PRIMARY_RATIO);
	});
	test("passes through in-range values", () => {
		expect(normalizeDirectorPrimaryRatio(0.7)).toBe(0.7);
	});
	test("falls back to default for NaN / null / undefined", () => {
		expect(normalizeDirectorPrimaryRatio(Number.NaN)).toBe(DEFAULT_DIRECTOR_PRIMARY_RATIO);
		expect(normalizeDirectorPrimaryRatio(null)).toBe(DEFAULT_DIRECTOR_PRIMARY_RATIO);
		expect(normalizeDirectorPrimaryRatio(undefined)).toBe(DEFAULT_DIRECTOR_PRIMARY_RATIO);
	});
});

describe("resolvePrimaryLeaf", () => {
	const leaves = [leaf("a"), leaf("b"), leaf("c")];
	test("uses primaryPanelId when it matches a live leaf", () => {
		expect(resolvePrimaryLeaf(leaves, "b")?.id).toBe("b");
	});
	test("falls back to first leaf when id is null", () => {
		expect(resolvePrimaryLeaf(leaves, null)?.id).toBe("a");
	});
	test("falls back to first leaf when id no longer exists", () => {
		expect(resolvePrimaryLeaf(leaves, "gone")?.id).toBe("a");
	});
	test("returns undefined when there are no leaves", () => {
		expect(resolvePrimaryLeaf([], "a")).toBeUndefined();
	});
});

describe("computeDirectorFrames", () => {
	test("single panel (no secondaries) → rail collapses to 0, primary fills minus padding", () => {
		const { railThickness, primaryFrame, secondaryFrames } = computeDirectorFrames({
			width: 1000,
			height: 800,
			isLandscape: true,
			secondaryCount: 0,
			primaryRatio: 0.72,
		});
		expect(railThickness).toBe(0);
		expect(secondaryFrames).toHaveLength(0);
		expect(primaryFrame).toEqual({
			left: DIRECTOR_PADDING,
			top: DIRECTOR_PADDING,
			width: 1000 - DIRECTOR_PADDING * 2,
			height: 800 - DIRECTOR_PADDING * 2,
		});
	});

	test("landscape → primary on the left, secondaries stacked vertically in the right rail", () => {
		const { railThickness, primaryFrame, secondaryFrames } = computeDirectorFrames({
			width: 1000,
			height: 800,
			isLandscape: true,
			secondaryCount: 2,
			primaryRatio: 0.7,
		});
		// rail = clamp(round(1000*0.3)=300, min 220, max 360) = 300
		expect(railThickness).toBe(300);
		expect(primaryFrame.left).toBe(DIRECTOR_PADDING);
		expect(primaryFrame.width).toBe(1000 - 300 - DIRECTOR_PADDING * 2);
		expect(secondaryFrames).toHaveLength(2);
		// both secondaries live in the right rail at the same left
		expect(secondaryFrames[0].left).toBe(1000 - 300 + DIRECTOR_PADDING);
		expect(secondaryFrames[1].left).toBe(secondaryFrames[0].left);
		// second is stacked below the first
		expect(secondaryFrames[1].top).toBeGreaterThan(secondaryFrames[0].top);
	});

	test("portrait → rail on top, primary below; secondaries in one row", () => {
		const { railThickness, primaryFrame, secondaryFrames } = computeDirectorFrames({
			width: 600,
			height: 1000,
			isLandscape: false,
			secondaryCount: 3,
			primaryRatio: 0.7,
		});
		// rail = clamp(round(1000*0.3)=300, min 180, max 360) = 300
		expect(railThickness).toBe(300);
		expect(primaryFrame.top).toBe(300 + DIRECTOR_PADDING);
		expect(primaryFrame.width).toBe(600 - DIRECTOR_PADDING * 2);
		expect(secondaryFrames).toHaveLength(3);
		// One row: every preview shares the rail's top edge and full rail height,
		// strictly marching right — never wrapping into a grid.
		for (const frame of secondaryFrames) {
			expect(frame.top).toBe(DIRECTOR_PADDING);
			expect(frame.height).toBe(300 - DIRECTOR_PADDING * 2);
		}
		expect(secondaryFrames[1].top).toBe(secondaryFrames[0].top);
		expect(secondaryFrames[1].left).toBeGreaterThan(secondaryFrames[0].left);
		expect(secondaryFrames[2].left).toBeGreaterThan(secondaryFrames[1].left);
		// Everything fits: the row shares the rail width exactly (no scrolling).
		const last = secondaryFrames[secondaryFrames.length - 1];
		expect(Math.round(last.left + last.width + DIRECTOR_PADDING)).toBe(600);
	});

	test("portrait → an overflowing rail holds the target width instead of wrapping", () => {
		const { secondaryFrames } = computeDirectorFrames({
			width: 390,
			height: 844,
			isLandscape: false,
			secondaryCount: 8,
			primaryRatio: 0.7,
		});
		expect(secondaryFrames).toHaveLength(8);
		// Sharing 390px across 8 previews would crush them to ~40px; the row holds
		// the 140px target width and overflows instead (the surface scrolls it).
		for (const frame of secondaryFrames) {
			expect(frame.width).toBe(DIRECTOR_SECONDARY_TARGET_PORTRAIT_WIDTH);
			expect(frame.top).toBe(DIRECTOR_PADDING);
		}
		const last = secondaryFrames[secondaryFrames.length - 1];
		expect(last.left + last.width).toBeGreaterThan(390);
	});

	test("portrait → a lone secondary caps at the max width instead of filling the rail", () => {
		const { secondaryFrames } = computeDirectorFrames({
			width: 1000,
			height: 700,
			isLandscape: false,
			secondaryCount: 1,
			primaryRatio: 0.7,
		});
		expect(secondaryFrames).toHaveLength(1);
		expect(secondaryFrames[0].width).toBe(DIRECTOR_SECONDARY_MAX_PORTRAIT);
		expect(secondaryFrames[0].left).toBe(DIRECTOR_PADDING);
	});
});

describe("directorRailIndexAtX", () => {
	// Mirrors the single-row portrait frames: 140px items, 8px gaps, 8px padding.
	const frames = [0, 1, 2].map((i) => ({
		left: 8 + i * 148,
		top: 8,
		width: 140,
		height: 200,
	}));

	test("hits a frame, misses the gaps, and stays inside the row", () => {
		expect(directorRailIndexAtX(frames, 8)).toBe(0);
		expect(directorRailIndexAtX(frames, 100)).toBe(0);
		expect(directorRailIndexAtX(frames, 148)).toBe(0); // right edge inclusive
		expect(directorRailIndexAtX(frames, 152)).toBe(-1); // the 8px gap activates nothing
		expect(directorRailIndexAtX(frames, 160)).toBe(1);
		expect(directorRailIndexAtX(frames, 400)).toBe(2);
		expect(directorRailIndexAtX(frames, 7)).toBe(-1); // left padding
		expect(directorRailIndexAtX(frames, 500)).toBe(-1); // past the row
		expect(directorRailIndexAtX([], 10)).toBe(-1);
	});
});

describe("previewScaleForWidth", () => {
	test("narrow previews scale down further", () => {
		expect(previewScaleForWidth(200)).toBe(0.68);
	});
	test("wider previews use the standard scale", () => {
		expect(previewScaleForWidth(400)).toBe(0.82);
	});
});
