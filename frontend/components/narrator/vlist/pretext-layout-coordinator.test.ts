import { beforeAll, describe, expect, it } from "bun:test";
import type { PretextDocumentPageResult, TreeMessage } from "@frontend/lib/api/types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { PretextLayoutCoordinator } from "./pretext-layout-coordinator";

beforeAll(() => {
	installCanvasStub();
});

function message(seq: number, text: string): TreeMessage {
	return {
		id: `m-${seq}`,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		createdAt: "2026-07-23T00:00:00.000Z",
		children: [],
		seq,
	} as TreeMessage;
}

function page(): PretextDocumentPageResult {
	return {
		messages: [message(0, "one"), message(1, "two")],
		minSeq: 0,
		maxSeq: 1,
		hasNext: false,
		messageVersion: 3,
		pruneBoundaryMessageId: "m-0",
		prunedPercent: 25,
	};
}

const buildOptions = {
	lod: 5 as const,
	widthBucket: "860",
	contentWidth: 860,
	viewportHeight: 720,
	topPadding: 16,
	bottomPadding: 16,
	gap: 4,
};

describe("PretextLayoutCoordinator", () => {
	it("keeps the old document unavailable until the complete input is laid out", async () => {
		const coordinator = new PretextLayoutCoordinator();
		const states: string[] = [];
		coordinator.subscribe(() => states.push(coordinator.getSnapshot().status));
		const result = await coordinator.load("n1", buildOptions, {
			fetchPage: async () => page(),
		});
		expect(result.status).toBe("ready");
		expect(result.index?.totalHeight).toBeGreaterThan(32);
		expect(result.items ?? []).toHaveLength(result.manifest?.items.length ?? 0);
		expect(result.input?.pruneBoundaryMessageId).toBe("m-0");
		expect(result.input?.prunedPercent).toBe(25);
		expect(result.items?.some((item) => item.spec.kind === "prune-divider")).toBe(true);
		expect((result.items ?? []).map((item) => item.measured.height)).toEqual(
			result.manifest?.items.map((item) => item.height) ?? [],
		);
		expect(states).toEqual(["loading", "ready"]);
	});

	it("rebuilds the same document for a new LOD and returns an anchor correction", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		const current = coordinator.getSnapshot().index;
		if (!current) throw new Error("expected layout");
		const anchor = {
			kind: "item" as const,
			itemKey: current.manifest.items[0]?.itemKey ?? "",
			offsetWithinItem: 4,
			fallbackIndex: 0,
		};
		const rebuilt = coordinator.rebuild({ ...buildOptions, lod: 2 }, anchor, 720);
		expect(rebuilt.status).toBe("ready");
		if (!rebuilt.index || !rebuilt.manifest) throw new Error("expected rebuilt layout");
		expect(rebuilt.scrollTop).toBe(rebuilt.index.itemStart(0) + 4);
		expect(rebuilt.scrollTopAnchorKind).toBe("item");
		expect(rebuilt.manifest.lod).toBe(2);
	});

	it("marks bottom corrections separately so a footer can be applied only there", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		const rebuilt = coordinator.rebuild(
			buildOptions,
			{ kind: "bottom", distanceFromBottom: 0 },
			720,
		);
		expect(rebuilt.scrollTopAnchorKind).toBe("bottom");
	});

	it("clamps a non-bottom anchor when the anchored item becomes shorter", async () => {
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", buildOptions, { fetchPage: async () => page() });
		const current = coordinator.getSnapshot().index;
		if (!current) throw new Error("expected layout");
		const rebuilt = coordinator.rebuild(
			buildOptions,
			{
				kind: "item",
				itemKey: current.manifest.items[0]?.itemKey ?? "",
				offsetWithinItem: Number.MAX_SAFE_INTEGER,
				fallbackIndex: 0,
			},
			720,
		);
		if (!rebuilt.index) throw new Error("expected rebuilt layout");
		expect(rebuilt.scrollTop).toBe(rebuilt.index.itemEnd(0));
	});
});
