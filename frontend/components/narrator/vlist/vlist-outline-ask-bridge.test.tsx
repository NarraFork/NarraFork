import { describe, expect, it } from "bun:test";
import { OutlineQuestionsForm } from "@frontend/components/outline/OutlineQuestions";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pruneHeightOverrides } from "./vlist-height-overrides";
import { useOutlineAskSlots } from "./vlist-outline-ask-bridge";
import type { VListItem } from "./vlist-pipeline";
import type { VListToolMeta } from "./vlist-tool-meta";

function item(id: string, opened = true): VListItem {
	return {
		spec: { key: `tool-${id}`, kind: "tool-call", data: {} },
		measured: { effectiveOpened: opened },
	} as unknown as VListItem;
}

const tools = new Map<string, VListToolMeta>([
	[
		"first",
		{
			outlineAsk: {
				questionRootIds: ["parent", "other"],
				questionIds: ["parent", "child", "other"],
			},
		},
	],
	["second", { outlineAsk: { questionRootIds: ["next"], questionIds: ["next"] } }],
	["legacy", { toolName: "Ask" }],
]);

function slots(renderItems: VListItem[], enabled?: boolean): ReadonlyMap<string, ReactNode> {
	let result: ReadonlyMap<string, ReactNode> = new Map();
	function Probe() {
		result = useOutlineAskSlots({ renderItems, tools, enabled });
		return null;
	}
	renderToStaticMarkup(<Probe />);
	return result;
}

describe("Outline Ask private form bridge", () => {
	it("defaults to static replay; a public/default surface mounts no private API consumer", () => {
		expect(slots([item("first")]).size).toBe(0);
		expect(slots([item("first")], false).size).toBe(0);
	});

	it("mounts exactly one shared form per call with distinct root and answer allowlists", () => {
		const result = slots([item("first"), item("second"), item("legacy")], true);
		expect(result.size).toBe(2);
		const first = result.get("tool-first") as ReactElement<Record<string, unknown>>;
		expect(first.type).toBe(OutlineQuestionsForm);
		expect(first.props).toMatchObject({
			blockId: "parent",
			questionRootIds: ["parent", "other"],
			questionIds: ["parent", "child", "other"],
		});
		const second = result.get("tool-second") as ReactElement<Record<string, unknown>>;
		expect(second.props).toMatchObject({
			blockId: "next",
			questionRootIds: ["next"],
			questionIds: ["next"],
		});
	});

	it("unmounts on collapse and removes the dynamic height in that same render", () => {
		const expanded = slots([item("first")], true);
		const heights = new Map([["tool-first", 620]]);
		expect(pruneHeightOverrides(heights, new Set(expanded.keys()))).toBeNull();
		const collapsed = slots([item("first", false)], true);
		expect(collapsed.size).toBe(0);
		expect(pruneHeightOverrides(heights, new Set(collapsed.keys()))?.size).toBe(0);
		expect(slots([item("first")], true).size).toBe(1);
	});
});
