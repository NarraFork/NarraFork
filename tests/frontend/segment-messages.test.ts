import { describe, expect, test } from "bun:test";
import {
	collectSegmentTargetIds,
	segmentMessages,
} from "../../frontend/components/narrator/message/message-segments";
import { makeMessage } from "./narrator-timeline.fixtures";

describe("segmentMessages", () => {
	test("non-assistant message → message segment", () => {
		const msg = makeMessage({
			id: "u1",
			role: "user",
			contentJson: [{ type: "text", text: "hi" }],
		});
		const segs = segmentMessages([msg]);
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("message");
	});

	test("plain text assistant → message segment", () => {
		const msg = makeMessage({
			id: "a1",
			role: "assistant",
			contentJson: [{ type: "text", text: "hello" }],
		});
		const segs = segmentMessages([msg]);
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("message");
	});

	test("tool-only assistant → single tool-run segment", () => {
		const msg = makeMessage({
			id: "a1",
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }],
			toolCalls: [
				{ toolUseId: "tu1", toolName: "Bash", status: "success", createdAt: "2025-01-01" },
			],
		});
		const segs = segmentMessages([msg]);
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("tool-run");
		if (segs[0].kind === "tool-run") {
			expect(segs[0].items).toHaveLength(1);
			expect(segs[0].items[0].kind).toBe("tool");
		}
	});

	test("reasoning + tool → message segment (reasoning) then tool-run", () => {
		const msg = makeMessage({
			id: "a1",
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "thinking..." },
				{ type: "tool_use", id: "tu1", name: "Read", input: {} },
			],
			toolCalls: [
				{ toolUseId: "tu1", toolName: "Read", status: "success", createdAt: "2025-01-01" },
			],
		});
		const segs = segmentMessages([msg]);
		expect(segs).toHaveLength(2);
		expect(segs[0].kind).toBe("message");
		expect(segs[1].kind).toBe("tool-run");
		if (segs[1].kind === "tool-run") {
			expect(segs[1].items.map((i) => i.kind)).toEqual(["tool"]);
		}
	});

	test("reasoning + text + tool → text message then tool-run", () => {
		const msg = makeMessage({
			id: "a1",
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "let me think" },
				{ type: "text", text: "here is my plan" },
				{ type: "tool_use", id: "tu1", name: "Write", input: {} },
			],
			toolCalls: [
				{ toolUseId: "tu1", toolName: "Write", status: "success", createdAt: "2025-01-01" },
			],
		});
		const segs = segmentMessages([msg]);
		expect(segs).toHaveLength(2);
		expect(segs[0].kind).toBe("message"); // text
		expect(segs[1].kind).toBe("tool-run"); // tool
	});

	test("consecutive tool-only messages merge into one tool-run", () => {
		const m1 = makeMessage({
			id: "a1",
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }],
			toolCalls: [
				{ toolUseId: "tu1", toolName: "Read", status: "success", createdAt: "2025-01-01" },
			],
		});
		const m2 = makeMessage({
			id: "a2",
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu2", name: "Write", input: {} }],
			toolCalls: [
				{ toolUseId: "tu2", toolName: "Write", status: "success", createdAt: "2025-01-01" },
			],
		});
		const segs = segmentMessages([m1, m2]);
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("tool-run");
		if (segs[0].kind === "tool-run") {
			expect(segs[0].items).toHaveLength(2);
			expect(segs[0].sourceMessages).toHaveLength(2);
		}
	});

	test("streaming tool merges into preceding tool-run", () => {
		const committed = makeMessage({
			id: "a1",
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }],
			toolCalls: [
				{ toolUseId: "tu1", toolName: "Read", status: "success", createdAt: "2025-01-01" },
			],
		});
		const streaming = makeMessage({
			id: "__streaming__",
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu2", name: "Write", input: {} }],
			toolCalls: [
				{ toolUseId: "tu2", toolName: "Write", status: "running", createdAt: "2025-01-01" },
			],
		});
		const segs = segmentMessages([committed], { streamingMsg: streaming });
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("tool-run");
		if (segs[0].kind === "tool-run") {
			expect(segs[0].items).toHaveLength(2);
		}
	});

	test("streaming reasoning breaks tool-run, producing 3 segments", () => {
		const committed = makeMessage({
			id: "a1",
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }],
			toolCalls: [
				{ toolUseId: "tu1", toolName: "Read", status: "success", createdAt: "2025-01-01" },
			],
		});
		const streaming = makeMessage({
			id: "__streaming__",
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "thinking about next step" },
				{ type: "tool_use", id: "tu2", name: "Write", input: {} },
			],
			toolCalls: [
				{ toolUseId: "tu2", toolName: "Write", status: "running", createdAt: "2025-01-01" },
			],
		});
		const segs = segmentMessages([committed], { streamingMsg: streaming });
		// reasoning is visible content → breaks the tool-run into 3 segments
		expect(segs).toHaveLength(3);
		expect(segs[0].kind).toBe("tool-run"); // committed tool
		expect(segs[1].kind).toBe("message"); // streaming reasoning
		expect(segs[2].kind).toBe("tool-run"); // streaming tool
	});

	test("text between tools breaks the run", () => {
		const m1 = makeMessage({
			id: "a1",
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }],
			toolCalls: [
				{ toolUseId: "tu1", toolName: "Read", status: "success", createdAt: "2025-01-01" },
			],
		});
		const m2 = makeMessage({
			id: "a2",
			role: "assistant",
			contentJson: [{ type: "text", text: "ok, now let me..." }],
		});
		const m3 = makeMessage({
			id: "a3",
			role: "assistant",
			contentJson: [{ type: "tool_use", id: "tu2", name: "Write", input: {} }],
			toolCalls: [
				{ toolUseId: "tu2", toolName: "Write", status: "success", createdAt: "2025-01-01" },
			],
		});
		const segs = segmentMessages([m1, m2, m3]);
		expect(segs).toHaveLength(3);
		expect(segs[0].kind).toBe("tool-run");
		expect(segs[1].kind).toBe("message");
		expect(segs[2].kind).toBe("tool-run");
	});

	test("standalone streaming reasoning → content-whole segment (fallback)", () => {
		const streaming = makeMessage({
			id: "__streaming__",
			role: "assistant",
			contentJson: [{ type: "reasoning", text: "thinking..." }],
		});
		const segs = segmentMessages([], { streamingMsg: streaming });
		// Reasoning blocks are ignored, but the message still gets a fallback segment
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("message");
	});

	test("adjacent messages produce only their content segments", () => {
		const m1 = makeMessage({
			id: "u1",
			role: "user",
			contentJson: [{ type: "text", text: "hi" }],
		});
		const m2 = makeMessage({
			id: "a1",
			role: "assistant",
			contentJson: [{ type: "text", text: "hello" }],
		});
		const segs = segmentMessages([m1, m2]);
		expect(segs).toHaveLength(2);
		expect(segs.map((segment) => segment.kind)).toEqual(["message", "message"]);
		expect(collectSegmentTargetIds(segs[0])).toEqual(["u1"]);
		expect(collectSegmentTargetIds(segs[1])).toEqual(["a1"]);
	});

	test("streaming text + tool: text stays before tool", () => {
		const streaming = makeMessage({
			id: "__streaming__",
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "thinking..." },
				{ type: "text", text: "here is my plan" },
				{ type: "tool_use", id: "tu1", name: "Write", input: {} },
			],
			toolCalls: [
				{ toolUseId: "tu1", toolName: "Write", status: "running", createdAt: "2025-01-01" },
			],
		});
		const segs = segmentMessages([], { streamingMsg: streaming });
		expect(segs).toHaveLength(2);
		expect(segs[0].kind).toBe("message"); // text
		expect(segs[1].kind).toBe("tool-run"); // tool
	});

	test("streaming text only (no tool) → message segment", () => {
		const streaming = makeMessage({
			id: "__streaming__",
			role: "assistant",
			contentJson: [{ type: "text", text: "hello world" }],
		});
		const segs = segmentMessages([], { streamingMsg: streaming });
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("message");
	});

	test("streaming reasoning + text → only message segment", () => {
		const streaming = makeMessage({
			id: "__streaming__",
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "thinking..." },
				{ type: "text", text: "here is my answer" },
			],
		});
		const segs = segmentMessages([], { streamingMsg: streaming });
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("message"); // text only, reasoning ignored
	});

	test("native web_search stays content by default for React renderer", () => {
		const msg = makeMessage({
			id: "a1",
			role: "assistant",
			contentJson: [{ type: "web_search", id: "ws1", status: "completed", query: "weather" }],
		});
		const segs = segmentMessages([msg]);
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("message");
	});

	// A case here used to assert that provider-native `web_search` blocks merge into a
	// tool-run via `nativeWebSearchAsTool`. That option existed for the Pixi renderer,
	// which built its own block models rather than consuming the segment adapter; the
	// renderer and the option are both gone. The vlist gives `web_search` its own
	// `web-search` lane, covered by `vlist/segment-adapter.test.ts`.
});
