/**
 * round-review-fixes.test.tsx — 覆盖 PR #727 评审修复项的回归测试：
 *   1. 折叠段保留子元素的 sourceMessageIds 与 seq 范围（搜索目标不丢失）；
 *   2. 流式回复进行中不提前折叠（`opts.streamingContent` / `__streaming__`）；
 *   3. `jumpTargetScrollTop` 支持 `align: "top"` 而不影响默认 `"center"`；
 *   4. `RoundRail` 桌面键盘激活打开选择器、Escape 恢复焦点、无嵌套 `<button>`、悬停卡可点击跳转；
 *   5. 预览内推理 trace 收起读取 `foldedChildMetaRef`、删除/编辑同步失效轮次缓存、收起态跳过子元素重测。
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import type { NarratorRound } from "@shared/narrator-rounds";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { NarratorMsg } from "../narrator-panel-types";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { isStreamingKey } from "./measure-cache";
import { buildPretextDocumentLayout } from "./pretext-document-layout";
import { formatRoundFoldTitle } from "./round-group-compose";
import { RoundRail } from "./round-rail/RoundRail";
import { jumpTargetItemIndex, jumpTargetScrollTop } from "./vlist-jump-target";

const disposeCanvas = installCanvasStub();
afterAll(() => disposeCanvas());

const readVlistFile = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");

function makeMsg(
	id: string,
	role: "user" | "assistant",
	seq: number,
	blocks: unknown[],
	extra?: Partial<NarratorMsg>,
): NarratorMsg {
	return {
		...rowWithElements(
			{
				id,
				role,
				origin: role === "user" ? "user" : null,
				createdAt: `2026-01-01T00:00:0${seq}.000Z`,
				...extra,
			},
			blocks as never,
		),
		seq,
	} as unknown as NarratorMsg;
}

describe("整轮折叠保留来源元数据与搜索目标（Devin #1）", () => {
	it("round-group 合并保留折叠内消息的 sourceMessageIds 与 [firstSeq, lastSeq]", () => {
		const messages: NarratorMsg[] = [
			makeMsg("u1", "user", 10, [{ type: "text", text: "帮我检查一下" }]),
			makeMsg("a1-progress", "assistant", 11, [{ type: "text", text: "先看一下日志进度" }]),
			makeMsg("a1-final", "assistant", 12, [{ type: "text", text: "最终结论：全部正常" }]),
		];

		const built = buildPretextDocumentLayout(messages, {
			contentWidth: 640,
			lod: 4,
			documentRevision: "rev-1",
			layoutRevision: "layout-1",
			widthBucket: "640",
			roundFold: {
				enabled: true,
				buildTitle: ({ durationMs, tokens }) => formatRoundFoldTitle("已处理", durationMs, tokens),
			},
		});

		const groupItem = built.manifest.items.find((item) => item.kind === "round-group");
		expect(groupItem).toBeDefined();
		expect(groupItem!.sourceMessageIds).toContain("a1-progress");
		expect(groupItem!.firstSeq).toBe(11);
		expect(groupItem!.lastSeq).toBe(11);

		// 搜索折叠内的中间进度消息，索引必须能命中该 round-group（而非 undefined 或错位行）
		const hitIndex = jumpTargetItemIndex(built.index, "a1-progress");
		expect(hitIndex).toBeDefined();
		expect(built.manifest.items[hitIndex!]?.kind).toBe("round-group");
	});
});

describe("流式回复进行中不提前折叠（Devin #5）", () => {
	const isLiveSpec = (spec: {
		key?: string;
		opts?: { streamingContent?: unknown };
		data?: unknown;
	}) => {
		if (spec.opts?.streamingContent === true) return true;
		if (typeof spec.key === "string" && isStreamingKey(spec.key)) return true;
		const data = spec.data as { isStreaming?: unknown; status?: unknown } | null;
		if (!data || typeof data !== "object") return false;
		if (data.isStreaming === true) return true;
		const status = data.status;
		return (
			status === "running" ||
			status === "pending" ||
			status === "queued" ||
			status === "initializing"
		);
	};

	it("工具完成后正在流式输出最终回复时，不折叠该轮；流式结束后才折叠", () => {
		const userMsg = makeMsg("u1", "user", 1, [{ type: "text", text: "分析一下" }]);
		const progressMsg = makeMsg("a-mid", "assistant", 2, [
			{ type: "text", text: "正在检查中间结果" },
		]);
		const liveReply = makeMsg("__streaming__", "assistant", 3, [
			{ type: "text", text: "正在流式输出的最终回答…" },
		]);

		const whileStreaming = buildPretextDocumentLayout([userMsg, progressMsg, liveReply], {
			contentWidth: 640,
			lod: 4,
			documentRevision: "rev-stream",
			layoutRevision: "layout-stream",
			widthBucket: "640",
			roundFold: {
				enabled: true,
				isLiveSpec,
				buildTitle: ({ durationMs, tokens }) => formatRoundFoldTitle("已处理", durationMs, tokens),
			},
		});
		expect(whileStreaming.items.some((item) => item.spec.kind === "round-group")).toBe(false);

		const settledReply = makeMsg("a-final", "assistant", 3, [
			{ type: "text", text: "流式已结束的最终回答。" },
		]);
		const afterSettled = buildPretextDocumentLayout([userMsg, progressMsg, settledReply], {
			contentWidth: 640,
			lod: 4,
			documentRevision: "rev-done",
			layoutRevision: "layout-done",
			widthBucket: "640",
			roundFold: {
				enabled: true,
				isLiveSpec,
				buildTitle: ({ durationMs, tokens }) => formatRoundFoldTitle("已处理", durationMs, tokens),
			},
		});
		expect(afterSettled.items.some((item) => item.spec.kind === "round-group")).toBe(true);
	});
});

describe("jumpTargetScrollTop 对齐选项（Devin #8）", () => {
	function makeGeometry(scrollTop: number, targetTopInViewport: number, targetHeight: number) {
		const viewport = {
			scrollTop,
			scrollHeight: 3000,
			clientHeight: 600,
			offsetHeight: 600,
			clientTop: 0,
			getBoundingClientRect: () => ({ top: 100, height: 600 }),
		} as unknown as HTMLElement;
		const target = {
			getBoundingClientRect: () => ({
				top: 100 + targetTopInViewport,
				height: targetHeight,
			}),
		} as unknown as HTMLElement;
		return { viewport, target };
	}

	it("默认居中对齐（搜索跳转不变）", () => {
		const { viewport, target } = makeGeometry(500, 300, 40);
		// 目标在文档 y = 800，高 40，视口高 600 → 居中 scrollTop = 800 - (600 - 40)/2 = 520
		expect(jumpTargetScrollTop(viewport, target)).toBe(520);
	});

	it("align: 'top' 对齐视口顶部（轮轨跳转）", () => {
		const { viewport, target } = makeGeometry(500, 300, 40);
		// 目标在文档 y = 800，topPadding = 16 → 顶对齐 scrollTop = 800 - 16 = 784
		expect(jumpTargetScrollTop(viewport, target, { align: "top", topPadding: 16 })).toBe(784);
	});
});

describe("RoundRail 键盘无障碍与 DOM 结构（Devin #6）", () => {
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	const originalHTMLElement = globalThis.HTMLElement;
	const originalRAF = globalThis.requestAnimationFrame;
	const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;

	afterEach(() => {
		globalThis.window = originalWindow;
		globalThis.document = originalDocument;
		globalThis.HTMLElement = originalHTMLElement;
		globalThis.requestAnimationFrame = originalRAF;
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct;
	});

	it("桌面键盘激活（detail=0）打开选择器而非直接跳转，无嵌套 button，Escape 关闭并恢复焦点", () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
		globalThis.window = dom.window as unknown as Window & typeof globalThis;
		globalThis.document = dom.document as unknown as Document;
		globalThis.HTMLElement = dom.HTMLElement as unknown as typeof HTMLElement;
		const raf = (cb: FrameRequestCallback) => {
			cb(0);
			return 0;
		};
		globalThis.requestAnimationFrame = raf;
		(dom.window as unknown as { requestAnimationFrame: typeof raf }).requestAnimationFrame = raf;
		(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
			() => {};

		const rounds: NarratorRound[] = [
			{ seq: 1, messageId: "m1", userText: "第一轮提问", startedAt: 1000, repliedAt: 2000 },
			{ seq: 3, messageId: "m3", userText: "第二轮提问", startedAt: 3000, repliedAt: 4000 },
			{ seq: 5, messageId: "m5", userText: "第三轮提问", startedAt: 5000, repliedAt: 6000 },
		];
		const jumped: string[] = [];
		const toggledFav: number[] = [];

		const container = dom.document.getElementById("root")!;
		const root = createRoot(container);
		act(() => {
			root.render(
				<RoundRail
					rounds={rounds}
					activeIndex={1}
					onJumpToRound={(round) => jumped.push(round.messageId)}
					favorites={new Set()}
					onToggleFavorite={(seq) => toggledFav.push(seq)}
				/>,
			);
		});

		const railBtn = container.querySelector<HTMLButtonElement>("button[aria-haspopup='listbox']");
		expect(railBtn).not.toBeNull();
		let railFocusedCount = 0;
		const focusCalls: Array<FocusOptions | undefined> = [];
		railBtn!.focus = (options?: FocusOptions) => {
			railFocusedCount += 1;
			focusCalls.push(options);
		};
		let focusedActive = false;
		const origFocus = dom.HTMLElement.prototype.focus;
		dom.HTMLElement.prototype.focus = function (this: HTMLElement) {
			if (this.getAttribute("data-round-card-active") === "1") focusedActive = true;
			origFocus?.call(this);
		};

		// 模拟键盘 Enter/Space 触发的无坐标 click（detail === 0）
		act(() => {
			const evt = Object.assign(new dom.window.Event("click", { bubbles: true }), { detail: 0 });
			railBtn!.dispatchEvent(evt);
		});

		// 必须打开选择器列表，而不是直接跳转，并把焦点移到当前轮按钮
		expect(jumped).toEqual([]);
		expect(focusedActive).toBe(true);
		const listbox = container.querySelector("[role='listbox']");
		expect(listbox).not.toBeNull();
		// 不存在非法嵌套 `<button>`
		expect(listbox!.querySelector("button button")).toBeNull();

		// 点收藏按钮只切换收藏，不触发跳转
		const favBtn = listbox!.querySelector<HTMLButtonElement>("button[aria-pressed]");
		expect(favBtn).not.toBeNull();
		act(() => {
			favBtn!.click();
		});
		expect(toggledFav).toEqual([1]);
		expect(jumped).toEqual([]);

		// 按 Escape 关闭选择器并把焦点无滚动地还给轨道按钮
		act(() => {
			const esc = Object.assign(new dom.window.Event("keydown", { bubbles: true }), {
				key: "Escape",
			});
			dom.window.dispatchEvent(esc);
		});
		expect(container.querySelector("[role='listbox']")).toBeNull();
		expect(railFocusedCount).toBe(1);
		expect(focusCalls[0]).toEqual({ preventScroll: true });

		// 重新键盘打开并按 Enter/点击选中一轮：选择器关闭、触发跳转，且焦点无滚动地还给轨道按钮
		act(() => {
			const evt = Object.assign(new dom.window.Event("click", { bubbles: true }), { detail: 0 });
			railBtn!.dispatchEvent(evt);
		});
		const selectBtn = container.querySelector<HTMLButtonElement>("[data-round-card-select='1']");
		expect(selectBtn).not.toBeNull();
		act(() => {
			selectBtn!.click();
		});
		expect(container.querySelector("[role='listbox']")).toBeNull();
		expect(jumped).toEqual(["m1"]);
		expect(railFocusedCount).toBe(2);
		expect(focusCalls[1]).toEqual({ preventScroll: true });

		act(() => {
			root.unmount();
		});
	});
});

describe("壳层与行组件接线守卫（Devin #4 / #7 / #8 与收起态零重测）", () => {
	it("PretextExactMessageList 的 onToggleItems 优先读 foldedChildMetaRef（预览 trace 可收起）", () => {
		const source = readVlistFile("PretextExactMessageList.tsx");
		expect(source).toMatch(
			/onToggleItems:\s*\(\)\s*=>\s*\{\s*const measured = \(foldedChildMetaRef\.current\.get\(key\)\?\.measured\s*\?\?/,
		);
	});

	it("删除与编辑处理器共享 invalidateNarratorRounds（Devin #4）", () => {
		const source = readVlistFile("PretextExactMessageList.tsx");
		const matches = source.match(/invalidateNarratorRounds\(\);/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(3);
	});

	it("ExactRow 收起态不遍历、不重测 folded 子元素", () => {
		const source = readVlistFile("ExactRow.tsx");
		expect(source).toContain("if (isPreviewOpen && Array.isArray(folded) && folded.length > 0)");
	});

	it("轮次高亮探针按 scrollTop + PAGE_PADDING + 1 与顶对齐跳转口径一致，搜索跳转会清空旧的轮轨覆盖", async () => {
		const source = readVlistFile("PretextExactMessageList.tsx");
		expect(source).toContain("scrollTop + PAGE_PADDING + 1");
		expect(source).toContain("roundSeq: round.seq");
		expect(source).toContain("setJumpedRoundSeq(roundSeq ?? null);");

		// 直接执行生产 scrollToMessageTarget：
		// 先经轮轨跳到 roundSeq=10，再在无手动滚动时经搜索跳到另一轮（不传 roundSeq），
		// 必须把 jumpedRoundSeq 从 10 清回 null，不留旧高亮。
		const start = source.indexOf("const scrollToMessageTarget = useCallback(");
		expect(start).toBeGreaterThan(-1);
		let depth = 0;
		let end = -1;
		for (let i = source.indexOf("(", start); i < source.length; i++) {
			if (source[i] === "(") depth += 1;
			else if (source[i] === ")") {
				depth -= 1;
				if (depth === 0) {
					end = i + 1;
					break;
				}
			}
		}
		expect(end).toBeGreaterThan(start);
		const region = source.slice(start, end);
		const code = new Bun.Transpiler({ loader: "tsx" }).transformSync(
			`${region}; return scrollToMessageTarget;`,
		);
		let jumpedRoundSeq: number | null = null;
		const jumpTokenRef = { current: 0 };
		const loadedTopNarratorRef = { current: null as string | null };
		const fakeEl = {} as HTMLElement;
		const fakeNode = {
			querySelector: () => fakeEl,
		} as unknown as HTMLElement;
		const bindings = {
			useCallback: <T,>(fn: T) => fn,
			t: (key: string) => key,
			jumpTokenRef,
			loadedTopNarratorRef,
			setJumpedRoundSeq: (next: number | null | ((c: number | null) => number | null)) => {
				jumpedRoundSeq = typeof next === "function" ? next(jumpedRoundSeq) : next;
			},
			getSmoothFollower: () => ({ cancel: () => {} }),
			viewportRef: { current: fakeNode },
			mountedJumpTarget: () => fakeEl,
			interactionAdmissionRef: { current: { markHistoryIntent: () => {} } },
			pinnedToBottomRef: { current: false },
			visibleViewportRef: { current: { setPinned: () => {} } },
			setPinnedToBottom: () => {},
			writeScrollTop: () => {},
			jumpTargetScrollTop: () => 420,
			PAGE_PADDING: 16,
			highlightRef: { current: { flash: () => {} } },
			pretextDocumentRef: {
				current: {
					readWindow: () => ({ index: null }),
				},
			},
			jumpTargetItemIndex: () => undefined,
			renderItemsRef: { current: [] },
			onPromoteRound: () => {},
			waitAnimationFrame: async () => {},
			messageIdFromTarget: (id: string) => id,
			resolveJumpTargetSeq: async () => null,
			dataSource: undefined,
			narratorId: "n1",
			narratorsApi: {},
			loadOlderToSeq: async () => false,
			loadOlder: async () => false,
			toast: { error: () => {} },
			pretextDocument: { status: "ready" },
			revealRetryRef: { current: null },
		};
		const scrollToMessageTarget = new Function(...Object.keys(bindings), code)(
			...Object.values(bindings),
		) as (opts: {
			domIds: string[];
			targetIds: string[];
			highlightId?: string;
			align?: "center" | "top";
			roundSeq?: number;
		}) => Promise<boolean>;

		// 1. 轮轨跳到第 10 轮
		expect(
			await scrollToMessageTarget({
				domIds: ["msg-m10"],
				targetIds: ["m10"],
				highlightId: "m10",
				align: "top",
				roundSeq: 10,
			}),
		).toBe(true);
		expect(jumpedRoundSeq).toBe(10);

		// 2. 不手动滚动，直接执行搜索跳转（不传 roundSeq）
		expect(
			await scrollToMessageTarget({
				domIds: ["msg-m30"],
				targetIds: ["m30"],
				highlightId: "m30",
			}),
		).toBe(true);
		expect(jumpedRoundSeq).toBeNull();
	});
});
