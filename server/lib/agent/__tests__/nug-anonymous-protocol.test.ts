import { describe, expect, test } from "bun:test";
import { setNugCachedModels } from "../../nug-model-cache";
import { NugProvider } from "../nug-provider";
import type { ParsedStreamEvent } from "../provider";

let nextId = 0;
function fixture(channelType = "anonymous") {
	const id = `nug-anonymous-protocol-${nextId++}`;
	const model = "nug:anonymous:model";
	const setChannelType = (value: string) =>
		setNugCachedModels(id, [
			{ id: "anonymous:model", channel: "anonymous", channelType: value, model: "model" },
		]);
	setChannelType(channelType);
	const provider = new NugProvider({
		id,
		name: "Anonymous protocol test",
		prefix: "nug",
		apiKey: "test-key",
		baseUrl: "https://gateway.example.test",
		defaultModel: "anonymous:model",
	});
	return { provider, model, setChannelType };
}

const protocolError =
	/NUG protocol configuration error: unsupported channelType.*Refresh the model catalog and check gateway\/client protocol compatibility/;

describe("NUG anonymous protocol rejection", () => {
	test("preparation rejects unsupported channels repeatedly", () => {
		const { provider, model } = fixture();
		expect(() => provider.prepareForModel(model)).toThrow(protocolError);
		expect(() => provider.prepareForModel(model)).toThrow(protocolError);
	});

	test("history rejects instead of returning an empty history", async () => {
		const { provider, model } = fixture();
		await expect(provider.buildHistory([], model)).rejects.toThrow(protocolError);
	});

	test("chat rejects on its first event without changing history or starting a request", async () => {
		const { provider, model } = fixture();
		const history = [{ role: "user", content: "retained history" }];
		let started = false;
		const stream = provider.chat({
			conversationId: "anonymous-test",
			content: "hello",
			model,
			cwd: ".",
			history,
			tools: [],
			toolResults: [],
			signal: new AbortController().signal,
			onRequestStart: () => {
				started = true;
			},
		});
		await expect(stream.next()).rejects.toThrow(protocolError);
		expect(started).toBe(false);
		expect(history).toEqual([{ role: "user", content: "retained history" }]);
	});

	test("all auxiliary generation methods reject instead of returning empty output", async () => {
		const { provider, model } = fixture();
		await expect(provider.generate("hello", model)).rejects.toThrow(protocolError);
		await expect(provider.generateWithMeta("hello", model)).rejects.toThrow(protocolError);
		await expect(provider.generateWithHistory("system", "hello", model)).rejects.toThrow(
			protocolError,
		);
		await expect(provider.generateWithHistoryWithMeta("system", "hello", model)).rejects.toThrow(
			protocolError,
		);
	});

	test("history mutation rejects repeatedly rather than caching a failed delegate", () => {
		const { provider, model } = fixture();
		const history: unknown[] = [];
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(() => provider.injectSystemPrompt(history, "system", model)).toThrow(protocolError);
			expect(() => provider.pushUserTurn(history, "hello", model, [])).toThrow(protocolError);
		}
		expect(history).toEqual([]);
	});

	test("catalog changes cannot reuse a stale supported delegate for the same routed model", () => {
		const { provider, model, setChannelType } = fixture("anthropic");
		provider.prepareForModel(model);
		setChannelType("unsupported");
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(() => provider.pushUserTurn([], "hello", model, [])).toThrow(protocolError);
		}
		setChannelType("anthropic");
		const history: unknown[] = [];
		provider.pushUserTurn(history, "hello", model, []);
		expect(history.length).toBeGreaterThan(0);
	});

	test("anonymous channel delegates real requests and trailing gateway measurements", async () => {
		const { provider, model } = fixture("anthropic");
		const savedFetch = globalThis.fetch;
		const requests: Request[] = [];
		let started = 0;
		const sse = [
			{
				type: "message_start",
				message: {
					id: "anonymous-message",
					content: [],
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Anonymous response." },
			},
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
			{ type: "message_stop" },
			{ type: "contextUsageEvent", contextUsagePercentage: 42 },
		]
			.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
			.join("");
		try {
			globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				requests.push(new Request(input, init));
				return new Response(sse, { headers: { "content-type": "text/event-stream" } });
			}) as typeof fetch;
			const events: ParsedStreamEvent[] = [];
			for await (const event of provider.chat({
				conversationId: "anonymous-delegate-test",
				content: "hello",
				model,
				cwd: ".",
				history: [],
				tools: [],
				toolResults: [],
				signal: new AbortController().signal,
				onRequestStart: () => {
					started++;
				},
			})) {
				events.push(event);
			}
			expect(requests).toHaveLength(1);
			const request = requests[0];
			expect(request.url).toBe("https://gateway.example.test/v1/anthropic/messages");
			expect((await request.json()).model).toBe("anonymous:model");
			expect(request.headers.get("X-NUG-Model-Hash")).toBeTruthy();
			expect(started).toBe(1);
			expect(events.map((event) => event.text ?? "").join("")).toBe("Anonymous response.");
			expect(
				events.find((event) => event.contextUsagePercentage != null)?.contextUsagePercentage,
			).toBe(42);
		} finally {
			globalThis.fetch = savedFetch;
		}
	});

	for (const channelType of ["anthropic", "openai", "codex", "responses"]) {
		test(`supported ${channelType} protocol still prepares and builds nonempty history`, async () => {
			const { provider, model } = fixture(channelType);
			provider.prepareForModel(model);
			const { history } = await provider.buildHistory([], model);
			provider.pushUserTurn(history, "hello", model, []);
			expect(history.length).toBeGreaterThan(0);
		});
	}
});
