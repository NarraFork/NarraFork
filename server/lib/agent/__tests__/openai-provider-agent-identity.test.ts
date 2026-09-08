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
