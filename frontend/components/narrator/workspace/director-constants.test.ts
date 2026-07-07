import { describe, expect, test } from "bun:test";
import {
	computeDirectorFrames,
	DEFAULT_DIRECTOR_PRIMARY_RATIO,
	DIRECTOR_PADDING,
	type DirectorLeaf,
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

	test("portrait → rail on top, primary below; secondaries laid out in a grid", () => {
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
