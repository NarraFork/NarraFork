import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
	catalogFromArchive,
	MAX_CATALOG_BYTES,
	parseCatalogRevision,
} from "../../../server/lib/model-catalog/source";
import {
	type CatalogQuery,
	modelProfile,
	type RawMetadata,
	rawCatalogFromModelFiles,
	resolveModelCard,
} from "../../../shared/model-catalog";

const date = "2026-01-01T00:00:00Z";
const version = "a".repeat(40);
function model() {
	return {
		id: "m",
		name: "M",
		status: "unverified",
		metadata: {
			max_input_tokens: 2000,
			input_cost_per_token: 5e-6,
			output_cost_per_token: 1e-5,
			supported_modalities: ["text", "image"],
			supports_web_search: true,
			reasoning_effort_levels: ["low", "high"],
		} as RawMetadata,
		variants: [
			{
				id: "m@one",
				providerKey: "one",
				upstreamModelIds: ["up"],
				metadata: {
					input_cost_per_token: 0,
					output_cost_per_token: null,
					supports_web_search: false,
					supported_modalities: [],
					reasoning_effort_levels: [],
				},
			},
			{ id: "m@two", providerKey: "two", upstreamModelIds: ["up"], metadata: {} },
		],
	};
}
function read(value: unknown, filename = "m.json") {
	return rawCatalogFromModelFiles(new Map([[filename, JSON.stringify(value)]]), version, date);
}
const resolveProfile = (catalog: ReturnType<typeof read>, query: CatalogQuery) =>
	modelProfile(resolveModelCard({ catalog, query }));

describe("data-only model directory adapter", () => {
	test("nested variants inherit defaults and retain explicit zero, null, false and empty arrays", () => {
		const catalog = read(model());
		expect(catalog.models).toHaveLength(1);
		expect(catalog.variants).toHaveLength(2);
		expect(catalog.variants.every((variant) => variant.modelId === "m")).toBe(true);
		const profile = resolveProfile(catalog, { upstreamModelId: "up", providerKey: "one" });
		expect(profile.contextWindow).toBe(2000);
		expect(profile.referencePricing).toMatchObject({ input: "0", output: null });
		expect(profile.nativeSearch).toBe(false);
		expect(profile.inputModalities).toEqual([]);
		expect(profile.reasoning.levels).toEqual([]);
	});
	test("changing one default propagates to every inheriting channel, without altering channel overrides", () => {
		const value = model();
		value.metadata.input_cost_per_token = 7e-6;
		const catalog = read(value);
		for (const [providerKey, price] of [
			["one", "0"],
			["two", "7"],
		]) {
			expect(
				resolveProfile(catalog, { upstreamModelId: "up", providerKey }).referencePricing?.input,
			).toBe(price);
		}
	});
	test("rejects source arrays, mismatched filenames, cross-file parents and operational pricing", () => {
		expect(() => read([model()])).toThrow();
		expect(() => read(model(), "other.json")).toThrow();
		expect(() =>
			read({ ...model(), variants: [{ ...model().variants[0], modelId: "other" }] }),
		).toThrow();
		expect(() => read({ ...model(), metadata: { billingMultiplier: 2 } })).toThrow();
		expect(() => read({ ...model(), variants: null })).toThrow();
	});
	test("rejects duplicate variant identities across model files", () => {
		const files = new Map([
			["m.json", JSON.stringify(model())],
			["other.json", JSON.stringify({ ...model(), id: "other" })],
		]);
		expect(() => rawCatalogFromModelFiles(files, version, date)).toThrow();
	});
	test("reads repository models only, without needing a manifest or build artifact", async () => {
		const bytes = await new Bun.Archive(
			{ "repo/models/m.json": JSON.stringify(model()), "repo/package.json": "not model data" },
			{ compress: "gzip" },
		).bytes();
		expect(await catalogFromArchive(bytes, version, date)).toEqual(read(model()));
	});
	test("rejects empty, corrupt and over-expanded archives", async () => {
		await expect(catalogFromArchive(new Uint8Array([1, 2]), version, date)).rejects.toThrow();
		const empty = await new Bun.Archive(
			{ "repo/README": "no models" },
			{ compress: "gzip" },
		).bytes();
		await expect(catalogFromArchive(empty, version, date)).rejects.toThrow();
		await expect(
			catalogFromArchive(gzipSync(Buffer.alloc(MAX_CATALOG_BYTES + 1)), version, date),
		).rejects.toThrow();
	});
	test("pins the branch head SHA and rejects malformed revisions", () => {
		const revision = (sha: unknown, publishedAt: unknown) => ({
			name: "main",
			commit: { sha, commit: { committer: { date: publishedAt } } },
		});
		expect(parseCatalogRevision(revision(version, date))).toEqual({
			version,
			publishedAt: date,
		});
		for (const value of [
			null,
			{},
			[],
			"main",
			{ commit: null },
			{ commit: { sha: version } },
			{ commit: { sha: version, commit: {} } },
			{ sha: version, commit: { committer: { date } } },
			revision("../../evil", date),
			revision("a".repeat(39), date),
			revision("A".repeat(40), date),
			revision(123, date),
			revision(version, "invalid"),
			revision(version, "2026-01-01"),
			revision(version, "2026-13-01T00:00:00Z"),
			revision(version, null),
		]) {
			expect(() => parseCatalogRevision(value)).toThrow("Invalid catalog Git revision");
		}
	});
});

test("resolution applies a model-wide override and hands out cards callers may mutate", () => {
	const catalog = read(model());
	const modelOverrides = new Map([["m", { contextWindow: 3000 }]]);
	const query = { upstreamModelId: "m" };
	const first = resolveModelCard({ catalog, query, modelOverrides });
	expect(first.metadata.working_context_tokens).toBe(3000);
	expect(first.provenance.working_context_tokens).toMatchObject({ layer: "local-model", id: "m" });
	expect(modelProfile(first).contextWindow).toBe(3000);
	(first.metadata.supported_modalities as string[]).push("audio");
	const second = resolveModelCard({ catalog, query, modelOverrides });
	expect(second.metadata.supported_modalities).toEqual(["text", "image"]);
	expect(catalog.models[0]?.metadata.supported_modalities).toEqual(["text", "image"]);
	// Without the override the catalog value is what remains.
	expect(modelProfile(resolveModelCard({ catalog, query })).contextWindow).toBe(2000);
});

describe("sub2api source rows", () => {
	test("converts source units locally and keeps standard, priority and long-context prices separate", () => {
		const catalog = read({
			id: "m",
			metadata: {
				litellm_provider: "openai",
				mode: "chat",
				max_input_tokens: 1050000,
				max_output_tokens: 128000,
				input_cost_per_token: 2e-6,
				output_cost_per_token: 1.2e-5,
				cache_read_input_token_cost: 2e-7,
				cache_creation_input_token_cost: 2.5e-6,
				input_cost_per_token_priority: 4e-6,
				long_context_input_token_threshold: 272000,
				long_context_input_cost_multiplier: 2,
				long_context_output_cost_multiplier: 1.5,
				supported_modalities: ["text", "image"],
				supported_output_modalities: ["text"],
				supports_reasoning: true,
				supports_none_reasoning_effort: true,
				supports_web_search: true,
			},
			variants: [
				{
					id: "m@codex",
					providerKey: "codex",
					upstreamModelIds: ["m"],
					metadata: { max_input_tokens: 272000 },
				},
			],
		});
		const profile = modelProfile(catalog.models[0]!);
		expect(profile.contextWindow).toBe(1050000);
		expect(profile.maxOutputTokens).toBe(128000);
		expect(profile.referencePricing).toEqual({
			currency: "USD",
			unit: "perMillionTokens",
			input: "2",
			output: "12",
			cacheRead: "0.2",
			cacheWrite: "2.5",
			longContext: {
				thresholdTokens: 272000,
				basis: "promptTokens",
				mode: "full",
				input: "4",
				output: "18",
				cacheRead: "0.4",
				cacheWrite: "5",
			},
		});
		expect(profile.inputModalities).toEqual(["text", "image"]);
		expect(profile.outputModalities).toEqual(["text"]);
		expect(profile.reasoning).toEqual({ supported: true, canDisable: true });
		expect(profile.nativeSearch).toBe(true);
		expect(
			resolveProfile(catalog, { upstreamModelId: "m", providerKey: "codex" }).contextWindow,
		).toBe(272000);
	});
	test("preserves explicit zero, unknown, false, empty arrays and absolute cache tiers", () => {
		const profile = modelProfile(
			read({
				id: "m",
				metadata: {
					litellm_provider: "openai",
					input_cost_per_token: 0,
					output_cost_per_token: null,
					cache_read_input_token_cost: 3e-7,
					cache_read_input_token_cost_above_200k_tokens: 4.5e-7,
					input_cost_per_token_above_200k_tokens: 0,
					supports_web_search: false,
					supported_modalities: [],
					supported_output_modalities: [],
				},
				variants: [],
			}).models[0]!,
		);
		expect(profile.referencePricing?.input).toBe("0");
		expect(profile.referencePricing?.output).toBeNull();
		expect(profile.referencePricing?.longContext?.cacheRead).toBe("0.45");
		expect(profile.nativeSearch).toBe(false);
		expect(profile.inputModalities).toEqual([]);
		expect(profile.outputModalities).toEqual([]);
	});
	test("does not confuse separate input and output caps with a total context limit", () => {
		const profile = modelProfile(
			read({
				id: "m",
				metadata: {
					litellm_provider: "openai",
					max_input_tokens: 128000,
					max_output_tokens: 272000,
				},
				variants: [],
			}).models[0]!,
		);
		expect(profile.contextWindow).toBeUndefined();
		expect(profile.maxOutputTokens).toBe(272000);
	});
});
