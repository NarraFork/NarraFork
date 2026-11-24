/** Relay rejections may remove an optional routing hint, never an output ceiling. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { replaceModelOverridesForTests } from "../../model-catalog";
import { settings } from "../../settings";
import { ProviderInvalidStateError } from "../error-handling";
import { OpenAIProvider } from "../openai-provider";
import type { ParsedStreamEvent } from "../provider";
import { ApiError } from "../types";
import {
	modelRejectsParameter,
	parseUnsupportedParameter,
	resetUnsupportedParameterMemory,
	stripUnsupportedParameter,
	unsupportedParameterFromError,
	withUnsupportedParameterFallback,
} from "../unsupported-parameter-fallback";

const config = {
	id: "unsupported-param",
	prefix: "unsup",
	name: "Unsupported param",
	apiKey: "test",
	baseUrl: "https://example.invalid/v1",
	defaultModel: "gpt-6-astra",
	apiMode: "codex" as const,
	codexWebSocket: false,
};
const model = `${config.prefix}:gpt-6-astra`;

const NUG_DETAIL_MESSAGE =
	'upstream status 400: {"detail":"Unsupported parameter: max_output_tokens"}';
const CACHE_KEY_REJECTION = new ApiError(400, "Unsupported parameter: prompt_cache_key");

beforeEach(() => {
	resetUnsupportedParameterMemory();
});

describe("parseUnsupportedParameter", () => {
	test("extracts the field name from observed gateways", () => {
		expect(parseUnsupportedParameter(NUG_DETAIL_MESSAGE)).toBe("max_output_tokens");
		expect(parseUnsupportedParameter("Unsupported parameter: max_output_tokens")).toBe(
			"max_output_tokens",
		);
		expect(parseUnsupportedParameter('Unsupported parameter: "max_tokens"')).toBe("max_tokens");
		expect(
			parseUnsupportedParameter(
				"OpenAI Responses stream error (400): upstream status 400: " +
					'{"detail":"Unsupported parameter: max_output_tokens"}',
			),
		).toBe("max_output_tokens");
	});

	test("ignores unrelated errors", () => {
		expect(parseUnsupportedParameter("rate limit exceeded")).toBeUndefined();
		expect(parseUnsupportedParameter(undefined)).toBeUndefined();
		expect(unsupportedParameterFromError(new Error("quota exceeded"))).toBeUndefined();
	});

	test("finds the parameter through error graphs", () => {
		expect(
			unsupportedParameterFromError(
				new ProviderInvalidStateError(
					"400",
					`OpenAI Responses stream error (400): ${NUG_DETAIL_MESSAGE}`,
				),
			),
		).toBe("max_output_tokens");
		expect(
			unsupportedParameterFromError({
				message: "OpenAI API error 400",
				diagnostics: { responseSnippet: NUG_DETAIL_MESSAGE },
			}),
		).toBe("max_output_tokens");
	});
});

describe("stripUnsupportedParameter", () => {
	test("removes only the rejected field and remembers it", () => {
		const body: { model: string; max_output_tokens: number; prompt_cache_key?: string } = {
			model: "m",
			max_output_tokens: 2300,
			prompt_cache_key: "thread",
		};
		expect(stripUnsupportedParameter(body, "p:m", CACHE_KEY_REJECTION)).toBe(true);
		expect(body).toEqual({ model: "m", max_output_tokens: 2300 });
		expect(modelRejectsParameter("p:m", "prompt_cache_key")).toBe(true);
		expect(modelRejectsParameter("p:m", "max_output_tokens")).toBe(false);
	});

	for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
		test(`${field}: rejection never replays without the requested ceiling`, async () => {
			const error = new ApiError(400, `Unsupported parameter: ${field}`);
			const body = { [field]: 23 };
			const sent: unknown[] = [];
			await expect(
				withUnsupportedParameterFallback("p:m", body, async (request) => {
					sent.push({ ...request });
					throw error;
				}),
			).rejects.toBe(error);
			expect(sent).toEqual([{ [field]: 23 }]);
			expect(body).toEqual({ [field]: 23 });
			expect(modelRejectsParameter("p:m", field)).toBe(false);
		});
	}

	test("returns false when the field is not on the body", () => {
		const body: Record<string, unknown> = { model: "m" };
		expect(stripUnsupportedParameter(body, "p:m", new ApiError(400, NUG_DETAIL_MESSAGE))).toBe(
			false,
		);
		expect(modelRejectsParameter("p:m", "max_output_tokens")).toBe(false);
	});
});

describe("withUnsupportedParameterFallback", () => {
	test("retries without the rejected field and succeeds", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const result = await withUnsupportedParameterFallback(
			"p:m",
			{ max_output_tokens: 10, prompt_cache_key: "thread" },
			async (body) => {
				seen.push({ ...body });
				if ("prompt_cache_key" in body) throw CACHE_KEY_REJECTION;
				return "ok";
			},
		);
		expect(result).toBe("ok");
		expect(seen).toHaveLength(2);
		expect(seen).toEqual([
			{ max_output_tokens: 10, prompt_cache_key: "thread" },
			{ max_output_tokens: 10 },
		]);
		expect(modelRejectsParameter("p:m", "prompt_cache_key")).toBe(true);
	});

	test("skips the doomed first attempt once the model is known", async () => {
		const body = { max_output_tokens: 10, prompt_cache_key: "thread" };
		await withUnsupportedParameterFallback("p:m", body, (b) => {
			if ("prompt_cache_key" in b) throw CACHE_KEY_REJECTION;
			return Promise.resolve("ok");
		});

		const seen: Array<Record<string, unknown>> = [];
		const second = await withUnsupportedParameterFallback(
			"p:m",
			{ max_output_tokens: 99, prompt_cache_key: "thread" },
			(b) => {
				seen.push({ ...b });
				return Promise.resolve("ok");
			},
		);
		expect(second).toBe("ok");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({ max_output_tokens: 99 });
	});

	test("re-throws unrelated errors without retrying", async () => {
		let calls = 0;
		await expect(
			withUnsupportedParameterFallback("p:m", { max_output_tokens: 1 }, async () => {
				calls++;
				throw new ApiError(429, "rate limit");
			}),
		).rejects.toThrow("rate limit");
		expect(calls).toBe(1);
	});

	test("propagates the second failure when the retry also fails", async () => {
		await expect(
			withUnsupportedParameterFallback(
				"p:m",
				{ max_output_tokens: 25, prompt_cache_key: "thread" },
				async (body) => {
					if ("prompt_cache_key" in body) throw CACHE_KEY_REJECTION;
					throw new ApiError(500, "upstream exploded");
				},
			),
		).rejects.toThrow("upstream exploded");
	});
});

describe("OpenAI request paths", () => {
	const originalFetch = globalThis.fetch;
	let requests: Array<Record<string, unknown>> = [];
	let savedOpenAI: typeof settings.openaiProviders;
	let restoreOverrides: () => void = () => {};

	beforeEach(() => {
		resetUnsupportedParameterMemory();
		requests = [];
		savedOpenAI = settings.openaiProviders;
		settings.openaiProviders = [...(savedOpenAI ?? []), { ...config }];
		// The entry's own override declares an output ceiling.
		restoreOverrides = replaceModelOverridesForTests({
			connections: { [model]: { maxOutputTokens: 2300 } },
		});

		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			const raw = init?.body;
			const body = typeof raw === "string" ? JSON.parse(raw) : {};
			requests.push(body);
			const sse =
				'data: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
				'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
			return new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		settings.openaiProviders = savedOpenAI;
		restoreOverrides();
	});

	test("codex chat omits max_output_tokens even when metadata declares a ceiling", async () => {
		const provider = new OpenAIProvider({ ...config });
		const events: ParsedStreamEvent[] = [];
		for await (const event of provider.chat({
			conversationId: "unsupported-parameter-chat",
			content: "hello",
			model,
			cwd: process.cwd(),
			history: [],
			tools: [],
			toolResults: [],
			signal: new AbortController().signal,
			maxOutputTokens: 2300,
		})) {
			events.push(event);
		}
		expect(events.map((event) => event.text ?? "").join("")).toBe("hi");
		expect(requests).toHaveLength(1);
		expect(requests[0]).not.toHaveProperty("max_output_tokens");
		expect(requests[0]).not.toHaveProperty("max_tokens");
		expect(modelRejectsParameter(model, "max_output_tokens")).toBe(false);
	});

	for (const [mode, baseUrl, target, field] of [
		["responses", config.baseUrl, model, "max_output_tokens"],
		["completions", "https://api.openai.com/v1", "unsup:opaque", "max_completion_tokens"],
		["completions", config.baseUrl, "unsup:legacy", "max_tokens"],
	] as const) {
		test(`${field}: chat and both utilities surface the rejection without learning to omit the cap`, async () => {
			const provider = new OpenAIProvider({ ...config, baseUrl, apiMode: mode });
			const message = `Unsupported parameter: ${field}`;
			globalThis.fetch = (async (_input, init) => {
				requests.push(JSON.parse(String(init?.body)));
				return Response.json({ error: { message, param: field } }, { status: 400 });
			}) as typeof fetch;
			const options = { maxOutputTokens: 57 };
			const chat = () =>
				provider
					.chat({
						conversationId: "cap",
						content: "hi",
						model: target,
						cwd: ".",
						history: [],
						tools: [],
						toolResults: [],
						signal: new AbortController().signal,
						...options,
					})
					.next();
			await expect(chat()).rejects.toThrow(message);
			await expect(provider.generateWithMeta("hi", target, undefined, options)).rejects.toThrow(
				message,
			);
			await expect(
				provider.generateWithHistoryWithMeta("system", "hi", target, "en", options),
			).rejects.toThrow(message);
			await expect(chat()).rejects.toThrow(message);
			expect(requests.map((body) => body[field])).toEqual([57, 57, 57, 57]);
			expect(modelRejectsParameter(target, field)).toBe(false);
		});
	}

	test("codex generateWithMeta omits max_output_tokens even when requested", async () => {
		const provider = new OpenAIProvider({ ...config });
		const result = await provider.generateWithMeta("hello", model, undefined, {
			maxOutputTokens: 2300,
		});
		expect(result.text).toBe("hi");
		expect(requests).toHaveLength(1);
		expect(requests[0]).not.toHaveProperty("max_output_tokens");
	});
});

describe("Completions prompt cache key fallback", () => {
	const completionsConfig = { ...config, apiMode: "completions" as const };
	const completionsModel = `${completionsConfig.prefix}:gpt-6-astra`;
	const originalFetch = globalThis.fetch;
	let requests: Array<Record<string, unknown>> = [];
	let savedOpenAI: typeof settings.openaiProviders;

	beforeEach(() => {
		resetUnsupportedParameterMemory();
		requests = [];
		savedOpenAI = settings.openaiProviders;
		settings.openaiProviders = [...(savedOpenAI ?? []), { ...completionsConfig }];
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push(body);
			if ("prompt_cache_key" in body)
				return new Response('{"detail":"Unsupported parameter: prompt_cache_key"}', {
					status: 400,
				});
			return new Response(
				'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		settings.openaiProviders = savedOpenAI;
	});

	const send = async (provider: OpenAIProvider) => {
		for await (const _event of provider.chat({
			conversationId: "unsupported-cache-key",
			content: "hello",
			model: completionsModel,
			cwd: process.cwd(),
			history: [],
			tools: [],
			toolResults: [],
			signal: new AbortController().signal,
		})) {
			/* drain */
		}
	};

	test("chat strips the rejected key, retries, and skips it afterwards", async () => {
		const provider = new OpenAIProvider({ ...completionsConfig });
		await send(provider);
		expect(requests).toHaveLength(2);
		expect(requests[0].prompt_cache_key).toBe("unsupported-cache-key");
		expect(requests[1]).not.toHaveProperty("prompt_cache_key");
		expect(modelRejectsParameter(completionsModel, "prompt_cache_key")).toBe(true);

		requests = [];
		await send(provider);
		expect(requests).toHaveLength(1);
		expect(requests[0]).not.toHaveProperty("prompt_cache_key");
	});
});
