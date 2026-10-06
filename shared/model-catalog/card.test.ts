import { describe, expect, test } from "bun:test";
import {
	decimalValue,
	modelCardView,
	multiplyDecimal,
	patchRawMetadata,
	rawCatalogFromModelFiles,
	validateRawMetadata,
	type RawMetadata,
} from "./card";

const samples: Record<string, RawMetadata> = {
	"gpt-5.6-terra": {
		mode: "responses",
		litellm_provider: "openai",
		max_input_tokens: 1050000,
		max_output_tokens: 128000,
		input_cost_per_token: 2e-6,
		output_cost_per_token: 12e-6,
		cache_read_input_token_cost: 0.2e-6,
		cache_creation_input_token_cost: 2.5e-6,
		input_cost_per_token_batches: 1e-6,
		input_cost_per_token_flex: 1e-6,
		input_cost_per_token_priority: 4e-6,
		long_context_input_token_threshold: 272000,
		long_context_input_cost_multiplier: 2,
		long_context_output_cost_multiplier: 1.5,
		supports_none_reasoning_effort: true,
	},
	"claude-opus-4-6": {
		mode: "chat",
		max_input_tokens: 1000000,
		max_output_tokens: 128000,
		cache_creation_input_token_cost: 6.25e-6,
		cache_creation_input_token_cost_above_1hr: 10e-6,
		supports_adaptive_thinking: true,
		supports_vision: true,
	},
	"gemini-2.5-flash": {
		mode: "chat",
		supported_modalities: ["text", "image", "audio", "video"],
		input_cost_per_token: 0.3e-6,
		input_cost_per_audio_token: 1e-6,
		max_audio_length_hours: 8.4,
		max_video_length: 1,
		search_context_cost_per_query: { search_context_size_low: 0.035 },
	},
	"gpt-image-2": {
		mode: "image_generation",
		output_cost_per_image_token: 32e-6,
		output_cost_per_image: 0.04,
		supported_output_modalities: ["image"],
	},
	"gemini-embedding-2": {
		mode: "embedding",
		output_vector_size: 3072,
		input_cost_per_token: 0.2e-6,
	},
	"gpt-5-pro": { mode: "responses", max_input_tokens: 128000, max_output_tokens: 272000 },
};
const files = () =>
	new Map(
		Object.entries(samples).map(([id, metadata]) => [
			`${id}.json`,
			JSON.stringify({ id, metadata, variants: [] }),
		]),
	);

describe("complete model cards v2", () => {
	test("keeps all six source records, unknown fields, original units and source identity", () => {
		const source = files();
		source.set(
			"future.json",
			JSON.stringify({
				id: "future",
				metadata: { future: { values: [0, null, false, []], unknown: "unchanged" } },
				variants: [
					{
						id: "future@channel",
						providerKey: "channel",
						upstreamModelIds: ["up"],
						metadata: { supports_vision: false },
					},
				],
			}),
		);
		const catalog = rawCatalogFromModelFiles(source, "sha-source", "2026-09-22T00:00:00Z");
		expect(catalog.schemaVersion).toBe(2);
		expect(catalog.catalogVersion).toBe("v2:sha-source");
		expect(catalog.sourceVersion).toBe("sha-source");
		for (const [id, metadata] of Object.entries(samples))
			expect(catalog.models.find((entry) => entry.id === id)!.metadata).toEqual(metadata);
		expect(catalog.variants[0]!.modelId).toBe("future");
		expect(catalog.models.find((entry) => entry.id === "future")!.metadata.future).toEqual({
			values: [0, null, false, []],
			unknown: "unchanged",
		});
	});
	test("separates input/output/total context/client budget instead of discarding valid input limits", () => {
		const view = modelCardView({ ...samples["gpt-5-pro"]!, working_context_tokens: 32000 });
		expect(view.limits).toEqual({
			maxInputTokens: 128000,
			maxOutputTokens: 272000,
			workingContextTokens: 32000,
		});
		expect(view.limits.totalContextTokens).toBeUndefined();
		expect(() =>
			validateRawMetadata({ context_window: 128000, max_output_tokens: 272000 }),
		).toThrow();
	});
	test("shows every service tier and derives exact long-context prices without crossing tiers", () => {
		const view = modelCardView(samples["gpt-5.6-terra"]!);
		expect(view.category).toBe("text");
		expect(view.prices.map((group) => group.tier)).toEqual([
			"standard",
			"batch",
			"flex",
			"priority",
		]);
		const standard = view.prices[0]!.rows;
		expect(standard.find((row) => row.key === "input_cost_per_token")?.displayRate).toBe("2");
		expect(standard.find((row) => row.derived && row.component === "cacheWrite")?.displayRate).toBe(
			"5",
		);
		expect(view.prices[3]!.rows.find((row) => row.derived)?.displayRate).toBe("8");
	});
	test("keeps cache durations, multimodal rates, counts, seconds and characters distinct", () => {
		const claude = modelCardView(samples["claude-opus-4-6"]!).prices[0]!.rows;
		expect(claude.find((row) => row.cacheDuration === "1h")?.displayRate).toBe("10");
		expect(claude.find((row) => row.cacheDuration === "default")?.displayRate).toBe("6.25");
		const gemini = modelCardView(samples["gemini-2.5-flash"]!);
		expect(gemini.attributes.max_video_length).toBe(1);
		expect(
			gemini.prices[0]!.rows.some((row) => row.modality === "audio" && row.displayRate === "1"),
		).toBe(true);
		expect(
			gemini.prices[0]!.rows.some((row) => row.unit === "request" && row.displayRate === "0.035"),
		).toBe(true);
		const image = modelCardView(samples["gpt-image-2"]!);
		expect(image.category).toBe("image");
		expect(image.prices[0]!.rows.find((row) => row.unit === "image")?.displayRate).toBe("0.04");
		expect(modelCardView(samples["gemini-embedding-2"]!).category).toBe("embedding");
	});
	test("preserves unknown siblings while setting, clearing and restoring a known field", () => {
		const original: RawMetadata = {
			supports_vision: true,
			future: { nested: [false, null, 0] },
			input_cost_per_token: 5e-6,
		};
		const edited = patchRawMetadata(original, {
			set: {
				input_cost_per_token: "0",
				supports_vision: false,
				supported_modalities: [],
				output_cost_per_token: null,
			},
		});
		expect(edited.future).toEqual(original.future);
		expect(edited.input_cost_per_token).toBe("0");
		expect(edited.supported_modalities).toEqual([]);
		expect(edited.output_cost_per_token).toBeNull();
		expect(patchRawMetadata(edited, { reset: ["input_cost_per_token"] })).not.toHaveProperty(
			"input_cost_per_token",
		);
		expect(original.input_cost_per_token).toBe(5e-6);
		expect(() => patchRawMetadata(original, { set: { "future.nested": [] } })).toThrow();
		expect(() => patchRawMetadata(original, { set: { "__proto__.polluted": true } })).toThrow();
		expect(() => validateRawMetadata(JSON.parse('{"x":{"constructor":{}}}'))).toThrow();
	});
	test("uses decimal arithmetic and respects absolute tiers and explicit free multipliers", () => {
		expect(decimalValue("1e-30", 6)).toBe("0.000000000000000000000001");
		expect(multiplyDecimal("0.00003", "1.5")).toBe("0.000045");
		const view = modelCardView({
			input_cost_per_token: 2e-6,
			input_cost_per_token_above_200k_tokens: 3e-6,
			input_cost_per_token_above_272k_tokens: 4e-6,
			long_context_input_token_threshold: 200000,
			long_context_input_cost_multiplier: 0,
		});
		expect(view.prices[0]!.rows).toHaveLength(3);
		expect(view.prices[0]!.rows.find((row) => row.thresholdTokens === 200000)?.displayRate).toBe(
			"3",
		);
		const free = modelCardView({
			input_cost_per_token: 2e-6,
			long_context_input_token_threshold: 200000,
			long_context_input_cost_multiplier: 0,
		});
		expect(free.prices[0]!.rows.find((row) => row.derived)?.rate).toBe("0");
	});
});
