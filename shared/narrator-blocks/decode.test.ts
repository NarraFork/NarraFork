import { describe, expect, test } from "bun:test";
import { encodeToolOutput } from "../agent-protocol/tool-output";
import { type DecodableMessage, decodeLegacyContent, splitToolInput } from "./decode";
import { isModelVisible } from "./types";

function row(overrides: Partial<DecodableMessage>): DecodableMessage {
	return {
		id: "m1",
		role: "user",
		contentJson: [],
		contentText: null,
		parentToolUseId: null,
		...overrides,
	};
}

describe("decodeLegacyContent: assistant steps", () => {
	test("one block per stored item, in stored order, with deterministic ids", () => {
		const envelope = decodeLegacyContent(
			row({
				role: "assistant",
				messageUuid: "msg_up",
				contentJson: [
					{
						type: "reasoning",
						text: "think",
						providerMetadata: {
							signatureSource: "anthropic",
							anthropic: { signature: "sig" },
						},
						translatedText: "想",
					},
					{ type: "text", text: "hello", citations: [{ startIndex: 0, endIndex: 5, sources: [] }] },
					{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } },
					{ type: "text", text: "after", completed: false },
				],
				toolCalls: [
					{
						toolUseId: "toolu_1",
						toolName: "Read",
						inputJson: { path: "a", __geminiThoughtSignature: "g" },
						outputJson: "file body",
						status: "success",
					},
				],
			}),
		);
		expect(envelope.upstreamMessageId).toBe("msg_up");
		expect(
			envelope.blocks.map((block) => [block.id, block.kind, block.ordinal, block.phase]),
		).toEqual([
			["m1:0", "reasoning", 0, "done"],
			["m1:1", "output", 1, "done"],
			["m1:2", "tool", 2, "done"],
			["m1:3", "output", 3, "aborted"],
		]);
		const [reasoning, output, tool] = envelope.blocks;
		expect(reasoning).toMatchObject({
			providerMeta: { source: "anthropic", wire: { anthropic: { signature: "sig" } } },
			state: { translatedText: "想" },
		});
		expect(output).toMatchObject({
			payload: { parts: [{ type: "text", text: "hello", citations: [{ endIndex: 5 }] }] },
		});
		expect(tool).toMatchObject({
			subtype: "Read",
			wireId: "toolu_1",
			payload: {
				input: { path: "a" },
				executor: "local",
				issuer: "model",
				result: { isError: false },
			},
			providerMeta: { wire: { thoughtSignature: "g" } },
		});
		expect(envelope.toolOutputs).toEqual({ toolu_1: { status: "success", output: "file body" } });
	});

	test("a call without a terminal ledger attempt stays open and invisible", () => {
		const envelope = decodeLegacyContent(
			row({
				role: "assistant",
				contentJson: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
				toolCalls: [
					{
						toolUseId: "toolu_1",
						toolName: "Bash",
						inputJson: {},
						outputJson: null,
						status: "running",
					},
				],
			}),
		);
		expect(envelope.blocks[0]).toMatchObject({ kind: "tool", phase: "open" });
		expect(isModelVisible(envelope.blocks[0])).toBe(false);
		expect(envelope.toolOutputs).toBeUndefined();
	});

	test("a broken call is failed and carries no result; tool images become result parts", () => {
		const envelope = decodeLegacyContent(
			row({
				role: "assistant",
				contentJson: [
					{ type: "tool_use", id: "toolu_bad", name: "Write", input: { content: "[invalid]" } },
					{ type: "tool_use", id: "toolu_shot", name: "Screenshot", input: {} },
				],
				toolCalls: [
					{
						toolUseId: "toolu_bad",
						toolName: "Write",
						inputJson: { content: "[invalid]" },
						outputJson: encodeToolOutput("not executed", { broken: true }),
						status: "fail",
					},
					{
						toolUseId: "toolu_shot",
						toolName: "Screenshot",
						inputJson: {},
						outputJson: encodeToolOutput("captured", {
							images: [{ imageId: "img1", mediaType: "image/png", uploadNarratorId: "n1" }],
						}),
						status: "success",
					},
				],
			}),
		);
		expect(envelope.blocks[0]).toMatchObject({
			phase: "failed",
			payload: { result: { isError: true } },
		});
		expect(isModelVisible(envelope.blocks[0])).toBe(false);
		expect(envelope.blocks[1]).toMatchObject({
			phase: "done",
			payload: {
				result: {
					isError: false,
					parts: [
						{ type: "image", assetId: "img1", mediaType: "image/png", uploadNarratorId: "n1" },
					],
				},
			},
		});
		expect(Object.keys(envelope.toolOutputs ?? {})).toEqual(["toolu_shot"]);
	});

	test("ledger-only calls are synthesized after the content; internal reads are dropped", () => {
		const envelope = decodeLegacyContent(
			row({
				role: "assistant",
				contentJson: [{ type: "text", text: "x" }],
				toolCalls: [
					{
						toolUseId: "old_1",
						toolName: "Grep",
						inputJson: '{"q":1}',
						outputJson: "o",
						status: "fail",
					},
					{
						toolUseId: "internal_read_abc",
						toolName: "Read",
						inputJson: { __internalRead: { parentToolCallId: "p" } },
						outputJson: {},
						status: "success",
					},
				],
			}),
		);
		expect(envelope.blocks.map((block) => block.id)).toEqual(["m1:0", "m1:call:old_1"]);
		expect(envelope.blocks[1]).toMatchObject({
			payload: { input: { q: 1 }, result: { isError: true } },
		});
		expect(Object.keys(envelope.toolOutputs ?? {})).toEqual(["old_1"]);
	});

	test("flat text is replayed ahead of the first tool call when no text block exists", () => {
		const envelope = decodeLegacyContent(
			row({
				role: "assistant",
				contentText: "edited text",
				contentJson: [{ type: "tool_use", id: "t", name: "Read", input: {} }],
				toolCalls: [
					{ toolUseId: "t", toolName: "Read", inputJson: {}, outputJson: "", status: "success" },
				],
			}),
		);
		expect(envelope.blocks.map((block) => [block.id, block.kind])).toEqual([
			["m1:text", "output"],
			["m1:0", "tool"],
		]);
	});

	test("redacted thinking, legacy thinking and provider tools", () => {
		const envelope = decodeLegacyContent(
			row({
				role: "assistant",
				contentJson: [
					{ type: "thinking", thinking: "old", signature: "s1" },
					{ type: "redacted_thinking", data: "opaque", signatureSource: "anthropic" },
					{ type: "web_search", id: "ws_1", query: "q", action: { type: "search", query: "q" } },
					{ type: "image_generation", id: "ig_1", revisedPrompt: "p", savedPath: "/tmp/a.png" },
					{ type: "tool_result", tool_use_id: "x", content: "display only" },
				],
			}),
		);
		expect(envelope.blocks).toHaveLength(4);
		expect(envelope.blocks[0]).toMatchObject({
			kind: "reasoning",
			payload: { parts: [{ text: "old" }] },
			providerMeta: { wire: { anthropic: { signature: "s1" } } },
		});
		expect(envelope.blocks[1]).toMatchObject({
			kind: "reasoning",
			payload: { parts: [], redacted: true },
			providerMeta: { source: "anthropic", wire: { data: "opaque" } },
		});
		expect(envelope.blocks[2]).toMatchObject({
			kind: "tool",
			subtype: "web_search",
			payload: { executor: "provider", input: { query: "q" } },
		});
		expect(envelope.blocks[3]).toMatchObject({
			subtype: "image_generation",
			providerMeta: { result: { revisedPrompt: "p", savedPath: "/tmp/a.png" } },
		});
	});
});

describe("decodeLegacyContent: single-block envelopes", () => {
	test("user input keeps every part in stored order and the projected model text", () => {
		const envelope = decodeLegacyContent(
			row({
				contentText: "look\n\n<attached_files>…</attached_files>",
				contentJson: [
					{
						type: "image",
						imageId: "img1",
						filename: "a.png",
						mediaType: "image/png",
						width: 2,
						height: 3,
					},
					{ type: "text_file", filename: "n.txt", size: 4, filePath: "/w/n.txt" },
					{
						type: "file_reference",
						reference: { id: "r", deviceId: "d", path: "/p", label: "p" },
						snapshotText: "body",
						snapshotHash: "h",
						capturedAt: "t",
					},
					{ type: "text", text: "look" },
				],
			}),
		);
		expect(envelope.blocks).toHaveLength(1);
		const [block] = envelope.blocks;
		expect(block).toMatchObject({ id: "m1:0", kind: "input", modelText: "look" });
		expect(block.kind === "input" && block.payload.parts.map((part) => part.type)).toEqual([
			"image",
			"file",
			"file_ref",
			"text",
		]);
	});

	test("system-written user turns are context; human turns are input", () => {
		expect(
			decodeLegacyContent(
				row({ origin: "system", contentJson: [{ type: "text", text: "continue" }] }),
			).blocks[0],
		).toMatchObject({ kind: "context", subtype: "system_text", modelText: "continue" });
		expect(
			decodeLegacyContent(row({ origin: "user", contentJson: [{ type: "text", text: "hi" }] }))
				.blocks[0],
		).toMatchObject({ kind: "input", modelText: "hi" });
	});

	test("subagent input stays input even though it carries a sender injection", () => {
		const envelope = decodeLegacyContent(
			row({
				origin: "assistant",
				contentText: "do it",
				contentJson: [
					{ type: "text", text: "do it" },
					{
						type: "system_injection",
						source: "subagent_message",
						body: {
							kind: "messages",
							items: [{ fromId: "p", fromTitle: "Parent", text: "do it" }],
						},
					},
				],
			}),
		);
		expect(envelope.blocks[0]).toMatchObject({ kind: "input", modelText: "do it" });
	});

	test("injections, legacy pairs and native cards are context with their model text", () => {
		expect(
			decodeLegacyContent(
				row({
					role: "sys",
					contentJson: [{ type: "system_injection", source: "bg_agent", modelText: "done" }],
				}),
			).blocks[0],
		).toMatchObject({ kind: "context", subtype: "system_injection", modelText: "done" });
		expect(
			decodeLegacyContent(
				row({
					role: "sys",
					contentJson: [
						{ type: "text", text: "legacy" },
						{ type: "sidecar", source: "spec_update" },
					],
				}),
			).blocks[0],
		).toMatchObject({ kind: "context", subtype: "system_injection", modelText: "legacy" });
		expect(
			decodeLegacyContent(
				row({
					role: "sys",
					contentJson: [
						{ type: "merge_summary", summary: "s", isLatest: true, modelText: "merged" },
					],
				}),
			).blocks[0],
		).toMatchObject({ subtype: "merge_summary", modelText: "merged", state: { isLatest: true } });
	});

	test("typed context updates keep frozen text separate from metadata and require a host row", () => {
		const contextUpdate = {
			epochId: "epoch-1",
			changes: [
				{ key: "workspace", value: "/repo/b" },
				{ key: "empty", value: "" },
				{ key: "removed", value: null },
			],
		};
		const contentJson = [
			{ type: "text", text: "frozen update" },
			{ type: "context_update", ...contextUpdate },
		];
		const host = row({ role: "sys", contentJson, contentText: "must not replace frozen text" });
		expect(decodeLegacyContent(host).blocks[0]).toMatchObject({
			kind: "context",
			subtype: "context_update",
			modelText: "frozen update",
			contextUpdate,
		});
		const user = decodeLegacyContent({ ...host, role: "user" }).blocks[0];
		expect(user).toMatchObject({ kind: "input", modelText: "frozen update" });
		expect(user).not.toHaveProperty("contextUpdate");
		const pasted = decodeLegacyContent(
			row({
				role: "user",
				contentJson: [{ type: "text", text: "<context_update>workspace=/repo/b</context_update>" }],
			}),
		).blocks[0];
		expect(pasted).not.toHaveProperty("contextUpdate");
		const invalid = decodeLegacyContent({
			...host,
			contentJson: [
				contentJson[0],
				{ type: "context_update", epochId: "epoch-1", changes: [{ key: "x", value: 5 }] },
			],
		}).blocks[0];
		expect(invalid).not.toHaveProperty("contextUpdate");
	});

	test("tool notices, bash, review, segment compact", () => {
		expect(
			decodeLegacyContent(
				row({
					contentText: "[loaded]",
					contentJson: [
						{ type: "tool_loaded", toolName: "eval", toolNames: ["Eval"], text: "[loaded]" },
					],
				}),
				{
					toolChangeOf: () => ({
						mode: "anthropic_tool_addition",
						additions: [{ name: "Eval" }],
						removals: [],
					}),
				},
			).blocks[0],
		).toMatchObject({
			kind: "context",
			subtype: "tool_loaded",
			modelText: "[loaded]",
			payload: { body: { toolName: "eval", toolNames: ["Eval"] } },
			toolChange: { additions: [{ name: "Eval" }] },
		});
		expect(
			decodeLegacyContent(
				row({ contentText: "/bash ls", contentJson: [{ type: "bash_command", command: "ls" }] }),
			).blocks[0],
		).toMatchObject({ kind: "input", subtype: "bash_command", modelText: "/bash ls" });
		expect(
			decodeLegacyContent(
				row({
					origin: "system",
					contentJson: [
						{ type: "text", text: "review says" },
						{ type: "review_feedback", verdict: "ok", applied: true },
					],
				}),
			).blocks[0],
		).toMatchObject({
			subtype: "review_feedback",
			modelText: "review says",
			state: { applied: true },
		});
		const compacting = decodeLegacyContent(
			row({
				contentText: "[Segment compacting]",
				contentJson: [{ type: "segment_compact", status: "compacting" }],
			}),
		).blocks[0];
		expect(compacting).toMatchObject({ phase: "open", modelText: null });
		expect(isModelVisible(compacting)).toBe(false);
		const done = decodeLegacyContent(
			row({
				contentText: "[Segment Compact]\nsummary",
				contentJson: [{ type: "segment_compact", status: "compacted", summary: "summary" }],
			}),
		).blocks[0];
		expect(done).toMatchObject({ phase: "done", modelText: "[Segment Compact]\nsummary" });
		const failed = decodeLegacyContent(
			row({
				contentText: "[Segment Compact Failed]\nx",
				contentJson: [{ type: "segment_compact", status: "failed" }],
			}),
		).blocks[0];
		expect(isModelVisible(failed)).toBe(false);
	});

	test("control markers and cards never reach the model", () => {
		const compact = decodeLegacyContent(
			row({
				role: "system",
				contentText: "[Compacting]",
				contentJson: [{ type: "compact", status: "compacting", mode: "background", attempts: [] }],
			}),
		).blocks[0];
		expect(compact).toMatchObject({
			subtype: "compact",
			phase: "open",
			state: { mode: "background" },
		});
		const plan = decodeLegacyContent(
			row({
				role: "system",
				contentJson: [{ type: "compact", status: "compacted", subtype: "plan", summary: "p" }],
			}),
		).blocks[0];
		expect(plan).toMatchObject({ subtype: "plan", phase: "done" });
		const error = decodeLegacyContent(
			row({
				role: "system",
				contentText: "[Error] x",
				contentJson: [{ type: "error", message: "x" }],
			}),
		).blocks[0];
		expect(error).toMatchObject({ kind: "context", subtype: "error", modelText: null });
		for (const block of [compact, plan, error]) expect(isModelVisible(block)).toBe(false);
	});
});

describe("splitToolInput", () => {
	test("separates reserved metadata from arguments and parses legacy strings", () => {
		expect(
			splitToolInput('{"a":1,"__geminiThoughtSignature":"s","__geminiThoughtSignatureSource":"g"}'),
		).toEqual({ input: { a: 1 }, thoughtSignature: "s", thoughtSignatureSource: "g" });
		expect(splitToolInput("not json")).toEqual({ input: {} });
	});
});
