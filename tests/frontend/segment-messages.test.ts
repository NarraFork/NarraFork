import { describe, expect, test } from "bun:test";
import { segmentMessages } from "../../frontend/components/narrator/message-segments";
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

	test("reasoning + tool → single tool-run with reasoning before tool", () => {
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
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("tool-run");
		if (segs[0].kind === "tool-run") {
			expect(segs[0].items.map((i) => i.kind)).toEqual(["reasoning", "tool"]);
		}
	});

	test("mixed message (reasoning + text + tool) → preserves original block order", () => {
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
		// Original order: reasoning, text, tool
		// reasoning starts a run, text breaks it, tool starts a new run
		expect(segs).toHaveLength(3);
		expect(segs[0].kind).toBe("tool-run"); // reasoning
		if (segs[0].kind === "tool-run") {
			expect(segs[0].items).toHaveLength(1);
			expect(segs[0].items[0].kind).toBe("reasoning");
		}
		expect(segs[1].kind).toBe("message"); // text
		expect(segs[2].kind).toBe("tool-run"); // tool
		if (segs[2].kind === "tool-run") {
			expect(segs[2].items).toHaveLength(1);
			expect(segs[2].items[0].kind).toBe("tool");
		}
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

	test("streaming reasoning + tool merges correctly", () => {
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
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("tool-run");
		if (segs[0].kind === "tool-run") {
			expect(segs[0].items.map((i) => i.kind)).toEqual(["tool", "reasoning", "tool"]);
		}
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

	test("standalone streaming reasoning → tool-run segment", () => {
		const streaming = makeMessage({
			id: "__streaming__",
			role: "assistant",
			contentJson: [{ type: "reasoning", text: "thinking..." }],
		});
		const segs = segmentMessages([], { streamingMsg: streaming });
		expect(segs).toHaveLength(1);
		expect(segs[0].kind).toBe("tool-run");
		if (segs[0].kind === "tool-run") {
			expect(segs[0].items).toHaveLength(1);
			expect(segs[0].items[0].kind).toBe("reasoning");
		}
	});

	test("prune divider is inserted", () => {
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
		const segs = segmentMessages([m1, m2], {
			pruneBoundaryMessageId: "u1",
			pruneDividerLabel: "pruned",
		});
		expect(segs.some((s) => s.kind === "prune-divider")).toBe(true);
	});

	test("streaming text + tool: text stays before tool (arrival order)", () => {
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
		expect(segs).toHaveLength(3);
		expect(segs[0].kind).toBe("tool-run"); // reasoning
		expect(segs[1].kind).toBe("message"); // text
		expect(segs[2].kind).toBe("tool-run"); // tool
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

	test("streaming reasoning + text → reasoning run then message", () => {
		const streaming = makeMessage({
			id: "__streaming__",
			role: "assistant",
			contentJson: [
				{ type: "reasoning", text: "thinking..." },
				{ type: "text", text: "here is my answer" },
			],
		});
		const segs = segmentMessages([], { streamingMsg: streaming });
		expect(segs).toHaveLength(2);
		expect(segs[0].kind).toBe("tool-run"); // reasoning
		expect(segs[1].kind).toBe("message"); // text
	});
});
