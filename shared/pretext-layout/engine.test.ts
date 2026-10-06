import { describe, expect, it } from "bun:test";
import { buildPretextEngineLayout, type PretextEngineSource } from "./engine";
import { projectPretextLayoutGolden, serializePretextLayoutGolden } from "./golden";

interface FixtureSource extends PretextEngineSource {
	baseHeight: number;
}

const sources: FixtureSource[] = [
	{
		itemKey: "message-1",
		firstSeq: 1,
		lastSeq: 1,
		sourceMessageIds: ["message-1"],
		kind: "message-bubble",
		baseHeight: 40,
	},
	{
		itemKey: "message-2",
		firstSeq: 2,
		lastSeq: 3,
		sourceMessageIds: ["message-2", "message-3"],
		kind: "tool-run",
		baseHeight: 80,
	},
];

function options(contentWidth = 800) {
	return {
		layoutRevision: "layout-1",
		documentRevision: 7,
		lod: 5,
		widthBucket: "800",
		layoutOptionsRevision: "engine-1",
		contentWidth,
		viewportHeight: 720,
		metrics: { topPadding: 8, itemGap: 4, bottomPadding: 8 },
	};
}

describe("shared pretext engine", () => {
	it("runs the same prepare/measure contract for deterministic providers", () => {
		const prepared: string[] = [];
		const built = buildPretextEngineLayout(
			sources,
			{
				prepare: (source, context) => {
					prepared.push(`${source.itemKey}:${context.lod}:${context.widthBucket}`);
					return source;
				},
				measure: (source, context) => source.baseHeight + context.viewportHeight / 100,
			},
			options(),
		);
		expect(prepared).toEqual(["message-1:5:800", "message-2:5:800"]);
		expect(built.manifest.items.map((item) => item.height)).toEqual([47.2, 87.2]);
		expect(built.index.totalHeight).toBe(154.4);
		expect(built.index.itemIndicesForSourceSeq(3)).toEqual([1]);
	});

	it("produces stable cross-runtime golden geometry and changes only with measure context", () => {
		const provider = {
			prepare: (source: FixtureSource) => source,
			measure: (source: FixtureSource, context: { contentWidth: number }) =>
				source.baseHeight + (800 - context.contentWidth) / 10,
		};
		const first = buildPretextEngineLayout(sources, provider, options(800));
		const second = buildPretextEngineLayout(sources, provider, options(800));
		const firstGolden = projectPretextLayoutGolden(
			first.manifest,
			first.index.itemStarts,
			first.index.itemEnds,
			first.index.totalHeight,
		);
		const secondGolden = projectPretextLayoutGolden(
			second.manifest,
			second.index.itemStarts,
			second.index.itemEnds,
			second.index.totalHeight,
		);
		expect(serializePretextLayoutGolden(firstGolden)).toBe(
			serializePretextLayoutGolden(secondGolden),
		);

		const narrower = buildPretextEngineLayout(sources, provider, options(600));
		expect(narrower.manifest.items.map((item) => item.height)).toEqual([60, 100]);
	});

	it("fails closed when a provider returns an invalid height", () => {
		expect(() =>
			buildPretextEngineLayout(
				sources,
				{
					prepare: (source) => source,
					measure: () => Number.NaN,
				},
				options(),
			),
		).toThrow("invalid height");
	});
});
