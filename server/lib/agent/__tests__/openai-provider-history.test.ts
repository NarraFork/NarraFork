import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pruneToolCalls } from "../../../services/narrator-session";
import type { OpenAIProviderConfig } from "../../settings";
import { setUploadsDirForTests } from "../../uploads";
import { isRetryableError } from "../error-handling";
import {
	convertHistoryToResponsesApi,
	type OAIMessage,
	OpenAIProvider,
	parseResponsesAPIEvent,
} from "../openai-provider";
import type { DbMessage } from "../provider";

const TEST_PROVIDER: OpenAIProviderConfig = {
	id: "test-openai",
	name: "Test OpenAI",
	prefix: "openai",
	apiKey: "test-key",
	baseUrl: "https://example.com/v1",
	defaultModel: "gpt-5",
	apiMode: "responses",
};

const SAMPLE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
let testUploadsRoot = "";

function registerTestImage(narratorId: string, imageId: string, ext = ".png"): string {
	const dir = resolve(testUploadsRoot, narratorId);
	mkdirSync(dir, { recursive: true });
	const filePath = resolve(dir, `${imageId}${ext}`);
	writeFileSync(filePath, Buffer.from(SAMPLE_PNG_BASE64, "base64"));
	return filePath;
}

beforeEach(() => {
	testUploadsRoot = mkdtempSync(join(tmpdir(), "narrafork-openai-history-"));
	setUploadsDirForTests(testUploadsRoot);
});

afterEach(() => {
	setUploadsDirForTests(null);
	if (testUploadsRoot) {
		rmSync(testUploadsRoot, { recursive: true, force: true });
		testUploadsRoot = "";
	}
});

function makeAssistantMessage(overrides: Partial<DbMessage> = {}): DbMessage {
	return {
		id: "msg-1",
		role: "assistant",
		contentJson: [],
		contentText: null,
		parentToolUseId: null,
		messageUuid: null,
		toolCalls: [],
		...overrides,
	};
}

function makeUserMessage(overrides: Partial<DbMessage> = {}): DbMessage {
	return {
		id: "user-1",
		role: "user",
		contentJson: [],
		contentText: null,
		parentToolUseId: null,
		messageUuid: null,
		toolCalls: [],
		...overrides,
	};
}

describe("OpenAIProvider Responses history reasoning continuation", () => {
	test("buildHistory includes reasoning items with encrypted_content for continuation", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{
						type: "reasoning",
						text: "Earlier hidden reasoning summary",
						providerMetadata: {
							signatureSource: "openai",
							openai: {
								itemId: "rs_123",
								reasoningEncryptedContent: "enc_123",
							},
						},
					},
					{ type: "text", text: "Visible assistant reply" },
				],
				contentText: "Visible assistant reply",
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const historyJson = JSON.stringify(result.history);

		// Should include reasoning item with encrypted_content
		expect(historyJson).toContain('"type":"reasoning"');
		expect(historyJson).toContain('"id":"rs_123"');
		expect(historyJson).toContain('"encrypted_content":"enc_123"');
		expect(historyJson).toContain("Earlier hidden reasoning summary");

		// Should also include assistant text
		expect(historyJson).toContain("Visible assistant reply");

		// Verify structure: reasoning item should come before assistant message
		const reasoningItem = (result.history as Array<{ type?: string }>).find(
			(msg) => msg.type === "reasoning",
		);
		const assistantMsg = (result.history as Array<{ role?: string }>).find(
			(msg) => msg.role === "assistant",
		);
		expect(reasoningItem).toBeDefined();
		expect(assistantMsg).toBeDefined();
	});

	test("buildHistory drops encrypted reasoning without a matching signature source on strict models", async () => {
		// gpt-5 is credential-bound: an encrypted item whose source identity is
		// missing (legacy data) or foreign (another provider) must not be echoed.
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{
						type: "reasoning",
						text: "Legacy untagged reasoning",
						providerMetadata: {
							openai: {
								itemId: "rs_untagged",
								reasoningEncryptedContent: "enc_untagged",
							},
						},
					},
					{
						type: "reasoning",
						text: "Foreign reasoning",
						providerMetadata: {
							signatureSource: "nug:other",
							openai: {
								itemId: "rs_foreign",
								reasoningEncryptedContent: "enc_foreign",
							},
						},
					},
					{ type: "text", text: "Visible assistant reply" },
				],
				contentText: "Visible assistant reply",
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const historyJson = JSON.stringify(result.history);

		expect(historyJson).not.toContain('"type":"reasoning"');
		expect(historyJson).not.toContain('"encrypted_content"');
		// The visible text survives untouched.
		expect(historyJson).toContain("Visible assistant reply");
	});

	test("buildHistory replays gateway-minted encrypted reasoning on relay models when the signature matches", async () => {
		// deepseek classifies as a plain-text relay, but the stored reasoning carries
		// an encrypted_content minted by this same gateway (Console Go-style Codex
		// endpoints do this for relay models too). It must be replayed verbatim —
		// degrading it to assistant text makes the gateway reject the turn with
		// "reasoning_text in the thinking mode must be passed back".
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{
						type: "reasoning",
						text: "Hidden reasoning",
						providerMetadata: {
							signatureSource: "openai", // matches TEST_PROVIDER.prefix
							openai: {
								itemId: "rs_relay_hist",
								reasoningEncryptedContent: "enc_relay_hist",
							},
						},
					},
					{ type: "text", text: "Visible assistant reply" },
				],
				contentText: "Visible assistant reply",
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:deepseek-chat");
		const historyJson = JSON.stringify(result.history);

		expect(historyJson).toContain('"type":"reasoning"');
		expect(historyJson).toContain('"id":"rs_relay_hist"');
		expect(historyJson).toContain('"encrypted_content":"enc_relay_hist"');
		expect(historyJson).toContain("Visible assistant reply");
	});

	test("buildHistory handles assistant message with reasoning but no text", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{
						type: "reasoning",
						text: "Pure reasoning turn",
						providerMetadata: {
							signatureSource: "openai",
							openai: {
								itemId: "rs_456",
								reasoningEncryptedContent: "enc_456",
							},
						},
					},
				],
				contentText: null,
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const historyJson = JSON.stringify(result.history);

		// Should include reasoning item
		expect(historyJson).toContain('"type":"reasoning"');
		expect(historyJson).toContain('"encrypted_content":"enc_456"');
	});

	test("pushAssistantTurn emits native reasoning and web_search items for responses history", () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const history: unknown[] = [];

		provider.pushAssistantTurn(
			history,
			"Tool result summary",
			[],
			[
				{
					text: "Live reasoning summary",
					outputIndex: 0,
					providerMetadata: {
						openai: {
							itemId: "rs_live",
							reasoningEncryptedContent: "enc_live",
						},
					},
				},
			],
			[{ id: "ws_live", query: "cache me", outputIndex: 1 }],
		);

		expect(history).toHaveLength(3);
		expect(JSON.stringify(history[0])).toContain('"type":"reasoning"');
		expect(JSON.stringify(history[0])).toContain('"encrypted_content":"enc_live"');
		expect(JSON.stringify(history[1])).toContain('"type":"web_search_call"');
		expect(JSON.stringify(history[1])).toContain('"query":"cache me"');
		expect(JSON.stringify(history[2])).toContain("Tool result summary");
		expect(JSON.stringify(history[2])).not.toContain("Live reasoning summary");
	});

	test("pushAssistantTurn preserves official assistant message id when provided", () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const history: unknown[] = [];

		provider.pushAssistantTurn(history, "Visible reply", [], undefined, undefined, "msg_remote_1");

		expect(history).toHaveLength(1);
		expect(JSON.stringify(history[0])).toContain('"id":"msg_remote_1"');
		expect(JSON.stringify(history[0])).toContain("Visible reply");
	});

	test("parseResponsesAPIEvent captures assistant message item ids from responses events", () => {
		const events = parseResponsesAPIEvent(
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					role: "assistant",
					id: "msg_remote_2",
					content: [{ type: "output_text", text: "done" }],
				},
			},
			new Map(),
			new Map(),
		);

		const parsed = events.find((event) => event.messageId);
		expect(parsed?.messageId).toBe("msg_remote_2");
	});

	test("parseResponsesAPIEvent captures partial image previews", () => {
		const events = parseResponsesAPIEvent(
			{
				type: "response.image_generation_call.partial_image",
				item_id: "ig_partial",
				output_index: 2,
				partial_image_index: 1,
				partial_image_b64: SAMPLE_PNG_BASE64,
			},
			new Map(),
			new Map(),
		);

		const parsed = events.find((event) => event.imageGeneration);
		expect(parsed?.imageGeneration?.id).toBe("ig_partial");
		expect(parsed?.imageGeneration?.status).toBe("generating");
		expect(parsed?.imageGeneration?.outputIndex).toBe(2);
		expect(parsed?.imageGeneration?.partialImageIndex).toBe(1);
		expect(parsed?.imageGeneration?.partialImageB64).toBe(SAMPLE_PNG_BASE64);
	});

	test("parseResponsesAPIEvent streams raw reasoning_text deltas without summary", () => {
		const reasoningAccum = new Map();
		parseResponsesAPIEvent(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "reasoning",
					id: "rs_raw",
					encrypted_content: "enc_raw",
				},
			},
			new Map(),
			reasoningAccum,
		);

		const events = parseResponsesAPIEvent(
			{
				type: "response.reasoning_text.delta",
				output_index: 0,
				delta: "raw reasoning chunk",
			},
			new Map(),
			reasoningAccum,
		);

		const parsed = events.find((event) => event.reasoning);
		expect(parsed?.reasoning).toBe("raw reasoning chunk");
		expect(parsed?.reasoningMetadata?.openai?.itemId).toBe("rs_raw");
		expect(parsed?.reasoningMetadata?.openai?.reasoningEncryptedContent).toBe("enc_raw");
		expect(parsed?.reasoningOutputIndex).toBe(0);
	});

	test("parseResponsesAPIEvent inserts a blank-line boundary between summary parts", () => {
		const reasoningAccum = new Map();
		parseResponsesAPIEvent(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_multi" },
			},
			new Map(),
			reasoningAccum,
		);

		const firstReasoning = (delta: string, summaryIndex: number) =>
			parseResponsesAPIEvent(
				{
					type: "response.reasoning_summary_text.delta",
					output_index: 0,
					summary_index: summaryIndex,
					delta,
				},
				new Map(),
				reasoningAccum,
			).find((event) => event.reasoning)?.reasoning;

		// Part 0: first delta, no leading boundary.
		expect(firstReasoning("first part start", 0)).toBe("first part start");
		// Same part, still no boundary.
		expect(firstReasoning(" continues", 0)).toBe(" continues");
		// Part 1: summary_index advances → blank-line boundary prepended.
		expect(firstReasoning("second part", 1)).toBe("\n\nsecond part");
		// Still part 1: no additional boundary.
		expect(firstReasoning(" more", 1)).toBe(" more");
	});

	test("parseResponsesAPIEvent uses reasoning_text.done only when no delta was emitted", () => {
		const reasoningAccum = new Map();
		parseResponsesAPIEvent(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_done" },
			},
			new Map(),
			reasoningAccum,
		);

		const doneEvents = parseResponsesAPIEvent(
			{
				type: "response.reasoning_text.done",
				output_index: 0,
				text: "complete reasoning",
			},
			new Map(),
			reasoningAccum,
		);
		expect(doneEvents.find((event) => event.reasoning)?.reasoning).toBe("complete reasoning");

		const deltaAccum = new Map();
		parseResponsesAPIEvent(
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "reasoning", id: "rs_delta" },
			},
			new Map(),
			deltaAccum,
		);
		parseResponsesAPIEvent(
			{
				type: "response.reasoning_text.delta",
				output_index: 1,
				delta: "already streamed",
			},
			new Map(),
			deltaAccum,
		);
		const skippedDoneEvents = parseResponsesAPIEvent(
			{
				type: "response.reasoning_text.done",
				output_index: 1,
				text: "already streamed",
			},
			new Map(),
			deltaAccum,
		);
		expect(skippedDoneEvents.some((event) => event.reasoning)).toBe(false);
	});

	test("pushAssistantTurn drops non-replayable reasoning on credential-bound models", () => {
		// gpt-5 is credential-bound: reasoning without an encrypted credential has
		// nothing to replay — echoing the plain text would fail upstream.
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const history: unknown[] = [];

		provider.pushAssistantTurn(history, "Visible reply", [], [{ text: "Fallback reasoning" }]);

		expect(history).toHaveLength(1);
		expect(JSON.stringify(history[0])).toContain("Visible reply");
		expect(JSON.stringify(history[0])).not.toContain("Fallback reasoning");
		expect(JSON.stringify(history[0])).not.toContain('"type":"reasoning"');
	});

	test("pushAssistantTurn keeps non-replayable reasoning as assistant text fallback on relay models", () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		provider.noteActiveModel("openai:deepseek-chat");
		const history: unknown[] = [];

		provider.pushAssistantTurn(history, "Visible reply", [], [{ text: "Fallback reasoning" }]);

		expect(history).toHaveLength(1);
		expect(JSON.stringify(history[0])).toContain("Fallback reasoning");
		expect(JSON.stringify(history[0])).toContain("Visible reply");
		expect(JSON.stringify(history[0])).not.toContain('"type":"reasoning"');
	});

	test("pushAssistantTurn replays gateway-minted encrypted reasoning verbatim on relay models", () => {
		// Some Codex-compatible gateways (e.g. Console Go) mint encrypted_content even
		// for model names that classify as plain-text relays (deepseek here). They
		// reject a follow-up turn that degrades the reasoning to assistant text
		// ("reasoning_text in the thinking mode must be passed back"), so the item
		// must be replayed verbatim with its credential.
		const provider = new OpenAIProvider(TEST_PROVIDER);
		provider.noteActiveModel("openai:deepseek-chat");
		const history: unknown[] = [];

		provider.pushAssistantTurn(
			history,
			"Visible reply",
			[],
			[
				{
					text: "Hidden reasoning",
					providerMetadata: {
						openai: { itemId: "rs_relay_1", reasoningEncryptedContent: "enc_relay_1" },
					},
				},
			],
		);

		expect(history).toHaveLength(2);
		const json = JSON.stringify(history);
		expect(json).toContain('"type":"reasoning"');
		expect(json).toContain('"id":"rs_relay_1"');
		expect(json).toContain('"encrypted_content":"enc_relay_1"');
		expect(json).toContain('"summary_text"');
		expect(json).toContain("Hidden reasoning");
	});

	test("buildHistory replays web_search as native responses items", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{ type: "web_search", id: "ws_123", query: "weather sf", outputIndex: 1 },
					{ type: "text", text: "Search result summary" },
				],
				contentText: "Search result summary",
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		expect(result.trailingToolResults).toEqual([]);
		expect(JSON.stringify(result.history[0])).toContain('"type":"web_search_call"');
		expect(JSON.stringify(result.history[0])).toContain('"query":"weather sf"');
		expect(JSON.stringify(result.history[1])).toContain("Search result summary");
		expect(JSON.stringify(result.history)).not.toContain("[Web search:");
	});

	test("pushAssistantTurn replays image_generation as native responses item with id", () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const history: unknown[] = [];

		provider.pushAssistantTurn(history, "", [], undefined, undefined, undefined, [
			{
				id: "ig_live",
				revisedPrompt: "a tiny blue square",
				result: SAMPLE_PNG_BASE64,
				outputIndex: 0,
			},
		]);

		expect(history).toHaveLength(1);
		expect(JSON.stringify(history[0])).toContain('"type":"image_generation_call"');
		expect(JSON.stringify(history[0])).toContain('"id":"ig_live"');
		expect(JSON.stringify(history[0])).toContain('"revised_prompt":"a tiny blue square"');
		expect(JSON.stringify(history[0])).toContain(SAMPLE_PNG_BASE64);
	});

	test("buildHistory replays saved image_generation with id and saved-path instruction", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const savedPath = join(testUploadsRoot, "generated-image.png");
		writeFileSync(savedPath, Buffer.from(SAMPLE_PNG_BASE64, "base64"));
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{
						type: "image_generation",
						id: "ig_saved",
						revisedPrompt: "a saved blue square",
						savedPath,
						outputIndex: 0,
					},
				],
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const historyJson = JSON.stringify(result.history);
		expect(historyJson).toContain('"role":"developer"');
		expect(historyJson).toContain(savedPath);
		expect(historyJson).toContain('"type":"image_generation_call"');
		expect(historyJson).toContain('"id":"ig_saved"');
		expect(historyJson).toContain('"revised_prompt":"a saved blue square"');
		expect(historyJson).toContain(SAMPLE_PNG_BASE64);
	});

	test("buildHistory replays inline image_generation result when saved file is unavailable", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{
						type: "image_generation",
						id: "ig_inline",
						revisedPrompt: "inline fallback",
						result: SAMPLE_PNG_BASE64,
						outputIndex: 0,
					},
				],
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const historyJson = JSON.stringify(result.history);
		expect(historyJson).toContain('"type":"image_generation_call"');
		expect(historyJson).toContain('"id":"ig_inline"');
		expect(historyJson).toContain('"revised_prompt":"inline fallback"');
		expect(historyJson).toContain(SAMPLE_PNG_BASE64);
	});

	test("buildHistory preserves stored assistant item ordering and official message id", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				messageUuid: "msg_remote_3",
				contentJson: [
					{ type: "text", text: "Lead in" },
					{ type: "web_search", id: "ws_ordered", query: "weather sf", outputIndex: 1 },
					{ type: "text", text: "Follow up" },
				],
				contentText: "Lead in\nFollow up",
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		expect(result.history).toHaveLength(3);
		expect(JSON.stringify(result.history[0])).toContain('"id":"msg_remote_3"');
		expect(JSON.stringify(result.history[0])).toContain("Lead in");
		expect(JSON.stringify(result.history[1])).toContain('"type":"web_search_call"');
		expect(JSON.stringify(result.history[2])).toContain("Follow up");
	});

	test("buildHistory matches pushAssistantTurn canonical responses layout", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				contentJson: [
					{
						type: "reasoning",
						text: "Reasoning summary",
						providerMetadata: {
							signatureSource: "openai",
							openai: {
								itemId: "rs_sync",
								reasoningEncryptedContent: "enc_sync",
							},
						},
						outputIndex: 0,
					},
					{ type: "web_search", id: "ws_sync", query: "search term", outputIndex: 1 },
					{ type: "text", text: "Assistant reply" },
				],
				contentText: "Assistant reply",
				toolCalls: [
					{
						toolUseId: "call_sync",
						toolName: "Read",
						inputJson: { file_path: "/tmp/demo" },
						outputJson: "file contents",
						status: "success",
					},
				],
			}),
		];

		const rebuilt = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const pushedHistory: unknown[] = [];
		provider.pushAssistantTurn(
			pushedHistory,
			"Assistant reply",
			[{ toolUseId: "call_sync", name: "Read", input: { file_path: "/tmp/demo" } }],
			[
				{
					text: "Reasoning summary",
					providerMetadata: {
						openai: {
							itemId: "rs_sync",
							reasoningEncryptedContent: "enc_sync",
						},
					},
					outputIndex: 0,
				},
			],
			[{ id: "ws_sync", query: "search term", outputIndex: 1 }],
		);
		const pushedTrailing = [provider.formatToolResult("call_sync", "file contents", false)];

		expect(pushedHistory).toEqual(rebuilt.history);
		expect(pushedTrailing).toEqual(rebuilt.trailingToolResults);
	});

	test("buildHistory replays persisted user images from the message owner narrator", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		registerTestImage("source-narrator", "img_hist");
		const dbMessages: DbMessage[] = [
			makeUserMessage({
				id: "user-image",
				narratorId: "source-narrator",
				contentJson: [
					{
						type: "image",
						imageId: "img_hist",
						filename: "sample.png",
						mediaType: "image/png",
					},
					{ type: "text", text: "Describe this screenshot" },
				],
				contentText: "Describe this screenshot",
			}),
			makeAssistantMessage({
				id: "assistant-after",
				contentJson: [{ type: "text", text: "done" }],
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5", "forked-narrator");
		const historyJson = JSON.stringify(result.history);
		expect(historyJson).toContain('"type":"input_image"');
		expect(historyJson).toContain('"image_url":"data:image/png;base64,');
		expect(historyJson).toContain("Describe this screenshot");
	});

	test("pushUserTurn preserves tool result images for the next responses turn", () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const history: unknown[] = [];
		const toolResult = provider.formatToolResult("call_image", "Rendered screenshot", false, [
			{ format: "png", base64: SAMPLE_PNG_BASE64 },
		]);

		provider.pushUserTurn(history, "", "openai:gpt-5", [toolResult]);

		const historyJson = JSON.stringify(history);
		expect(historyJson).toContain('"type":"function_call_output"');
		expect(historyJson).toContain('"call_id":"call_image"');
		expect(historyJson).toContain('"type":"input_image"');
		expect(historyJson).toContain('"image_url":"data:image/png;base64,');
	});

	test("pushUserTurn preserves user images for tool continuation turns", () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const history: unknown[] = [];

		provider.pushUserTurn(
			history,
			"Describe this screenshot",
			"openai:gpt-5",
			[],
			[{ format: "png", base64: SAMPLE_PNG_BASE64 }],
		);

		const responsesInput = convertHistoryToResponsesApi(history as OAIMessage[]);
		const historyJson = JSON.stringify(responsesInput);
		expect(historyJson).toContain('"type":"input_text"');
		expect(historyJson).toContain("Describe this screenshot");
		expect(historyJson).toContain('"type":"input_image"');
		expect(historyJson).toContain('"image_url":"data:image/png;base64,');
	});

	test("pruneToolCalls removes pruned non-protected tool_use blocks from responses history", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				id: "assistant-pruned",
				contentJson: [
					{ type: "tool_use", id: "call_enter_plan", name: "EnterPlanMode", input: {} },
					{ type: "text", text: "Planning mode entered." },
				],
				contentText: "Planning mode entered.",
				toolCalls: [
					{
						toolUseId: "call_enter_plan",
						toolName: "EnterPlanMode",
						inputJson: {},
						outputJson: "Entered plan mode",
						status: "success",
					},
				],
			}),
			makeAssistantMessage({
				id: "assistant-later",
				contentJson: [{ type: "text", text: "Later assistant turn" }],
				contentText: "Later assistant turn",
			}),
		];

		pruneToolCalls(dbMessages, "assistant-pruned");
		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const historyJson = JSON.stringify(result.history);
		expect(historyJson).not.toContain('"call_id":"call_enter_plan"');
		expect(historyJson).not.toContain('"type":"function_call_output"');
		expect(result.trailingToolResults).toEqual([]);
	});

	test("pruneToolCalls preserves protected tool pairs in responses history", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				id: "assistant-protected",
				contentJson: [
					{
						type: "tool_use",
						id: "call_exit_plan",
						name: "ExitPlanMode",
						input: { plan: "Do it" },
					},
					{ type: "text", text: "Plan submitted." },
				],
				contentText: "Plan submitted.",
				toolCalls: [
					{
						toolUseId: "call_exit_plan",
						toolName: "ExitPlanMode",
						inputJson: { plan: "Do it" },
						outputJson: "Plan presented for approval",
						status: "success",
					},
				],
			}),
			makeAssistantMessage({
				id: "assistant-after-protected",
				contentJson: [{ type: "text", text: "Execution starts later" }],
				contentText: "Execution starts later",
			}),
		];

		pruneToolCalls(dbMessages, "assistant-protected");
		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const historyJson = JSON.stringify(result.history);
		expect(historyJson).toContain('"type":"function_call"');
		expect(historyJson).toContain('"call_id":"call_exit_plan"');
		expect(historyJson).toContain('"type":"function_call_output"');
		expect(historyJson).toContain("Plan presented for approval");
		expect(result.trailingToolResults).toEqual([]);
	});

	test("buildHistory skips orphaned tool_use blocks without completed tool results", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			makeAssistantMessage({
				id: "assistant-orphaned",
				contentJson: [
					{ type: "tool_use", id: "call_orphaned", name: "Read", input: { file_path: "/tmp/a" } },
					{ type: "text", text: "This tool call was pruned elsewhere." },
				],
				contentText: "This tool call was pruned elsewhere.",
				toolCalls: [],
			}),
			makeAssistantMessage({
				id: "assistant-after-orphaned",
				contentJson: [{ type: "text", text: "Next assistant turn" }],
				contentText: "Next assistant turn",
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const historyJson = JSON.stringify(result.history);
		expect(historyJson).not.toContain('"call_id":"call_orphaned"');
		expect(historyJson).not.toContain('"type":"function_call"');
		expect(result.trailingToolResults).toEqual([]);
	});

	test("buildHistory emits sys context as user input on responses format (not developer)", async () => {
		const provider = new OpenAIProvider(TEST_PROVIDER);
		const dbMessages: DbMessage[] = [
			{
				id: "sys-spec",
				role: "sys",
				contentJson: [{ type: "text", text: "Continue working on the current Dynamic Spec task." }],
				contentText: "Continue working on the current Dynamic Spec task.",
				parentToolUseId: null,
				messageUuid: null,
				toolCalls: [],
			},
			makeAssistantMessage({
				id: "assistant-after-sys",
				contentJson: [{ type: "text", text: "On it." }],
				contentText: "On it.",
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		// The sys message must land in the conversation input as a user turn so
		// Gemini-translating proxies do not hoist it into system_instruction and
		// leave `contents` empty (which triggers "contents is not specified").
		const userItem = (result.history as Array<{ role?: string }>).find(
			(item) => item.role === "user",
		);
		expect(userItem).toBeDefined();
		expect(JSON.stringify(userItem)).toContain(
			"Continue working on the current Dynamic Spec task.",
		);
		expect(JSON.stringify(result.history)).not.toContain('"role":"developer"');
	});

	test("buildHistory emits sys context as user message on completions format (not system)", async () => {
		const provider = new OpenAIProvider({ ...TEST_PROVIDER, apiMode: "completions" });
		const dbMessages: DbMessage[] = [
			{
				id: "sys-spec",
				role: "sys",
				contentJson: [{ type: "text", text: "Continue working on the current Dynamic Spec task." }],
				contentText: "Continue working on the current Dynamic Spec task.",
				parentToolUseId: null,
				messageUuid: null,
				toolCalls: [],
			},
			makeAssistantMessage({
				id: "assistant-after-sys",
				contentJson: [{ type: "text", text: "On it." }],
				contentText: "On it.",
			}),
		];

		const result = await provider.buildHistory(dbMessages, "openai:gpt-5");
		const userItem = (result.history as Array<{ role?: string; content?: unknown }>).find(
			(item) => item.role === "user",
		);
		expect(userItem).toBeDefined();
		expect(userItem?.content).toBe("Continue working on the current Dynamic Spec task.");
		expect((result.history as Array<{ role?: string }>).some((m) => m.role === "system")).toBe(
			false,
		);
	});
});

describe("OpenAIProvider lightweight streaming generation", () => {
	test.each([
		["responses", "responses"],
		["codex", "responses"],
		["completions", "completions"],
	] as const)("streams %s requests and forwards text deltas", async (apiMode, protocol) => {
		const provider = new OpenAIProvider({ ...TEST_PROVIDER, apiMode });
		const requests: Array<{ body: Record<string, unknown>; signal?: AbortSignal }> = [];
		const originalFetch = globalThis.fetch;
		const encoder = new TextEncoder();
		const responseBody =
			protocol === "responses"
				? [
						'data: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
						'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
						'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
					].join("")
				: [
						'data: {"choices":[{"index":0,"delta":{"content":"Hello "},"finish_reason":null}]}\n\n',
						'data: {"choices":[{"index":0,"delta":{"content":"world"},"finish_reason":null}]}\n\n',
						'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
						'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
						"data: [DONE]\n\n",
					].join("");

		globalThis.fetch = (async (_input, init) => {
			requests.push({
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				signal: init?.signal ?? undefined,
			});
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode(responseBody));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		try {
			const deltas: string[] = [];
			const result = await provider.generateWithMeta("prompt", "openai:gpt-5", undefined, {
				onTextDelta: async (delta) => {
					await Promise.resolve();
					deltas.push(delta);
				},
			});

			expect(requests).toHaveLength(1);
			expect(requests[0]?.body.stream).toBe(true);
			if (apiMode === "completions") {
				expect(requests[0]?.body.stream_options).toEqual({ include_usage: true });
			}
			expect(deltas).toEqual(["Hello ", "world"]);
			expect(result.text).toBe("Hello world");
			expect(result.usage?.inputTokens).toBe(3);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("history generation forwards its abort signal to the streaming request", async () => {
		const provider = new OpenAIProvider({ ...TEST_PROVIDER, apiMode: "completions" });
		const controller = new AbortController();
		const originalFetch = globalThis.fetch;
		let requestSignal: AbortSignal | undefined;
		globalThis.fetch = (async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Response(
				'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;

		try {
			const result = await provider.generateWithHistoryWithMeta(
				"system",
				"content",
				"openai:gpt-5",
				"en",
				{ signal: controller.signal },
			);
			expect(requestSignal).toBe(controller.signal);
			expect(result.text).toBe("ok");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test.each([429, 503])("preserves OpenAI HTTP %s status and retry diagnostics", async (status) => {
		const provider = new OpenAIProvider({ ...TEST_PROVIDER, apiMode: "completions" });
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					error: {
						code: status === 429 ? "rate_limit_exceeded" : "server_error",
						message: status === 429 ? "Too many requests; retry later" : "upstream unavailable",
					},
				}),
				{
					status,
					headers: { "content-type": "application/json", "retry-after": "2" },
				},
			)) as unknown as typeof fetch;

		try {
			let thrown: unknown;
			try {
				await provider.generateWithMeta("prompt", "openai:gpt-5");
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toMatchObject({ status, diagnostics: { statusCode: status } });
			expect(isRetryableError(thrown)).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("preserves structured Responses SSE failure details from an HTTP 200 stream", async () => {
		const provider = new OpenAIProvider({ ...TEST_PROVIDER, apiMode: "responses" });
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","status_code":503,"message":"upstream unavailable"}}}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			)) as unknown as typeof fetch;

		try {
			let thrown: unknown;
			try {
				await provider.generateWithMeta("prompt", "openai:gpt-5");
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toMatchObject({
				reason: "server_error",
				classification: "transient",
				retryable: true,
				status: 503,
				diagnostics: {
					statusCode: 503,
					phase: "response_failed",
					message: "upstream unavailable",
				},
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("preserves non-transient incomplete completion-limit details from an HTTP 200 stream", async () => {
		const provider = new OpenAIProvider({ ...TEST_PROVIDER, apiMode: "responses" });
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			)) as unknown as typeof fetch;

		try {
			let thrown: unknown;
			try {
				await provider.generateWithMeta("prompt", "openai:gpt-5");
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toMatchObject({
				reason: "max_output_tokens",
				classification: "completion_limit",
				retryable: false,
			});
			expect((thrown as { status?: number }).status).not.toBe(502);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
