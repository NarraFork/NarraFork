import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAIProviderConfig } from "../../settings";
import { OpenAIProvider } from "../openai-provider";
import type { ChatParams } from "../provider";
import { ApiRequestDumpCollector } from "../request-dump";

/**
 * Agent Identity credentials authenticate via a full `AgentAssertion ...`
 * Authorization header (set as `authorizationHeader`) with an empty `apiKey`
 * (no bearer token exists). The provider must not mistake the empty apiKey
 * for a missing credential when `authorizationHeader` is present.
 */
const AGENT_IDENTITY_CONFIG: OpenAIProviderConfig = {
	id: "codex",
	name: "Codex",
	prefix: "codex",
	apiKey: "",
	authorizationHeader: "AgentAssertion abc.def",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	defaultModel: "gpt-5.3-codex",
	apiMode: "codex",
};

const NO_AUTH_CONFIG: OpenAIProviderConfig = {
	id: "codex",
	name: "Codex",
	prefix: "codex",
	apiKey: "",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	defaultModel: "gpt-5.3-codex",
	apiMode: "codex",
};

function minimalChatParams(overrides?: Partial<ChatParams>): ChatParams {
	return {
		history: [],
		content: "hi",
		model: "codex:gpt-5.3-codex",
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		conversationId: "conv-1",
		...overrides,
	} as ChatParams;
}

const originalFetch = globalThis.fetch;
let capturedAuthorization: string | null | undefined;

function mockFetchCapturingAuth(): void {
	capturedAuthorization = undefined;
	globalThis.fetch = (async (_input, init) => {
		const headers = new Headers((init as RequestInit | undefined)?.headers);
		capturedAuthorization = headers.get("Authorization");
		// Return a deliberately invalid (non-JSON) 500 so the provider surfaces
		// a normal API error rather than trying to reach the real network.
		return new Response("upstream unavailable", { status: 500 });
	}) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	capturedAuthorization = undefined;
});

describe("OpenAIProvider HTTP dump", () => {
	for (const stop of ["consumer", "done", "error"] as const) {
		test(`preserves raw SSE on ${stop} without cloning or draining`, async () => {
			const raw = 'data: {"type":"response.output_text.delta","delta":"中","output_index":0}\n\n';
			let reads = 0;
			let cancelled = false;
			globalThis.fetch = (async () => {
				const response = new Response(
					new ReadableStream(
						{
							pull(controller) {
								reads++;
								if (reads === 1) controller.enqueue(new TextEncoder().encode(raw));
								else if (stop === "done") controller.close();
								else controller.error(new Error("upstream lost"));
							},
							cancel() {
								cancelled = true;
							},
						},
						{ highWaterMark: 0 },
					),
				);
				response.clone = () => {
					throw new Error("must not clone");
				};
				return response;
			}) as unknown as typeof fetch;
			const dump = new ApiRequestDumpCollector();
			const iterator = new OpenAIProvider(AGENT_IDENTITY_CONFIG).chat(
				minimalChatParams({ requestDump: dump }),
			);
			const first = await iterator.next();
			expect(first.value).toMatchObject({ text: "中" });
			if (stop === "consumer") await iterator.return(undefined);
			else if (stop === "error") await expect(iterator.next()).rejects.toThrow("upstream lost");
			else {
				await iterator.next();
				await iterator.return(undefined);
			}
			expect(dump.snapshot().response?.bodyText).toContain(raw);
			expect(dump.snapshot().response?.bodyIncomplete).toBe(stop !== "done");
			expect(reads).toBe(stop === "consumer" ? 1 : 2);
			if (stop === "consumer") expect(cancelled).toBe(true);
		});
	}
});

describe("OpenAIProvider offline reflection request shape", () => {
	test("keeps Codex stable body and headers identical outside the input tail", async () => {
		const captured: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
		globalThis.fetch = (async (_input, init) => {
			captured.push({
				body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
				headers: Object.fromEntries(new Headers((init as RequestInit).headers).entries()),
			});
			return new Response("offline verification", { status: 500 });
		}) as typeof fetch;

		const provider = new OpenAIProvider({
			...AGENT_IDENTITY_CONFIG,
			apiKey: "offline-test-key",
			codexWebSearch: true,
			codexImageGeneration: true,
		});
		const history = [
			{ role: "developer", content: "stable system prompt" },
			{ role: "user", content: "parent request" },
		];
		const tools = [
			{
				type: "function",
				name: "Read",
				description: "read",
				parameters: { type: "object", properties: {} },
				strict: false,
			},
			{
				type: "function",
				name: "DangerConfirm",
				description: "confirm",
				parameters: { type: "object", properties: {} },
				strict: false,
			},
		];
		const base = minimalChatParams({
			model: "codex:gpt-6-astra",
			history,
			tools,
			conversationId: "conv-offline-reflection",
			stickySessionKey: "narrator-offline",
			reasoningEffort: "high",
			serviceTier: "priority",
		});

		for (const content of ["parent request", "danger reflection prompt"]) {
			const iterator = provider.chat({
				...base,
				content,
				requestDump: new ApiRequestDumpCollector(),
			})[Symbol.asyncIterator]();
			await expect(iterator.next()).rejects.toThrow("offline verification");
		}

		expect(captured).toHaveLength(2);
		const [parent, reflection] = captured;
		const withoutInput = (body: Record<string, unknown>) => {
			const copy = { ...body };
			delete copy.input;
			return copy;
		};
		expect(withoutInput(reflection.body)).toEqual(withoutInput(parent.body));
		expect(reflection.headers).toEqual(parent.headers);
		expect(reflection.body.prompt_cache_key).toBe("conv-offline-reflection");
		expect((reflection.body.client_metadata as Record<string, unknown>).session_id).toBe(
			"conv-offline-reflection",
		);
		expect((reflection.body.client_metadata as Record<string, unknown>).thread_id).toBe(
			"conv-offline-reflection",
		);
		expect(reflection.body.tools).toEqual(parent.body.tools);
		expect((reflection.body.input as unknown[]).slice(0, -1)).toEqual(
			(parent.body.input as unknown[]).slice(0, -1),
		);
	});
});

describe("OpenAIProvider Agent Identity empty apiKey handling", () => {
	test("chat() does not throw 'API key not configured' when authorizationHeader is set", async () => {
		mockFetchCapturingAuth();
		const provider = new OpenAIProvider(AGENT_IDENTITY_CONFIG);
		const iterator = provider.chat(minimalChatParams())[Symbol.asyncIterator]();
		await expect(iterator.next()).rejects.not.toThrow(/API key not configured/);
		// Confirms the request actually went out with the AgentAssertion header,
		// not a Bearer header built from the empty apiKey.
		expect(capturedAuthorization).toBe("AgentAssertion abc.def");
	});

	test("chat() still throws 'API key not configured' with no apiKey and no authorizationHeader", async () => {
		const provider = new OpenAIProvider(NO_AUTH_CONFIG);
		const iterator = provider.chat(minimalChatParams())[Symbol.asyncIterator]();
		await expect(iterator.next()).rejects.toThrow(/API key not configured/);
	});

	test("generateWithMeta does not throw 'API key not configured' when authorizationHeader is set", async () => {
		mockFetchCapturingAuth();
		const provider = new OpenAIProvider(AGENT_IDENTITY_CONFIG);
		await expect(provider.generateWithMeta("hi", "codex:gpt-5.3-codex")).rejects.not.toThrow(
			/API key not configured/,
		);
		expect(capturedAuthorization).toBe("AgentAssertion abc.def");
	});
});
