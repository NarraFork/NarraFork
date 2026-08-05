/**
 * live-reasoning-tail.test.ts — The L1/L2 folded reasoning row must SCROLL its live
 * text instead of hiding the end, without leaking measurement-cache entries.
 *
 * ── The bug this locks down ───────────────────────────────────────────────────
 *
 * A folded reasoning row labels itself with `segment.title`, falling back to the
 * first non-blank LINE of the body. Both are settled-PREFIX views. A reasoning body
 * streamed under a single `**title**` never closes its step, so the row froze on
 * that title for the whole turn: measured on the real document path, 200 consecutive
 * deltas produced exactly ONE distinct row label while the model kept writing.
 *
 * ── Why the tail cannot live in the measured payload ──────────────────────────
 *
 * The obvious fix — write the tail into the row's `title` — is what this test's
 * second half forbids. A trace row's measured title feeds the measurement cache key
 * (`traceRevision`'s `|tt:` signature), and an activity trace's key is
 * `activity-<firstMsgId>-<i>`, which carries no `__streaming__` marker and is
 * therefore cached like any settled element. A per-delta title would mint one cache
 * entry per frame and march the cache toward its bulk-clear ceiling, which
 * re-measures the whole window in a single frame (a visible hitch).
 *
 * The inverse mistake is equally real: putting the tail on the measured row behind a
 * field `traceRevision` ignores would make a CACHE HIT serve a stale tail. So the
 * tail rides the freshly adapted `spec.data` and is read at draw time via
 * `resolveRenderExtra` — the same channel `rowCard` uses. Both halves are asserted
 * here because either one failing silently restores the frozen row.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

/** A settled tool call, so the activity unit's key is cacheable (not `__streaming__`). */
const HISTORY = [
	{
		id: "m0",
		seq: 0,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: "tu-0", name: "Read", input: { file_path: "src/a.ts" } }],
		toolCalls: [{ id: "c0", toolUseId: "tu-0", toolName: "Read", status: "success" }],
		children: [],
	},
];

const streamingMessage = (text: string) => ({
	id: "__streaming__",
	seq: 999,
	role: "assistant",
	contentJson: [{ type: "reasoning", text }],
	toolCalls: [],
	children: [],
});

const settledMessage = (text: string) => ({
	id: "real-1",
	seq: 1,
	role: "assistant",
	contentJson: [{ type: "reasoning", text }],
	toolCalls: [],
	children: [],
});

type Tails = ReadonlyMap<string, { charCount: number; tail: string }> | undefined;

/** Build one frame through the REAL document path and read its draw-time tails. */
async function frameTails(messages: unknown[]): Promise<Tails> {
	const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
	const { resolveRenderExtra } = await import("./render-registry");
	const { recentRunSegmentMessageIds } = await import("../run-segments");
	const built = buildPretextDocumentLayout(messages as never[], {
		layoutRevision: "r1",
		documentRevision: "v1",
		lod: 2,
		widthBucket: 800,
		contentWidth: 800,
		viewportHeight: 900,
		resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
	});
	const spec = built.items[0]?.spec;
	expect(spec?.kind).toBe("activity-trace");
	return resolveRenderExtra(spec as never).rowLiveTails as Tails;
}

/** A body whose single title would otherwise freeze the row for the whole turn. */
const BODY = (chars: number) => `**分析步骤**\n\n${"长文本".repeat(Math.ceil(chars / 3))}`;

describe("live reasoning row shows a scrolling tail", () => {
	it("labels the live row with the accumulated size and the newest text", async () => {
		const tails = await frameTails([...HISTORY, streamingMessage(`${BODY(300)}最后到达的内容`)]);
		const tail = tails?.get("r-run0-0-step-0");
		expect(tail).toBeDefined();
		// The size prefix describes the WHOLE body, and the visible slice is its end.
		expect(tail?.charCount).toBeGreaterThan(300);
		expect(tail?.tail.endsWith("最后到达的内容")).toBe(true);
	});

	it("advances as the stream grows (the frozen-title regression)", async () => {
		// The exact shape that used to yield one label for the entire turn.
		const first = await frameTails([...HISTORY, streamingMessage(BODY(300))]);
		const later = await frameTails([...HISTORY, streamingMessage(`${BODY(300)}续写的新内容`)]);
		const a = first?.get("r-run0-0-step-0");
		const b = later?.get("r-run0-0-step-0");
		expect(a?.tail).toBeDefined();
		expect(b?.tail).not.toBe(a?.tail);
		expect(b?.charCount).toBeGreaterThan(a?.charCount ?? 0);
	});

	it("leaves a SHORT live body on its ordinary title", async () => {
		// Nothing is hidden yet, so scrolling would be churn for no benefit.
		const tails = await frameTails([...HISTORY, streamingMessage("**分析**\n\n就几个字")]);
		expect(tails).toBeUndefined();
	});

	it("never labels a SETTLED reasoning run with a tail", async () => {
		// A finished run is history: its steps are closed and its titles are correct,
		// so a scrolling tail there would be motion the reader cannot act on.
		const tails = await frameTails([...HISTORY, settledMessage(BODY(600))]);
		expect(tails).toBeUndefined();
	});

	it("tails only the LAST row of a multi-step live run", async () => {
		// Earlier steps have settled titles; only the open one is still being written.
		const text = `**第一步**\n\n${"甲".repeat(200)}\n\n**第二步**\n\n${"乙".repeat(200)}`;
		const tails = await frameTails([...HISTORY, streamingMessage(text)]);
		expect(tails?.size).toBe(1);
		// Both steps come from ONE reasoning block, so they share the run base and
		// differ by step index — the tail belongs to the second (still open) step.
		const [key, tail] = [...(tails ?? new Map())][0] ?? [];
		expect(key).toBe("r-run0-0-step-1");
		expect(tail?.tail.endsWith("乙")).toBe(true);
	});
});

describe("the scrolling tail does not leak measurement-cache entries", () => {
	it("keeps the cache flat while the label changes every frame", async () => {
		const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
		const { resolveRenderExtra } = await import("./render-registry");
		const { measureCache } = await import("./measure-cache");
		const { recentRunSegmentMessageIds } = await import("../run-segments");

		const renderFrame = (text: string) =>
			buildPretextDocumentLayout([...HISTORY, streamingMessage(text)] as never[], {
				layoutRevision: "r1",
				documentRevision: "v1",
				lod: 2,
				widthBucket: 800,
				contentWidth: 800,
				viewportHeight: 900,
				resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
			});

		measureCache.clear();
		measureCache.resetStats();

		let text = "**分析步骤**\n\n";
		const distinct = new Set<string>();
		const frames = 200;
		for (let i = 0; i < frames; i++) {
			text += "长文本";
			const built = renderFrame(text);
			const tails = resolveRenderExtra(built.items[0]?.spec as never).rowLiveTails as Tails;
			for (const [key, value] of tails ?? new Map()) {
				distinct.add(`${key}|${value.charCount}|${value.tail}`);
			}
		}

		// The label really did move on nearly every frame (measured: 177 of 200) —
		// without this the cache assertion below could pass on a frozen row.
		expect(distinct.size).toBeGreaterThan(frames / 2);
		// Yet the trace was measured ONCE: the tail never enters the cache key, so a
		// per-frame label costs no entries and the frames are served from cache.
		expect(measureCache.size).toBeLessThanOrEqual(2);
		expect(measureCache.hits).toBeGreaterThan(measureCache.misses * 10);
	});
});
