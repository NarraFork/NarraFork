import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Providers import usage tracking, but this suite must never open a runtime database.
mock.module("@server/db", () => ({ db: {}, sqlite: {}, activeDatabaseBackend: "sqlite" }));
mock.module("../../../db", () => ({ db: {}, sqlite: {}, activeDatabaseBackend: "sqlite" }));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	diagnosticsFromError,
	normalizeApiRequestDiagnostics,
} from "@shared/agent-protocol/error-diagnostics";
import {
	selectTokenDanceProtocol,
	TOKENDANCE_APP_URL,
	type TokenDanceCatalogModel,
} from "@shared/tokendance";
import { z } from "zod/v4";
import { registerTokenDanceRuntime } from "../../tokendance-runtime";
import type { ChatParams } from "../provider";
import type { TokenDanceProvider as ProviderType } from "../tokendance-provider";

let TokenDanceProvider: typeof ProviderType;
let setFetch: typeof import("../../net/outbound-fetch").setOutboundFetchOverrideForTest;
let retry: typeof import("../error-handling").isRetryableError;
let resumable: typeof import("../error-handling").isResumableError;
let settingsProvider: typeof import("../../settings/provider");
let settings: typeof import("../../settings").settings;
let transport: typeof import("../tokendance-provider").tokenDanceTransport;
let runTransport: typeof import("../provider-transport").runProviderTransport;
let resolve: typeof import("../provider").resolveProviderAndModel;
let home = "";
let oldHome: string | undefined;
const apiKey = "test-key-that-must-never-escape-12345";
let config: { apiKey: string; generation: number; disabled: boolean } | undefined;
let models: TokenDanceCatalogModel[] = [];
let dispose: () => void;
const controllers = new Set<AbortController>();
beforeAll(async () => {
	oldHome = process.env.NARRAFORK_HOME;
	home = mkdtempSync(join(tmpdir(), "narrafork-tokendance-runtime-"));
	process.env.NARRAFORK_HOME = home;
	const provider = await import("../tokendance-provider");
	TokenDanceProvider = provider.TokenDanceProvider;
	transport = provider.tokenDanceTransport;
	runTransport = (await import("../provider-transport")).runProviderTransport;
	setFetch = (await import("../../net/outbound-fetch")).setOutboundFetchOverrideForTest;
	const errors = await import("../error-handling");
	retry = errors.isRetryableError;
	resumable = errors.isResumableError;
	settingsProvider = await import("../../settings/provider");
	settings = (await import("../../settings")).settings;
	resolve = (await import("../provider")).resolveProviderAndModel;
});
beforeEach(() => {
	config = { apiKey, generation: 1, disabled: false };
	models = [];
	const assert = (generation: number) => {
		if (!config || config.disabled || config.generation !== generation)
			throw new Error("TokenDance connection changed");
	};
	dispose = registerTokenDanceRuntime({
		getTokenDanceRuntimeConfig: () => config,
		getTokenDanceCatalogModels: () => models,
		assertTokenDanceConnection: assert,
		registerTokenDanceRequest(controller, generation) {
			assert(generation);
			controllers.add(controller);
			return () => {
				controllers.delete(controller);
			};
		},
	});
});
afterEach(() => {
	setFetch(null);
	dispose();
	controllers.clear();
});
afterAll(() => {
	if (oldHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = oldHome;
	rmSync(home, { recursive: true, force: true });
});
const protocols = [
	["openai:responses", "/gateway/v1/responses"],
	["anthropic:messages", "/gateway/v1/messages"],
	["openai:chat-completions", "/gateway/v1/chat/completions"],
	["gemini:generate-content", "/gateway/v1beta/models/opaque-model:streamGenerateContent?alt=sse"],
] as const;
function catalog(protocol: string) {
	models = [
		{
			id: "opaque-model",
			name: "Not a protocol hint",
			context_length: 123456,
			supported_protocols: [protocol],
		},
	];
}
function params(provider: ProviderType): ChatParams {
	const history: unknown[] = [];
	provider.pushUserTurn(history, "hello", "tokendance:opaque-model", []);
	return {
		model: "tokendance:opaque-model",
		conversationId: "test-conversation",
		content: "hello",
		cwd: home,
		history,
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
	};
}

describe("strict TokenDance protocol mapping", () => {
	test("fixed priority and no inference", () => {
		expect(selectTokenDanceProtocol(protocols.map(([protocol]) => protocol).reverse())).toBe(
			"openai-responses",
		);
		expect(selectTokenDanceProtocol(["openai", "claude", "gemini"])).toBeUndefined();
		models = [
			{ id: "claude-gpt-gemini", name: "guess", context_length: 123, supported_protocols: [] },
		];
		expect(() => new TokenDanceProvider().prepareForModel("tokendance:claude-gpt-gemini")).toThrow(
			"no supported protocol",
		);
	});
	test("registry, resolution, stateful helpers and context windows", () => {
		catalog("openai:responses");
		expect(resolve("tokendance:opaque-model").adapter).toBeInstanceOf(TokenDanceProvider);
		expect(settingsProvider.getVisibleModels()).toContain("tokendance:opaque-model");
		expect(settingsProvider.usesStatefulModel("tokendance", "opaque-model")).toBe(true);
		expect(settingsProvider.getModelContextWindow("opaque-model", "tokendance")).toBe(123456);
		if (!config) throw new Error("test connection missing");
		config.disabled = true;
		expect(settingsProvider.getVisibleModels()).not.toContain("tokendance:opaque-model");
	});
	test("default, aggregation and original colon-containing model ID remain intact", () => {
		models = [
			{
				id: "vendor:opaque/id",
				name: "opaque",
				context_length: 456789,
				supported_protocols: ["openai:responses"],
			},
		];
		const previousDefault = settings.agent.defaultModel;
		const previousAggregations = settings.agent.modelAggregations;
		try {
			settings.agent.defaultModel = "tokendance:vendor:opaque/id";
			settings.agent.modelAggregations = [
				{
					id: "td-test",
					name: "test",
					models: [settings.agent.defaultModel],
					routingMode: "priority",
				},
			];
			expect(resolve("__default__").model).toBe("tokendance:vendor:opaque/id");
			expect(resolve("__agg__:td-test").model).toBe("tokendance:vendor:opaque/id");
			expect(settingsProvider.usesStatefulModel("tokendance", "vendor:opaque/id")).toBe(true);
			expect(settingsProvider.getModelContextWindow("vendor:opaque/id", "tokendance")).toBe(456789);
		} finally {
			settings.agent.defaultModel = previousDefault;
			settings.agent.modelAggregations = previousAggregations;
		}
	});
	test("disconnected singleton does not hijack existing legacy prefix", () => {
		config = undefined;
		const previous = settings.openaiProviders;
		try {
			settings.openaiProviders = [
				{
					id: "legacy",
					name: "legacy",
					prefix: "tokendance",
					apiKey: "fake-key",
					baseUrl: "https://legacy.test/v1",
					defaultModel: "opaque-model",
					apiMode: "responses",
				},
			];
			expect(resolve("tokendance:opaque-model").adapter).not.toBeInstanceOf(TokenDanceProvider);
			expect(settingsProvider.usesStatefulModel("tokendance", "opaque-model")).toBe(true);
			config = { apiKey, generation: 1, disabled: false };
			expect(() => resolve("tokendance:opaque-model")).toThrow("prefix conflicts");
		} finally {
			settings.openaiProviders = previous;
		}
	});
	test("stable protocol-specific tools, history and signatures", async () => {
		for (const [protocol] of protocols) {
			catalog(protocol);
			const provider = new TokenDanceProvider();
			provider.prepareForModel("tokendance:opaque-model");
			const source = provider.getActiveReasoningSource();
			expect(source?.startsWith("tokendance:")).toBe(true);
			const tool = {
				name: "inspect",
				description: "inspect",
				parameters: z.object({ text: z.string() }),
			};
			const formatted = provider.formatTools([tool as never]);
			expect(formatted.length).toBe(1);
			if (protocol === "openai:responses") expect(formatted[0]).toHaveProperty("type", "function");
			if (protocol === "openai:chat-completions") expect(formatted[0]).toHaveProperty("function");
			if (protocol === "anthropic:messages") expect(formatted[0]).toHaveProperty("name", "inspect");
			if (protocol === "gemini:generate-content")
				expect(formatted[0]).toHaveProperty("functionDeclarations");
			await provider.buildHistory([], "tokendance:opaque-model");
			expect(provider.getActiveReasoningSource()).toBe(source);
			const history: unknown[] = [];
			provider.pushAssistantTurn(history, "calling", [
				{ toolUseId: "tool1", name: "inspect", input: { text: "x" } },
			]);
			provider.pushUserTurn(history, "", "tokendance:opaque-model", [
				provider.formatToolResult("tool1", "done", false, undefined, "inspect"),
			]);
			expect(JSON.stringify(history)).toContain("done");
		}
	});
});

describe("final headers, recovery, redaction and generation", () => {
	for (const [protocol, path] of protocols) {
		for (const mode of ["chat", "generate"] as const) {
			test(`${protocol} ${mode} uses exact path and typed terminal recovery`, async () => {
				catalog(protocol);
				let calls = 0;
				setFetch(async (input, init) => {
					calls++;
					const url = String(input);
					expect(url).toBe(`https://tokendance.space${path}`);
					expect(new Headers(init?.headers).get("x-app-url")).toBe(TOKENDANCE_APP_URL);
					return new Response(`rate limit try again ${apiKey}`, {
						status: 429,
						headers: { "TokenDance-Recovery-Action": "top_up_balance" },
					});
				});
				const provider = new TokenDanceProvider();
				provider.prepareForModel("tokendance:opaque-model");
				try {
					if (mode === "generate") await provider.generate("hello", "tokendance:opaque-model");
					else
						for await (const _ of provider.chat(params(provider))) {
							/* no output expected */
						}
					throw new Error("Expected API failure");
				} catch (error) {
					const diagnostics = diagnosticsFromError(error);
					expect(diagnostics?.provider).toBe("tokendance");
					expect(diagnostics?.tokendanceRecoveryAction).toBe("top_up_balance");
					expect(JSON.stringify(diagnostics)).not.toContain(apiKey);
					expect(String(error)).not.toContain(apiKey);
					expect(retry(error, [{ type: "status", value: "429", retryable: true } as never])).toBe(
						false,
					);
					expect(resumable(error)).toBe(false);
				}
				expect(calls).toBe(1);
				expect(controllers.size).toBe(0);
			});
		}
	}
	test("header override is case-insensitive and survives repeated requests", async () => {
		for (let n = 0; n < 2; n++) {
			await runTransport(
				transport(apiKey, 1),
				"https://tokendance.space",
				{ headers: { "x-App-Url": "attacker" } },
				async (_, init) => {
					expect(new Headers(init?.headers).get("X-App-URL")).toBe(TOKENDANCE_APP_URL);
					return new Response(null, { status: 204 });
				},
			);
		}
	});
	test("redacts success stream even when key spans chunks", async () => {
		const response = await runTransport(
			transport(apiKey, 1),
			"https://tokendance.space",
			{},
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							const encoder = new TextEncoder();
							controller.enqueue(encoder.encode(`prefix ${apiKey.slice(0, 9)}`));
							controller.enqueue(encoder.encode(`${apiKey.slice(9)} suffix`));
							controller.close();
						},
					}),
				),
		);
		expect(await response.text()).not.toContain(apiKey);
		expect(controllers.size).toBe(0);
	});
	test("transparent streaming preserves UTF-8, surrogate boundaries and tool SSE JSON", async () => {
		const original = `event: response.output_item.added\ndata: ${JSON.stringify({ type: "function_call", name: "inspect", arguments: JSON.stringify({ text: "Unicode \\u{1f680} \\u{1f308}" }) })}\n\n`;
		const bytes = new TextEncoder().encode(original);
		const response = await runTransport(
			transport(apiKey, 1),
			"https://tokendance.space",
			{},
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
							controller.close();
						},
					}),
				),
		);
		expect(await response.text()).toBe(original);
		expect(controllers.size).toBe(0);
	});
	test("old wrapper and old transport cannot use new authorization", async () => {
		catalog("openai:responses");
		const provider = new TokenDanceProvider();
		provider.prepareForModel("tokendance:opaque-model");
		if (!config) throw new Error("test connection missing");
		config.generation++;
		let calls = 0;
		setFetch(async () => {
			calls++;
			return new Response(null);
		});
		await expect(provider.generate("hello", "tokendance:opaque-model")).rejects.toThrow("changed");
		await expect(
			runTransport(transport(apiKey, 1), "https://tokendance.space", {}, async () => {
				calls++;
				return new Response(null);
			}),
		).rejects.toThrow("changed");
		expect(calls).toBe(0);
	});
	test("deleting connection aborts in-flight controller and unregisters", async () => {
		const pending = runTransport(
			transport(apiKey, 1),
			"https://tokendance.space",
			{},
			async (_, init) => {
				config = undefined;
				for (const controller of controllers) controller.abort();
				expect(init?.signal?.aborted).toBe(true);
				throw new Error("connection deleted");
			},
		);
		await expect(pending).rejects.toThrow("deleted");
		expect(controllers.size).toBe(0);
	});
	test("known recovery cancels never-closing body without reading it", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					cancelled = true;
				},
			}),
			{
				status: 503,
				headers: { "TokenDance-Recovery-Action": "reauthorize_api_key" },
			},
		);
		try {
			await runTransport(
				transport(apiKey, 1),
				"https://tokendance.space",
				{},
				async () => response,
			);
			throw new Error("expected failure");
		} catch (error) {
			expect(diagnosticsFromError(error)?.tokendanceRecoveryAction).toBe("reauthorize_api_key");
			expect(retry(error)).toBe(false);
		}
		expect(cancelled).toBe(true);
		expect(controllers.size).toBe(0);
	});
	test("known recovery survives a broken body, unknown recovery redacts body and header echoes", async () => {
		for (const action of ["api_key_quota", "unknown"] as const) {
			const response = new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.error(new Error(apiKey));
					},
				}),
				{
					status: 503,
					headers: { "TokenDance-Recovery-Action": action, "x-request-id": apiKey },
				},
			);
			try {
				await runTransport(
					transport(apiKey, 1),
					"https://tokendance.space",
					{},
					async () => response,
				);
				throw new Error("expected failure");
			} catch (error) {
				expect(String(error)).not.toContain(apiKey);
				expect(JSON.stringify(diagnosticsFromError(error))).not.toContain(apiKey);
				expect(diagnosticsFromError(error)?.tokendanceRecoveryAction).toBe(
					action === "unknown" ? undefined : action,
				);
			}
			expect(controllers.size).toBe(0);
		}
	});
	test("unknown recovery masks bounded failed body before diagnostics", async () => {
		try {
			await runTransport(
				transport(apiKey, 1),
				"https://tokendance.space",
				{},
				async () => new Response(`prefix ${apiKey} suffix`, { status: 400 }),
			);
			throw new Error("expected failure");
		} catch (error) {
			expect(String(error)).not.toContain(apiKey);
			expect(diagnosticsFromError(error)?.responseSnippet).toContain("prefix");
			expect(diagnosticsFromError(error)?.responseSnippet).toContain("suffix");
		}
		expect(controllers.size).toBe(0);
	});
	test("unknown action and other providers keep existing defaults", () => {
		for (const action of ["top_up_balance", "reauthorize_api_key", "api_key_quota"] as const) {
			const diag = normalizeApiRequestDiagnostics({
				provider: "tokendance",
				tokendanceRecoveryAction: action,
			});
			expect(diag?.tokendanceRecoveryAction).toBe(action);
			expect(retry({ status: 503, message: "overloaded", diagnostics: diag })).toBe(false);
		}
		expect(
			normalizeApiRequestDiagnostics({
				provider: "other",
				tokendanceRecoveryAction: "top_up_balance",
			})?.tokendanceRecoveryAction,
		).toBeUndefined();
		expect(retry({ status: 503, message: "overloaded" })).toBe(true);
		expect(retry({ status: 401, message: "unauthorized" })).toBe(false);
		expect(settings.agent).toBeDefined();
	});
});
