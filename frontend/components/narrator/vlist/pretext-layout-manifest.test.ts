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

describe("pretext layout manifest deduplication", () => {
	it("does not throw on duplicate itemKeys and deduplicates them deterministically", () => {
		// Simulates provider retry: two assistant messages each produce an item with the
		// same tool_use id → same spec.key (e.g. "tool-tooluse_DtBtRGVTKZhiMWea1BuxVM").
		// We use two messages with the same id to trigger duplicate bubble keys.
		const msg1 = message("m0", "assistant", "first");
		const msg2 = message("m0", "assistant", "second");
		(msg2 as { seq: number }).seq = 30162;
		const renderUnits = [msg1, msg2].map((item) => ({
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
			resolveSource: (spec) => ({
				firstSeq: spec.key.includes("#dup") ? 30162 : 30161,
				lastSeq: spec.key.includes("#dup") ? 30162 : 30161,
				sourceMessageIds: ["m0"],
			}),
		});

		// Must not throw (previously threw "duplicate layout item key")
		expect(built.manifest.items).toHaveLength(2);
		expect(built.items).toHaveLength(2);

		// All itemKeys must be unique
		const keys = built.manifest.items.map((item) => item.itemKey);
		expect(new Set(keys).size).toBe(keys.length);

		// The invariant item.spec.key === manifest.items[i].itemKey must hold
		for (let i = 0; i < built.items.length; i++) {
			expect(built.items[i].spec.key).toBe(built.manifest.items[i].itemKey);
		}

		// Deduped key uses deterministic suffix: first occurrence keeps original, second gets #dup1
		expect(keys[1]).toBe(`${keys[0]}#dup1`);

		// Heights preserved (not altered by dedup)
		expect(built.items.map((item) => item.measured.height)).toEqual(
			built.manifest.items.map((item) => item.height),
		);
	});

	it("does not alter keys when there are no duplicates", () => {
		const messages = [message("m0", "user", "hello"), message("m1", "assistant", "world")];
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
			resolveSource: (spec) => {
				const source = messages.find((item) => spec.key.startsWith(item.id));
				if (!source) throw new Error(`missing source for ${spec.key}`);
				return {
					firstSeq: source.seq as number,
					lastSeq: source.seq as number,
					sourceMessageIds: [source.id],
				};
			},
		});
		const keys = built.manifest.items.map((item) => item.itemKey);
		// No #dup suffixes when all keys are unique
		expect(keys.every((k) => !k.includes("#dup"))).toBe(true);
	});
});

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

describe("pretext layout manifest segment gap", () => {
	function buildWith(segmentGap: number | undefined) {
		const messages = [message("m0", "user", "hi"), message("m1", "assistant", "one\n\ntwo")];
		const renderUnits = messages.map((item) => ({
			kind: "segment" as const,
			seg: { kind: "message" as const, msg: item },
		})) as unknown as AdapterRenderUnit[];
		return buildPretextLayoutManifest({
			layoutRevision: "seg-gap",
			documentRevision: 1,
			lod: 5,
			widthBucket: "860",
			renderUnits,
			contentWidth: 860,
			viewportHeight: 720,
			gap: 4,
			segmentGap,
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
	}

	it("widens the gap after a unit whose next item starts a new unit", () => {
		const built = buildWith(12);
		// Two message units → the boundary between them carries the widened gap.
		expect(built.manifest.items[0]?.gapAfter).toBe(12);
		// The final item never carries a trailing gap.
		expect(built.manifest.items[built.manifest.items.length - 1]?.gapAfter).toBeUndefined();
	});

	it("keeps a taller total height than the uniform-gap build", () => {
		const widened = buildWith(12);
		const uniform = buildWith(undefined);
		expect(widened.index.totalHeight).toBeGreaterThan(uniform.index.totalHeight);
		// Difference is exactly the extra spacing at the single unit boundary (12 − 4).
		expect(widened.index.totalHeight - uniform.index.totalHeight).toBe(8);
	});

	it("does not widen when segmentGap equals the base gap", () => {
		const built = buildWith(4);
		expect(built.manifest.items.every((item) => item.gapAfter === undefined)).toBe(true);
	});
});

// ── Intra-run boundaries carry no gap ────────────────────────────────────────
// A frameless in-run tool card already includes its own trailing 1px Divider in
// its measured height; that divider IS the separator. Adding the base itemGap on
// top of it striped the decorative run frame and made the per-divider cells
// unequal (first cell `h`, every later one `gap + h`) — the "some rows tall,
// some short, text not vertically centred" symptom.
describe("pretext layout manifest in-run gaps", () => {
	function toolMessage(id: string, seq: number, name: string, command: string): NarratorMsg {
		const input = { command };
		return {
			id,
			seq,
			role: "assistant",
			contentJson: [
				{ type: "tool_use", id: `tu-${id}`, name, input, inputJson: input, status: "completed" },
			],
			contentText: null,
			toolCalls: [
				{
					toolUseId: `tu-${id}`,
					toolName: name,
					inputJson: input,
					outputJson: null,
					status: "success",
				},
			],
			children: [],
			parentToolUseId: null,
			createdAt: "2026-07-25T00:00:00.000Z",
		} as unknown as NarratorMsg;
	}

	/** One tool-run of `count` consecutive Bash calls, at full-card LOD 5. */
	function buildRun(count: number) {
		const messages = Array.from({ length: count }, (_, i) =>
			toolMessage(`t${i}`, i + 1, "Bash", `echo ${i}`),
		);
		const renderUnits = segmentMessages(messages) as unknown as AdapterRenderUnit[];
		return buildPretextLayoutManifest({
			layoutRevision: "in-run",
			documentRevision: 1,
			lod: 5,
			widthBucket: "860",
			renderUnits,
			contentWidth: 860,
			viewportHeight: 720,
			gap: 4,
			segmentGap: 12,
			topPadding: 16,
			bottomPadding: 16,
			resolveSource: (_spec, index) => ({
				firstSeq: index + 1,
				lastSeq: index + 1,
				sourceMessageIds: [`t${index}`],
			}),
		});
	}

	it("folds consecutive tool calls into one run of in-run cards", () => {
		const built = buildRun(4);
		expect(built.manifest.items).toHaveLength(4);
		expect(built.manifest.items.every((item) => item.kind === "tool-call")).toBe(true);
		// All but the last card are in-run (frameless + trailing divider).
		const inRun = built.items.map((item) => (item.measured as { inRun?: boolean }).inRun);
		expect(inRun).toEqual([true, true, true, true]);
	});

	it("sets gapAfter 0 on every boundary inside the run", () => {
		const built = buildRun(4);
		// Boundaries 0-1, 1-2, 2-3 are intra-run → no gap. The last item never
		// carries a trailing gap.
		expect(built.manifest.items.slice(0, -1).map((item) => item.gapAfter)).toEqual([0, 0, 0]);
		expect(built.manifest.items[3]?.gapAfter).toBeUndefined();
	});

	it("stacks the cards flush so each divider-to-divider cell is equal", () => {
		const built = buildRun(4);
		const { itemStarts, itemEnds } = built.index;
		// Flush: every card starts exactly where the previous one ended.
		for (let i = 1; i < itemStarts.length; i++) {
			expect(itemStarts[i]).toBe(itemEnds[i - 1]);
		}
		// The non-last cards are identical in height (each = chrome + header +
		// divider); the last one is exactly one divider shorter.
		const heights = built.manifest.items.map((item) => item.height);
		expect(new Set(heights.slice(0, -1)).size).toBe(1);
		expect((heights[0] ?? 0) - (heights[3] ?? 0)).toBe(1);
	});

	it("keeps the run shorter than the pre-fix uniform-gap geometry", () => {
		const built = buildRun(4);
		const heights = built.manifest.items.map((item) => item.height);
		const content = heights.reduce((sum, h) => sum + h, 0);
		// No intra-run gaps at all: total is just padding + the card heights.
		expect(built.index.totalHeight).toBe(16 + content + 16);
	});

	it("still separates a tool-run from a following message with the widened gap", () => {
		const messages = [
			toolMessage("t0", 1, "Bash", "echo 0"),
			toolMessage("t1", 2, "Bash", "echo 1"),
			message("m9", "assistant", "done"),
		];
		const renderUnits = segmentMessages(messages) as unknown as AdapterRenderUnit[];
		const built = buildPretextLayoutManifest({
			layoutRevision: "in-run-then-message",
			documentRevision: 1,
			lod: 5,
			widthBucket: "860",
			renderUnits,
			contentWidth: 860,
			viewportHeight: 720,
			gap: 4,
			segmentGap: 12,
			topPadding: 16,
			bottomPadding: 16,
			resolveSource: (_spec, index) => ({
				firstSeq: index + 1,
				lastSeq: index + 1,
				sourceMessageIds: [`s${index}`],
			}),
		});
		// Inside the run: no gap. At the run → message boundary: the widened gap.
		expect(built.manifest.items[0]?.gapAfter).toBe(0);
		expect(built.manifest.items[1]?.gapAfter).toBe(12);
	});
});
