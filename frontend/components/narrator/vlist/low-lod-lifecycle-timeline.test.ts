/**
 * low-lod-lifecycle-timeline.test.ts — A tool call's and a reasoning run's WHOLE
 * lifecycle, replayed frame by frame through the real document layout.
 *
 * Why a timeline and not per-state assertions
 * -------------------------------------------
 * Every state here was individually correct before this file existed. The reported
 * problem ("状态和高度跳变") lived BETWEEN states: the element that represents one
 * call changed identity or component from one frame to the next — a trace row became
 * a standalone card for the approval and went back to a row after it, and the whole
 * activity trace re-keyed the moment its content persisted. None of that is visible
 * to a test that builds one state at a time, so this one replays the same event
 * sequence the WS stream produces (probed against the server's emit order) and
 * asserts on the TRANSITIONS.
 *
 * Always through `buildPretextDocumentLayout` + `projectStreamingDocument`, the
 * shell's own entry point: the activity key is minted there, and the streaming
 * projection is what decides which copy of a block survives a hand-off.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

async function load() {
	const [chunks, helpers, segments, layout, display, runs, handoff] = await Promise.all([
		import("./streaming-tool-chunks"),
		import("../narrator-message-helpers"),
		import("../message/message-segments"),
		import("./pretext-document-layout"),
		import("../tool-call/tool-display"),
		import("../trace/run-segments"),
		import("./streaming-handoff"),
	]);
	return { chunks, helpers, segments, layout, display, runs, handoff };
}

type Mod = Awaited<ReturnType<typeof load>>;
type Built = ReturnType<Mod["layout"]["buildPretextDocumentLayout"]>;

const USER = {
	id: "u1",
	seq: 1,
	role: "user",
	contentJson: [{ type: "text", text: "请帮我构建" }],
	toolCalls: [],
	children: [],
};

/** One persisted assistant message (the partial the server keeps appending to). */
function persisted(blocks: unknown[]) {
	return { id: "a1", seq: 2, role: "assistant", contentJson: blocks, toolCalls: [], children: [] };
}

const REASONING = {
	type: "reasoning",
	id: "rs-1",
	revision: 3,
	text: "**分析**\n\n先看看构建脚本。",
};
const TEXT = { type: "text", id: "tx-1", revision: 2, text: "我来运行构建。" };

function bashTool(status: string, extra: Record<string, unknown> = {}) {
	return {
		type: "tool_use",
		id: "t1",
		name: "Bash",
		input: { command: "npm run build" },
		status,
		...extra,
	};
}

/**
 * A frame runner over one mutable streaming store + pending-permission set, so a
 * test reads as the event sequence it replays.
 */
function createTimeline(
	mod: Mod,
	lod: 1 | 2 | 3 | 4 | 5,
	overrides: {
		resolvePermissionFormHeight?: (toolUseId: string | undefined) => number | undefined;
		resolveRecentMessageIds?: (messages: readonly unknown[]) => ReadonlySet<string>;
	} = {},
) {
	const store = mod.chunks.createStreamingToolStore();
	let pending = new Set<string>();
	const options = (revision: string) => ({
		layoutRevision: `L-${revision}`,
		// Held FIXED across the whole timeline on purpose: the live paths under test
		// (append / live patch / streaming) keep `messageVersion` constant, so every
		// transition below has to be carried by keys and data revisions alone.
		documentRevision: "v1",
		lod,
		widthBucket: "800",
		contentWidth: 800,
		viewportHeight: 900,
		gap: 4,
		segmentGap: 12,
		resolveToolCategory: mod.display.getCategory,
		resolveToolColor: (name: string, input: unknown) =>
			mod.display.getCategoryColor(mod.display.getCategory(name, input)),
		resolveToolSummary: (tc: unknown) =>
			String((tc as { inputJson?: { command?: unknown } })?.inputJson?.command ?? ""),
		resolveRecentMessageIds:
			overrides.resolveRecentMessageIds ??
			((messages: readonly unknown[]) =>
				mod.runs.recentRunSegmentMessageIds([...messages] as never, 2)),
		resolveHasPendingPermission: (toolUseId: string | undefined) =>
			toolUseId ? pending.has(toolUseId) : false,
		// What the shell derives from the live request list: a prediction exists only
		// for a call that has one.
		resolvePermissionFormPrediction: (toolUseId: string | undefined) =>
			toolUseId && pending.has(toolUseId) ? BASH_PREDICTION : undefined,
		...(overrides.resolvePermissionFormHeight
			? { resolvePermissionFormHeight: overrides.resolvePermissionFormHeight }
			: {}),
	});
	const frame = (
		label: string,
		committed: unknown[],
		streamingBlocks: unknown[],
		liveBlockIndex?: number,
	): Built => {
		const toolChunksMsg = mod.helpers.buildTopLevelStreamingChunksMsg(
			mod.chunks.streamingToolChunks(store),
			"n1",
			null,
		);
		const row = mod.segments.buildStreamingMsg({
			streamingBlocks: streamingBlocks as never,
			toolChunksMsg,
			narratorId: "n1",
			liveBlockIndex,
		});
		const messages = mod.handoff.projectStreamingDocument(
			[USER, ...committed] as never,
			row as never,
		);
		return mod.layout.buildPretextDocumentLayout(messages as never, options(label));
	};
	return {
		store,
		frame,
		setPending(ids: string[]) {
			pending = new Set(ids);
		},
	};
}

/** Every element the frame lays out, as `kind key`. */
function shape(built: Built): string[] {
	return built.items.map((item) => `${item.spec.kind} ${item.spec.key}`);
}

/** The activity trace holding a row with this key, if any. */
function traceHolding(built: Built, rowKey: string) {
	return built.items.find(
		(item) =>
			item.spec.kind === "activity-trace" &&
			((item.spec.data as { items?: { key: string }[] }).items ?? []).some(
				(row) => row.key === rowKey,
			),
	);
}

describe("L1/L2: the activity trace keeps its key across the streaming hand-off", () => {
	for (const lod of [1, 2] as const) {
		it(`L${lod}: a tool's trace is the same element while streaming and once persisted`, async () => {
			const mod = await load();
			const t = createTimeline(mod, lod);
			t.frame("reasoning", [], [REASONING], 0);
			mod.chunks.applyStreamingToolChunk(t.store, {
				toolUseId: "t1",
				toolName: "Bash",
				inputCharsTotal: 10,
				streamingField: { name: "command", delta: "npm run bu" },
			});
			const streaming = t.frame("args", [persisted([REASONING, TEXT])], [REASONING, TEXT], -1);
			const handedOff = t.frame(
				"persisted",
				[persisted([REASONING, TEXT, bashTool("initializing")])],
				[REASONING, TEXT],
				-1,
			);
			const before = traceHolding(streaming, "tool-t1");
			const after = traceHolding(handedOff, "tool-t1");
			expect(before).toBeDefined();
			expect(after).toBeDefined();
			// The regression this pins: the key used to be minted from the first SOURCE
			// MESSAGE id (`activity-__streaming__-3` → `activity-a1-3`), so React remounted
			// the whole trace at the instant its content merely settled.
			expect(after?.spec.key).toBe(before?.spec.key);
			expect(after?.spec.key).toBe("activity-t:t1");
		});

		it(`L${lod}: a reasoning trace is the same element while streaming and once persisted`, async () => {
			const mod = await load();
			const t = createTimeline(mod, lod);
			const live = t.frame("reasoning", [], [REASONING], 0);
			const settled = t.frame("persisted", [persisted([REASONING])], [REASONING, TEXT], 1);
			const liveTrace = live.items.find((item) => item.spec.kind === "activity-trace");
			const settledTrace = settled.items.find((item) => item.spec.kind === "activity-trace");
			expect(liveTrace?.spec.key).toBe("activity-r:rs-1");
			expect(settledTrace?.spec.key).toBe(liveTrace?.spec.key);
		});
	}

	it("keeps activity keys unique when two units start with different calls", async () => {
		const mod = await load();
		const t = createTimeline(mod, 2);
		const second = {
			type: "tool_use",
			id: "t2",
			name: "Read",
			input: { file_path: "a.ts" },
			status: "success",
		};
		// reasoning → text → tool → text → tool: two activity units separated by prose.
		const built = t.frame(
			"two units",
			[
				persisted([
					REASONING,
					TEXT,
					bashTool("success", { outputJson: "ok" }),
					{ type: "text", id: "tx-2", revision: 1, text: "再读一个文件。" },
					second,
				]),
			],
			[],
			-1,
		);
		const keys = shape(built).filter((entry) => entry.startsWith("activity-trace"));
		expect(keys).toEqual([
			"activity-trace activity-r:rs-1",
			"activity-trace activity-t:t1",
			"activity-trace activity-t:t2",
		]);
	});
});

/** The measured trace row with this key, if any. */
function measuredRow(built: Built, rowKey: string) {
	for (const item of built.items) {
		if (item.spec.kind !== "activity-trace") continue;
		const rows = (item.measured as { rows?: { key: string }[] }).rows ?? [];
		const row = rows.find((candidate) => candidate.key === rowKey);
		if (row)
			return row as unknown as {
				key: string;
				expanded: boolean;
				pinnedOpen?: boolean;
				blockHeight: number;
				cardMeasured: { height: number; permissionFormHeight: number } | null;
			};
	}
	return undefined;
}

/** A plausible prediction the shell would supply for the Bash request. */
const BASH_PREDICTION = {
	readOnly: false,
	hasExecutionTarget: true,
	executionCwdLines: 1,
	executionPathLines: 0,
	isExitPlanMode: false,
	hasDecisionReason: false,
	feedbackRows: 1,
	buttonRows: 1,
};

describe("L1/L2: a tool awaiting approval stays ONE row from arguments to result", () => {
	for (const lod of [1, 2] as const) {
		it(`L${lod}: never becomes a standalone card, and drills open only while the request is live`, async () => {
			const mod = await load();
			const t = createTimeline(mod, lod);
			mod.chunks.applyStreamingToolChunk(t.store, {
				toolUseId: "t1",
				toolName: "Bash",
				inputCharsTotal: 10,
				streamingField: { name: "command", delta: "npm run bu" },
			});
			const committed = (status: string, extra: Record<string, unknown> = {}) => [
				persisted([REASONING, TEXT, bashTool(status, extra)]),
			];
			// Every frame of the lifecycle, in the order the server emits it.
			const frames: [string, Built][] = [];
			frames.push(["args streaming", t.frame("args", [persisted([REASONING, TEXT])], [], -1)]);
			frames.push(["persisted", t.frame("persisted", committed("initializing"), [], -1)]);
			// The status patch can land a frame before the request list — and the
			// list is what the drill keys on, so the row must NOT open yet.
			const statusFirst = t.frame("pending, list not yet", committed("pending"), [], -1);
			frames.push(["pending, list not yet", statusFirst]);
			t.setPending(["t1"]);
			const awaiting = t.frame("awaiting", committed("pending"), [], -1);
			frames.push(["awaiting", awaiting]);
			// The reader answers: the client drops the request at once, before the
			// server's status update arrives.
			t.setPending([]);
			const answered = t.frame("answered", committed("pending"), [], -1);
			frames.push(["answered", answered]);
			frames.push(["running", t.frame("running", committed("running"), [], -1)]);
			frames.push([
				"success",
				t.frame("success", committed("success", { outputJson: "ok" }), [], -1),
			]);

			for (const [label, built] of frames) {
				// The regression this pins: the call used to be split out as a top-level
				// `tool-call` card for the approval and folded back afterwards.
				expect({
					label,
					cards: shape(built).filter((entry) => entry.startsWith("tool-call")),
				}).toEqual({
					label,
					cards: [],
				});
				expect({ label, trace: traceHolding(built, "tool-t1")?.spec.key }).toEqual({
					label,
					trace: "activity-t:t1",
				});
			}

			expect(measuredRow(statusFirst, "tool-t1")?.expanded).toBe(false);
			const open = measuredRow(awaiting, "tool-t1");
			expect(open?.expanded).toBe(true);
			expect(open?.pinnedOpen).toBe(true);
			// The drilled block IS the card, and the card already reserves the form.
			expect(open?.cardMeasured).not.toBeNull();
			expect(open?.blockHeight).toBe(open?.cardMeasured?.height);
			expect(open?.cardMeasured?.permissionFormHeight ?? 0).toBeGreaterThan(0);
			// Closed again the instant the reader answered, with the status still pending.
			expect(measuredRow(answered, "tool-t1")?.expanded).toBe(false);
			expect(measuredRow(answered, "tool-t1")?.pinnedOpen).toBeUndefined();
		});
	}

	it("uses the painted form height once it has been reported", async () => {
		const mod = await load();
		const t = createTimeline(mod, 2, {
			resolvePermissionFormHeight: (toolUseId) => (toolUseId === "t1" ? 177 : undefined),
		});
		t.setPending(["t1"]);
		const built = t.frame("awaiting", [persisted([REASONING, TEXT, bashTool("pending")])], [], -1);
		expect(measuredRow(built, "tool-t1")?.cardMeasured?.permissionFormHeight).toBe(177);
	});

	it("does not force the drill while a reflection gate is deliberating", async () => {
		const mod = await load();
		const t = createTimeline(mod, 2);
		t.setPending(["t1"]);
		const gated = bashTool("pending", {
			permissionSuggestions: [{ type: "danger_reflection", status: "running", requestId: "r1" }],
		});
		const built = t.frame("gated", [persisted([REASONING, TEXT, gated])], [], -1);
		const row = measuredRow(built, "tool-t1");
		expect(row).toBeDefined();
		expect(row?.pinnedOpen).toBeUndefined();
	});

	it("un-collapses an L1 history trace that holds the awaiting row", async () => {
		const mod = await load();
		const t = createTimeline(mod, 1, {
			// Nothing is "recent": the trace would fold behind its header at L1.
			resolveRecentMessageIds: () => new Set<string>(),
		});
		t.setPending(["t1"]);
		const built = t.frame("awaiting", [persisted([REASONING, TEXT, bashTool("pending")])], [], -1);
		const trace = traceHolding(built, "tool-t1");
		expect((trace?.spec.opts as { collapsed?: boolean }).collapsed).toBe(false);
		expect(measuredRow(built, "tool-t1")?.expanded).toBe(true);
	});
});

describe("content blocks carry a hand-off-stable lifecycle id", () => {
	it("pairs a live reasoning card with its persisted copy even though the key changes", async () => {
		const mod = await load();
		const t = createTimeline(mod, 3);
		const live = t.frame("reasoning", [], [{ ...REASONING, text: "先看看构建脚本。" }], 0);
		const settled = t.frame(
			"persisted",
			[persisted([{ ...REASONING, text: "先看看构建脚本。" }])],
			[{ ...REASONING, text: "先看看构建脚本。" }, TEXT],
			1,
		);
		const liveCard = live.items.find((item) => item.spec.kind === "reasoning");
		const settledCard = settled.items.find((item) => item.spec.kind === "reasoning");
		expect(liveCard?.spec.key).toBe("__streaming__-b0");
		expect(settledCard?.spec.key).toBe("a1-b0");
		expect(liveCard?.spec.lifecycleId).toBe("blk:rs-1");
		expect(settledCard?.spec.lifecycleId).toBe("blk:rs-1");
		// The trap the id exists for: after the hand-off the STILL-LIVE text block took
		// over the streaming key the reasoning used to hold.
		const liveText = settled.items.find(
			(item) => item.spec.kind === "markdown" && item.spec.key.startsWith("__streaming__"),
		);
		expect(liveText?.spec.key).toBe("__streaming__-b0");
		expect(liveText?.spec.lifecycleId).toBe("blk:tx-1");
	});

	it("omits the id for a synthetic lane with no persisted counterpart", async () => {
		const mod = await load();
		const t = createTimeline(mod, 3);
		const built = t.frame("legacy", [], [{ type: "text", text: "没有 id 的旧式文本" }], 0);
		const body = built.items.find((item) => item.spec.kind === "markdown");
		expect(body).toBeDefined();
		expect(body?.spec.lifecycleId).toBeUndefined();
	});
});
