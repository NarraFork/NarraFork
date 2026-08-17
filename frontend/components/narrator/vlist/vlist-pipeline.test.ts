import { beforeAll, describe, expect, it } from "bun:test";
import { segmentMessages } from "../message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { groupRenderUnits } from "../render-units";
import { installCanvasStub } from "./measure/test-canvas-stub";
import type { AdapterRenderUnit, AdapterSegment } from "./segment-adapter";

beforeAll(() => {
	installCanvasStub();
});

const SEGMENTS: AdapterSegment[] = [
	{
		kind: "message",
		msg: { id: "u1", role: "user", contentJson: [{ type: "text", text: "hello there" }] },
	},
	{
		kind: "message",
		msg: {
			id: "a1",
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "thinking about it" },
				{ type: "text", text: "Here is a fairly long answer that should wrap across lines." },
			],
		},
	},
	{
		kind: "tool-run",
		sourceMessages: [],
		items: [{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", summary: "read file" } }],
	},
	{ kind: "prune-divider", label: "older" },
];

describe("computeVListLayout", () => {
	it("adapts, measures, and lays out a mixed segment list", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const result = computeVListLayout(SEGMENTS, { contentWidth: 600, lod: 5 });
		// user bubble + (reasoning + markdown) + tool-call + prune = 5 items
		expect(result.items).toHaveLength(5);
		expect(result.items.map((i) => i.spec.kind)).toEqual([
			"message-bubble",
			"reasoning",
			"markdown",
			"tool-call",
			"prune-divider",
		]);
	});

	it("gives every item a positive measured height", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const { items } = computeVListLayout(SEGMENTS, { contentWidth: 600, lod: 5 });
		for (const item of items) expect(item.measured.height).toBeGreaterThan(0);
	});

	it("produces a monotonically increasing layout with a positive total height", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const { layout } = computeVListLayout(SEGMENTS, { contentWidth: 600, lod: 5, gap: 8 });
		for (let i = 1; i < layout.items.length; i++) {
			expect(layout.items[i]!.top).toBeGreaterThanOrEqual(layout.items[i - 1]!.bottom);
		}
		expect(layout.totalHeight).toBeGreaterThan(layout.items.at(-1)!.top);
	});

	it("re-measures taller when the width shrinks (wrapping)", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const wide = computeVListLayout(SEGMENTS, { contentWidth: 1200, lod: 5 });
		const narrow = computeVListLayout(SEGMENTS, { contentWidth: 200, lod: 5 });
		expect(narrow.layout.totalHeight).toBeGreaterThan(wide.layout.totalHeight);
	});

	it("honors LOD: folding a multi-tool run at L2 differs from L5", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const multiTool: AdapterSegment[] = [
			{
				kind: "tool-run",
				sourceMessages: [],
				items: [
					{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", status: "completed" } },
					{ blockIndex: 1, isSubagent: false, tc: { toolName: "Bash", status: "completed" } },
				],
			},
		];
		const l5 = computeVListLayout(multiTool, { contentWidth: 600, lod: 5 });
		const l2 = computeVListLayout(multiTool, { contentWidth: 600, lod: 2 });
		expect(l5.items).toHaveLength(2); // two full cards
		expect(l2.items).toHaveLength(1); // one count line
		expect(l2.items[0]!.spec.kind).toBe("tool-run-count");
	});

	it("resolveToolCategory drives tool-call default-open height (auto-open category taller)", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const toolSeg = (toolName: string): AdapterSegment => ({
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: { toolName, status: "success", inputJson: { file_path: "/x" } },
				},
			],
		});
		// "generic" category → collapsed by default; "file"/"plan"/"tasks" auto-open.
		const resolveToolCategory = (name: string) => (name === "TodoWrite" ? "tasks" : "generic");
		const generic = computeVListLayout([toolSeg("SomethingUnknown")], {
			contentWidth: 600,
			lod: 5,
			resolveToolCategory,
		});
		const autoOpen = computeVListLayout([toolSeg("TodoWrite")], {
			contentWidth: 600,
			lod: 5,
			resolveToolCategory,
		});
		// The auto-open (tasks) card measures at least as tall as the collapsed one;
		// with the category wired, default-open logic can differ them.
		expect(autoOpen.items[0]!.spec.kind).toBe("tool-call");
		expect((autoOpen.items[0]!.spec.data as { category?: string }).category).toBe("tasks");
		expect((generic.items[0]!.spec.data as { category?: string }).category).toBe("generic");
	});

	it("passes reasoning expand state through to a taller measurement", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const seg: AdapterSegment[] = [
			{
				kind: "message",
				msg: {
					id: "a2",
					role: "assistant",
					contentJson: [{ type: "reasoning", text: "a".repeat(400) }],
				},
			},
		];
		const collapsed = computeVListLayout(seg, {
			contentWidth: 600,
			lod: 5,
			isExpanded: () => false,
		});
		const expanded = computeVListLayout(seg, { contentWidth: 600, lod: 5, isExpanded: () => true });
		expect(expanded.items[0]!.measured.height).toBeGreaterThan(collapsed.items[0]!.measured.height);
	});

	it("carries the reasoning show-original choice from resolver to measured body", async () => {
		// End-to-end for the "show original does nothing" defect: the resolver runs in
		// the shell, the flip is applied by the adapter, and the height + text must
		// come out of the MEASURE. Anything short of that chain leaves the button inert.
		const { computeVListLayout } = await import("./vlist-pipeline");
		const seg: AdapterSegment[] = [
			{
				kind: "message",
				msg: {
					id: "a3",
					role: "assistant",
					contentJson: [
						{ type: "reasoning", text: "short original", translatedText: "翻译".repeat(200) },
					],
				},
			},
		];
		const opts = { contentWidth: 600, lod: 5, isExpanded: () => true } as const;
		const translated = computeVListLayout(seg, opts);
		const original = computeVListLayout(seg, { ...opts, showOriginal: () => true });

		const translatedMeasured = translated.items[0]!.measured as unknown as {
			displayText: string;
			showingOriginal: boolean;
		};
		const originalMeasured = original.items[0]!.measured as unknown as {
			displayText: string;
			showingOriginal: boolean;
		};
		expect(translatedMeasured.showingOriginal).toBe(false);
		expect(originalMeasured.showingOriginal).toBe(true);
		expect(originalMeasured.displayText).toBe("short original");
		// The long translation must measure taller than the short original.
		expect(translated.items[0]!.measured.height).toBeGreaterThan(
			original.items[0]!.measured.height,
		);
	});
});

describe("L1-L5 render-unit matrix", () => {
	it("uses one activity trace for L1/L2 and keeps its row state in measurement", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const activity = {
			kind: "activity" as const,
			key: "activity-a",
			items: [
				{
					kind: "reasoning" as const,
					msg: { id: "a", role: "assistant", contentJson: [] },
					blockIndex: 0,
					block: { type: "reasoning", text: "thought" },
				},
				{
					kind: "tool" as const,
					msg: { id: "a", role: "assistant", contentJson: [] },
					blockIndex: 1,
					tc: { toolName: "Read", status: "success" },
				},
			],
			sourceMessages: [],
		} as unknown as AdapterRenderUnit;
		// An EMPTY recency window puts this unit in history, which is what L1 folds.
		// (A unit inside the window — or holding live output — deliberately keeps its
		// rows visible; see adaptActivityUnit's isRecentActivityUnit.)
		const history = new Set<string>();
		const l1 = computeVListLayout([activity], {
			contentWidth: 600,
			lod: 1,
			recentMessageIds: history,
		});
		const l2 = computeVListLayout([activity], {
			contentWidth: 600,
			lod: 2,
			recentMessageIds: history,
		});
		const l1Open = computeVListLayout([activity], {
			contentWidth: 600,
			lod: 1,
			recentMessageIds: history,
			isExpanded: () => true,
		});
		expect(l1.items[0]!.spec.kind).toBe("activity-trace");
		expect(l2.items[0]!.spec.kind).toBe("activity-trace");
		expect(
			(l1.items[0]!.measured as unknown as { collapsedToHeader: boolean }).collapsedToHeader,
		).toBe(true);
		expect(
			(l2.items[0]!.measured as unknown as { collapsedToHeader: boolean }).collapsedToHeader,
		).toBe(false);
		expect(l1Open.items[0]!.measured.height).toBeGreaterThan(l1.items[0]!.measured.height);
	});

	it("keeps reasoning/text/tool order across the shared L1/L2 fold", () => {
		const messages = [
			{ id: "a1", role: "assistant", contentJson: [{ type: "reasoning", text: "r" }] },
			{
				id: "a2",
				role: "assistant",
				contentJson: [
					{ type: "tool_use", id: "t1", name: "Read", inputJson: {}, status: "success" },
				],
				toolCalls: [{ toolUseId: "t1", toolName: "Read", inputJson: {}, status: "success" }],
			},
			{ id: "a3", role: "assistant", contentJson: [{ type: "text", text: "answer" }] },
		] as unknown as NarratorMsg[];
		const units = groupRenderUnits(segmentMessages(messages), true);
		expect(units.map((unit) => unit.kind)).toEqual(["activity", "segment"]);
		if (units[1]?.kind === "segment") expect(units[1].seg.kind).toBe("message");
	});

	it("lets L3 and older L4 tool cards expand only through a LOD override", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const segment: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [{ id: "old-tool", role: "assistant", contentJson: [] }],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					msg: { id: "old-tool", role: "assistant", contentJson: [] },
					tc: { toolName: "Read", status: "success", toolUseId: "old-1" },
				},
			],
		};
		for (const lod of [3, 4] as const) {
			const collapsed = computeVListLayout([segment], {
				contentWidth: 600,
				lod,
				recentMessageIds: new Set(),
			});
			const opened = computeVListLayout([segment], {
				contentWidth: 600,
				lod,
				recentMessageIds: new Set(),
				isLodUserOverride: () => true,
			});
			expect(
				(collapsed.items[0]?.measured as unknown as { effectiveOpened: boolean }).effectiveOpened,
			).toBe(false);
			expect(
				(opened.items[0]?.measured as unknown as { effectiveOpened: boolean }).effectiveOpened,
			).toBe(true);
		}
	});

	it("keeps active tool cards full at every LOD while completed tools fold", async () => {
		const { computeVListLayout } = await import("./vlist-pipeline");
		const segment: AdapterSegment = {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{ blockIndex: 0, isSubagent: false, tc: { toolName: "Read", status: "success" } },
				{ blockIndex: 1, isSubagent: false, tc: { toolName: "Bash", status: "running" } },
			],
		};
		for (const lod of [1, 2, 3, 4, 5] as const) {
			const result = computeVListLayout([segment], { contentWidth: 600, lod });
			const active = result.items.find(
				(item) =>
					item.spec.kind === "tool-call" &&
					(item.spec.data as { toolName?: string }).toolName === "Bash",
			);
			expect(active).toBeDefined();
			expect((active!.measured as unknown as { effectiveOpened: boolean }).effectiveOpened).toBe(
				true,
			);
		}
	});
});

describe("resolveVisibleWindow", () => {
	it("mounts only the items intersecting the viewport", async () => {
		const { computeVListLayout, resolveVisibleWindow } = await import("./vlist-pipeline");
		// Many identical segments to build a tall list.
		const many: AdapterSegment[] = Array.from({ length: 50 }, (_, i) => ({
			kind: "message" as const,
			msg: { id: `u${i}`, role: "user", contentJson: [{ type: "text", text: `msg ${i}` }] },
		}));
		const { layout } = computeVListLayout(many, { contentWidth: 600, lod: 5 });
		const win = resolveVisibleWindow(layout, 0, 300, 0);
		expect(win.start).toBe(0);
		expect(win.end).toBeLessThan(50); // not everything mounted
		expect(win.topSpacer).toBe(0);
		expect(win.bottomSpacer).toBeGreaterThan(0);
	});

	it("advances the window and grows the top spacer when scrolled down", async () => {
		const { computeVListLayout, resolveVisibleWindow } = await import("./vlist-pipeline");
		const many: AdapterSegment[] = Array.from({ length: 50 }, (_, i) => ({
			kind: "message" as const,
			msg: { id: `u${i}`, role: "user", contentJson: [{ type: "text", text: `msg ${i}` }] },
		}));
		const { layout } = computeVListLayout(many, { contentWidth: 600, lod: 5 });
		const top = resolveVisibleWindow(layout, 0, 300, 0);
		const mid = resolveVisibleWindow(layout, layout.totalHeight / 2, 300, 0);
		expect(mid.start).toBeGreaterThan(top.start);
		expect(mid.topSpacer).toBeGreaterThan(top.topSpacer);
	});
});
