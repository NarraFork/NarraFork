import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { type OpenAIProviderConfig, settings } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
import { GeminiInteractionsProvider } from "../gemini-interactions-provider";
import { GeminiProvider } from "../gemini-provider";
import { buildAdapterHistory } from "../history-build";
import { OpenAIProvider, withCodexNativeTools } from "../openai-provider";
import type { DbMessage, ProviderAdapter } from "../provider";
import type { ResolvedToolDefinition } from "../types";

const CONFIG = {
	id: "request-json",
	name: "Request JSON",
	prefix: "request-json",
	apiKey: "unused",
	baseUrl: "https://example.invalid/v1",
	defaultModel: "gpt-5.5",
};
const ROWS: DbMessage[] = [
	{
		id: "input",
		role: "user",
		messageUuid: null,
		parentToolUseId: null,
		contentText: "use the catalog",
		contentJson: [{ type: "text", text: "use the catalog" }],
	},
	{
		id: "update",
		role: "sys",
		messageUuid: null,
		parentToolUseId: null,
		contentText: "<context_update>workspace=/repo/b</context_update>",
		contentJson: [
			{ type: "text", text: "<context_update>workspace=/repo/b</context_update>" },
			{
				type: "context_update",
				epochId: "epoch",
				changes: [{ key: "workspace", value: "/repo/b" }],
			},
		],
	},
];

async function drain(
	provider: ProviderAdapter,
	tools: unknown[],
	signal: AbortSignal,
	model: string,
	id: string,
) {
	const { history } = await buildAdapterHistory(provider, ROWS, { provider: "test", model });
	provider.injectSystemPrompt(history, "frozen baseline", model);
	for await (const _event of provider.chat({
		conversationId: id,
		content: "",
		model,
		cwd: ".",
		history,
		tools,
		toolResults: [],
		signal,
		onInputCharacters: () => {},
	})) {
		/* mock ends the stream */
	}
}

test("Codex native revocation changes only the hosted declaration overlay, never frozen tools", async () => {
	const originalFetch = globalThis.fetch;
	const originalSearch = settings.search;
	const requests: Array<Record<string, unknown>> = [];
	const config: OpenAIProviderConfig = {
		...CONFIG,
		apiMode: "codex",
		codexWebSearch: true,
		codexImageGeneration: true,
	};
	const provider = new OpenAIProvider(config);
	const tools = Object.freeze([{ type: "function", name: "Read", parameters: { type: "object" } }]);
	globalThis.fetch = (async (_url, init) => {
		requests.push(JSON.parse(String(init?.body)));
		return new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n', {
			headers: { "content-type": "text/event-stream" },
		});
	}) as typeof fetch;
	try {
		for (const enabled of [true, false, true]) {
			settings.search = {
				...originalSearch,
				customProviders: originalSearch?.customProviders ?? [],
				channels: [{ id: "native", kind: "native", enabled }],
			};
			config.codexImageGeneration = enabled;
			await drain(
				provider,
				tools as unknown as unknown[],
				new AbortController().signal,
				"gpt-5.5",
				"same-epoch",
			);
		}
	} finally {
		globalThis.fetch = originalFetch;
		settings.search = originalSearch;
	}
	expect(
		requests.map((body) => (body.tools as Array<{ type: string }>).map((tool) => tool.type)),
	).toEqual([
		["function", "web_search", "image_generation"],
		["function"],
		["function", "web_search", "image_generation"],
	]);
	expect(tools).toHaveLength(1);
	for (const request of requests) {
		expect(request.instructions).toBe(requests[0].instructions);
		expect(request.prompt_cache_key).toBe("same-epoch");
		expect((request.tools as unknown[])[0]).toEqual(tools[0]);
	}
	const frozenNative = Object.freeze({ type: "image_generation" });
	expect(
		withCodexNativeTools(Object.freeze([frozenNative]), "gpt-5.5", { webSearch: false }),
	).toEqual([{ type: "image_generation", output_format: "png", partial_images: 2 }]);
	expect(frozenNative).toEqual({ type: "image_generation" });
});

test("Responses strip-and-retry reuses the already serialized large tool fragment", async () => {
	const originalFetch = globalThis.fetch;
	const requests: Array<Record<string, unknown>> = [];
	let dispatched = false;
	const provider = new OpenAIProvider({ ...CONFIG, apiMode: "responses" });
	const tools = [
		{
			type: "function",
			name: "Read",
			parameters: { type: "object", "x-byte-default": new Uint8Array([0, 127, 255]) },
			get description() {
				if (dispatched) throw new Error("Retry traversed the frozen tools again");
				return "x".repeat(256 * 1024);
			},
		},
	];
	globalThis.fetch = (async (_url, init) => {
		requests.push(JSON.parse(String(init?.body)));
		dispatched = true;
		if (requests.length === 1)
			return new Response('{"detail":"Unsupported parameter: max_output_tokens"}', { status: 400 });
		return new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n', {
			headers: { "content-type": "text/event-stream" },
		});
	}) as typeof fetch;
	try {
		const { history } = await buildAdapterHistory(provider, ROWS, {
			provider: "test",
			model: "gpt-5.5-json-retry",
		});
		for await (const _event of provider.chat({
			conversationId: "retry-json",
			content: "",
			model: "gpt-5.5-json-retry",
			cwd: ".",
			history,
			tools,
			toolResults: [],
			signal: new AbortController().signal,
			maxOutputTokens: 123,
		})) {
			/* drain */
		}
	} finally {
		globalThis.fetch = originalFetch;
	}
	expect(requests).toHaveLength(2);
	expect(requests[0].max_output_tokens).toBe(123);
	expect(requests[1]).not.toHaveProperty("max_output_tokens");
	expect(requests[1].tools).toEqual(requests[0].tools);
	expect(requests[1].input).toEqual(requests[0].input);
	expect(requests[1].tools).toMatchObject([
		{ parameters: { "x-byte-default": { 0: 0, 1: 127, 2: 255 } } },
	]);
});

test("large catalogs reach actual HTTP wire builders concurrently with live signals and heartbeats", async () => {
	const originalFetch = globalThis.fetch;
	const wires: string[] = [];
	globalThis.fetch = (async (_url, init) => {
		init?.signal?.throwIfAborted();
		wires.push(String(init?.body));
		return new Response("stub upstream", { status: 400 });
	}) as typeof fetch;
	// Explicit opt-in expands the same real-provider test, not a synthetic serializer benchmark.
	const toolCount = Number(process.env.NF_REQUEST_JSON_STRESS_TOOLS ?? 2000);
	const descriptionChars = Number(process.env.NF_REQUEST_JSON_STRESS_CHARS ?? 2300);
	const description = "schema description "
		.repeat(Math.ceil(descriptionChars / 19))
		.slice(0, descriptionChars);
	const definitions: ResolvedToolDefinition[] = Array.from({ length: toolCount }, (_, i) => ({
		name: `Tool${i}`,
		description: `${description}${i}`,
		parameters: z.object({}),
		rawJsonSchema: { type: "object", properties: { file: { type: "string" } } },
		execute: async () => ({ output: "unused" }),
	}));
	const clients: Array<[ProviderAdapter, string]> = [
		[new OpenAIProvider({ ...CONFIG, apiMode: "responses" }), "gpt-5.5"],
		[new AnthropicProvider({ ...CONFIG, officialApi: false }), "claude-opus-5"],
		[new GeminiProvider(CONFIG), "gemini-2.5-pro"],
		[new GeminiInteractionsProvider(CONFIG), "gemini-2.5-pro"],
	];
	const controllers = clients.map(() => new AbortController());
	const start = performance.now();
	const initialRss = process.memoryUsage().rss;
	let peakRss = initialRss;
	let heartbeats = 0;
	let maxHeartbeatMs = 0;
	let last = start;
	const timer = setInterval(() => {
		const now = performance.now();
		maxHeartbeatMs = Math.max(maxHeartbeatMs, now - last);
		last = now;
		heartbeats++;
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
	}, 5);
	const abortTimer = setTimeout(() => controllers[3].abort(new Error("cancelled caller")), 20);
	try {
		const results = await Promise.allSettled(
			clients.map(([provider, model], i) =>
				drain(
					provider,
					provider.formatTools(definitions),
					controllers[i].signal,
					model,
					`caller-${i}`,
				),
			),
		);
		expect(results.every((result) => result.status === "rejected")).toBe(true);
		expect(wires).toHaveLength(3);
		expect(heartbeats).toBeGreaterThan(10);
		console.info("provider-wire-load", {
			callers: clients.length,
			tools: definitions.length,
			elapsedMs: Math.round(performance.now() - start),
			peakRssDeltaMiB: Math.round((peakRss - initialRss) / 1048576),
			heartbeats,
			maxHeartbeatMs: Math.round(maxHeartbeatMs),
			wireCharacters: wires.map((wire) => wire.length),
		});
	} finally {
		clearInterval(timer);
		clearTimeout(abortTimer);
		globalThis.fetch = originalFetch;
	}
	// Parse only after the heartbeat measurement: the upstream, not our event loop, parses the body.
	for (const wire of wires) {
		expect(wire.length).toBeGreaterThan(4 * 1024 * 1024);
		const body = JSON.parse(wire);
		const count = body.tools[0]?.functionDeclarations?.length ?? body.tools.length;
		expect(count).toBe(definitions.length);
		expect(wire).toContain(`Tool${toolCount - 1}`);
		expect(wire.split("<context_update>")).toHaveLength(2);
	}
}, 30000);
