/**
 * streaming-math-load.test.ts — KaTeX must load for math that arrives WITHOUT a fetch.
 *
 * The lazy KaTeX seam (katex-runtime) is awaited on the coordinator's async paths:
 * `load` and `loadOlder`. Every other way math can reach the document is synchronous:
 *
 *   - `setStreamingMessage` — the live row, i.e. the ENTIRE streaming experience
 *   - `appendMessage`       — a broadcast message adopted in place (the streamed
 *                            answer's persisted form, so the settled result too)
 *
 * On those paths `markdownMathSupport()` returns undefined, `splitMathOutsideCode`
 * never runs, and the formula is prepared as literal text — which is exactly the
 * reported symptom: formulas render as raw `$...$` source while streaming AND after
 * it settles, and only a page reload (which goes through `load`) fixes them.
 *
 * These tests assert the OBSERVABLE outcome — a `katex` unknown block exists for
 * display math, and an inline block carries `mathHtmls` for inline math — rather
 * than that some loader was called, because "KaTeX was loaded" is not the
 * requirement: "the row is laid out as math" is.
 */

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

type Loaded = Awaited<ReturnType<typeof load>>;

async function load() {
	const [coordinator, runtime, prepared] = await Promise.all([
		import("./pretext-layout-coordinator"),
		import("./katex-runtime"),
		import("@shared/pretext-layout/prepared-markdown-cache"),
	]);
	return { ...coordinator, ...runtime, ...prepared };
}

const BUILD = {
	lod: 5 as const,
	widthBucket: "800",
	contentWidth: 800,
	viewportHeight: 600,
	gap: 4,
	segmentGap: 12,
	topPadding: 16,
	bottomPadding: 16,
	resolveToolCategory: () => "generic",
	resolveToolColor: () => "gray",
	resolveToolSummary: () => "cmd",
};

/** Plain prose only: the loaded document must NOT be what triggers the KaTeX load. */
function prose(seq: number): TreeMessage {
	const text = "这一段完全没有公式，只是普通的中文散文内容，用来占据一定的高度。";
	return {
		id: `m${seq}`,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
		seq,
	} as unknown as TreeMessage;
}

function mathMessage(id: string, seq: number, text: string): TreeMessage {
	return {
		id,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", id: "streaming:text:0", text }],
		contentText: text,
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
		seq,
	} as unknown as TreeMessage;
}

function page(messages: readonly TreeMessage[]) {
	return {
		messages: [...messages],
		messageVersion: 7,
		pruneBoundaryMessageId: null,
		prunedPercent: null,
		hasPrev: false,
		maxSeq: messages.length - 1,
	};
}

async function mathFreeCoordinator(mod: Loaded) {
	const coordinator = new mod.PretextLayoutCoordinator();
	await coordinator.load(
		"n1",
		BUILD,
		{ fetchPage: async () => page([prose(0), prose(1)]) as never },
		undefined,
		600,
	);
	return coordinator;
}

/** Wait for the coordinator's async KaTeX load + rebuild to settle. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const DISPLAY_MD =
	"推导结果：\n\n$$\n\\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$\n";
const INLINE_MD = "质能关系 $E = mc^2$ 是狭义相对论的结论。";

/** Blocks of the LAST row, which is the streaming / appended message under test. */
function lastRowBlocks(coordinator: {
	getSnapshot: () => { items?: readonly { spec: { key: string } }[]; index?: unknown };
}): readonly { kind: string; tag?: string; mathHtmls?: unknown }[] {
	const snapshot = coordinator.getSnapshot() as unknown as {
		items?: readonly { spec: { key: string }; measured?: { blocks?: unknown } }[];
	};
	const items = snapshot.items ?? [];
	const out: { kind: string; tag?: string; mathHtmls?: unknown }[] = [];
	for (const item of items) {
		const measured = item.measured as
			| { blocks?: readonly { kind: string; tag?: string; mathHtmls?: unknown }[] }
			| undefined;
		for (const block of measured?.blocks ?? []) out.push(block);
	}
	return out;
}

describe("KaTeX loads for math that arrives on a synchronous path", () => {
	beforeEach(async () => {
		const mod = await load();
		mod.resetKatexRuntimeForTest();
		mod.resetPreparedMarkdownCache();
	});

	it("loads for a STREAMING row whose display math is the document's first formula", async () => {
		const mod = await load();
		const coordinator = await mathFreeCoordinator(mod);
		// Precondition: the fetched document had no math, so nothing loaded KaTeX.
		expect(mod.isKatexReady()).toBe(false);

		coordinator.setStreamingMessage(mathMessage("__streaming__", 999_999, DISPLAY_MD));
		await settle();

		expect(mod.isKatexReady()).toBe(true);
		const blocks = lastRowBlocks(coordinator);
		expect(blocks.some((block) => block.kind === "unknown" && block.tag === "katex")).toBe(true);
	});

	it("loads for a STREAMING row carrying inline math", async () => {
		const mod = await load();
		const coordinator = await mathFreeCoordinator(mod);
		expect(mod.isKatexReady()).toBe(false);

		coordinator.setStreamingMessage(mathMessage("__streaming__", 999_999, INLINE_MD));
		await settle();

		expect(mod.isKatexReady()).toBe(true);
		const blocks = lastRowBlocks(coordinator);
		expect(blocks.some((block) => block.kind === "inline" && block.mathHtmls != null)).toBe(true);
	});

	it("loads for an APPENDED broadcast message (the settled result of a stream)", async () => {
		const mod = await load();
		const coordinator = await mathFreeCoordinator(mod);
		expect(mod.isKatexReady()).toBe(false);

		coordinator.appendMessage(mathMessage("m2", 2, DISPLAY_MD), false);
		await settle();

		expect(mod.isKatexReady()).toBe(true);
		const blocks = lastRowBlocks(coordinator);
		expect(blocks.some((block) => block.kind === "unknown" && block.tag === "katex")).toBe(true);
	});

	it("does NOT load for a math-free streaming row", async () => {
		const mod = await load();
		const coordinator = await mathFreeCoordinator(mod);

		coordinator.setStreamingMessage(
			mathMessage("__streaming__", 999_999, "只是普通文本，没有公式。"),
		);
		await settle();

		expect(mod.isKatexReady()).toBe(false);
	});
});
