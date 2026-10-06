import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GeminiProviderConfig } from "../../lib/settings/types";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-gemini-route-"));
process.env.NARRAFORK_HOME = testHome;
const { fetchGeminiModels, isUsableGeminiModel, resolveGeminiModelPrefix } = await import(
	"../gemini"
);

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

function provider(id: string, prefix: string): GeminiProviderConfig {
	return {
		id,
		name: prefix,
		prefix,
		apiKey: "test-key",
		baseUrl: "https://example.com/v1beta",
		defaultModel: "gemini-test",
	};
}

function modelsResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("Gemini model resolution", () => {
	test("filters models according to the configured transport", () => {
		const interactionOnly = {
			name: "models/gemini-3-flash-preview",
			supportedGenerationMethods: ["interact"],
		};
		expect(isUsableGeminiModel(interactionOnly)).toBe(false);
		expect(isUsableGeminiModel(interactionOnly, "interactions")).toBe(true);
		expect(
			isUsableGeminiModel({
				name: "models/gemini-2.5-flash",
				supportedGenerationMethods: ["generateContent"],
			}),
		).toBe(true);
		expect(isUsableGeminiModel({ name: "models/gemini-embedding-001" }, "interactions")).toBe(
			false,
		);
	});

	test("ignores caches tagged for a different transport and treats legacy arrays as generateContent", () => {
		const generateProvider = provider("generate", "gemini-generate");
		const interactionsProvider = {
			...provider("interactions", "gemini-interactions"),
			geminiTransport: "interactions" as const,
		};
		const cache = new Map([
			["generate", [{ id: "gemini-legacy-cache" }]],
			[
				"interactions",
				{ transport: "generate-content" as const, models: [{ id: "gemini-wrong-cache" }] },
			],
		]);
		expect(
			resolveGeminiModelPrefix(
				"gemini-legacy-cache",
				[generateProvider, interactionsProvider],
				cache,
			),
		).toBe("gemini-generate");
		expect(
			resolveGeminiModelPrefix(
				"gemini-wrong-cache",
				[generateProvider, interactionsProvider],
				cache,
			),
		).toBeUndefined();
	});

	test("returns the real provider prefix and honors providerOrder for duplicate models", () => {
		const providers = [provider("first", "gemini-a"), provider("second", "gemini-b")];
		const cache = new Map([
			["first", [{ id: "gemini-shared" }]],
			["second", [{ id: "gemini-shared" }]],
		]);

		expect(resolveGeminiModelPrefix("gemini-shared", providers, cache, ["gemini-b"])).toBe(
			"gemini-b",
		);
		expect(resolveGeminiModelPrefix("gemini-shared", providers, cache, [])).toBe("gemini-a");
	});
});

describe("Gemini model refresh bounds", () => {
	test("generateContent discovery keeps supported models and never requests /interactions", async () => {
		const urls: string[] = [];
		const models = await fetchGeminiModels(provider("generate-only", "gemini"), {
			fetcher: async (_config, url) => {
				urls.push(url);
				return modelsResponse({
					models: [
						{
							name: "models/gemini-generate-only",
							supportedGenerationMethods: ["generateContent"],
						},
						{
							name: "models/gemini-interactions-only",
							supportedGenerationMethods: ["interact"],
						},
					],
				});
			},
		});
		expect(models.map((model) => model.id)).toEqual(["gemini-generate-only"]);
		expect(urls).toHaveLength(1);
		expect(urls[0]).toContain("/models?");
		expect(urls[0]).not.toContain("/interactions");
	});
	test("rejects repeated pagination tokens", async () => {
		let calls = 0;
		await expect(
			fetchGeminiModels(provider("repeat", "gemini"), {
				fetcher: async () => {
					calls += 1;
					return modelsResponse({
						models: [],
						nextPageToken: "same-token",
					});
				},
			}),
		).rejects.toThrow("repeated page token");
		expect(calls).toBe(2);
	});

	test("rejects an oversized model page", async () => {
		const models = Array.from({ length: 1_001 }, (_, index) => ({
			name: `models/gemini-${index}`,
			supportedGenerationMethods: ["generateContent"],
		}));
		await expect(
			fetchGeminiModels(provider("large", "gemini"), {
				fetcher: async () => modelsResponse({ models }),
			}),
		).rejects.toThrow("more than 1000 models in one page");
	});

	test("bounds upstream error bodies", async () => {
		const oversizedError = `failure:${"x".repeat(20_000)}:secret-tail`;
		await expect(
			fetchGeminiModels(provider("error", "gemini"), {
				fetcher: async () => new Response(oversizedError, { status: 502 }),
			}),
		).rejects.not.toThrow("secret-tail");
	});

	test("propagates caller cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			fetchGeminiModels(provider("cancel", "gemini"), {
				signal: controller.signal,
				fetcher: async (_config, _url, init) => {
					if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
					return modelsResponse({ models: [] });
				},
			}),
		).rejects.toThrow("was cancelled");
	});
});
