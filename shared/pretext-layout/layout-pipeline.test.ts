import { describe, expect, it } from "bun:test";
import { computePretextVListLayout, resolveVisibleWindow } from "./layout-pipeline";
import type { MeasuredElement } from "./prepared-block";
import type { AdapterRenderUnit } from "./segment-adapter";

function measured(height: number, contentWidth: number): MeasuredElement {
	return {
		height,
		blocks: [],
		frame: { blocks: [], contentHeight: height, usedWidth: contentWidth },
		contentWidth,
		usedWidth: contentWidth,
	};
}

function messageUnit(id: string): AdapterRenderUnit {
	return {
		kind: "segment",
		seg: {
			kind: "message",
			msg: {
				id,
				role: "user",
				contentJson: [{ type: "text", text: id }],
			},
		},
	};
}

describe("shared pretext layout pipeline", () => {
	it("adapts units and delegates only concrete measurement to the runtime", () => {
		const measuredKinds: string[] = [];
		const result = computePretextVListLayout(
			[messageUnit("m1"), messageUnit("m2")],
			{ contentWidth: 640, lod: 5, gap: 4, topPadding: 8, bottomPadding: 12 },
			(kind, _data, contentWidth) => {
				measuredKinds.push(kind);
				return measured(kind === "message-bubble" ? 30 : 40, contentWidth);
			},
		);
		expect(measuredKinds).toEqual(["message-bubble", "message-bubble"]);
		expect(result.layout.items.map((item) => [item.top, item.height, item.bottom])).toEqual([
			[8, 30, 38],
			[42, 30, 72],
		]);
		expect(result.layout.totalHeight).toBe(84);
	});

	it("uses the shared geometry for visible windows and spacers", () => {
		const result = computePretextVListLayout(
			[messageUnit("m1"), messageUnit("m2"), messageUnit("m3")],
			{ contentWidth: 640, lod: 5, gap: 4 },
			() => measured(40, 640),
		);
		const window = resolveVisibleWindow(result.layout, 44, 40);
		expect(window).toEqual({ start: 1, end: 2, topSpacer: 44, bottomSpacer: 44 });
	});
});
