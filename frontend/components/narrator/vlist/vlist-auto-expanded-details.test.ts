/**
 * vlist-auto-expanded-details.test.ts — Guards the "no height change without a
 * user action" rule at its source.
 *
 * A card that opens BY ITSELF (computeDefaultOpen / LOD 6) must have its full body
 * fetched before the layout is built, or it is measured from a 2000-char preview
 * and then re-measured taller once the async detail lands — a height change nobody
 * asked for. These tests pin down exactly which cards that covers.
 */

import { describe, expect, it } from "bun:test";
import type { NarratorMsg } from "../narrator-panel-types";
import {
	AUTO_EXPANDED_DETAIL_LIMIT,
	autoExpandsAtLod,
	collectAutoExpandedTruncatedToolUses,
	defaultOpensCard,
} from "./vlist-auto-expanded-details";

const TRUNCATED = { _truncated: true, preview: "x".repeat(2000), fullLength: 500_000 };

/** One assistant message carrying a single tool_use block. */
function msgWithTool(opts: {
	id: string;
	name: string;
	status?: string;
	truncated?: "input" | "output" | "none";
	input?: unknown;
	children?: NarratorMsg[];
}): NarratorMsg {
	const truncated = opts.truncated ?? "output";
	return {
		id: `m-${opts.id}`,
		role: "assistant",
		contentJson: [
			{
				type: "tool_use",
				id: opts.id,
				name: opts.name,
				status: opts.status ?? "success",
				inputJson: truncated === "input" ? TRUNCATED : (opts.input ?? { file_path: "/a.ts" }),
				outputJson: truncated === "output" ? TRUNCATED : { ok: true },
			},
		],
		...(opts.children ? { children: opts.children } : {}),
	} as unknown as NarratorMsg;
}

/** Category resolver mirroring the real one for the tools used here. */
const resolveToolCategory = (toolName: string): string => {
	if (toolName === "Read" || toolName === "Write" || toolName === "Edit") return "file";
	if (toolName === "Bash") return "bash";
	if (toolName === "Grep") return "search";
	if (toolName === "ExitPlanMode") return "plan";
	return "generic";
};

function collect(messages: NarratorMsg[], lod = 5, limit?: number): string[] {
	return collectAutoExpandedTruncatedToolUses({
		messages,
		lod: lod as never,
		resolveToolCategory,
		...(limit === undefined ? {} : { limit }),
	});
}

describe("autoExpandsAtLod", () => {
	it("expands everything at LOD 6 and nothing below LOD 5", () => {
		expect(autoExpandsAtLod(6 as never, false)).toBe(true);
		expect(autoExpandsAtLod(5 as never, true)).toBe(true);
		expect(autoExpandsAtLod(5 as never, false)).toBe(false);
		expect(autoExpandsAtLod(4 as never, true)).toBe(false);
		expect(autoExpandsAtLod(1 as never, true)).toBe(false);
	});
});

describe("defaultOpensCard", () => {
	it("opens the auto-open categories without any user input", () => {
		for (const category of [
			"tasks",
			"share",
			"recall",
			"send",
			"pipeline",
			"plan",
			"knowledge",
			"file",
		]) {
			expect(defaultOpensCard(category, "success", true)).toBe(true);
		}
	});

	it("opens await/bash only when a detail body exists", () => {
		expect(defaultOpensCard("bash", "success", true)).toBe(true);
		expect(defaultOpensCard("bash", "success", false)).toBe(false);
		expect(defaultOpensCard("await", "success", true)).toBe(true);
		expect(defaultOpensCard("await", "success", false)).toBe(false);
	});

	it("opens failed and pending calls regardless of category", () => {
		expect(defaultOpensCard("search", "fail", false)).toBe(true);
		expect(defaultOpensCard("search", "pending", false)).toBe(true);
	});

	it("leaves an ordinary successful call closed", () => {
		expect(defaultOpensCard("search", "success", true)).toBe(false);
		expect(defaultOpensCard("generic", "success", true)).toBe(false);
	});
});

describe("collectAutoExpandedTruncatedToolUses", () => {
	it("collects a truncated file card (auto-open category)", () => {
		expect(collect([msgWithTool({ id: "t1", name: "Read" })])).toEqual(["t1"]);
	});

	it("collects a truncated INPUT as well as a truncated output", () => {
		expect(collect([msgWithTool({ id: "t1", name: "Write", truncated: "input" })])).toEqual(["t1"]);
	});

	it("ignores a card whose payload is not truncated", () => {
		expect(collect([msgWithTool({ id: "t1", name: "Read", truncated: "none" })])).toEqual([]);
	});

	it("ignores a card that would stay collapsed at this LOD", () => {
		// A search card does not default-open, so at LOD 5 it paints no body.
		expect(collect([msgWithTool({ id: "t1", name: "Grep" })])).toEqual([]);
		// …but LOD 6 expands everything, so its truncated body must be prefetched.
		expect(collect([msgWithTool({ id: "t1", name: "Grep" })], 6)).toEqual(["t1"]);
	});

	it("collects nothing at collapsed LODs even for auto-open categories", () => {
		const messages = [msgWithTool({ id: "t1", name: "Read" })];
		expect(collect(messages, 4)).toEqual([]);
		expect(collect(messages, 3)).toEqual([]);
		expect(collect(messages, 1)).toEqual([]);
	});

	it("skips in-flight calls whose body is still arriving", () => {
		for (const status of ["running", "pending", "initializing"]) {
			expect(collect([msgWithTool({ id: "t1", name: "Read", status })])).toEqual([]);
		}
	});

	it("collects a failed call in any category", () => {
		expect(collect([msgWithTool({ id: "t1", name: "Grep", status: "fail" })])).toEqual(["t1"]);
	});

	it("walks child (subagent) messages", () => {
		const child = msgWithTool({ id: "c1", name: "Read" });
		const parent = msgWithTool({ id: "t1", name: "Read", children: [child] });
		expect(collect([parent])).toEqual(["t1", "c1"]);
	});

	it("dedupes a tool use seen twice", () => {
		const a = msgWithTool({ id: "dup", name: "Read" });
		const b = msgWithTool({ id: "dup", name: "Read" });
		expect(collect([a, b])).toEqual(["dup"]);
	});

	it("returns ids in document order", () => {
		const messages = [
			msgWithTool({ id: "t1", name: "Read" }),
			msgWithTool({ id: "t2", name: "Write" }),
			msgWithTool({ id: "t3", name: "Edit" }),
		];
		expect(collect(messages)).toEqual(["t1", "t2", "t3"]);
	});

	it("caps the prefetch so one page cannot fan out unbounded", () => {
		const messages = Array.from({ length: 40 }, (_, i) =>
			msgWithTool({ id: `t${i}`, name: "Read" }),
		);
		expect(collect(messages)).toHaveLength(AUTO_EXPANDED_DETAIL_LIMIT);
		expect(collect(messages, 5, 3)).toEqual(["t0", "t1", "t2"]);
		expect(collect(messages, 5, 0)).toEqual([]);
	});

	it("tolerates malformed input without throwing", () => {
		expect(collect([])).toEqual([]);
		expect(
			collectAutoExpandedTruncatedToolUses({
				messages: undefined as unknown as NarratorMsg[],
				lod: 5 as never,
			}),
		).toEqual([]);
		// A message with no contentJson / a non-tool_use block / a missing id.
		const junk = [
			{ id: "m1", role: "assistant" },
			{ id: "m2", role: "assistant", contentJson: [{ type: "text", text: "hi" }] },
			{ id: "m3", role: "assistant", contentJson: [{ type: "tool_use", outputJson: TRUNCATED }] },
		] as unknown as NarratorMsg[];
		expect(collect(junk)).toEqual([]);
	});

	it("treats an absent category resolver as generic (so only fail/pending qualify)", () => {
		const messages = [msgWithTool({ id: "t1", name: "Read" })];
		expect(collectAutoExpandedTruncatedToolUses({ messages, lod: 5 as never })).toEqual([]);
		const failed = [msgWithTool({ id: "t2", name: "Read", status: "fail" })];
		expect(collectAutoExpandedTruncatedToolUses({ messages: failed, lod: 5 as never })).toEqual([
			"t2",
		]);
	});
});
