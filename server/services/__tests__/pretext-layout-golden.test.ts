import { describe, expect, it } from "bun:test";
import { buildPretextEngineLayout } from "@shared/pretext-layout/engine";
import {
	projectPretextLayoutGolden,
	serializePretextLayoutGolden,
} from "@shared/pretext-layout/golden";
import {
	PRETEXT_GOLDEN_OPTIONS,
	PRETEXT_GOLDEN_PROVIDER,
	PRETEXT_GOLDEN_SOURCES,
} from "@shared/pretext-layout/golden-fixture";

describe("shared pretext layout golden fixture", () => {
	it("produces the same deterministic geometry in the Bun/server runtime", () => {
		const built = buildPretextEngineLayout(
			PRETEXT_GOLDEN_SOURCES,
			PRETEXT_GOLDEN_PROVIDER,
			PRETEXT_GOLDEN_OPTIONS,
		);
		const golden = projectPretextLayoutGolden(
			built.manifest,
			built.index.itemStarts,
			built.index.itemEnds,
			built.index.totalHeight,
		);
		expect(golden).toEqual({
			layoutRevision: "golden-layout-1",
			documentRevision: "golden-document-1",
			lod: 4,
			widthBucket: "720",
			metrics: { topPadding: 12, itemGap: 4, bottomPadding: 12 },
			totalHeight: 220,
			items: [
				{
					itemKey: "golden-message-1",
					firstSeq: 1,
					lastSeq: 1,
					sourceMessageIds: ["golden-message-1"],
					kind: "message-bubble",
					height: 30,
					start: 12,
					end: 42,
				},
				{
					itemKey: "golden-tool-run",
					firstSeq: 2,
					lastSeq: 4,
					sourceMessageIds: ["golden-message-2", "golden-message-3", "golden-message-4"],
					kind: "tool-run",
					height: 102,
					start: 46,
					end: 148,
				},
				{
					itemKey: "golden-plan",
					firstSeq: 5,
					lastSeq: 5,
					sourceMessageIds: ["golden-message-5"],
					kind: "plan-card",
					height: 56,
					start: 152,
					end: 208,
				},
			],
		});
		expect(serializePretextLayoutGolden(golden)).toBe(JSON.stringify(golden));
	});
});
