/**
 * live-tail-crosses-row-memo.test.tsx — The live reasoning tail must survive the
 * ROW MEMO, not just the adapter.
 *
 * ── The gap this closes ───────────────────────────────────────────────────────
 *
 * Two tests already cover the tail, and neither could see this:
 *   - `reasoning-live-tail.test.ts` proves the pure function returns the newest text.
 *   - `live-reasoning-tail.test.ts` proves `resolveRenderExtra(spec).rowLiveTails`
 *     advances per frame, and that the measurement cache stays flat.
 * Both stop at the pure layers. The shell mounts each row through `React.memo` with
 * a comparator that (correctly) does NOT compare `spec.data` — that would re-render
 * the whole window on every rebuild, a measured 22.3ms/frame regression.
 *
 * For a folded activity trace the three things it DOES compare are all constant
 * while the tail advances:
 *   - `item.measured` is the SAME object (the trace is a measurement-cache hit,
 *     because the tail is deliberately outside the cache key),
 *   - `spec.key` is `activity-<firstMsgId>-<i>`,
 *   - the row height never moves (the tail is height-neutral by construction).
 * So the memo skipped the re-render and the newest characters never reached the DOM:
 * the live row froze exactly as it did before the tail existed, one layer lower.
 *
 * The fix is a tail term in `interactionSig` (`liveTailSignature`). This file mounts
 * a real memoized row and drives two frames through it, so it fails if that term is
 * dropped OR if the memo starts comparing something that hides the tail again.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { liveTailSignature } from "@shared/pretext-layout/reasoning-live-tail";
import { parseHTML } from "linkedom";
import { act, memo } from "react";
import { createRoot } from "react-dom/client";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { renderElement, resolveRenderExtra } from "./render-registry";

const CONTENT_WIDTH = 800;

beforeAll(() => {
	installCanvasStub();
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	if (typeof g.matchMedia !== "function") {
		g.matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		});
	}
	if (typeof g.ResizeObserver !== "function") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
});

/** A settled tool call, so the activity unit's key is a cacheable (non-streaming) one. */
const HISTORY = [
	{
		id: "m0",
		seq: 0,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: "tu-0", name: "Read", input: { file_path: "a.ts" } }],
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

/** A body long enough that the ordinary title view is lossy (so a tail is produced). */
const BODY = (chars: number) => `**分析步骤**\n\n${"长文本".repeat(Math.ceil(chars / 3))}`;

/** Build one frame through the REAL document path and return its first item. */
async function frameItem(text: string) {
	const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
	const { recentRunSegmentMessageIds } = await import("../run-segments");
	const built = buildPretextDocumentLayout([...HISTORY, streamingMessage(text)] as never[], {
		layoutRevision: "r1",
		documentRevision: "v1",
		lod: 2,
		widthBucket: CONTENT_WIDTH,
		contentWidth: CONTENT_WIDTH,
		viewportHeight: 900,
		resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
	});
	const item = built.items[0];
	expect(item?.spec.kind).toBe("activity-trace");
	return item as NonNullable<typeof item>;
}

/**
 * The shell's row, reduced to the parts this property depends on: the same
 * draw-time extra channel, and a comparator with the same three terms plus
 * `interactionSig`.
 *
 * Deliberately NOT importing `ExactRow` (it is module-private and takes ~30 props
 * the shell owns). What is under test is whether a tail change can cross a memo of
 * this shape at all, which is exactly what the shell's comparator is.
 */
const MemoRow = memo(
	function Row({
		item,
	}: {
		item: { spec: { kind: string; key: string; data: unknown }; measured: unknown };
		interactionSig: string;
	}) {
		const extra = resolveRenderExtra(item.spec as never);
		extra.labels = { liveTailChars: (formatted: string) => `${formatted} 字符` } as never;
		return <>{renderElement(item.spec.kind as never, item.measured as never, extra)}</>;
	},
	(prev, next) =>
		// The shell's comparator, restricted to the terms that matter here.
		prev.item.measured === next.item.measured &&
		prev.item.spec.key === next.item.spec.key &&
		prev.item.spec.kind === next.item.spec.kind &&
		prev.interactionSig === next.interactionSig,
);

interface Mounted {
	text: () => string;
	render: (item: Awaited<ReturnType<typeof frameItem>>) => void;
	unmount: () => void;
}

/**
 * @param withTailSignature false reproduces the PRE-FIX signature (interaction +
 * viewer state only), which the negative-control case below uses to show the memo
 * really does swallow the update without it.
 */
function mount(withTailSignature = true): Mounted {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	return {
		text: () => container.textContent ?? "",
		render: (item) => {
			const sig = withTailSignature ? `||${liveTailSignature(item.spec.data)}` : "||";
			act(() => {
				root.render(
					<MantineProvider>
						<MemoRow item={item} interactionSig={sig} />
					</MantineProvider>,
				);
			});
		},
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("the live tail reaches the DOM across the row memo", () => {
	it("the memo's OTHER inputs really are identical between two frames", async () => {
		// Without this the test below could pass for the wrong reason (a changed
		// `measured` would re-render the row regardless of the signature).
		const first = await frameItem(BODY(300));
		const second = await frameItem(`${BODY(300)}续写的新内容`);
		expect(second.spec.key).toBe(first.spec.key);
		expect(second.spec.kind).toBe(first.spec.kind);
		// The trace is served from the measurement cache, so it is the SAME object —
		// which is precisely why the memo needed a separate tail term.
		expect(second.measured).toBe(first.measured);
		// ...and the row's height is unchanged, so no geometry prop moves either.
		expect(second.measured.height).toBe(first.measured.height);
	});

	it("repaints the row when only the tail advanced", async () => {
		const view = mount();
		try {
			const first = await frameItem(BODY(300));
			view.render(first);
			const before = view.text();
			expect(before).toContain("字符");

			const second = await frameItem(`${BODY(300)}这是刚刚到达的新内容`);
			view.render(second);
			const after = view.text();

			// The newest characters are on screen, and the label really moved.
			expect(after).not.toBe(before);
			expect(after).toContain("这是刚刚到达的新内容");
		} finally {
			view.unmount();
		}
	});

	// NEGATIVE CONTROL. Without the tail term the row is frozen — this is the bug,
	// reproduced. If a future change makes the pre-fix signature pass too, the test
	// above has stopped proving anything and this case goes red instead of silently
	// becoming vacuous.
	it("WOULD freeze without the tail term in the signature", async () => {
		const view = mount(false);
		try {
			view.render(await frameItem(BODY(300)));
			const before = view.text();
			view.render(await frameItem(`${BODY(300)}这是刚刚到达的新内容`));
			expect(view.text()).toBe(before);
		} finally {
			view.unmount();
		}
	});

	it("keeps the size readout in step with the accumulated body", async () => {
		const view = mount();
		try {
			view.render(await frameItem(BODY(300)));
			const first = view.text();
			view.render(await frameItem(BODY(900)));
			const second = view.text();
			expect(second).not.toBe(first);
		} finally {
			view.unmount();
		}
	});

	it("leaves the signature EMPTY for a settled row, so scroll-time memo hits stand", async () => {
		// The tail only exists on the live row. A settled document must produce no
		// signature at all, or every scroll frame would re-render every row.
		const settled = {
			id: "real-1",
			seq: 1,
			role: "assistant",
			contentJson: [{ type: "reasoning", text: BODY(600) }],
			toolCalls: [],
			children: [],
		};
		const { buildPretextDocumentLayout } = await import("./pretext-document-layout");
		const { recentRunSegmentMessageIds } = await import("../run-segments");
		const built = buildPretextDocumentLayout([...HISTORY, settled] as never[], {
			layoutRevision: "r1",
			documentRevision: "v1",
			lod: 2,
			widthBucket: CONTENT_WIDTH,
			contentWidth: CONTENT_WIDTH,
			viewportHeight: 900,
			resolveRecentMessageIds: (msgs) => recentRunSegmentMessageIds([...msgs] as never, 2),
		});
		for (const item of built.items) {
			expect(liveTailSignature(item.spec.data)).toBe("");
		}
	});
});

describe("liveTailSignature", () => {
	it("is empty for data that carries no rows", () => {
		expect(liveTailSignature(undefined)).toBe("");
		expect(liveTailSignature(null)).toBe("");
		expect(liveTailSignature({})).toBe("");
		expect(liveTailSignature({ items: "not an array" })).toBe("");
		expect(liveTailSignature({ items: [{ key: "a" }, null] })).toBe("");
	});

	it("advances with the accumulated size, not the tail text", () => {
		const at = (charCount: number) => liveTailSignature({ items: [{ liveTail: { charCount } }] });
		expect(at(100)).not.toBe(at(101));
		// The same size yields the same signature: the tail is a suffix of a
		// monotonically growing body, so the count is a sufficient frame identity.
		expect(at(100)).toBe(at(100));
	});

	it("covers several live rows without conflating them", () => {
		const one = liveTailSignature({ items: [{ liveTail: { charCount: 10 } }] });
		const two = liveTailSignature({
			items: [{ liveTail: { charCount: 1 } }, { liveTail: { charCount: 0 } }],
		});
		expect(one).not.toBe(two);
	});
});
