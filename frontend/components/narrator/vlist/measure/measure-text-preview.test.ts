import { afterAll, describe, expect, test } from "bun:test";
import { TEXT_PREVIEW_MAX_CHARS } from "@shared/pretext-layout/text-preview";
import { installCanvasStub } from "./test-canvas-stub";

const dispose = installCanvasStub();
afterAll(dispose);
const { measureTextPreview } = await import("./measure-text-preview");
const { measureReasoning } = await import("./measure-reasoning");
const { measureInjectionBubble } = await import("./measure-injection-bubble");
const { measureCommunicationBubble } = await import("./measure-communication-bubble");
const { measureCollapsibleTrace } = await import("./measure-tool-run");
const { typographyMetrics } = await import("../pretext-fonts");
const long = `${"A paragraph with text\n\n".repeat(1000)}END_MARKER`;

describe("shared body budgets", () => {
	test("registry long live reasoning never prepares the unbounded source cache", async () => {
		const { measureElementCached } = await import("../registry");
		const { resetStreamingBlockCache, streamingBlockCacheSize } = await import(
			"../streaming-block-cache"
		);
		resetStreamingBlockCache();
		const data = { text: long, isStreaming: true };
		const live = measureElementCached("reasoning", data, 600, 4, {}, "__streaming__-preview");
		const direct = measureReasoning(data, 600, 4);
		expect(live.frame).toEqual(direct.frame);
		expect(live.textPreview).toEqual(direct.textPreview);
		expect(streamingBlockCacheSize()).toBe(0);
		measureElementCached("reasoning", data, 600, 4, { textExpanded: true }, "__streaming__-full");
		expect(streamingBlockCacheSize()).toBe(1);
		resetStreamingBlockCache();
	});
	test("registry short live reasoning retains its existing incremental path", async () => {
		const { measureElementCached } = await import("../registry");
		const { resetStreamingBlockCache, streamingBlockCacheSize } = await import(
			"../streaming-block-cache"
		);
		resetStreamingBlockCache();
		const result = measureElementCached(
			"reasoning",
			{ text: "short thought", isStreaming: true },
			600,
			4,
			{},
			"__streaming__-short",
		);
		expect(result.textPreview?.buttonHeight).toBe(0);
		expect(streamingBlockCacheSize()).toBe(1);
		resetStreamingBlockCache();
	});
	test("every injection LOD has bounded preparation and no old 32Ki full-text cap", () => {
		for (const lod of [1, 2, 3, 4, 5] as const) {
			const result = measureInjectionBubble({ markdown: long.repeat(3) }, 600, lod);
			expect(result.measuredMarkdown.length).toBe(TEXT_PREVIEW_MAX_CHARS);
			expect(result.textPreview?.bodyHeight).toBeLessThanOrEqual(
				typographyMetrics().line.body * 12,
			);
			const full = measureInjectionBubble({ markdown: long.repeat(3) }, 600, lod, {
				textExpanded: true,
			});
			expect(full.measuredMarkdown).toBe(long.repeat(3));
			expect(full.textPreview?.buttonHeight).toBeGreaterThan(0);
		}
	});
	test("communication measures the full available messageBody, distinguishing true truncation", () => {
		const data = {
			message: "legacy bounded prefix",
			messageTruncated: true,
			sourceTruncated: false,
			messageBody: { text: long },
		};
		const result = measureCommunicationBubble(data, 600);
		expect(result.textPreview?.sourceText).toBe(long);
		expect(result.textPreview?.clipped).toBe(true);
		expect(result.isTruncated).toBe(false);
		const full = measureCommunicationBubble(data, 600, 4, { textExpanded: true });
		expect(full.measuredMarkdown).toBe(long);
		expect(full.viewFullTop).toBe(-1);
		const truncated = measureCommunicationBubble({ ...data, sourceTruncated: true }, 600, 4, {
			textExpanded: true,
		});
		expect(truncated.viewFullTop).toBeGreaterThan(0);
	});
	test("live reasoning has newest literal tail and original char count", () => {
		const result = measureReasoning({ text: long, isStreaming: true }, 600);
		expect(result.charCount).toBe(long.length);
		expect(result.displayText).toBe(long);
		expect(result.textPreview?.direction).toBe("tail");
		expect(result.textPreview?.plainText).toBe(true);
		expect(result.textPreview?.previewText.endsWith("END_MARKER")).toBe(true);
		expect(result.blocks.every((block) => block.kind === "code")).toBe(true);
		const full = measureReasoning({ text: long, isStreaming: true }, 600, 4, {
			textExpanded: true,
		});
		expect(full.textPreview?.expanded).toBe(true);
		expect(full.textPreview?.plainText).toBe(false);
	});
	test("height-only live overflow also falls back to plain text", () => {
		const result = measureTextPreview("**literal**\n\n".repeat(30), 600, { direction: "tail" });
		expect(result.textPreview?.plainText).toBe(true);
		expect(result.frame.contentHeight).toBe(typographyMetrics().line.body * 12);
	});
	test("nested bodies honor their stable key independently", () => {
		const data = {
			variant: "reasoning-steps" as const,
			items: [
				{ key: "step", title: "Step", bodyText: long },
				{ title: "Fallback", bodyText: long },
			],
		};
		const preview = measureCollapsibleTrace(data, 600, { expandedIndices: [0, 1] });
		expect(preview.rows[0]?.body?.textPreview?.expanded).toBe(false);
		const full = measureCollapsibleTrace(data, 600, {
			expandedIndices: [0, 1],
			textExpandedKeys: ["step", "1"],
		});
		expect(full.rows[0]?.body?.textPreview?.expanded).toBe(true);
		expect(full.rows[1]?.key).toBe("1");
		expect(full.rows[1]?.body?.textPreview?.expanded).toBe(true);
		expect(full.height).toBeGreaterThan(preview.height);
	});
	test("unknown intrinsic content keeps an explicit in-place expansion path", () => {
		const result = measureTextPreview("```mermaid\ngraph TD\nA-->B\n```", 600);
		expect(result.textPreview?.clipped).toBe(true);
		expect(result.textPreview?.buttonHeight).toBeGreaterThan(0);
		expect(result.frame.contentHeight).toBeLessThanOrEqual(typographyMetrics().line.body * 12);
	});
	test("preview code never offers a partial body as full copy text", () => {
		const source = `\`\`\`ts\n${"const a = 1;\n".repeat(3000)}\`\`\``;
		const result = measureTextPreview(source, 600);
		expect(result.blocks.find((block) => block.kind === "code")?.copyText).toBeNull();
		const full = measureTextPreview(source, 600, { textExpanded: true });
		expect(full.blocks.find((block) => block.kind === "code")?.copyText).toBeUndefined();
	});
});
