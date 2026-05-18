import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type TestParsedEvent = {
	reasoning?: string;
	text?: string;
	reasoningOutputIndex?: number;
	reasoningMetadata?: { anthropic?: { blockIndex?: number } };
};

type ParseAnthropicEventForTest = (
	event: unknown,
	toolAccum: Map<unknown, unknown>,
	thinkingAccum: Map<unknown, unknown>,
	redactedThinkingAccum: Map<unknown, unknown>,
	serverToolAccum: Map<unknown, unknown>,
	usageAccum: ReturnType<typeof makeUsageAccum>,
) => TestParsedEvent[];

type TestAnthropicProvider = {
	buildHistory: (
		dbMessages: unknown[],
		model: string,
	) => Promise<{ history: unknown[]; trailingToolResults: unknown[] }>;
};

let AnthropicProvider: new (config: Record<string, unknown>) => TestAnthropicProvider;
let parseAnthropicEvent: ParseAnthropicEventForTest;
let testHome = "";
let originalHome: string | undefined;

beforeAll(async () => {
	originalHome = process.env.HOME;
	testHome = mkdtempSync(join(tmpdir(), "narrafork-anthropic-provider-"));
	process.env.HOME = testHome;

	const mod = await import("../anthropic-provider");
	AnthropicProvider = mod.AnthropicProvider as unknown as new (
		config: Record<string, unknown>,
	) => TestAnthropicProvider;
	parseAnthropicEvent = mod.parseAnthropicEvent as unknown as ParseAnthropicEventForTest;
});

afterAll(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (testHome) {
		rmSync(testHome, { recursive: true, force: true });
		testHome = "";
	}
});

const TEST_PROVIDER = {
	id: "test-anthropic",
	name: "Test Anthropic",
	prefix: "anthropic",
	apiKey: "test-key",
	baseUrl: "https://example.com/v1",
	defaultModel: "deepseek-reasoner",
};

function makeUsageAccum() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheCreation5mTokens: 0,
		cacheCreation1hTokens: 0,
	};
}

function parseWithFreshState(event: Record<string, unknown>) {
	return parseAnthropicEvent(event, new Map(), new Map(), new Map(), new Map(), makeUsageAccum());
}

type TestDbMessage = {
	id: string;
	role: "user" | "assistant";
	contentJson: unknown;
	contentText: string | null;
	parentToolUseId: string | null;
	messageUuid: string | null;
	toolCalls: Array<{
		toolUseId: string;
		toolName: string;
		inputJson: unknown;
		outputJson: unknown;
		status: string;
	}>;
};

function makeUserMessage(overrides: Partial<TestDbMessage> = {}): TestDbMessage {
	return {
		id: "user-1",
		role: "user",
		contentJson: [{ type: "text", text: "Please inspect the repo." }],
		contentText: "Please inspect the repo.",
		parentToolUseId: null,
		messageUuid: null,
		toolCalls: [],
		...overrides,
	};
}

function makeAssistantMessage(overrides: Partial<TestDbMessage> = {}): TestDbMessage {
	return {
		id: "assistant-1",
		role: "assistant",
		contentJson: [],
		contentText: null,
		parentToolUseId: null,
		messageUuid: null,
		toolCalls: [],
		...overrides,
	};
}

describe("AnthropicProvider reasoning replay", () => {
	test("routes text_delta inside a thinking block to reasoning", () => {
		const toolAccum = new Map();
		const thinkingAccum = new Map();
		const redactedThinkingAccum = new Map();
		const serverToolAccum = new Map();
		const usageAccum = makeUsageAccum();

		parseAnthropicEvent(
			{ type: "content_block_start", index: 0, content_block: { type: "thinking" } },
			toolAccum,
			thinkingAccum,
			redactedThinkingAccum,
			serverToolAccum,
			usageAccum,
		);

		const events = parseAnthropicEvent(
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hidden" } },
			toolAccum,
			thinkingAccum,
			redactedThinkingAccum,
			serverToolAccum,
			usageAccum,
		);

		expect(events).toHaveLength(1);
		expect(events[0].reasoning).toBe("hidden");
		expect(events[0].text).toBeUndefined();
		expect(events[0].reasoningMetadata?.anthropic?.blockIndex).toBe(0);
	});

	test("captures thinking text from content_block_start fallback fields", () => {
		const fromThinking = parseWithFreshState({
			type: "content_block_start",
			index: 1,
			content_block: { type: "thinking", thinking: "start thinking" },
		});
		const fromReasoningContent = parseWithFreshState({
			type: "content_block_start",
			index: 2,
			content_block: { type: "thinking", reasoning_content: "start reasoning" },
		});

		expect(fromThinking[0].reasoning).toBe("start thinking");
		expect(fromThinking[0].reasoningOutputIndex).toBe(1);
		expect(fromReasoningContent[0].reasoning).toBe("start reasoning");
		expect(fromReasoningContent[0].reasoningOutputIndex).toBe(2);
	});

	test("replays persisted reasoning as Anthropic thinking before tool_use", async () => {
		const provider = new AnthropicProvider(TEST_PROVIDER);
		const dbMessages: TestDbMessage[] = [
			makeUserMessage(),
			makeAssistantMessage({
				contentJson: [
					{
						type: "reasoning",
						text: "Need to read the file before answering.",
						providerMetadata: { anthropic: { blockIndex: 0 } },
						outputIndex: 0,
					},
					{
						type: "tool_use",
						id: "toolu_1",
						name: "Read",
						input: { file_path: "/tmp/example.ts" },
						outputIndex: 1,
					},
				],
				toolCalls: [
					{
						toolUseId: "toolu_1",
						toolName: "Read",
						inputJson: { file_path: "/tmp/example.ts" },
						outputJson: "file contents",
						status: "success",
					},
				],
			}),
		];

		const result = await provider.buildHistory(dbMessages, "anthropic:deepseek-reasoner");
		const assistant = result.history.find(
			(msg) => (msg as { role?: string }).role === "assistant",
		) as { content?: Array<{ type?: string; thinking?: string; name?: string }> };

		expect(assistant).toBeDefined();
		expect(assistant.content?.[0]).toMatchObject({
			type: "thinking",
			thinking: "Need to read the file before answering.",
		});
		expect(assistant.content?.[1]).toMatchObject({ type: "tool_use", name: "Read" });
	});
});
