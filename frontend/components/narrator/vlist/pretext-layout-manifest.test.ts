import { beforeAll, describe, expect, it } from "bun:test";
import { segmentMessages } from "../message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextLayoutManifest } from "./pretext-layout-manifest";
import type { AdapterRenderUnit } from "./segment-adapter";

beforeAll(() => {
	installCanvasStub();
});

function message(id: string, role: "user" | "assistant", text: string): NarratorMsg {
	return {
		id,
		seq: Number(id.slice(1)),
		role,
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		children: [],
		parentToolUseId: null,
		createdAt: "2026-07-23T00:00:00.000Z",
	} as unknown as NarratorMsg;
}

describe("pretext layout manifest integration", () => {
	it("uses the exact current pretext measurement as every scrollbar item's height", () => {
		const messages = [
			message("m0", "user", "short"),
			message("m1", "assistant", "# A heading\n\nA longer markdown body."),
		];
		const renderUnits = messages.map((item) => ({
			kind: "segment" as const,
			seg: { kind: "message" as const, msg: item },
		})) as unknown as AdapterRenderUnit[];
		const built = buildPretextLayoutManifest({
			layoutRevision: "layout-1",
			documentRevision: 1,
			lod: 5,
			widthBucket: "860",
			renderUnits,
			contentWidth: 860,
			viewportHeight: 720,
			gap: 4,
			topPadding: 16,
			bottomPadding: 16,
			resolveSource: (spec) => {
				const source = messages.find((item) => spec.key.startsWith(item.id));
				if (!source) throw new Error(`missing source for ${spec.key}`);
				return {
					firstSeq: source.seq as number,
					lastSeq: source.seq as number,
					sourceMessageIds: [source.id as string],
				};
			},
		});
		expect(built.manifest.items).toHaveLength(2);
		expect(built.items).toHaveLength(built.manifest.items.length);
		expect(built.items.map((item) => item.measured.height)).toEqual(
			built.manifest.items.map((item) => item.height),
		);
		expect(built.manifest.items.every((item) => Number.isFinite(item.height))).toBe(true);
		expect(built.index.totalHeight).toBeGreaterThan(
			built.manifest.metrics.topPadding + built.manifest.metrics.bottomPadding,
		);
		expect(built.index.itemByKey("m0-bubble")?.item.height).toBe(built.manifest.items[0]?.height);
	});

	it("keeps the same pretext-derived heights for repeated builds", () => {
		const source = [message("m0", "assistant", "line one\n\nline two")];
		const renderUnits = segmentMessages(source) as unknown as AdapterRenderUnit[];
		const options = {
			layoutRevision: "layout-1",
			documentRevision: 1,
			lod: 3 as const,
			widthBucket: "860",
			renderUnits,
			contentWidth: 860,
			viewportHeight: 720,
			resolveSource: () => ({ firstSeq: 0, lastSeq: 0, sourceMessageIds: ["m0"] }),
		};
		const first = buildPretextLayoutManifest(options);
		const second = buildPretextLayoutManifest(options);
		expect(second.manifest.items.map((item) => item.height)).toEqual(
			first.manifest.items.map((item) => item.height),
		);
		expect(second.index.totalHeight).toBe(first.index.totalHeight);
	});
});
