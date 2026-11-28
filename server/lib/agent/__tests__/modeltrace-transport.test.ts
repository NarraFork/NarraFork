import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { CallContext, CodexManager } from "../../codex-manager";
import {
	buildModelTraceProbeParams,
	rememberModelTraceRequest,
	requireModelTraceAnchor,
} from "../modeltrace-request";
import type { ChatParams, ProviderAdapter } from "../provider";

const websocket = { ...(await import("../codex-websocket")) };
let captured: Parameters<typeof websocket.streamCodexResponsesWebSocket>[0] | undefined;
mock.module("../codex-websocket", () => ({
	...websocket,
	async *streamCodexResponsesWebSocket(
		options: Parameters<typeof websocket.streamCodexResponsesWebSocket>[0],
	) {
		options.validateBeforeDispatch?.();
		captured = options;
		yield { text: "[]", stopReason: "stop" };
	},
}));
const { OpenAIProvider } = await import("../openai-provider");
const { AnthropicProvider } = await import("../anthropic-provider");
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
function fork(provider: ProviderAdapter, parent: ChatParams, credentialId?: string): ChatParams {
	rememberModelTraceRequest("wire-parent", provider, parent, "test", credentialId);
	return buildModelTraceProbeParams(
		requireModelTraceAnchor("wire-parent"),
		"probe-local-socket",
		new AbortController().signal,
		"diagnostic suffix",
	);
}

async function drain(provider: ProviderAdapter, params: ChatParams): Promise<void> {
	for await (const _event of provider.chat(params)) {
		// No local tools or parent runtime involved.
	}
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

test("fork keeps the complete Codex input and cache key, but replaces socket and wire thread identity", async () => {
	const provider = new OpenAIProvider({
		id: "test-codex-fork",
		name: "test",
		prefix: "test",
		apiKey: "test-key",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		defaultModel: "gpt-5.5",
		apiMode: "codex",
		codexWebSocket: true,
		codexWebSearch: false,
		codexImageGeneration: false,
	});
	const parent = {
		...params(),
		transportSessionKey: undefined,
		content: "text before [image #1: a.png] after",
		history: [{ role: "developer", content: "original instructions" }],
		tools: [{ type: "function", name: "Local", parameters: { type: "object" } }],
		images: [{ format: "png", base64: "dGVzdA==" }],
	};
	await drain(provider, parent);
	const original = captured;
	await drain(provider, fork(provider, parent));
	const diagnostic = captured;
	expect(original?.request.input[0]).toEqual({
		role: "developer",
		content: [{ type: "input_text", text: "original instructions" }],
	});
	expect(JSON.stringify(original?.request.input)).toContain("dGVzdA==");
	expect(diagnostic?.request.tools).toEqual(original?.request.tools);
	expect(diagnostic?.request.input).toEqual([
		...(original?.request.input ?? []),
		{ role: "user", content: [{ type: "input_text", text: "diagnostic suffix" }] },
	]);
	expect(diagnostic?.request.prompt_cache_key).toBe(original?.request.prompt_cache_key);
	expect(diagnostic?.resetSessionBeforeRequest).toBe(true);
	expect(diagnostic?.sessionKey).toBe("probe-local-socket");
	expect(diagnostic?.conversationId).toBe("probe-local-socket");
	expect(diagnostic?.narratorId).toBe("probe-local-socket");
});

test("Anthropic wire suffix preserves system, tool definitions, images and the parent's cache breakpoint", async () => {
	const provider = new AnthropicProvider({
		id: "test-claude-fork",
		name: "test",
		prefix: "test",
		apiKey: "test-key",
		baseUrl: "https://example.invalid/v1",
		defaultModel: "claude-opus-5",
		officialApi: true,
	});
	const parent: ChatParams = {
		...params(),
		model: "claude-opus-5",
		content: "before [image #1: x.png] after",
		history: [],
		tools: [{ name: "Local", description: "Local tool", input_schema: { type: "object" } }],
		images: [{ format: "png", base64: "dGVzdA==" }],
	};
	provider.injectSystemPrompt(parent.history, "original system", parent.model);
	const bodies: {
		system: unknown;
		tools: unknown;
		messages: { role: string; content: unknown[] }[];
	}[] = [];
	const fetch = globalThis.fetch;
	globalThis.fetch = (async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		return new Response("upstream stubbed", { status: 500 });
	}) as typeof globalThis.fetch;
	try {
		await expect(drain(provider, parent)).rejects.toThrow();
		await expect(drain(provider, fork(provider, parent))).rejects.toThrow();
	} finally {
		globalThis.fetch = fetch;
	}
	expect(bodies).toHaveLength(2);
	const [original, diagnostic] = bodies;
	expect(JSON.stringify(original.system)).toContain("original system");
	expect(diagnostic.system).toEqual(original.system);
	expect(diagnostic.tools).toEqual(original.tools);
	const parentTail = original.messages.at(-1);
	expect(JSON.stringify(parentTail)).toContain("dGVzdA==");
	expect(JSON.stringify(parentTail)).toContain("cache_control");
	expect(diagnostic.messages).toEqual([
		...original.messages.slice(0, -1),
		{
			role: "user",
			content: [...(parentTail?.content ?? []), { type: "text", text: "diagnostic suffix" }],
		},
	]);
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

test.each([
	false,
	true,
])("built-in Codex blocks a disabled diagnostic credential before dispatch (websocket=%s)", async (useWebSocket) => {
	const provider = new CodexProvider({
		useWebSocket,
		useWebSearch: false,
		useImageGeneration: false,
	});
	const context: CallContext = {
		id: "test-credential",
		token: "test-token",
		authorization: "Bearer test-token",
		credential: { id: "test-credential", accountId: "test-account" } as CallContext["credential"],
	};
	const internals = provider as unknown as {
		getContext: () => Promise<CallContext>;
		refreshUsageOnUse: () => void;
		getMaxFailoverAttempts: () => number;
		manager: Pick<
			CodexManager,
			"acquireDiagnosticContext" | "isDiagnosticCredentialCurrent" | "reportSuccess"
		>;
	};
	internals.getContext = async () => context;
	internals.refreshUsageOnUse = () => {};
	internals.getMaxFailoverAttempts = () => 1;
	internals.manager = {
		acquireDiagnosticContext: async () => context,
		isDiagnosticCredentialCurrent: (credential) => !credential.disabled,
		reportSuccess: () => {},
	};
	const fetch = globalThis.fetch;
	const upstream = mock(async () => new Response("upstream stubbed", { status: 500 }));
	globalThis.fetch = upstream as unknown as typeof globalThis.fetch;
	try {
		let validate: (() => boolean) | undefined;
		const parent: ChatParams = {
			...params(),
			onRequestStart: (info) => {
				validate = info?.validateDiagnosticCredential;
			},
		};
		if (useWebSocket) await drain(provider, parent);
		else await expect(drain(provider, parent)).rejects.toThrow();
		expect(validate?.()).toBe(true);
		upstream.mockClear();
		captured = undefined;
		const diagnostic = fork(provider, parent, context.id);
		diagnostic.onInputCharacters = () => {
			context.credential.disabled = true;
		};
		await expect(drain(provider, diagnostic)).rejects.toThrow(
			"The parent Codex credential is unavailable",
		);
		expect(validate?.()).toBe(false);
		expect(upstream).not.toHaveBeenCalled();
		expect(captured).toBeUndefined();
	} finally {
		globalThis.fetch = fetch;
	}
});
