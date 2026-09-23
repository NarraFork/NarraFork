/**
 * NUG's Responses-compatible gateway rejects `max_output_tokens` with a FastAPI
 * envelope (`{"detail":"Unsupported parameter: max_output_tokens"}`). Without a
 * strip-and-retry the whole turn dies even though the model is fine.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
		const body: Record<string, unknown> = { model: "m", max_output_tokens: 2300, store: false };
		expect(stripUnsupportedParameter(body, "p:m", new ApiError(400, NUG_DETAIL_MESSAGE))).toBe(
			true,
		);
		expect(body).toEqual({ model: "m", store: false });
		expect(modelRejectsParameter("p:m", "max_output_tokens")).toBe(true);
		expect(modelRejectsParameter("p:m", "store")).toBe(false);
	});

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
			{ max_output_tokens: 10 },
			async (body) => {
				seen.push({ ...body });
				if ("max_output_tokens" in body) throw new ApiError(400, NUG_DETAIL_MESSAGE);
				return "ok";
			},
		);
		expect(result).toBe("ok");
		expect(seen).toHaveLength(2);
		expect(seen[0]).toHaveProperty("max_output_tokens");
		expect(seen[1]).not.toHaveProperty("max_output_tokens");
		expect(modelRejectsParameter("p:m", "max_output_tokens")).toBe(true);
	});

	test("skips the doomed first attempt once the model is known", async () => {
		const body = { max_output_tokens: 10 };
		await withUnsupportedParameterFallback("p:m", body, (b) => {
			if ("max_output_tokens" in b) throw new ApiError(400, NUG_DETAIL_MESSAGE);
			return Promise.resolve("ok");
		});

		const seen: Array<Record<string, unknown>> = [];
		const second = await withUnsupportedParameterFallback("p:m", { max_output_tokens: 99 }, (b) => {
			seen.push({ ...b });
			return Promise.resolve("ok");
		});
		expect(second).toBe("ok");
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toHaveProperty("max_output_tokens");
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
			withUnsupportedParameterFallback("p:m", { max_output_tokens: 1 }, async (body) => {
				if ("max_output_tokens" in body) throw new ApiError(400, NUG_DETAIL_MESSAGE);
				throw new ApiError(500, "upstream exploded");
			}),
		).rejects.toThrow("upstream exploded");
	});
});

describe("OpenAI request paths", () => {
	const originalFetch = globalThis.fetch;
	let requests: Array<Record<string, unknown>> = [];
	let savedOpenAI: typeof settings.openaiProviders;
	let savedCatalog: typeof settings.agent.modelCatalog;

	beforeEach(() => {
		resetUnsupportedParameterMemory();
		requests = [];
		savedOpenAI = settings.openaiProviders;
		savedCatalog = settings.agent.modelCatalog;
		settings.openaiProviders = [...(savedOpenAI ?? []), { ...config }];
		settings.agent.modelCatalog = {
			schemaVersion: 1,
			migrationVersion: 1,
			autoApply: false,
			pinnedVersion: null,
			local: {
				revision: 1,
				models: [{ id: "card", metadata: {} }],
				bindings: [
					{
						id: "b",
						providerId: config.id,
						upstreamModelId: "gpt-6-astra",
						modelId: "card",
						overrides: { limits: { maxOutputTokens: 2300 } },
					},
				],
			},
		};

		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			const raw = init?.body;
			const body = typeof raw === "string" ? JSON.parse(raw) : {};
			requests.push(body);
			if ("max_output_tokens" in body) {
				return new Response(
					JSON.stringify({ detail: "Unsupported parameter: max_output_tokens" }),
					{
						status: 400,
						headers: { "content-type": "application/json" },
					},
				);
			}
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
		settings.agent.modelCatalog = savedCatalog;
	});

	for (const partialOutput of [false, true]) {
		test(`chat HTTP 200 SSE rejection ${partialOutput ? "does not retry after output" : "strips and retries before output"}`, async () => {
			globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
				const body = JSON.parse(init?.body as string);
				requests.push(body);
				const delta = 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n';
				const rejection = `data: ${JSON.stringify({
					type: "error",
					code: "unsupported_parameter",
					message: NUG_DETAIL_MESSAGE,
				})}\n\n`;
				const sse =
					requests.length === 1
						? (partialOutput ? delta : "") + rejection
						: `${delta}data: {"type":"response.completed","response":{"status":"completed"}}\n\n`;
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}) as typeof fetch;
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
			expect(requests).toHaveLength(partialOutput ? 1 : 2);
			expect(requests[0].max_output_tokens).toBe(2300);
			if (partialOutput) {
				expect(events.at(-1)?.invalidState?.message).toContain(NUG_DETAIL_MESSAGE);
				expect(modelRejectsParameter(model, "max_output_tokens")).toBe(false);
			} else {
				expect(requests[1]).not.toHaveProperty("max_output_tokens");
				expect(events.some((event) => event.invalidState)).toBe(false);
				expect(modelRejectsParameter(model, "max_output_tokens")).toBe(true);
			}
		});
	}

	test("generateWithMeta strips max_output_tokens after the NUG 400 and succeeds", async () => {
		const provider = new OpenAIProvider({ ...config });
		const result = await provider.generateWithMeta("hello", model, undefined, {
			maxOutputTokens: 2300,
		});
		expect(result.text).toBe("hi");
		expect(requests.length).toBe(2);
		expect(requests[0].max_output_tokens).toBe(2300);
		expect(requests[1].max_output_tokens).toBeUndefined();
	});
});
