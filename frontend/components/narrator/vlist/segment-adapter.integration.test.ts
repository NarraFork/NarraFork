/**
 * segment-adapter.integration.test.ts — Validates the adapter against the REAL
 * segmentMessages output (not the structural mirror types). This closes the risk
 * that `segmentMessages(...) as unknown as AdapterSegment[]` silently reads
 * fields that don't exist on the real RenderSegment / ToolCallData.
 *
 * Uses real segmentMessages + realistic NarratorMsg-shaped inputs. The adapter
 * itself is pure classification/extraction and needs no canvas, but the tests
 * that go on to MEASURE a spec do (pretext measures text through a canvas), so a
 * deterministic stub is installed here rather than relying on one leaking in
 * from another test file.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { segmentMessages } from "../message/message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { groupRenderUnits } from "../render-units";
import type { MeasuredCommunicationBubble } from "./measure/measure-communication-bubble";
import type { MeasuredSubagent } from "./measure/measure-subagent";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { buildPretextLayoutManifest } from "./pretext-layout-manifest";
import { VLIST_REGISTRY } from "./registry";
import {
	type AdapterContext,
	type AdapterRenderUnit,
	type AdapterSegment,
	adaptSegments,
	type CommunicationBubbleData,
} from "./segment-adapter";
import { toolCompletedPatch } from "./vlist-live-events";
import { buildSelectionIndex } from "./vlist-selection";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

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

describe("subagent cards default to folded at L1 and expanded at L2–L5", () => {
	it.each([
		1, 2, 3, 4, 5,
	] as const)("L%s keeps multiple finished subagents between their ordinary-tool neighbours", (lod) => {
		const message = {
			...toolMessage(),
			contentJson: ["Read", "Agent", "Agent", "Read"].map((name, index) => ({
				type: "tool_use",
				id: `call-${index}`,
				name,
				input:
					name === "Agent"
						? { subagent_type: "explore", description: "Inspect auth", prompt: "Check auth" }
						: { file_path: "/repo/auth.ts" },
				status: "success",
				outputJson: { _text: "Finished inspection" },
			})),
			toolCalls: [],
		} as unknown as NarratorMsg;
		const units = groupRenderUnits(segmentMessages([message]), lod <= 2).map((unit, i) =>
			unit.kind === "activity" ? { ...unit, key: `activity-${i}` } : unit,
		) as unknown as AdapterRenderUnit[];
		const built = buildPretextLayoutManifest({
			layoutRevision: "subagent-low-lod",
			documentRevision: 1,
			lod,
			widthBucket: "600",
			renderUnits: units,
			contentWidth: 600,
			viewportHeight: 720,
			resolveSource: () => ({ firstSeq: 1, lastSeq: 1, sourceMessageIds: [message.id] }),
		});
		expect(built.items.map((item) => item.spec.kind)).toEqual([
			lod <= 2 ? "activity-trace" : "tool-call",
			"subagent-card",
			"subagent-card",
			lod <= 2 ? "activity-trace" : "tool-call",
		]);
		for (const item of built.items.filter((item) => item.spec.kind === "subagent-card")) {
			expect(item.spec.opts?.collapsesByLod).toBe(lod === 1);
			const measured = item.measured as MeasuredSubagent;
			expect(measured.effectiveExpanded).toBe(lod !== 1);
			expect(measured.resultBlockHeight > 0).toBe(lod !== 1);
			for (const opened of [false, true]) {
				const toggled = VLIST_REGISTRY["subagent-card"].measure(item.spec.data, 600, lod, {
					...item.spec.opts,
					...(lod === 1 ? { lodUserOverride: opened } : { opened }),
				}) as MeasuredSubagent;
				expect(toggled.effectiveExpanded).toBe(opened);
			}
		}
	});
});

describe("communication × real messages, manifest and selection", () => {
	function send(id: string, seq: number, status = "success"): NarratorMsg {
		return {
			...toolMessage(),
			id,
			seq,
			contentJson: [
				{
					type: "tool_use",
					id: "send-real",
					tcId: `call-${id}`,
					name: "Send",
					input: { name: "worker", message: "**hello**" },
					status,
					outputJson: { _metadata: { targets: [{ id: "worker-real", label: "worker" }] } },
				},
			],
			toolCalls: [],
		} as unknown as NarratorMsg;
	}
	function layout(messages: NarratorMsg[], lod: 1 | 2 | 3 | 4 | 5) {
		const units = groupRenderUnits(segmentMessages(messages), lod <= 2).map((unit, i) =>
			unit.kind === "activity" ? { ...unit, key: `activity-${i}` } : unit,
		) as unknown as AdapterRenderUnit[];
		return buildPretextLayoutManifest({
			layoutRevision: "communication",
			documentRevision: 1,
			lod,
			widthBucket: "600",
			renderUnits: units,
			contentWidth: 600,
			viewportHeight: 720,
			resolveSource: () => ({
				firstSeq: 1,
				lastSeq: 3,
				sourceMessageIds: messages.map((m) => m.id),
			}),
		});
	}

	it.each([
		1, 2, 3, 4, 5,
	] as const)("L%s preserves call identity and selection while retiring the synthetic twin", (lod) => {
		const persisted = send("saved", 1);
		const live = send("__streaming__", 3, "running");
		const separator = { ...textMessage("answer", "assistant", "between"), seq: 2 };
		const built = layout([persisted, separator, live], lod);
		const bubbles = built.items.filter((item) => item.spec.kind === "communication-bubble");
		expect(bubbles).toHaveLength(1);
		const bubble = bubbles[0];
		if (!bubble) throw new Error("missing communication bubble");
		const data = bubble.spec.data as CommunicationBubbleData;
		expect(bubble.spec.key).toBe("tool-send-real");
		expect(bubble.spec.unitId).toBe("tool-send-real");
		expect(data).toMatchObject({
			message: "**hello**",
			toolUseId: "send-real",
			toolName: "Send",
			recipients: [{ id: "worker-real", label: "worker" }],
			toolDetailRef: { toolCallId: "call-saved", messageId: "saved" },
		});
		expect(bubble.measured.height).toBeGreaterThan(30);
		const selection = buildSelectionIndex([persisted, separator]);
		expect(selection.byBlockId.get(`tc-${data.toolUseId}`)).toMatchObject({
			messageId: "saved",
			blockId: "tc-send-real",
			blockIndex: 0,
		});
		expect(built.items.map((item) => item.spec.kind)).toEqual(["communication-bubble", "markdown"]);
		const liveOnly = layout([live], lod).items[0];
		expect(liveOnly?.spec.key).toBe(bubble.spec.key);
		expect(liveOnly?.spec.unitId).toBe(bubble.spec.unitId);
	});

	it.each([
		1, 2, 3, 4, 5,
	] as const)("L%s maps a real fail completion without errorMessage through adapter and measurement", (lod) => {
		for (const toolName of ["Send", "TeamStatus"]) {
			const running = send("live-failure", 1, "running");
			running.contentJson = running.contentJson.map((block) => ({
				...block,
				name: toolName,
				input: { name: "worker", target_id: "worker", action: "send", message: "**hello**" },
			}));
			const before = layout([running], lod).items[0];
			for (const output of [
				"Send error: target missing",
				{ _text: "Send error: target missing" },
				undefined,
			]) {
				// Production completion writes status/output only, never errorMessage.
				const patched = toolCompletedPatch({
					toolUseId: "send-real",
					status: "fail",
					output,
					durationMs: 123,
				})([running]);
				expect(patched.changed).toBe(true);
				expect(patched.messages[0]?.contentJson[0]?.errorMessage).toBeUndefined();
				const failed = layout([...patched.messages], lod).items[0];
				if (!before || !failed) throw new Error("missing communication item");
				const data = failed.spec.data as CommunicationBubbleData;
				const measured = failed.measured as MeasuredCommunicationBubble;
				expect(failed.spec.kind).toBe("communication-bubble");
				expect(failed.spec.key).toBe(before.spec.key);
				expect(data).toMatchObject({
					status: "fail",
					message: "**hello**",
					timing: { durationMs: 123 },
				});
				expect(data.error).toBe(output === undefined ? undefined : "Send error: target missing");
				expect(measured.errorTop).toBeGreaterThanOrEqual(0);
				expect(measured.errorText).toBe(data.error ?? "");
				expect(measured.height).toBeGreaterThan(before.measured.height);
			}
		}
	});

	it.each([
		1, 2, 3, 4, 5,
	] as const)("L%s gives persisted retries independent keys and exact refs", (lod) => {
		const items = layout([send("retry-one", 1), send("retry-two", 2)], lod).items;
		expect(items.map((item) => item.spec.key)).toEqual(["tool-send-real", "tool-send-real#dup1"]);
		expect(new Set(items.map((item) => item.spec.unitId)).size).toBe(2);
		expect(
			items.map((item) => (item.spec.data as CommunicationBubbleData).toolDetailRef?.messageId),
		).toEqual(["retry-one", "retry-two"]);
	});
});

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

	it("subagent card carries height-relevant fields (recentCallCount, isTerminal) + render-only status glyph", () => {
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
			hasRecentCallsButton?: boolean;
			isTerminal?: boolean;
			isActive?: boolean;
			status?: unknown;
		};
		expect(data.recentCallCount).toBe(2); // from latestToolCalls
		// A known child narrator turns the recent-calls header into the "open full
		// session" button row (taller compact-xs), like SubagentCard gates it. Without
		// this field the button was never drawn and the card had NO in-card way to
		// reach the child session.
		expect(data.hasRecentCallsButton).toBe(true);
		expect(data.isTerminal).toBe(true); // status "success" is terminal
		expect(data.isActive).toBe(false); // terminal → not active (drives measure)
		// `status` is carried as a RENDER-ONLY field for the header status glyph
		// (success/fail/cancelled); the measure layer keys off isTerminal/isActive,
		// NOT this string, so it stays height-neutral.
		expect(data.status).toBe("success");
	});

	it("subagent card without a child narrator draws no open-session button", () => {
		const agentMsg = {
			id: "a-agent-2",
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentJson: [
				{
					type: "tool_use",
					id: "tu-agent-2",
					name: "Agent",
					input: { description: "explore the repo" },
					inputJson: { description: "explore the repo" },
					status: "running",
					// The card exists before the child is announced (subagent_started).
					_subagentActivity: { latestToolCalls: [{ toolName: "Read" }] },
				},
			],
			contentText: null,
			toolCalls: [{ toolUseId: "tu-agent-2", toolName: "Agent", inputJson: {}, status: "running" }],
			createdAt: "2026-01-01T00:00:00Z",
			children: [],
		} as unknown as NarratorMsg;
		const specs = adaptSegments(segmentMessages([agentMsg]) as unknown as AdapterSegment[], CTX);
		const data = specs.find((s) => s.kind === "subagent-card")?.data as {
			recentCallCount?: number;
			hasRecentCallsButton?: boolean;
		};
		expect(data.recentCallCount).toBe(1);
		expect(data.hasRecentCallsButton).toBe(false);
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

	// End-to-end regression for the dropped user image: segmentMessages emits ONE
	// whole-message segment for a user message (no visibleBlockIndices), and the
	// adapter must keep its image/text_file blocks as bubble attachments. Before the
	// fix they were filtered out and the picture never rendered in the vlist.
	it("keeps a user message's image + text_file attachments on the bubble", () => {
		const userMsg = {
			id: "u-media",
			narratorId: "n1",
			parentToolUseId: null,
			role: "user",
			// Server block order: attachments first, then the text block.
			contentJson: [
				{ type: "image", imageId: "img-1", filename: "shot.png", mediaType: "image/png" },
				{ type: "text_file", filename: "notes.txt", size: 12 },
				{ type: "text", text: "have a look" },
			],
			contentText: "have a look",
			toolCalls: [],
			createdAt: "2026-01-01T00:00:00Z",
			children: [],
		} as unknown as NarratorMsg;
		const segments = segmentMessages([userMsg]) as unknown as AdapterSegment[];
		const specs = adaptSegments(segments, CTX);
		// Attachments live INSIDE the bubble — still exactly one element.
		expect(specs).toHaveLength(1);
		expect(specs[0]?.kind).toBe("message-bubble");
		const data = specs[0]?.data as {
			text: string;
			attachments?: Array<{ type: string; imageId?: unknown; uploadNarratorId?: unknown }>;
		};
		expect(data.text).toBe("have a look");
		expect(data.attachments?.map((a) => a.type)).toEqual(["image", "text_file"]);
		expect(data.attachments?.[0]?.imageId).toBe("img-1");
		expect(data.attachments?.[0]?.uploadNarratorId).toBe("n1");
	});

	it("measures a user image bubble taller than the same caption alone", () => {
		const mk = (withImage: boolean) =>
			({
				id: withImage ? "u-img" : "u-plain",
				narratorId: "n1",
				parentToolUseId: null,
				role: "user",
				contentJson: withImage
					? [
							{ type: "image", imageId: "i" },
							{ type: "text", text: "hi" },
						]
					: [{ type: "text", text: "hi" }],
				contentText: "hi",
				toolCalls: [],
				createdAt: "2026-01-01T00:00:00Z",
				children: [],
			}) as unknown as NarratorMsg;
		const measure = (withImage: boolean) => {
			const segments = segmentMessages([mk(withImage)]) as unknown as AdapterSegment[];
			const spec = adaptSegments(segments, CTX)[0];
			if (!spec) throw new Error("expected a bubble spec");
			return VLIST_REGISTRY[spec.kind].measure(spec.data, 800, 5, spec.opts).height;
		};
		expect(measure(true)).toBeGreaterThan(measure(false));
	});
});
