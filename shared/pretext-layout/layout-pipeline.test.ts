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

/**
 * A tool-run unit whose output is a server-side PREVIEW, i.e. the shape the
 * on-demand full-payload fetch exists for.
 */
function truncatedToolUnit(toolUseId: string): AdapterRenderUnit {
	return {
		kind: "segment",
		seg: {
			kind: "tool-run",
			sourceMessages: [],
			items: [
				{
					blockIndex: 0,
					isSubagent: false,
					tc: {
						toolName: "Read",
						toolUseId,
						status: "success",
						outputJson: { _truncated: true, preview: "first chunk…", fullLength: 40_000 },
					},
				},
			],
		},
	} as unknown as AdapterRenderUnit;
}

/**
 * Every resolver the pipeline must hand to the adapter context.
 *
 * This is the guard for a class of bug the type system cannot catch: the options
 * interface and the ctx literal are written by hand, so a resolver the shell
 * supplies and the adapter reads can be silently dropped in between and
 * everything still compiles. That is what happened to the three below —
 * `resolveFullToolInput` / `resolveFullToolOutput` never reached the adapter, so
 * a fetched payload was never substituted: `truncatedLeafCount` stayed above
 * zero, the row stayed in the shell's "in flight" set, and the truncation notice
 * read "loading full data…" forever.
 */
describe("shared pretext layout pipeline — adapter context forwarding", () => {
	it("hands the adapter every injected resolver", () => {
		const seen: string[] = [];
		const probe = (name: string) => () => {
			seen.push(name);
			return undefined;
		};
		computePretextVListLayout(
			[truncatedToolUnit("tu-1")],
			{
				contentWidth: 640,
				lod: 5,
				resolveToolCategory: () => {
					seen.push("resolveToolCategory");
					return "read";
				},
				resolveToolSummary: () => {
					seen.push("resolveToolSummary");
					return "a.ts";
				},
				resolveHasPendingPermission: () => {
					seen.push("resolveHasPendingPermission");
					return false;
				},
				resolvePendingPlan: probe("resolvePendingPlan"),
				resolveFullToolInput: probe("resolveFullToolInput"),
				resolveFullToolOutput: probe("resolveFullToolOutput"),
				resolvePendingPermissionSuggestions: probe("resolvePendingPermissionSuggestions"),
			},
			(_kind, _data, contentWidth) => measured(40, contentWidth),
		);
		// The output IS truncated, so the adapter must consult the full-payload
		// resolver. A dropped forward shows up here as a missing name.
		expect(seen).toContain("resolveFullToolOutput");
		expect(seen).toContain("resolveToolCategory");
	});

	it("substitutes a fetched payload, which is what clears the truncation notice", () => {
		const FULL = "the complete file body";
		const result = computePretextVListLayout(
			[truncatedToolUnit("tu-1")],
			{
				contentWidth: 640,
				lod: 5,
				resolveToolCategory: () => "read",
				resolveFullToolOutput: (toolUseId) => (toolUseId === "tu-1" ? FULL : undefined),
			},
			(_kind, _data, contentWidth) => measured(40, contentWidth),
		);
		const card = result.items.find((item) => item?.spec.kind === "tool-call");
		const data = card?.spec.data as { truncatedLeafCount?: number };
		// Zero (absent) is the signal the card drops its notice and the shell stops
		// treating the row as loading — the end of the chain this pipeline feeds.
		expect(data).toBeDefined();
		expect("truncatedLeafCount" in (data ?? {})).toBe(false);
	});

	it("keeps the payload counted as truncated while no fetch has resolved", () => {
		const result = computePretextVListLayout(
			[truncatedToolUnit("tu-1")],
			{
				contentWidth: 640,
				lod: 5,
				resolveToolCategory: () => "read",
				resolveFullToolOutput: () => undefined,
			},
			(_kind, _data, contentWidth) => measured(40, contentWidth),
		);
		const card = result.items.find((item) => item?.spec.kind === "tool-call");
		const data = card?.spec.data as { truncatedLeafCount?: number };
		expect(data?.truncatedLeafCount).toBe(1);
	});
});

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
