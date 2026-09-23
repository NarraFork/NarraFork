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
import { resolveStreamAnimExtra } from "./vlist-stream-anim-extra";

let nextMountEpoch = 0;

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
		animationCount: () => number;
		animationText: () => string;
		showOnlyKeys: (keys: readonly string[] | null) => Promise<void>;
		coordinator: PretextLayoutCoordinator;
		switchNarrator: (id: string, subagent?: boolean) => Promise<void>;
		live: () => TreeMessage | null;
	}) => Promise<void>,
	{ animateStreaming = false }: { animateStreaming?: boolean } = {},
) {
	let mountEpoch = ++nextMountEpoch;
	// Keep active tokens alive while measuring/rendering the large snapshot fixture.
	const clock = animateStreaming ? spyOn(Date, "now").mockReturnValue(Date.now()) : null;
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
	let visibleKeys: ReadonlySet<string> | null = null;
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
				{snapshot.items
					?.filter((item) => visibleKeys == null || visibleKeys.has(item.spec.key))
					.map((item) => (
						<div key={item.spec.key}>
							{renderElement(item.spec.kind, item.measured, {
								...resolveRenderExtra(item.spec),
								...resolveStreamAnimExtra({
									animateStreaming: animateStreaming && item.spec.key.startsWith("__streaming__"),
									kind: item.spec.kind,
									specKey: item.spec.key,
									narratorId,
									mountEpoch,
									// Use the coordinator's committed version, never the hook's pending value.
									snapshotEpoch: snapshot.streamingMessage?._streamAnimSnapshotEpoch,
								}),
							})}
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
			animationCount: () => container.querySelectorAll("span.vlist-anim-token").length,
			animationText: () =>
				Array.from(container.querySelectorAll("span.vlist-anim-token"))
					.map((span) => span.textContent ?? "")
					.join(""),
			live: () => latestLive,
			showOnlyKeys: async (keys) => {
				await act(async () => {
					visibleKeys = keys == null ? null : new Set(keys);
					root.render(<Harness />);
				});
			},
			switchNarrator: async (id, subagent = false) => {
				await act(async () => {
					narratorId = id;
					isSubagent = subagent;
					mountEpoch = ++nextMountEpoch;
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
		clock?.mockRestore();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}

describe("snapshot animation through real WS / hook / coordinator / DOM", () => {
	for (const type of ["text", "reasoning"] as const) {
		it(`seals a delayed 10,000+ character ${type} snapshot in a warm scope, then animates live paragraphs`, async () => {
			await withStream(
				async (h) => {
					await h.delta(content(type, "snapshot-body", "开头", 1, 0));
					await h.raf();
					await h.delta(content(type, "snapshot-body", "暖场", 2, 2));
					await h.raf();
					expect(h.animationText()).toContain("暖场");
					const paragraphs = Array.from(
						{ length: 24 },
						(_, i) => `历史段落${i}：${"这是静态历史正文。".repeat(50)}`,
					);
					const body = `开头暖场\n\n${paragraphs.join("\n\n")}`;
					expect(body.length).toBeGreaterThan(10_000);
					const snapshot = () =>
						h.frame({
							type: "streaming_snapshot",
							streamingBlocks: [content(type, "snapshot-body", body, 3, 0)],
							toolChunks: [],
						});
					await snapshot();
					await h.raf();
					expect(h.animationCount()).toBe(0);
					for (const paragraph of paragraphs) expect(h.text()).toContain(paragraph);
					const epoch = h.coordinator.getSnapshot().streamingMessage?._streamAnimSnapshotEpoch;
					expect(epoch).toBeGreaterThan(0);
					await snapshot(); // reconnect resends the same large body
					await h.raf();
					expect(h.animationCount()).toBe(0);
					expect(h.coordinator.getSnapshot().streamingMessage?._streamAnimSnapshotEpoch).toBe(
						epoch,
					);
					await h.delta(content(type, "snapshot-body", "实时尾巴", 4, body.length));
					await h.raf();
					expect(h.animationText()).toContain("实时尾巴");
					expect(h.animationText()).not.toContain("历史段落");
					await h.delta(content(type, "snapshot-body", "\n\n新段落首批", 5, body.length + 4));
					await h.raf();
					expect(h.animationText()).toContain("新段落首批");
				},
				{ animateStreaming: true },
			);
		});
	}

	it("seals an offscreen snapshot block on late mount but animates a genuinely new live block", async () => {
		await withStream(
			async (h) => {
				await h.showOnlyKeys(["__streaming__-b0"]);
				await h.frame({
					type: "streaming_snapshot",
					streamingBlocks: [
						content("text", "snapshot-a", "可见历史", 1, 0),
						content("text", "snapshot-b", "屏外历史第一段\n\n屏外历史第二段", 1, 0),
					],
					toolChunks: [],
				});
				await h.raf();
				expect(h.text()).toContain("可见历史");
				expect(h.text()).not.toContain("屏外历史");
				await h.showOnlyKeys(null);
				expect(h.text()).toContain("屏外历史第一段");
				expect(h.animationCount()).toBe(0);
				await h.delta(content("text", "new-live-block", "真正实时的新块", 1, 0));
				await h.raf();
				expect(h.animationText()).toBe("真正实时的新块");
				expect(h.live()?.contentJson.find((block) => block.id === "snapshot-b")).toHaveProperty(
					"_streamAnimSnapshotEpoch",
				);
				expect(
					h.live()?.contentJson.find((block) => block.id === "new-live-block"),
				).not.toHaveProperty("_streamAnimSnapshotEpoch");
			},
			{ animateStreaming: true },
		);
	});

	for (const snapshotFirst of [true, false]) {
		it(`seals one rAF batch with ${snapshotFirst ? "snapshot → delta" : "delta → snapshot"} without losing text`, async () => {
			await withStream(
				async (h) => {
					await h.delta(content("text", "batch-body", "PREFIX", 1, 0));
					await h.raf();
					const body = "PREFIX-CATCHUP\n\n历史第二段";
					const snapshot = () =>
						h.frame({
							type: "streaming_snapshot",
							streamingBlocks: [content("text", "batch-body", body, 2, 0)],
							toolChunks: [],
						});
					const delta = () => h.delta(content("text", "batch-body", "+TAIL", 3, body.length));
					if (snapshotFirst) {
						await snapshot();
						await delta();
					} else {
						await delta();
						await snapshot();
					}
					await h.raf();
					expect(h.live()?.contentJson).toEqual([
						expect.objectContaining({ text: `${body}+TAIL`, textOffset: 0 }),
					]);
					expect(h.text()).toContain("PREFIX-CATCHUP");
					expect(h.text()).toContain("历史第二段+TAIL");
					expect(h.animationCount()).toBe(0);
					await h.delta(content("text", "batch-body", "+NEXT", 4, body.length + 5));
					await h.raf();
					expect(h.animationText()).toBe("+NEXT");
					expect(h.text()).toContain("历史第二段+TAIL+NEXT");
				},
				{ animateStreaming: true },
			);
		});
	}

	it("seals restored history after switching away and back, then resumes new-token animation", async () => {
		await withStream(
			async (h) => {
				await h.delta(content("text", "switch-body", "离开前", 1, 0));
				await h.raf();
				await h.delta(content("text", "switch-body", "新字", 2, 3));
				await h.raf();
				expect(h.animationText()).toContain("新字");
				await h.switchNarrator("other");
				expect(h.animationCount()).toBe(0);
				await h.switchNarrator("handoff-n");
				const body = "离开前新字\n\n离开期间历史";
				await h.frame({
					type: "streaming_snapshot",
					streamingBlocks: [content("text", "switch-body", body, 3, 0)],
					toolChunks: [],
				});
				await h.raf();
				expect(h.text()).toContain("离开前新字");
				expect(h.text()).toContain("离开期间历史");
				expect(h.animationCount()).toBe(0);
				await h.delta(content("text", "switch-body", "回归实时", 4, body.length));
				await h.raf();
				expect(h.animationText()).toBe("回归实时");
			},
			{ animateStreaming: true },
		);
	});

	it("empty, duplicate, stale, provenance-only and tool-only snapshots retain the epoch and active new text", async () => {
		await withStream(
			async (h) => {
				await h.delta(content("text", "noop-body", "历史", 1, 0));
				await h.raf();
				await h.frame({
					type: "streaming_snapshot",
					streamingBlocks: [content("text", "noop-body", "历史正文", 2, 0)],
					toolChunks: [],
				});
				await h.raf();
				expect(h.animationCount()).toBe(0);
				const epoch = h.coordinator.getSnapshot().streamingMessage?._streamAnimSnapshotEpoch;
				expect(epoch).toBeGreaterThan(0);
				await h.delta(content("text", "noop-body", "活跃新字", 3, 4));
				await h.raf();
				expect(h.animationText()).toBe("活跃新字");
				const snapshots = [
					{ streamingBlocks: [], toolChunks: [] },
					{
						streamingBlocks: [content("text", "noop-body", "历史正文活跃新字", 3, 0)],
						toolChunks: [],
					},
					{ streamingBlocks: [content("text", "noop-body", "历史", 1, 0)], toolChunks: [] },
					{
						streamingBlocks: [content("text", "noop-body", "历史正文活跃新字", 4, 0)],
						toolChunks: [],
					},
					{
						streamingBlocks: [],
						toolChunks: [{ toolUseId: "noop-tool", toolName: "Bash", inputCharsTotal: 0 }],
					},
				];
				for (const snapshot of snapshots) {
					await h.frame({ type: "streaming_snapshot", ...snapshot });
					await h.raf();
					expect(h.live()?._streamAnimSnapshotEpoch).toBe(epoch);
					expect(h.coordinator.getSnapshot().streamingMessage?._streamAnimSnapshotEpoch).toBe(
						epoch,
					);
					expect(h.text()).toContain("历史正文活跃新字");
					expect(h.animationText()).toBe("活跃新字");
				}
				expect(h.live()?.toolCalls?.some((call) => call.toolUseId === "noop-tool")).toBe(true);
				await h.delta(content("text", "noop-body", "随后", 5, 8));
				await h.raf();
				expect(h.animationText()).toBe("活跃新字随后");
				// A second accepted body change must establish a fresh baseline, not reuse
				// the first snapshot's generation merely because this scope is already warm.
				const caughtUp = "历史正文活跃新字随后再次追赶";
				await h.frame({
					type: "streaming_snapshot",
					streamingBlocks: [content("text", "noop-body", caughtUp, 6, 0)],
					toolChunks: [],
				});
				await h.raf();
				expect(
					h.coordinator.getSnapshot().streamingMessage?._streamAnimSnapshotEpoch,
				).toBeGreaterThan(epoch as number);
				expect(h.text()).toContain(caughtUp);
				expect(h.animationCount()).toBe(0);
				await h.delta(content("text", "noop-body", "新尾", 7, caughtUp.length));
				await h.raf();
				expect(h.animationText()).toBe("新尾");
			},
			{ animateStreaming: true },
		);
	});
});

describe("real streaming hook / local WS / coordinator / DOM handoff", () => {
	it("restores a name-only tool after switching back without another live event", async () => {
		await withStream(async (h) => {
			const chunk = { toolUseId: "quiet-write", toolName: "Write", inputCharsTotal: 0 };
			await h.frame({ type: "tool_use_chunk", ...chunk });
			await h.raf();
			expect(h.live()?.toolCalls?.some((call) => call.toolUseId === chunk.toolUseId)).toBe(true);
			await h.switchNarrator("other");
			await h.switchNarrator("handoff-n");
			await h.frame({ type: "streaming_snapshot", streamingBlocks: [], toolChunks: [chunk] });
			await h.raf();
			expect(h.live()?.toolCalls?.some((call) => call.toolUseId === chunk.toolUseId)).toBe(true);
			expect(h.text()).toContain("Write");
		});
	});

	it("ignores child and persisted tools in snapshots but restores tools on their own page", async () => {
		await withStream(async (h) => {
			const chunk = {
				toolUseId: "child-write",
				toolName: "Write",
				inputCharsTotal: 0,
				parentToolUseId: "agent",
			};
			await h.frame({ type: "streaming_snapshot", streamingBlocks: [], toolChunks: [chunk] });
			await h.raf();
			expect(h.live()).toBeNull();
			await h.switchNarrator("child", true);
			await h.frame({ type: "streaming_snapshot", streamingBlocks: [], toolChunks: [chunk] });
			await h.raf();
			expect(h.live()?.toolCalls?.some((call) => call.toolUseId === chunk.toolUseId)).toBe(true);
			await h.commit([tool(chunk.toolUseId)]);
			await h.frame({ type: "streaming_snapshot", streamingBlocks: [], toolChunks: [chunk] });
			await h.raf();
			expect(h.live()?.toolCalls?.some((call) => call.toolUseId === chunk.toolUseId) ?? false).toBe(
				false,
			);
		});
	});
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
	for (const type of ["text", "reasoning"] as const) {
		for (const deltaFirst of [true, false]) {
			it(`restores ${type} after switching back (${deltaFirst ? "delta" : "snapshot"} first)`, async () => {
				await withStream(async (h) => {
					await h.delta(content(type, "active-block", "PREFIX", 1, 0));
					await h.raf();
					await h.switchNarrator("other");
					await h.switchNarrator("handoff-n");
					const delta = () => h.delta(content(type, "active-block", "+TAIL", 2, 6));
					if (deltaFirst) await delta();
					await h.frame({
						type: "streaming_snapshot",
						streamingBlocks: [content(type, "active-block", "PREFIX", 1, 0)],
						toolChunks: [],
					});
					if (!deltaFirst) await delta();
					await h.raf();
					expect(h.live()?.contentJson).toEqual([
						expect.objectContaining({ type, text: "PREFIX+TAIL", textOffset: 0 }),
					]);
					await h.commit([content(type, "active-block", "PREFIX+TAIL", 2, 0)]);
					await h.delta(content(type, "active-block", "+NEXT", 3, 11));
					await h.raf();
					expect(h.live()?.contentJson).toEqual([
						expect.objectContaining({ type, text: "PREFIX+TAIL+NEXT", textOffset: 0 }),
					]);
				});
			});
		}
	}
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
