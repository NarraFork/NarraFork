import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	hasSideRequestNativeSearchProvider,
	shouldUseNativeSearch,
	supportsNativeSearch,
	usesSideRequestNativeSearch,
} from "../../search/native";
import type { AnthropicProviderConfig } from "../../settings";
import { settings } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
import type { ChatParams } from "../provider";

const MODEL = "claude-opus-5";
const ORIGINAL_FETCH = globalThis.fetch;

interface CapturedRequest {
	url: string;
	body: Record<string, unknown>;
}

let capturedRequests: CapturedRequest[] = [];

function providerConfig(overrides: Partial<AnthropicProviderConfig> = {}): AnthropicProviderConfig {
	return {
		id: "native-search-test",
		name: "Native search test",
		prefix: "ns_official",
		apiKey: "sk-test",
		baseUrl: "https://example.invalid/v1",
		defaultModel: MODEL,
		officialApi: true,
		nativeSearch: true,
		...overrides,
	};
}

function installFetchCapture(sse: string): void {
	capturedRequests = [];
	globalThis.fetch = (async (input, init) => {
		if (typeof init?.body !== "string") {
			throw new Error("Expected Anthropic request body to be a serialized string");
		}
		capturedRequests.push({ url: String(input), body: JSON.parse(init.body) });
		return new Response(sse, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}) as typeof fetch;
}

const CHAT_SSE =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ns","usage":{"input_tokens":1}}}\n\n' +
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
	'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const SEARCH_SSE =
	'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_search","usage":{"input_tokens":1}}}\n\n' +
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}\n\n' +
	'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"title":"Result A","url":"https://a.example","encrypted_content":"x"},{"title":"Result B","url":"https://b.example","encrypted_content":"y"}]}}\n\n' +
	'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n' +
	'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"summary of results"}}\n\n' +
	'event: message_stop\ndata: {"type":"message_stop"}\n\n';

function collectCacheControlPaths(value: unknown, path = "$", output: string[] = []): string[] {
	if (!value || typeof value !== "object") return output;
	if (Array.isArray(value)) {
		value.forEach((child, index) => {
			collectCacheControlPaths(child, `${path}[${index}]`, output);
		});
		return output;
	}
	const record = value as Record<string, unknown>;
	if (Object.hasOwn(record, "cache_control")) output.push(`${path}.cache_control`);
	for (const [key, child] of Object.entries(record)) {
		collectCacheControlPaths(child, `${path}.${key}`, output);
	}
	return output;
}

let savedProviders: AnthropicProviderConfig[] | undefined;
let savedSearch: unknown;

beforeEach(() => {
	savedProviders = settings.anthropicProviders;
	savedSearch = settings.search;
	settings.anthropicProviders = [providerConfig()];
	// Native channel first-enabled — the configuration that used to trigger
	// inline server-tool injection into the main request.
	settings.search = {
		...(settings.search ?? {}),
		channels: [{ id: "native", kind: "native", enabled: true }],
	} as typeof settings.search;
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	capturedRequests = [];
	settings.anthropicProviders = savedProviders;
	settings.search = savedSearch as typeof settings.search;
});

describe("native search gating", () => {
	test("side-request providers support native search but never hide WebSearch", () => {
		expect(usesSideRequestNativeSearch("ns_official")).toBe(true);
		expect(supportsNativeSearch("ns_official", MODEL)).toBe(true);
		// Inline-only: an Anthropic provider must NOT swap WebSearch for a server tool.
		expect(shouldUseNativeSearch("ns_official", MODEL)).toBe(false);
		expect(hasSideRequestNativeSearchProvider()).toBe(true);
	});

	test("nativeSearch requires the explicit opt-in, not just officialApi", () => {
		settings.anthropicProviders = [providerConfig({ nativeSearch: undefined })];
		expect(usesSideRequestNativeSearch("ns_official")).toBe(false);
		expect(hasSideRequestNativeSearchProvider()).toBe(false);
	});
});

describe("main conversation request", () => {
	test("never declares web_search_20250305 even with native search enabled", async () => {
		installFetchCapture(CHAT_SSE);
		const provider = new AnthropicProvider(providerConfig());
		const params: ChatParams = {
			conversationId: "native-search-conversation",
			content: "current user message",
			model: MODEL,
			cwd: process.cwd(),
			history: [],
			tools: [
				{
					name: "WebSearch",
					description: "function-style search tool",
					input_schema: { type: "object", properties: { query: { type: "string" } } },
				},
			],
			toolResults: [],
			signal: new AbortController().signal,
			reasoningEffort: "none",
		};
		for await (const _event of provider.chat(params)) {
			// exhaust
		}
		expect(capturedRequests).toHaveLength(1);
		const { body } = capturedRequests[0];
		const tools = (body.tools as Array<Record<string, unknown>>) ?? [];
		expect(tools.map((tool) => tool.type ?? "function-schema")).not.toContain(
			"web_search_20250305",
		);
		expect(tools.map((tool) => tool.name)).toEqual(["WebSearch"]);
		expect(body.tool_choice).toBeUndefined();
	});
});

describe("performWebSearch side request", () => {
	test("matches the CLI one-shot shape and flattens results", async () => {
		installFetchCapture(SEARCH_SSE);
		const provider = new AnthropicProvider(providerConfig());
		const result = await provider.performWebSearch({
			model: MODEL,
			query: "narrafork release notes",
			allowedDomains: ["example.com"],
		});

		expect(capturedRequests).toHaveLength(1);
		const { body } = capturedRequests[0];
		expect(body.stream).toBe(true);
		expect(body.thinking).toBeUndefined();
		expect(body.tool_choice).toEqual({ type: "tool", name: "web_search" });
		const tools = body.tools as Array<Record<string, unknown>>;
		expect(tools).toHaveLength(1);
		expect(tools[0].type).toBe("web_search_20250305");
		expect(tools[0].name).toBe("web_search");
		expect(tools[0].allowed_domains).toEqual(["example.com"]);
		// Zero cache breakpoints anywhere in the side request.
		expect(collectCacheControlPaths(body)).toEqual([]);

		expect(result.text).toBe("summary of results");
		expect(result.sources).toEqual([
			{ title: "Result A", url: "https://a.example" },
			{ title: "Result B", url: "https://b.example" },
		]);
	});
});
