/**
 * segment-adapter.integration.test.ts — Validates the adapter against the REAL
 * segmentMessages output (not the structural mirror types). This closes the risk
 * that `segmentMessages(...) as unknown as AdapterSegment[]` silently reads
 * fields that don't exist on the real RenderSegment / ToolCallData.
 *
 * Uses real segmentMessages + realistic NarratorMsg-shaped inputs; no canvas
 * needed (adapter is pure classification/extraction).
 */

import { describe, expect, it } from "bun:test";
import { segmentMessages } from "../message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { VLIST_REGISTRY } from "./registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "./segment-adapter";

const CTX: AdapterContext = { lod: 5 };

// A realistic assistant message with a tool_use block (mirrors what the backend
// sends: contentJson carries the enriched tool_use block).
function toolMessage(): NarratorMsg {
	return {
		id: "a-tool",
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [
			{
				type: "tool_use",
				id: "tu-1",
				name: "Read",
				input: { file_path: "/tmp/x.ts" },
				inputJson: { file_path: "/tmp/x.ts" },
				status: "completed",
			},
		],
		contentText: null,
		toolCalls: [
			{
				toolUseId: "tu-1",
				toolName: "Read",
				inputJson: { file_path: "/tmp/x.ts" },
				status: "completed",
			},
		],
		createdAt: "2026-01-01T00:00:00Z",
		children: [],
	} as unknown as NarratorMsg;
}

function textMessage(id: string, role: string, text: string): NarratorMsg {
	return {
		id,
		narratorId: "n1",
		parentToolUseId: null,
		role,
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		createdAt: "2026-01-01T00:00:00Z",
		children: [],
	} as unknown as NarratorMsg;
}

describe("adapter × real segmentMessages", () => {
	it("adapts real segments to registry kinds with defined tool data", () => {
		const messages = [
			textMessage("u1", "user", "hello"),
			textMessage("a1", "assistant", "hi there"),
			toolMessage(),
		];
		const segments = segmentMessages(messages) as unknown as AdapterSegment[];
		const specs = adaptSegments(segments, CTX);

		expect(specs.length).toBeGreaterThan(0);
		for (const spec of specs) {
			expect(VLIST_REGISTRY[spec.kind]).toBeDefined();
		}

		// The tool-run must produce a tool-call spec whose data carries a real
		// toolName (NOT undefined — the previous mirror read a phantom tc.summary).
		const toolSpec = specs.find((s) => s.kind === "tool-call");
		expect(toolSpec).toBeDefined();
		const data = toolSpec?.data as { toolName?: unknown; summary?: unknown };
		expect(data.toolName).toBe("Read");
		// Summary is DERIVED from inputJson (file_path), not read from a phantom
		// tc.summary — this is the regression the mirror-type risk hid.
		expect(data.summary).toBe("/tmp/x.ts");
	});

	it("real tool item exposes toolName/status/inputJson (not a summary field)", () => {
		const segments = segmentMessages([toolMessage()]) as unknown as AdapterSegment[];
		const toolRun = segments.find((s) => s.kind === "tool-run");
		expect(toolRun).toBeDefined();
		if (toolRun?.kind !== "tool-run") return;
		const tc = toolRun.items[0]!.tc as Record<string, unknown>;
		// Ground truth: ToolCallData has toolName/status/inputJson, and NO summary.
		expect(tc.toolName).toBe("Read");
		expect(tc.status).toBe("completed");
		expect("summary" in tc).toBe(false);
	});

	it("routes a system knowledge_hint even when it is NOT block[0]", () => {
		// Real structure (MessageBubble scans blocks.find(type===...)): the
		// meaningful system block can sit after a leading text block.
		const sysMsg = {
			id: "s-kh",
			narratorId: "n1",
			parentToolUseId: null,
			role: "system",
			contentJson: [
				{ type: "text", text: "note" },
				{ type: "knowledge_hint", entries: [{ id: "k1", title: "Doc" }] },
			],
			contentText: null,
			toolCalls: [],
			createdAt: "2026-01-01T00:00:00Z",
			children: [],
		} as unknown as NarratorMsg;
		const segments = segmentMessages([sysMsg]) as unknown as AdapterSegment[];
		const specs = adaptSegments(segments, CTX);
		expect(specs.some((s) => s.kind === "knowledge-hint")).toBe(true);
	});

	it("routes a system compact/plan even when preceded by other blocks", () => {
		const sysMsg = {
			id: "s-plan",
			narratorId: "n1",
			parentToolUseId: null,
			role: "system",
			contentJson: [
				{ type: "text", text: "x" },
				{ type: "compact", subtype: "plan", summary: "the plan body" },
			],
			contentText: null,
			toolCalls: [],
			createdAt: "2026-01-01T00:00:00Z",
			children: [],
		} as unknown as NarratorMsg;
		const segments = segmentMessages([sysMsg]) as unknown as AdapterSegment[];
		const specs = adaptSegments(segments, CTX);
		expect(specs.some((s) => s.kind === "plan-card")).toBe(true);
	});

	it("routes assistant media blocks (image / image_generation / text_file) to media", () => {
		const mediaMsg = {
			id: "a-media",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [
				{ type: "image", imageId: "img-1", filename: "pic.png" },
				{ type: "image_generation", status: "completed", width: 1024, height: 512, result: "..." },
				{ type: "text_file", filename: "notes.txt", mediaType: "text/plain" },
			],
			contentText: null,
			toolCalls: [],
			createdAt: "2026-01-01T00:00:00Z",
			children: [],
		} as unknown as NarratorMsg;
		const segments = segmentMessages([mediaMsg]) as unknown as AdapterSegment[];
		const specs = adaptSegments(segments, CTX);
		const mediaSpecs = specs.filter((s) => s.kind === "media");
		expect(mediaSpecs).toHaveLength(3);
		// image_generation carries real numeric width/height (raw block fields).
		const gen = mediaSpecs.find((s) => (s.data as { type?: string }).type === "image_generation");
		expect((gen?.data as { width?: unknown }).width).toBe(1024);
		expect((gen?.data as { height?: unknown }).height).toBe(512);
	});

	it("ask_in_passing: pending status → pending, any other → resolved (mirrors MessageBubble)", () => {
		const mk = (status: string) =>
			({
				id: `aip-${status}`,
				narratorId: "n1",
				parentToolUseId: null,
				role: "system",
				contentJson: [{ type: "ask_in_passing", status, text: "q?" }],
				contentText: null,
				toolCalls: [],
				createdAt: "2026-01-01T00:00:00Z",
				children: [],
			}) as unknown as NarratorMsg;

		const pending = adaptSegments(
			segmentMessages([mk("pending")]) as unknown as AdapterSegment[],
			CTX,
		);
		const resolved = adaptSegments(
			segmentMessages([mk("resolved")]) as unknown as AdapterSegment[],
			CTX,
		);
		expect((pending[0]?.data as { kind?: string }).kind).toBe("pending");
		expect((resolved[0]?.data as { kind?: string }).kind).toBe("resolved");
	});

	it("subagent card carries height-relevant fields (recentCallCount, isTerminal), not phantom status", () => {
		const agentMsg = {
			id: "a-agent",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [
				{
					type: "tool_use",
					id: "tu-agent",
					name: "Agent",
					input: { description: "explore the repo" },
					inputJson: { description: "explore the repo" },
					status: "success",
					_subagentActivity: {
						subagentNarratorId: "sub-1",
						model: "sonnet",
						latestToolCalls: [{ toolName: "Read" }, { toolName: "Grep" }],
					},
				},
			],
			contentText: null,
			toolCalls: [{ toolUseId: "tu-agent", toolName: "Agent", inputJson: {}, status: "success" }],
			createdAt: "2026-01-01T00:00:00Z",
			children: [],
		} as unknown as NarratorMsg;
		const segments = segmentMessages([agentMsg]) as unknown as AdapterSegment[];
		const specs = adaptSegments(segments, CTX);
		const sub = specs.find((s) => s.kind === "subagent-card");
		expect(sub).toBeDefined();
		const data = sub?.data as {
			recentCallCount?: number;
			isTerminal?: boolean;
			status?: unknown;
		};
		expect(data.recentCallCount).toBe(2); // from latestToolCalls
		expect(data.isTerminal).toBe(true); // status "success" is terminal
		expect("status" in data).toBe(false); // no phantom status field
	});

	it("user + assistant text segments route to bubble/markdown", () => {
		const segments = segmentMessages([
			textMessage("u1", "user", "question?"),
			textMessage("a1", "assistant", "answer."),
		]) as unknown as AdapterSegment[];
		const specs = adaptSegments(segments, CTX);
		expect(specs.some((s) => s.kind === "message-bubble")).toBe(true);
		expect(specs.some((s) => s.kind === "markdown")).toBe(true);
	});
});
