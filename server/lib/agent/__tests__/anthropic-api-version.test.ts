import { afterEach, describe, expect, test } from "bun:test";
import { fetchAnthropicModels } from "../../../routes/anthropic";
import type { AnthropicProviderConfig } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";

const DIRECT = "https://api.anthropic.com/v1";
const RELAY = "https://relay.invalid/v1";
const CURRENT = "2026-10-21";
const LEGACY = "2023-06-01";
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

interface Capture {
	path: string;
	headers: Headers;
	body: Record<string, unknown> & { tools?: Array<{ name?: string }> };
}

// Intercept the transport, including the catalog's GET. Never contact a public host.
function captureRequests(): Capture[] {
	const requests: Capture[] = [];
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		const body: Capture["body"] =
			request.method === "GET" ? {} : ((await request.json()) as Capture["body"]);
		requests.push({ path, headers: request.headers, body });
		if (path.endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
		return new Response(
			[
				{ type: "message_start", message: { id: "msg_fixture", usage: { input_tokens: 1 } } },
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
				...(body.tools?.[0]?.name === "web_search"
					? [
							{
								type: "content_block_start",
								index: 1,
								content_block: {
									type: "web_search_tool_result",
									tool_use_id: "srv_1",
									content: [],
								},
							},
						]
					: []),
				{ type: "message_stop" },
			]
				.map((event) => `data: ${JSON.stringify(event)}\n\n`)
				.join(""),
			{ headers: { "content-type": "text/event-stream" } },
		);
	}) as typeof fetch;
	return requests;
}

function config(overrides: Partial<AnthropicProviderConfig> = {}): AnthropicProviderConfig {
	return {
		id: "version-test",
		name: "Version test",
		prefix: "version",
		apiKey: "test-key",
		baseUrl: DIRECT,
		defaultModel: "opaque-model",
		proxy: { mode: "direct" },
		...overrides,
	};
}

async function chat(provider: AnthropicProvider, history: unknown[] = []) {
	for await (const _ of provider.chat({
		model: "version:opaque-model",
		conversationId: "version-test",
		cwd: ".",
		content: "continue",
		history,
		tools: [],
		toolResults: [],
		reasoningEffort: "none",
		signal: AbortSignal.timeout(3000),
	})) {
		// Drain through the normal parser.
	}
}

describe("Anthropic API version and request body", () => {
	const cases: Array<[string, Partial<AnthropicProviderConfig>, string]> = [
		["direct API", {}, CURRENT],
		["default URL", { baseUrl: "" }, CURRENT],
		["direct CLI dialect", { officialApi: true }, LEGACY],
		["compatible relay", { baseUrl: RELAY }, LEGACY],
		["CLI dialect relay", { baseUrl: RELAY, officialApi: true }, LEGACY],
		["lookalike host", { baseUrl: "https://api.anthropic.com.relay.invalid/v1" }, LEGACY],
		["custom base path", { baseUrl: "https://api.anthropic.com/vendor/v1" }, LEGACY],
		["nonstandard port", { baseUrl: "https://api.anthropic.com:9443/v1" }, LEGACY],
		["explicit legacy pin", { extraHeaders: { "ANTHROPIC-VERSION": LEGACY } }, LEGACY],
		[
			"explicit relay upgrade",
			{
				baseUrl: RELAY,
				officialApi: true,
				extraHeaders: {
					"anthropic-version": LEGACY,
					"Anthropic-Version": ` ${CURRENT} `,
					"ANTHROPIC-VERSION": "\t",
				},
			},
			CURRENT,
		],
		["blank direct override", { extraHeaders: { "Anthropic-Version": "  " } }, CURRENT],
		[
			"custom gateway version",
			{ baseUrl: RELAY, extraHeaders: { "Anthropic-Version": "vendor-v1" } },
			"vendor-v1",
		],
	];
	for (const [name, overrides, expected] of cases) {
		test(`${name}: messages and catalog use the same effective version`, async () => {
			const requests = captureRequests();
			const settings = config(overrides);
			await chat(new AnthropicProvider(settings));
			await fetchAnthropicModels(settings);
			const path = new URL(settings.baseUrl || DIRECT).pathname.replace(/\/+$/, "");
			expect(requests.map((r) => r.path)).toEqual([`${path}/messages`, `${path}/models`]);
			for (const { headers } of requests) {
				expect(headers.get("anthropic-version")).toBe(expected);
				expect(headers.get("x-api-key")).toBe(settings.officialApi ? null : settings.apiKey);
				expect(headers.get("authorization")).toBe(
					settings.officialApi ? `Bearer ${settings.apiKey}` : null,
				);
			}
			const { body } = requests[0];
			if (expected === CURRENT) expect(body).not.toHaveProperty("temperature");
			else expect(body.temperature).toBe(1);
			for (const key of ["top_p", "top_k"]) expect(body).not.toHaveProperty(key);
		});
	}

	test("utility and native search requests honor an explicit upgrade on a relay", async () => {
		const requests = captureRequests();
		const provider = new AnthropicProvider(
			config({ baseUrl: RELAY, officialApi: true, extraHeaders: { "Anthropic-Version": CURRENT } }),
		);
		await provider.generateWithMeta("hello", "claude-opus-5");
		await provider.generateWithHistoryWithMeta("system", "hello", "claude-opus-5");
		await provider.performWebSearch({ model: "claude-opus-5", query: "fixture" });
		expect(requests).toHaveLength(3);
		for (const { headers, body } of requests) {
			expect(headers.get("anthropic-version")).toBe(CURRENT);
			for (const key of ["temperature", "top_p", "top_k"]) expect(body).not.toHaveProperty(key);
		}
	});

	test("only user text loses non-empty citations; documents, assistant citations and tool inputs survive", async () => {
		const requests = captureRequests();
		const cited = {
			type: "text",
			text: "excerpt",
			citations: [
				{
					type: "char_location",
					cited_text: "excerpt",
					start_char_index: 0,
					end_char_index: 7,
					document_index: 0,
					document_title: null,
				},
			],
		};
		const plain = { type: "text", text: "excerpt" };
		const document = {
			type: "document",
			source: { type: "text", media_type: "text/plain", data: "source" },
			citations: { enabled: true },
		};
		const sourced = {
			type: "document",
			source: { type: "content", content: [cited] },
			citations: { enabled: true },
		};
		const search = {
			type: "search_result",
			title: "result",
			source: "https://example.invalid",
			content: [cited],
			citations: { enabled: true },
		};
		const tool = {
			type: "tool_use",
			id: "call",
			name: "fixture",
			input: { content: [cited, document] },
		};
		const fetched = {
			type: "web_fetch_tool_result",
			tool_use_id: "srv",
			content: { type: "web_fetch_result", url: "https://example.invalid", content: document },
		};
		const fetching = {
			type: "server_tool_use",
			id: "srv",
			name: "web_fetch",
			input: { url: "https://example.invalid" },
		};
		const result = { type: "tool_result", tool_use_id: "call", content: [cited, search, document] };
		const history = [
			{
				role: "user",
				content: [
					cited,
					search,
					document,
					sourced,
					{ ...plain, citations: [], cache_control: { type: "ephemeral" } },
				],
			},
			{ role: "assistant", content: [cited, fetching, fetched, tool] },
			{ role: "user", content: [result] },
		];
		const saved = structuredClone(history);
		await chat(new AnthropicProvider(config()), history);
		expect(requests).toHaveLength(1);
		const messages = requests[0].body.messages as Array<{ role: string; content: unknown[] }>;
		const cleanSearch = { ...search, content: [plain] };
		expect(messages[0].content).toEqual([
			plain,
			cleanSearch,
			document,
			{ ...sourced, source: { type: "content", content: [plain] } },
			{ ...plain, citations: [] },
		]);
		expect(messages[1].content).toEqual([cited, fetching, fetched, tool]);
		expect(messages[2].content[0]).toEqual({ ...result, content: [plain, cleanSearch, document] });
		expect(history).toEqual(saved);
		await chat(
			new AnthropicProvider(config({ extraHeaders: { "anthropic-version": LEGACY } })),
			history,
		);
		expect((requests[1].body.messages as typeof messages)[0].content).toEqual([
			cited,
			search,
			document,
			sourced,
			{ ...plain, citations: [] },
		]);
		expect(history).toEqual(saved);
	});

	test("a direct assistant document is rejected before dispatch, not dropped or relabeled", async () => {
		const requests = captureRequests();
		const document = {
			type: "document",
			source: { type: "text", media_type: "text/plain", data: "private fixture bytes" },
		};
		const history = [
			{ role: "user", content: "start" },
			{ role: "assistant", content: [document] },
		];
		const saved = structuredClone(history);
		await expect(chat(new AnthropicProvider(config()), history)).rejects.toThrow(/document.*user/i);
		expect(requests).toHaveLength(0);
		expect(history).toEqual(saved);
		await chat(new AnthropicProvider(config({ baseUrl: RELAY })), history);
		expect((requests[0].body.messages as Array<{ content: unknown }>)[1].content).toEqual([
			document,
		]);
	});
});
