/**
 * morph-group-id.test.ts — `spec.morphGroupId` must identify one activity group
 * IDENTICALLY at every LOD.
 *
 * ## What broke, and why nothing caught it
 *
 * The morph admission window judges a group's members on the group's box rather than
 * their own, because the two forms differ by an order of magnitude: folded, a 12-tool
 * group is one ~228px trace; expanded, it is 12 cards spanning ~4800px. Judged
 * individually, the later cards sit outside the window that all the folded rows sit
 * inside, so they pair with nothing and teleport while their neighbours ease.
 *
 * That box used to be accumulated from `spec.unitStart` — which fails at exactly the
 * level it is needed. `groupRenderUnits(segments, lod <= 2)` turns grouping OFF at
 * L3+, so every spec starts its own render unit, `unitStart` is true for all of them,
 * and the "group" box collapses to each element's own box. Measured on a 12-tool group
 * at scrollTop 9500: 3 of 12 members paired, versus all 12 with a real group box.
 *
 * It was invisible because `admitPair` takes the union of both frames and rescues
 * missing counterparts, which masks the degeneration at most scroll positions — the
 * loss only appears deep inside the expanded group's extent. So this asserts the
 * INVARIANT (both levels agree on membership) rather than a pixel outcome.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { RenderLod } from "../lod/RenderLodCtx";
import type { NarratorMsg } from "../narrator-panel-types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextDocumentLayout } from "./pretext-document-layout";

beforeAll(() => {
	installCanvasStub();
});

let seq = 0;

function toolMessage(id: string, toolUseId: string): NarratorMsg {
	seq += 1;
	return {
		id,
		narratorId: "n1",
		seq,
		role: "assistant",
		contentJson: [
			{ type: "tool_use", id: toolUseId, name: "Read", input: { file_path: `/${toolUseId}.ts` } },
		],
		toolCalls: [
			{
				toolUseId,
				toolName: "Read",
				status: "success",
				inputJson: { file_path: `/${toolUseId}.ts` },
				outputJson: { _text: "line1\nline2\n" },
			},
		],
		children: [],
		parentToolUseId: null,
		createdAt: "2026-07-23T00:00:00.000Z",
	} as unknown as NarratorMsg;
}

/** An assistant message holding one reasoning run of `blockCount` blocks. */
function reasoningMessage(id: string, blockCount: number): NarratorMsg {
	seq += 1;
	return {
		id,
		model: "gpt-5.6",
		narratorId: "n1",
		seq,
		role: "assistant",
		contentJson: Array.from({ length: blockCount }, (_v, i) => ({
			type: "thinking",
			thinking: `**步骤 ${i + 1}**\n\n第 ${i + 1} 段推理正文，长到足以产生一个 step。`,
		})),
		toolCalls: [],
		children: [],
		parentToolUseId: null,
		createdAt: "2026-07-23T00:00:00.000Z",
	} as unknown as NarratorMsg;
}

function answerMessage(id: string, text: string): NarratorMsg {
	seq += 1;
	return {
		id,
		narratorId: "n1",
		seq,
		role: "assistant",
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		children: [],
		parentToolUseId: null,
		createdAt: "2026-07-23T00:00:00.000Z",
	} as unknown as NarratorMsg;
}

/** `unitId` → `morphGroupId` for every spec carrying an identity, at one level. */
function groupsAt(messages: NarratorMsg[], lod: RenderLod): Map<string, string | undefined> {
	const built = buildPretextDocumentLayout(messages, {
		lod,
		documentRevision: 1,
		layoutRevision: "r1",
		widthBucket: "860",
		contentWidth: 860,
		viewportHeight: 720,
	} as never);
	const out = new Map<string, string | undefined>();
	for (const item of built.items) {
		if (item.spec.unitId) out.set(item.spec.unitId, item.spec.morphGroupId);
		// A `reasoning-steps` trace has no `unitId` of its own: the identities are on its
		// step rows, and the GROUP is a property of the containing spec (that is the box
		// the admission window uses), so the steps inherit the container's label here.
		const steps = (item.spec.data as { steps?: { unitId?: string }[] } | undefined)?.steps;
		if (!Array.isArray(steps)) continue;
		for (const step of steps) {
			if (step?.unitId) out.set(step.unitId, item.spec.morphGroupId);
		}
	}
	return out;
}

describe("morphGroupId — one activity group, one id at every level", () => {
	it("gives every card of an expanded group the SAME id", () => {
		const messages = Array.from({ length: 12 }, (_v, i) => toolMessage(`m${i}`, `tu-${i}`));
		const groups = groupsAt(messages, 5);
		expect(groups.size).toBe(12);
		const ids = [...groups.values()];
		// One shared id, and it is actually present — `undefined` for all 12 would also
		// make a naive "all equal" assertion pass while restoring the old bug.
		expect(ids[0]).toBeTruthy();
		expect(new Set(ids).size).toBe(1);
	});

	/**
	 * The regression itself: at L3+ every spec is `unitStart`, so an id derived from
	 * that flag differs per element. A shared id proves the grouping was computed
	 * independently of the level.
	 */
	it("does not degenerate to one id per element at high LOD", () => {
		const messages = Array.from({ length: 6 }, (_v, i) => toolMessage(`m${i}`, `tu-${i}`));
		for (const lod of [3, 4, 5] as RenderLod[]) {
			const ids = [...groupsAt(messages, lod).values()];
			expect(new Set(ids).size).toBe(1);
			expect(ids[0]).toBeTruthy();
		}
	});

	it("keeps a group's members together across the L2/L3 boundary", () => {
		const messages = Array.from({ length: 4 }, (_v, i) => toolMessage(`m${i}`, `tu-${i}`));
		const expanded = groupsAt(messages, 3);
		// The folded side renders one trace whose ROWS carry the identities, so the
		// spec-level map is empty there; membership is asserted on the expanded side,
		// which is where the degeneration lived.
		expect(new Set(expanded.values()).size).toBe(1);
		for (const toolUseId of ["tu-0", "tu-1", "tu-2", "tu-3"]) {
			expect(expanded.get(`tool-${toolUseId}`)).toBeTruthy();
		}
	});

	/**
	 * Reasoning interleaved between tools is the case the whole morph effort was about,
	 * and its identity is per STEP (`reason-<msg>-b<run>-s<step>`) while the group map
	 * is registered per RUN. If the step suffix were not stripped on lookup, these steps
	 * would silently miss the group they belong to.
	 */
	it("labels the steps of an interleaved reasoning run with the group id", () => {
		const messages = [
			toolMessage("m0", "tu-0"),
			reasoningMessage("m1", 2),
			toolMessage("m2", "tu-1"),
		];
		const groups = groupsAt(messages, 3);
		const toolGroup = groups.get("tool-tu-0");
		expect(toolGroup).toBeTruthy();
		const stepEntries = [...groups.entries()].filter(([id]) => id.startsWith("reason-m1-b"));
		expect(stepEntries.length).toBeGreaterThan(0);
		// Same group as the tools they sit between — not a group of their own.
		for (const [, groupId] of stepEntries) expect(groupId).toBe(toolGroup);
	});

	/** Two groups separated by answer text must not share an id. */
	it("separates groups split by visible answer text", () => {
		const messages = [
			toolMessage("m0", "tu-a0"),
			toolMessage("m1", "tu-a1"),
			answerMessage("m2", "这是可见的回答文本，会切断活动组。"),
			toolMessage("m3", "tu-b0"),
			toolMessage("m4", "tu-b1"),
		];
		const groups = groupsAt(messages, 3);
		const first = groups.get("tool-tu-a0");
		const second = groups.get("tool-tu-b0");
		expect(first).toBeTruthy();
		expect(second).toBeTruthy();
		expect(first).not.toBe(second);
		// And each group is internally consistent.
		expect(groups.get("tool-tu-a1")).toBe(first);
		expect(groups.get("tool-tu-b1")).toBe(second);
	});

	/**
	 * A LONE call gets no group id: labelling it would only make it judged on a box
	 * identical to its own, and a group of one has no sibling to be co-admitted with.
	 */
	it("leaves a solitary call ungrouped", () => {
		const groups = groupsAt([toolMessage("m0", "tu-only")], 3);
		expect(groups.get("tool-tu-only")).toBeUndefined();
	});

	/** A document body is not part of any group and must stay unlabelled. */
	it("does not label document bodies", () => {
		const built = buildPretextDocumentLayout(
			[answerMessage("m0", "纯回答文本，不属于任何活动组。")],
			{
				lod: 5,
				documentRevision: 1,
				layoutRevision: "r1",
				widthBucket: "860",
				contentWidth: 860,
				viewportHeight: 720,
			} as never,
		);
		expect(built.items.length).toBeGreaterThan(0);
		for (const item of built.items) expect(item.spec.morphGroupId).toBeUndefined();
	});
});
