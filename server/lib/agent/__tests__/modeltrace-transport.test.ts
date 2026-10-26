import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { ChatParams } from "../provider";

const websocket = { ...(await import("../codex-websocket")) };
let captured: Parameters<typeof websocket.streamCodexResponsesWebSocket>[0] | undefined;
mock.module("../codex-websocket", () => ({
	...websocket,
	async *streamCodexResponsesWebSocket(
		options: Parameters<typeof websocket.streamCodexResponsesWebSocket>[0],
	) {
		captured = options;
		yield { text: "[]", stopReason: "stop" };
	},
}));
const { OpenAIProvider } = await import("../openai-provider");
const { CodexProvider } = await import("../codex-provider");
beforeEach(() => {
	captured = undefined;
});
afterAll(() => {
	mock.module("../codex-websocket", () => websocket);
	mock.restore();
});

function params(): ChatParams {
	return {
		conversationId: "parent-wire-session",
		stickySessionKey: "parent-credential-affinity",
		transportSessionKey: "probe-local-socket",
		content: "original content\n\nprobe",
		model: "gpt-5.5",
		cwd: "/workspace",
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
	};
}
function expectIsolatedTransport() {
	expect(captured?.sessionKey).toBe("probe-local-socket");
	expect(captured?.conversationId).toBe("parent-wire-session");
	expect(captured?.narratorId).toBe("parent-credential-affinity");
	expect(captured?.request.prompt_cache_key).toBe("parent-wire-session");
}

test("OpenAI/NUG Codex delegates isolate the socket without changing wire cache identity", async () => {
	const provider = new OpenAIProvider({
		id: "test-modeltrace",
		name: "test",
		prefix: "test-modeltrace",
		apiKey: "test-key",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		defaultModel: "gpt-5.5",
		apiMode: "codex",
		codexWebSocket: true,
	});
	for await (const _event of provider.chat(params())) {
		// Consume the stubbed transport only; no external requests.
	}
	expectIsolatedTransport();
});

test("built-in Codex keeps credential affinity while isolating the probe socket", async () => {
	const provider = new CodexProvider({ useWebSocket: true });
	const internals = provider as unknown as {
		getContext: (key?: string) => Promise<unknown>;
		refreshUsageOnUse: () => void;
		getMaxFailoverAttempts: () => number;
		manager: { reportSuccess: (id: string) => void };
	};
	const acquire = mock(async (_key?: string) => ({
		id: "test-credential",
		token: "test-token",
		authorization: "Bearer test-token",
		credential: { accountId: "test-account" },
	}));
	internals.getContext = acquire;
	internals.refreshUsageOnUse = () => {};
	internals.getMaxFailoverAttempts = () => 1;
	const oldSuccess = internals.manager.reportSuccess;
	internals.manager.reportSuccess = () => {};
	try {
		for await (const _event of provider.chat(params())) {
			// Consume the stubbed transport only; no external requests.
		}
		expectIsolatedTransport();
		expect(acquire).toHaveBeenCalledWith("parent-credential-affinity");
	} finally {
		internals.manager.reportSuccess = oldSuccess;
	}
});
