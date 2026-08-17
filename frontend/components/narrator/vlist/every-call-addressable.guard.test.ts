/**
 * every-call-addressable.guard.test.ts — the invariant CONTRACT.md states for the
 * fold: **at every LOD, every tool call must be addressable.**
 *
 * Addressable means the reader can reach that specific call: it either has its own
 * card (`tool-call` / `subagent-card`, identified by `unitId`), or it is a NAMED row
 * inside a trace. A `tool-run-count` line satisfies neither — it has no rows at all,
 * only "工具调用 ×N" — so it must never be the ONLY place a call lands.
 *
 * Why a guard rather than a normal case: the fold is chosen per level and per item
 * (active / permission-blocked / pinned tasks calls opt out), and the historical bug
 * was a whole tool-run escaping the activity fold and collapsing into a count line,
 * making its other calls unreachable at low LOD. That failure is invisible in any
 * single-level test — the level that lost the call still rendered something.
 *
 * Removing the old L3 (the "tool-run summary block" level) changed which folds exist,
 * so this sweeps the whole scale rather than the level that happened to be edited.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { AdapterContext, AdapterRenderUnit } from "@shared/pretext-layout/segment-adapter";
import { segmentMessages } from "../message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { MAX_RENDER_LOD, MIN_RENDER_LOD, type RenderLod } from "../RenderLodCtx";
import { groupRenderUnits } from "../render-units";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

const ALL_LEVELS: RenderLod[] = Array.from(
	{ length: MAX_RENDER_LOD - MIN_RENDER_LOD + 1 },
	(_v, i) => (MIN_RENDER_LOD + i) as RenderLod,
);

/** One assistant message owning a single tool call. */
function toolMessage(id: string, toolUseId: string, status = "success"): NarratorMsg {
	const call = {
		toolUseId,
		toolName: "Read",
		status,
		inputJson: { file_path: `/${toolUseId}.ts` },
		outputJson: { _text: "line1\nline2\n" },
	};
	return {
		id,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name: "Read", input: call.inputJson }],
		toolCalls: [call],
		children: [],
	} as unknown as NarratorMsg;
}

/** Every tool-use id the specs make addressable (own card, or a named trace row). */
function addressableIds(
	specs: readonly { kind: string; data: unknown; key: string }[],
): Set<string> {
	const ids = new Set<string>();
	for (const spec of specs) {
		if (spec.kind === "tool-call" || spec.kind === "subagent-card") {
			// A card addresses exactly the call it renders.
			const id = (spec.data as { toolUseId?: string }).toolUseId;
			if (id) ids.add(id);
			continue;
		}
		// A trace addresses each call it emitted a NAMED row for. Rows key on
		// `tool-<toolUseId>` (see toolItemKey), which is what the reader clicks.
		const items = (spec.data as { items?: { key?: string; title?: string }[] }).items;
		if (!Array.isArray(items)) continue;
		for (const row of items) {
			if (!row?.key?.startsWith("tool-")) continue;
			// A row with no title would be a blank line, i.e. not actually addressable.
			if (!row.title || row.title.length === 0) continue;
			ids.add(row.key.slice("tool-".length).replace(/#\d+$/, ""));
		}
	}
	return ids;
}

/**
 * Adapt the messages at one level exactly as the document pipeline would.
 *
 * The casts are deliberately narrowed to the payload FIELDS whose frontend and
 * shared shapes differ structurally. Casting the whole unit array and the context
 * (`as never`) would also switch off checking of the arguments themselves, so a
 * future required `AdapterContext` field — one gating which rows a fold emits —
 * would leave this guard passing on an under-specified context while production
 * produced unaddressable rows. That is the exact class of bug this file exists to
 * catch, so the context is passed as a checked `AdapterContext`.
 */
async function adaptAtLod(messages: NarratorMsg[], lod: RenderLod) {
	const { adaptRenderUnits } = await import("@shared/pretext-layout/segment-adapter");
	const ctx: AdapterContext = { lod };
	// `lod <= 2` is the same gate `buildPretextDocumentLayout` applies.
	const units = groupRenderUnits(segmentMessages(messages), lod <= 2);
	const adapterUnits: AdapterRenderUnit[] = units.map((unit, index) =>
		unit.kind === "activity"
			? {
					kind: "activity" as const,
					key: `activity-${unit.sourceMessages[0]?.id ?? "unknown"}-${index}`,
					items: unit.items as never,
					sourceMessages: unit.sourceMessages as never,
				}
			: { kind: "segment" as const, seg: unit.seg as never },
	);
	return adaptRenderUnits(adapterUnits, ctx);
}

describe("every tool call is addressable at every LOD (protected invariant)", () => {
	it("a plain batch of completed calls", async () => {
		const messages = [
			toolMessage("m1", "tu-1"),
			toolMessage("m2", "tu-2"),
			toolMessage("m3", "tu-3"),
		];
		const missing: string[] = [];
		for (const lod of ALL_LEVELS) {
			const ids = addressableIds(await adaptAtLod(messages, lod));
			for (const expected of ["tu-1", "tu-2", "tu-3"]) {
				if (!ids.has(expected)) missing.push(`L${lod}: ${expected}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("a batch whose middle call is blocked on a permission decision", async () => {
		// The blocked call keeps its own card; the invariant is about its NEIGHBOURS,
		// which historically got downgraded to an anonymous count line with it.
		const messages = [
			toolMessage("m1", "tu-1"),
			toolMessage("m2", "tu-blocked", "pending"),
			toolMessage("m3", "tu-3"),
		];
		const missing: string[] = [];
		for (const lod of ALL_LEVELS) {
			const ids = addressableIds(await adaptAtLod(messages, lod));
			for (const expected of ["tu-1", "tu-blocked", "tu-3"]) {
				if (!ids.has(expected)) missing.push(`L${lod}: ${expected}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("a batch interleaved with reasoning (the activity fold's real input)", async () => {
		const reasoning = {
			id: "r1",
			role: "assistant",
			contentJson: [{ type: "reasoning", text: "**Look it up**\n\nchecking the cache" }],
			toolCalls: [],
			children: [],
		} as unknown as NarratorMsg;
		const messages = [toolMessage("m1", "tu-1"), reasoning, toolMessage("m2", "tu-2")];
		const missing: string[] = [];
		for (const lod of ALL_LEVELS) {
			const ids = addressableIds(await adaptAtLod(messages, lod));
			for (const expected of ["tu-1", "tu-2"]) {
				if (!ids.has(expected)) missing.push(`L${lod}: ${expected}`);
			}
		}
		expect(missing).toEqual([]);
	});
});
