import { describe, expect, it, spyOn } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { useNarratorWS } from "../../../hooks/useNarratorWS";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { measureCache } from "./measure-cache";
import { PretextLayoutCoordinator } from "./pretext-layout-coordinator";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { useVListStreamingMessage } from "./useVListStreamingMessage";

const BUILD = { lod: 5 as const, widthBucket: "800", contentWidth: 800, viewportHeight: 600 };
const VIEW = () => ({ scrollTop: 0, viewportHeight: 600, pinnedToBottom: true });
const REASON = "分析甲";
const TEXT = "正文乙";
function message(contentJson: unknown[], id = "assistant-1"): TreeMessage {
	return {
		id,
		seq: 1,
		narratorId: "handoff-n",
		role: "assistant",
		parentToolUseId: null,
		contentJson,
		contentText: null,
		toolCalls: [],
		children: [],
		createdAt: "2026-09-20T00:00:00Z",
	} as TreeMessage;
}
function content(
	type: "text" | "reasoning",
	id: string,
	text: string,
	revision = 1,
	textOffset?: number,
) {
	return {
		type,
		id,
		text,
		revision,
		...(textOffset != null ? { textOffset } : {}),
		outputIndex: type === "reasoning" ? 0 : 1,
	};
}
function tool(id: string) {
	return { type: "tool_use", id, name: "Bash", input: { command: id } };
}

async function withStream(
	check: (test: {
		frame: (data: Record<string, unknown>) => Promise<void>;
		delta: (block: ReturnType<typeof content>) => Promise<void>;
		commit: (blocks: unknown[], final?: boolean) => Promise<void>;
		raf: () => Promise<void>;
		text: () => string;
		coordinator: PretextLayoutCoordinator;
		switchNarrator: (id: string, subagent?: boolean) => Promise<void>;
		live: () => TreeMessage | null;
	}) => Promise<void>,
) {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	let nextRaf = 0;
	const frames = new Map<number, FrameRequestCallback>();
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++nextRaf, callback);
			return nextRaf;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	};
	const previous = new Map(
		Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(values))
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	const restoreCanvas = installCanvasStub();
	// Fixtures reuse global block/message ids across independent narrator instances.
	measureCache.clear();
	const subscribe = spyOn(narratorWSManager, "subscribe").mockImplementation((ids, opts) => ({
		_id: 1,
		_narratorIds: ids,
		_kind: opts?.kind ?? "messages",
	}));
	const unsubscribe = spyOn(narratorWSManager, "unsubscribe").mockImplementation(() => {});
	const connection = spyOn(narratorWSManager, "onConnectionChange").mockImplementation(
		() => () => {},
	);
	const coordinator = new PretextLayoutCoordinator();
	await coordinator.load(
		"handoff-n",
		BUILD,
		{
			fetchPage: async () => ({
				messages: [],
				messageVersion: 1,
				hasPrev: false,
				hasNext: false,
				minSeq: null,
				maxSeq: null,
			}),
		},
		undefined,
		600,
	);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	let narratorId = "handoff-n";
	let isSubagent = false;
	let latestLive: TreeMessage | null = null;
	function Harness() {
		const snapshot = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot);
		const committed = snapshot.input?.messages ?? [];
		const streaming = useVListStreamingMessage(narratorId, {
			enabled: true,
			isSubagent,
			committedMessages: committed,
		});
		latestLive = streaming;
		useEffect(() => {
			coordinator.setStreamingMessage(streaming as TreeMessage | null, VIEW);
		}, [streaming]);
		useNarratorWS(
			narratorId,
			{
				onMessageUpdated: (value) => {
					coordinator.upsertMessage(value, false, VIEW);
				},
				onMessage: (data) => {
					if (data.message) coordinator.upsertMessage(data.message as TreeMessage, false, VIEW);
				},
			},
			undefined,
			{ kind: "messages" },
		);
		return (
			<MantineProvider>
				{snapshot.items?.map((item) => (
					<div key={item.spec.key}>
						{renderElement(item.spec.kind, item.measured, resolveRenderExtra(item.spec))}
					</div>
				))}
			</MantineProvider>
		);
	}
	const frame = async (data: Record<string, unknown>) => {
		await act(async () => {
			narratorWSManager.dispatchLocalFrame({ narratorId, ...data } as never);
		});
	};
	const raf = async () => {
		await act(async () => {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(performance.now());
		});
	};
	try {
		await act(async () => {
			root.render(<Harness />);
		});
		await check({
			frame,
			raf,
			coordinator,
			text: () => container.textContent ?? "",
			live: () => latestLive,
			switchNarrator: async (id, subagent = false) => {
				await act(async () => {
					narratorId = id;
					isSubagent = subagent;
					coordinator.reset();
					await coordinator.load(
						id,
						BUILD,
						{
							fetchPage: async () => ({
								messages: [],
								messageVersion: 1,
								hasPrev: false,
								hasNext: false,
								minSeq: null,
								maxSeq: null,
							}),
						},
						undefined,
						600,
					);
					root.render(<Harness />);
				});
			},
			delta: (block) =>
				frame({
					type: "stream_event",
					event: {
						type: "content_block_delta",
						outputIndex: block.outputIndex,
						delta: { ...block, type: `${block.type}_delta` },
					},
				}),
			commit: (blocks, final = false) =>
				frame({ type: final ? "message" : "message_updated", message: message(blocks) }),
		});
	} finally {
		await act(async () => {
			root.unmount();
		});
		coordinator.reset();
		container.remove();
		restoreCanvas();
		subscribe.mockRestore();
		unsubscribe.mockRestore();
		connection.mockRestore();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}

describe("real streaming hook / local WS / coordinator / DOM handoff", () => {
	it("keeps global content ownership when a user interjects before checkpoint delivery", async () => {
		await withStream(async (h) => {
			const block = content("text", "interrupted-b", "ORIGINAL", 1, 0);
			await h.delta(block);
			await h.raf();
			await h.commit([block]);
			await h.frame({
				type: "message",
				message: { ...message([], "user-interjection"), role: "user", seq: 2 },
			});
			await h.frame({ type: "streaming_snapshot", streamingBlocks: [block], toolChunks: [] });
			await h.raf();
			expect(h.text().split("ORIGINAL")).toHaveLength(2);
			expect(h.live()).toBeNull();
			await h.delta(content("text", "interrupted-b", "+TAIL", 2, 8));
			await h.raf();
			expect(h.text().split("ORIGINAL+TAIL")).toHaveLength(2);
			await h.commit([content("text", "interrupted-b", "ORIGINAL+TAIL", 2)], true);
			await h.raf();
			expect(h.text().split("ORIGINAL+TAIL")).toHaveLength(2);
			expect(h.live()).toBeNull();
		});
	});
	it("retiring the last tool never retires unrelated reasoning and text", async () => {
		await withStream(async (h) => {
			await h.delta(content("reasoning", "r1", REASON));
			await h.raf();
			expect(h.text()).toContain(REASON);
			await h.delta(content("text", "t1", TEXT));
			await h.raf();
			expect(h.text()).toContain(TEXT);
			await h.frame({
				type: "tool_use_chunk",
				toolUseId: "tool1",
				toolName: "Bash",
				inputCharsTotal: 1,
			});
			await h.raf();
			await h.commit([tool("tool1")]);
			await h.raf();
			expect(h.text()).toContain(REASON);
			expect(h.text()).toContain(TEXT);
			await h.frame({
				type: "tool_use_chunk",
				toolUseId: "tool2",
				toolName: "Bash",
				inputCharsTotal: 1,
			});
			await h.raf();
			expect(h.text()).toContain(REASON);
			expect(h.text()).toContain(TEXT);
		});
	});
	it("a short new block survives after all older content handed off", async () => {
		await withStream(async (h) => {
			const r = content("reasoning", "r1", REASON);
			const t = content("text", "t1", TEXT);
			await h.delta(r);
			await h.delta(t);
			await h.frame({
				type: "tool_use_chunk",
				toolUseId: "tool1",
				toolName: "Bash",
				inputCharsTotal: 1,
			});
			await h.raf();
			await h.commit([r, t, tool("tool1")]);
			await h.raf();
			await h.delta(content("text", "new", "NEW"));
			await h.raf();
			expect(h.text()).toContain("NEW");
		});
	});
	it("checkpoint continuation updates one real block without losing the raw prefix", async () => {
		await withStream(async (h) => {
			await h.delta(content("text", "t1", "PREFIX", 1));
			await h.raf();
			await h.commit([content("text", "t1", "PREFIX", 1)]);
			await h.raf();
			await h.delta(content("text", "t1", "+TAIL", 2));
			await h.raf();
			expect(h.text()).toContain("PREFIX+TAIL");
			expect(h.text().split("PREFIX")).toHaveLength(2);
			await h.commit([content("text", "t1", "PREFIX+TAIL", 2)], true);
			await h.raf();
			expect(h.text().split("PREFIX+TAIL")).toHaveLength(2);
		});
	});
	it("reasoning → text → tool1 complete → tool2 running → final stays visible exactly once", async () => {
		await withStream(async (h) => {
			const r = content("reasoning", "r", REASON, 1, 0);
			const t = content("text", "t", TEXT, 1, 0);
			const visible = () => {
				expect(h.text().split(REASON)).toHaveLength(2);
				expect(h.text().split(TEXT)).toHaveLength(2);
			};
			await h.delta(r);
			await h.raf();
			expect(h.text()).toContain(REASON);
			await h.commit([r]);
			expect(h.text()).toContain(REASON);
			await h.delta(t);
			await h.raf();
			visible();
			await h.commit([r, t]);
			visible();
			await h.frame({
				type: "tool_use_chunk",
				toolUseId: "tool1",
				toolName: "Bash",
				inputCharsTotal: 4,
			});
			await h.raf();
			visible();
			await h.commit([r, t, tool("tool1")]);
			visible();
			await h.frame({
				type: "tool_completed",
				toolUseId: "tool1",
				status: "success",
				output: "done",
			});
			await h.raf();
			visible();
			await h.frame({
				type: "tool_use_chunk",
				toolUseId: "tool2",
				toolName: "Bash",
				inputCharsTotal: 4,
			});
			await h.frame({
				type: "tool_started",
				toolUseId: "tool2",
				toolName: "Bash",
				input: { command: "tool2" },
			});
			await h.frame({ type: "tool_executing", toolUseId: "tool2", executionStartedAt: Date.now() });
			await h.raf();
			visible();
			expect(h.live()?.toolCalls?.some((call) => call.toolUseId === "tool2")).toBe(true);
			await h.commit([r, t, tool("tool1"), tool("tool2")], true);
			visible();
			await h.raf();
			visible();
			expect(h.live()).toBeNull();
			expect(
				h.coordinator.getSnapshot().items?.filter((item) => item.spec.kind === "tool-call"),
			).toHaveLength(2);
		});
	});
	for (const snapshotFirst of [true, false]) {
		it(`snapshot ${snapshotFirst ? "before" : "after"} committed and a short NEW survive without duplicates`, async () => {
			await withStream(async (h) => {
				const old = content("text", "old", "OLD-LONG-CONTENT", 3, 0);
				const snapshot = () =>
					h.frame({ type: "streaming_snapshot", streamingBlocks: [old], toolChunks: [] });
				if (snapshotFirst) {
					await snapshot();
					await h.raf();
					await h.commit([old]);
				} else {
					await h.commit([old]);
					await snapshot();
				}
				await h.raf();
				expect(h.text().split("OLD-LONG-CONTENT")).toHaveLength(2);
				await h.frame({
					type: "streaming_snapshot",
					streamingBlocks: [old, content("text", "new", "NEW", 1, 0)],
					toolChunks: [],
				});
				await h.raf();
				expect(h.text()).toContain("NEW");
				await snapshot();
				await h.raf();
				expect(h.text()).toContain("NEW");
			});
		});
	}
	it("late committed and delayed rAF cannot apply old ownership to a newer revision", async () => {
		await withStream(async (h) => {
			await h.delta(content("text", "t", "A", 1, 0));
			await h.raf();
			await h.delta(content("text", "t", "BC", 2, 1)); // rAF withheld
			await h.commit([content("text", "t", "A", 1)]);
			await h.raf();
			expect(h.text().split("ABC")).toHaveLength(2);
			await h.commit([content("text", "t", "AB", 1)]); // old checkpoint arrives late
			expect(h.text().split("ABC")).toHaveLength(2);
			await h.delta(content("text", "t", "D", 3, 3));
			await h.commit([content("text", "t", "ABCD", 3)], true); // final wins before rAF
			expect(h.text().split("ABCD")).toHaveLength(2);
			await h.delta(content("text", "new", "NEW", 1, 0));
			await h.raf();
			expect(h.text()).toContain("NEW");
			expect(h.text().split("ABCD")).toHaveLength(2);
			await h.commit([content("text", "t", "A", 1)]);
			await h.raf();
			expect(h.text().split("ABCD")).toHaveLength(2);
			expect(h.text()).toContain("NEW");
		});
	});
	it("delta-first reconnect recovers its raw prefix from an older snapshot", async () => {
		await withStream(async (h) => {
			await h.delta(content("text", "t", "+TAIL", 8, 6));
			await h.raf();
			await h.frame({
				type: "streaming_snapshot",
				streamingBlocks: [content("text", "t", "PREFIX", 7, 0)],
				toolChunks: [],
			});
			await h.raf();
			expect(h.text()).toContain("PREFIX+TAIL");
			await h.delta(content("text", "t", "+TAIL", 8, 6));
			await h.raf();
			expect(h.text().split("+TAIL")).toHaveLength(2);
		});
	});
	it("citation-cleaned checkpoints and metadata-only revisions never seed the raw accumulator", async () => {
		await withStream(async (h) => {
			const raw = "RAW-INTERNAL-MARKER";
			await h.delta(content("text", "t", raw, 1, 0));
			await h.raf();
			await h.commit([{ ...content("text", "t", "RAW", 2), rawTextLength: raw.length }]);
			expect(h.text()).not.toContain("INTERNAL-MARKER");
			await h.delta(content("text", "t", "+TAIL", 3, raw.length));
			await h.raf();
			expect(h.live()?.contentJson).toEqual([
				expect.objectContaining({ text: `${raw}+TAIL`, revision: 3 }),
			]);
			await h.commit([content("text", "t", "RAW+TAIL", 4)], true);
			await h.raf();
			expect(h.text().split("RAW+TAIL")).toHaveLength(2);
			expect(h.text()).not.toContain("INTERNAL-MARKER");
			await h.frame({
				type: "streaming_snapshot",
				streamingBlocks: [content("text", "t", `${raw}+TAIL`, 3, 0)],
				toolChunks: [],
			});
			await h.raf();
			expect(h.live()).toBeNull();
		});
	});
	it("a bounded raw tail keeps the full committed prefix through rawTextLength", async () => {
		await withStream(async (h) => {
			await h.commit([{ ...content("text", "t", "CLEAN-PREFIX", 5), rawTextLength: 130_000 }]);
			await h.frame({
				type: "streaming_snapshot",
				streamingBlocks: [content("text", "t", `${"x".repeat(119_996)}TAIL`, 6, 10_004)],
				toolChunks: [],
			});
			await h.raf();
			expect(h.text()).toContain("CLEAN-PREFIXTAIL");
			expect(h.text()).not.toContain("xxxx");
		});
	});
	it("parent/child filtering, reset, errors, finish and narrator switches do not leak raw state", async () => {
		await withStream(async (h) => {
			await h.frame({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					subagentToolUseId: "child",
					delta: { type: "text_delta", id: "child-b", revision: 1, textOffset: 0, text: "CHILD" },
				},
			});
			await h.raf();
			expect(h.live()).toBeNull();
			await h.delta(content("text", "t", "BEFORE", 1, 0));
			await h.raf();
			await h.frame({ type: "streaming_reset", parentToolUseId: "child" });
			expect(h.text()).toContain("BEFORE");
			await h.frame({ type: "streaming_reset" });
			await h.raf();
			expect(h.live()).toBeNull();
			await h.delta(content("text", "t", "AFTER", 1, 0));
			await h.raf();
			expect(h.text()).toContain("AFTER");
			await h.switchNarrator("other", true);
			await h.raf();
			expect(h.live()).toBeNull();
			await h.frame({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					subagentToolUseId: "child",
					delta: { type: "text_delta", id: "child-b", revision: 1, textOffset: 0, text: "CHILD" },
				},
			});
			await h.raf();
			expect(h.text()).toContain("CHILD");
			await h.frame({ type: "narrator_error", error: "failed" });
			await h.raf();
			expect(h.live()).toBeNull();
			await h.delta(content("text", "after-error", "LAST", 1, 0));
			await h.raf();
			expect(h.text()).toContain("LAST");
			await h.frame({ type: "status_change", status: "idle" });
			await h.raf();
			expect(h.live()).toBeNull();
		});
	});
});
