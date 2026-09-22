import { describe, expect, it } from "bun:test";
import {
	classifyToolDetail,
	type ToolCappedDetail,
	type ToolDetailData,
	type ToolMetaRowsDetail,
	type ToolSectionsDetail,
	type ToolStructuredDetail,
} from "./tool-detail";

function asSections(detail: ToolDetailData | null): ToolSectionsDetail {
	expect(detail?.kind).toBe("sections");
	if (!detail) throw new Error("Missing sections detail");
	return detail;
}

function metaRowsOf(detail: ToolDetailData | null): ToolMetaRowsDetail {
	const found = asSections(detail).sections.find((s) => s.body.kind === "meta-rows");
	if (!found) throw new Error("no meta-rows section");
	return found.body as ToolMetaRowsDetail;
}

function metaBadgeLabels(detail: ToolDetailData | null): string[] {
	return metaRowsOf(detail).rows.flatMap((r) => (r.badges ?? []).map((b) => b.label));
}

function sectionBodyByLabel(detail: ToolDetailData | null, label: string) {
	const found = asSections(detail).sections.find((s) => s.label === label);
	if (!found) throw new Error(`no "${label}" section in ${JSON.stringify(detail)}`);
	return found.body;
}

const baseInput = {
	toolUseId: "tu_1",
	toolName: "ContextAsk",
	category: "contextAsk",
	status: "success",
	inputJson: {
		id: "follow-model-runtime",
		questions: ["Q one?", "Q two?", "Q three?"],
	},
	outputJson:
		"ContextAsk result for model-runtime:\n\nThe answer body.\n\nNote: some oversized messages were truncated at ContextAsk safety limits.",
	metadata: {
		kind: "context_ask",
		target: { id: "n1", title: "model-runtime", status: "active" },
		questions: ["Q one?", "Q two?", "Q three?"],
		messageCount: 128,
		contextPercent: 42,
		sourceTruncated: true,
		hasMore: false,
		chunkCount: 3,
	},
};

describe("classifyContextAsk", () => {
	it("shows numbered questions instead of a raw JSON input dump", () => {
		const detail = classifyToolDetail(baseInput);
		const body = sectionBodyByLabel(detail, "input") as ToolStructuredDetail;
		expect(body.kind).toBe("structured");
		expect(body.bodyLines).toEqual(["1. Q one?", "2. Q two?", "3. Q three?"]);
		const labels = asSections(detail).sections.map((s) => s.label);
		expect(labels).not.toContain("output");
		const text = JSON.stringify(detail);
		expect(text).not.toContain("input.arguments");
		expect(text).not.toContain('"id":"follow-model-runtime"');
	});

	it("strips the server heading and trailing warning from the result body", () => {
		const detail = classifyToolDetail(baseInput);
		const body = sectionBodyByLabel(detail, "result") as ToolCappedDetail;
		expect(body.kind).toBe("capped");
		expect(body.text).toBe("The answer body.");
		expect(body.format).toBe("markdown");
		expect(body.text).not.toContain("ContextAsk result for");
		expect(body.text).not.toContain("Note:");
	});

	it("surfaces target and source stats as meta badges", () => {
		const detail = classifyToolDetail(baseInput);
		const labels = metaBadgeLabels(detail);
		expect(labels).toContain("→ model-runtime");
		expect(labels).toContain("3 questions");
		expect(labels).toContain("128 msgs");
		expect(labels).toContain("42% ctx");
		expect(labels).toContain("3 chunks");
		expect(labels).toContain("source truncated");
		expect(labels).not.toContain("older history omitted");
	});

	it("marks hasMore as an explicit badge", () => {
		const detail = classifyToolDetail({
			...baseInput,
			metadata: { ...baseInput.metadata, hasMore: true },
		});
		expect(metaBadgeLabels(detail)).toContain("older history omitted");
	});

	it("does not paint a live numeric stream as the answer body", () => {
		const detail = classifyToolDetail({
			...baseInput,
			status: "running",
			outputJson: undefined,
			metadata: { ...baseInput.metadata, _streamingOutput: "1240" },
		});
		const body = sectionBodyByLabel(detail, "result") as ToolStructuredDetail;
		expect(body.kind).toBe("structured");
		expect(body.bodyLines).toEqual(["1240 chars"]);
	});

	it("still shows questions while running", () => {
		const detail = classifyToolDetail({
			...baseInput,
			status: "running",
			outputJson: undefined,
			metadata: { _streamingOutput: "12" },
		});
		const body = sectionBodyByLabel(detail, "input") as ToolStructuredDetail;
		expect(body.bodyLines).toEqual(["1. Q one?", "2. Q two?", "3. Q three?"]);
	});

	it("degrades to input.id + status summary when metadata is missing", () => {
		const detail = classifyToolDetail({
			toolUseId: "tu_2",
			toolName: "ContextAsk",
			category: "contextAsk",
			status: "success",
			inputJson: { id: "alias" },
			outputJson: "plain answer",
		});
		expect(metaBadgeLabels(detail)).toContain("→ alias");
		expect(metaBadgeLabels(detail)).toContain("status summary");
		const body = sectionBodyByLabel(detail, "result") as ToolCappedDetail;
		expect(body.text).toBe("plain answer");
	});

	it("handles the zh-CN result heading", () => {
		const detail = classifyToolDetail({
			...baseInput,
			outputJson:
				"ContextAsk（model-runtime）结果：\n\n中文答案。\n\n注意：部分超长消息已按安全上限截断。",
		});
		const body = sectionBodyByLabel(detail, "result") as ToolCappedDetail;
		expect(body.text).toBe("中文答案。");
	});
});
