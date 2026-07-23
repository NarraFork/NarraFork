import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAIProviderConfig } from "../../settings";
import { OpenAIProvider } from "../openai-provider";
import type { ChatParams } from "../provider";

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
