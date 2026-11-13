import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { getProviderKeyStore, type ProviderKey } from "../../provider-keys";
import type { NUGProviderConfig, OpenAIProviderConfig } from "../../settings";
import { CodexProvider } from "../codex-provider";
import { buildImageGenerationBody } from "../image-generation-api";
import { NugProvider } from "../nug-provider";
import { OpenAIProvider } from "../openai-provider";
import {
	PooledProvider,
	resetProviderKeyRuntimeForTests,
	selectProviderKey,
} from "../pooled-provider";
import type { ImageGenerationRequest, ProviderAdapter } from "../provider";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	mock.restore();
	resetProviderKeyRuntimeForTests();
});

function params(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
	return {
		prompt: "A transparent cat",
		model: "future-image-model",
		signal: new AbortController().signal,
		conversationId: "image-session",
		callId: "image-call",
		...overrides,
	};
}

function config(overrides: Partial<OpenAIProviderConfig> = {}): OpenAIProviderConfig {
	return {
		id: "images-test",
		name: "Images Test",
		prefix: "images-test",
		apiKey: "sk-images-test",
		baseUrl: "https://images.example.invalid/v1///",
		defaultModel: "chat-model-not-image-model",
		proxy: { mode: "direct" },
		...overrides,
	};
}

interface FetchCall {
	url: string;
	init: RequestInit & { proxy?: string };
}

function captureFetch(result: Response | Error) {
	const calls: FetchCall[] = [];
	globalThis.fetch = (async (input, init) => {
		calls.push({ url: String(input), init: init ?? {} });
		if (result instanceof Error) throw result;
		return result;
	}) as typeof fetch;
	return calls;
}

function untouchedResponse(status = 200) {
	let pulls = 0;
	const response = new Response(
		new ReadableStream(
			{
				pull(controller) {
					pulls++;
					controller.enqueue(new Uint8Array(8 * 1024 * 1024));
					controller.close();
				},
			},
			{ highWaterMark: 0 },
		),
		{ status, headers: { "content-type": "application/json" } },
	);
	response.text = async () => {
		throw new Error("must not read response text");
	};
	response.json = async () => {
		throw new Error("must not parse response JSON");
	};
	response.clone = () => {
		throw new Error("must not clone response");
	};
	return { response, pulls: () => pulls };
}

describe("Images request body", () => {
	test("leaves optional upstream defaults absent and preserves arbitrary model/size/quality", () => {
		expect(buildImageGenerationBody(params())).toEqual({
			model: "future-image-model",
			prompt: "A transparent cat",
		});
		expect(
			buildImageGenerationBody(
				params({ model: "channel:future-model", size: "1536x2048", quality: "future-quality" }),
			),
		).toEqual({
			model: "channel:future-model",
			prompt: "A transparent cat",
			size: "1536x2048",
			quality: "future-quality",
		});
	});

	test("transparent output asks for PNG; false does not force an opaque background", () => {
		expect(buildImageGenerationBody(params({ transparentBackground: true }))).toMatchObject({
			background: "transparent",
			output_format: "png",
		});
		expect(buildImageGenerationBody(params({ transparentBackground: false }))).toEqual(
			buildImageGenerationBody(params()),
		);
	});
});

describe("OpenAI Images transport", () => {
	for (const apiMode of ["responses", "completions", "codex"] as const) {
		test(`${apiMode} sends one independent POST with the caller's exact model`, async () => {
			const { response, pulls } = untouchedResponse();
			const calls = captureFetch(response);
			const request = params({ model: "other:custom-image", size: "2048x1024", quality: "high" });
			const provider = new OpenAIProvider(config({ apiMode, codexWebSocket: true }));
			const result = await provider.generateImage(request);
			expect(result.response).toBe(response);
			expect(calls).toHaveLength(1);
			expect(calls[0].url).toBe("https://images.example.invalid/v1/images/generations");
			expect(new Headers(calls[0].init.headers).get("accept")).toBe("application/json");
			expect(calls[0].init).toMatchObject({
				method: "POST",
				redirect: "error",
				signal: request.signal,
			});
			expect(JSON.parse(String(calls[0].init.body))).toEqual({
				model: "other:custom-image",
				prompt: "A transparent cat",
				size: "2048x1024",
				quality: "high",
			});
			expect(pulls()).toBe(0);
			expect(response.bodyUsed).toBe(false);
		});
	}

	test("preserves proxy, fingerprint, dynamic headers, and protects selected authentication", async () => {
		const calls = captureFetch(new Response(null));
		const provider = new OpenAIProvider(
			config({
				proxy: { mode: "custom", url: "http://proxy.invalid:8080" },
				userAgentMode: "custom",
				customUserAgent: "images-test-client",
				extraHeaders: { authorization: "Bearer wrong-key", "X-Custom": "extra" },
				dynamicHeaders: () => ({ "X-Dynamic": "current-value" }),
			}),
		);
		await provider.generateImage(params());
		const headers = new Headers(calls[0].init.headers);
		expect(headers.get("authorization")).toBe("Bearer sk-images-test");
		expect(headers.get("user-agent")).toBe("images-test-client");
		expect(headers.get("x-custom")).toBe("extra");
		expect(headers.get("x-dynamic")).toBe("current-value");
		expect(calls[0].init.proxy).toBe("http://proxy.invalid:8080/");
	});

	for (const status of [400, 401, 429, 500]) {
		test(`returns unconsumed HTTP ${status} without fallback or replay`, async () => {
			const { response, pulls } = untouchedResponse(status);
			const calls = captureFetch(response);
			const result = await new OpenAIProvider(config()).generateImage(params());
			expect(result.response).toBe(response);
			expect(pulls()).toBe(0);
			expect(response.bodyUsed).toBe(false);
			expect(calls).toHaveLength(1);
		});
	}

	test("network failure is not replayed", async () => {
		const calls = captureFetch(new Error("images network lost"));
		await expect(new OpenAIProvider(config()).generateImage(params())).rejects.toThrow(
			"Network request failed",
		);
		expect(calls).toHaveLength(1);
	});

	test("missing authentication fails before sending", async () => {
		const calls = captureFetch(new Response(null));
		await expect(
			new OpenAIProvider(config({ apiKey: "" })).generateImage(params()),
		).rejects.toThrow("API key not configured");
		expect(calls).toHaveLength(0);
	});

	test("cancelled request serialization does not send an Images POST", async () => {
		const calls = captureFetch(new Response(null));
		const controller = new AbortController();
		controller.abort(new Error("Images cancelled before encoding"));
		await expect(
			new OpenAIProvider(config()).generateImage(params({ signal: controller.signal })),
		).rejects.toThrow("Images cancelled before encoding");
		expect(calls).toHaveLength(0);
	});

	test("keeps the runtime transport hook", async () => {
		const calls = captureFetch(new Response(null));
		const transportCalls: string[] = [];
		const provider = new OpenAIProvider(config(), undefined, {
			transportHeaders: (headers) => headers.set("X-Transport", "present"),
			fetch: (input, init, next) => {
				transportCalls.push(String(input));
				return next(input, init);
			},
		});
		await provider.generateImage(params());
		expect(transportCalls).toEqual(["https://images.example.invalid/v1/images/generations"]);
		expect(new Headers(calls[0].init.headers).get("x-transport")).toBe("present");
	});
});

function codexProvider(authMode: "oauth" | "agent_identity" = "oauth") {
	const provider = new CodexProvider({ useWebSocket: true });
	const sessions: Array<string | undefined> = [];
	const context = {
		id: "codex-image-account",
		token: authMode === "oauth" ? "oauth-image-token" : "",
		authorization: authMode === "oauth" ? "Bearer oauth-image-token" : "AgentAssertion abc.def",
		credential: {
			accountId: "chatgpt-image-account",
			authMode,
			disabled: false,
			expiresAt: Date.now() + 3_600_000,
			network: {
				deviceId: "images-device",
				proxy: { mode: "custom", url: "http://codex-proxy.invalid:8080" },
				userAgentMode: "custom",
				customUserAgent: "codex-image-client",
				extraHeaders: { "X-Account-Identity": "selected-account" },
			},
		},
	};
	const manager = {
		acquireContext: async (session?: string) => {
			sessions.push(session);
			return context;
		},
		refreshUsageOnUseIfNeeded: async () => {},
		snapshot: () => {
			throw new Error("Images must not enter failover");
		},
	};
	(provider as unknown as { manager: unknown }).manager = manager;
	return { provider, sessions };
}

describe("Codex Images credentials", () => {
	for (const authMode of ["oauth", "agent_identity"] as const) {
		test(`${authMode} uses the selected account headers, proxy, and session`, async () => {
			const { response, pulls } = untouchedResponse(429);
			const calls = captureFetch(response);
			const { provider, sessions } = codexProvider(authMode);
			const result = await provider.generateImage(params());
			expect(result).toEqual({ response, credentialId: "codex-image-account" });
			expect(sessions).toEqual(["image-session"]);
			expect(calls).toHaveLength(1);
			expect(calls[0].url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
			const headers = new Headers(calls[0].init.headers);
			expect(headers.get("authorization")).toBe(
				authMode === "oauth" ? "Bearer oauth-image-token" : "AgentAssertion abc.def",
			);
			expect(headers.get("chatgpt-account-id")).toBe("chatgpt-image-account");
			expect(headers.get("user-agent")).toBe("codex-image-client");
			expect(headers.get("x-account-identity")).toBe("selected-account");
			expect(headers.get("session-id")).toBe("image-session");
			expect(calls[0].init.proxy).toBe("http://codex-proxy.invalid:8080/");
			expect(pulls()).toBe(0);
		});
	}

	test("network failure never rotates or reacquires an account", async () => {
		const calls = captureFetch(new Error("Codex image connection reset"));
		const { provider, sessions } = codexProvider();
		await expect(provider.generateImage(params())).rejects.toThrow("[connection_reset]");
		expect(calls).toHaveLength(1);
		expect(sessions).toEqual(["image-session"]);
	});
});

function poolKeys(count = 2) {
	const keys: ProviderKey[] = Array.from({ length: count }, (_, index) => ({
		id: `image-key-${index}`,
		providerId: "image-pool",
		apiKey: `secret-${index}`,
		priority: index,
		createdAt: 1,
	}));
	spyOn(getProviderKeyStore(), "list").mockImplementation(() => keys);
	return keys;
}

function imagePool(response: Response | Error, supportsImages = true) {
	const used: Array<{ id: string; params: ImageGenerationRequest }> = [];
	const pool = new PooledProvider("image-pool", (key) => {
		const adapter = {
			generateImage: async (request: ImageGenerationRequest) => {
				used.push({ id: key.id, params: request });
				if (response instanceof Error) throw response;
				return { response, credentialId: "inner-id" };
			},
		} as ProviderAdapter;
		if (!supportsImages) delete adapter.generateImage;
		return adapter;
	});
	return { pool, used };
}

describe("Pooled Images selection", () => {
	for (const keyCount of [1, 2]) {
		test(`${keyCount} key(s): returns selected credential and unconsumed non-2xx exactly once`, async () => {
			const keys = poolKeys(keyCount);
			const { response, pulls } = untouchedResponse(429);
			const { pool, used } = imagePool(response);
			const request = params();
			expect(await pool.generateImage?.(request)).toEqual({
				response,
				credentialId: keys[0].id,
			});
			expect(used).toEqual([{ id: keys[0].id, params: request }]);
			expect(pulls()).toBe(0);
		});
	}

	test("uses the existing chat session affinity instead of a newly preferred key", async () => {
		const keys = poolKeys();
		expect(selectProviderKey("image-pool", "image-session")?.id).toBe(keys[0].id);
		keys.reverse();
		const { pool, used } = imagePool(new Response(null));
		await pool.generateImage?.(params());
		expect(used.map((call) => call.id)).toEqual(["image-key-0"]);
	});

	test("network failure never invokes a second key", async () => {
		poolKeys();
		const { pool, used } = imagePool(new Error("pool image network failed"));
		await expect(pool.generateImage?.(params())).rejects.toThrow("pool image network failed");
		expect(used.map((call) => call.id)).toEqual(["image-key-0"]);
	});

	test("does not advertise Images for adapter families without the method", () => {
		poolKeys();
		expect(imagePool(new Response(null), false).pool.generateImage).toBeUndefined();
	});
});

function nugProvider() {
	const nugConfig: NUGProviderConfig = {
		id: "nug-images-test",
		name: "NUG Images Test",
		prefix: "nug-images",
		apiKey: "nug-image-key",
		baseUrl: "https://nug-images.example.invalid/api/v1/",
		defaultModel: "codex:chat-model",
		proxy: { mode: "custom", url: "http://nug-proxy.invalid:8080" },
	};
	return new NugProvider(nugConfig);
}

describe("NUG local Images delegation", () => {
	for (const channel of ["codex", "openai"]) {
		test(`${channel} delegates through the existing OpenAI-shaped connection`, async () => {
			const { response, pulls } = untouchedResponse(404);
			const calls = captureFetch(response);
			const request = params({ chatModel: `nug-images:${channel}:chat-model` });
			const result = await nugProvider().generateImage(request);
			expect(result.response).toBe(response);
			expect(calls).toHaveLength(1);
			expect(calls[0].url).toBe("https://nug-images.example.invalid/v1/images/generations");
			expect(JSON.parse(String(calls[0].init.body))).toEqual(
				buildImageGenerationBody({ ...request, model: `${channel}:future-image-model` }),
			);
			expect(request.model).toBe("future-image-model");
			const headers = new Headers(calls[0].init.headers);
			expect(headers.get("authorization")).toBe("Bearer nug-image-key");
			expect(headers.get("x-nug-model-hash")).toBeTruthy();
			expect(calls[0].init.proxy).toBe("http://nug-proxy.invalid:8080/");
			expect(pulls()).toBe(0);
		});
	}

	for (const [model, expected] of [
		["codex:custom-image-model", "codex:custom-image-model"],
		["other-channel:custom-image-model", "other-channel:custom-image-model"],
		["nug-images:codex:custom-image-model", "codex:custom-image-model"],
		["nug-images:custom-image-model", "codex:custom-image-model"],
	]) {
		test(`preserves image model routing for ${model}`, async () => {
			const calls = captureFetch(new Response(null));
			const request = params({ model, chatModel: "nug-images:codex:chat-model" });
			await nugProvider().generateImage(request);
			expect(calls).toHaveLength(1);
			expect(JSON.parse(String(calls[0].init.body)).model).toBe(expected);
			expect(request.model).toBe(model);
		});
	}

	test("missing chat route and Anthropic-shaped routes fail without sending", async () => {
		const calls = captureFetch(new Response(null));
		const provider = nugProvider();
		await expect(provider.generateImage(params())).rejects.toThrow("current chat model route");
		await expect(
			provider.generateImage(params({ chatModel: "nug-images:anthropic:chat-model" })),
		).rejects.toThrow("OpenAI-shaped channel");
		expect(calls).toHaveLength(0);
	});

	test("network failure does not replay locally or switch delegates", async () => {
		const calls = captureFetch(new Error("NUG image network failed"));
		await expect(
			nugProvider().generateImage(params({ chatModel: "nug-images:codex:chat-model" })),
		).rejects.toThrow("Network request failed");
		expect(calls).toHaveLength(1);
	});
});
