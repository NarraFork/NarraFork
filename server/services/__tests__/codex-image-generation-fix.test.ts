/**
 * The one-click "turn off image generation" fix must write exactly one provider's
 * flag, in the right place, and never guess.
 *
 * The planner is pure, so these tests run against constructed settings snapshots
 * and never touch the real singleton or the settings file. What they lock down:
 *   - the caller passes a MODEL REFERENCE (`prefix:model`), not a settings path,
 *     so prefix extraction is part of the contract
 *   - the built-in Codex adapter and custom API providers use different keys
 *   - the derived `openaiProviders` mirror (what the provider factory reads) is
 *     re-derived, otherwise the flag would be persisted but ignored at runtime
 *   - a sibling provider sharing the settings array is left untouched
 *   - an unknown prefix or a non-Codex protocol fails loudly instead of writing
 *     a flag that could never take effect
 */

import { describe, expect, test } from "bun:test";
import { type NarraForkSettings, settings } from "../../lib/settings";
import {
	CodexImageGenerationFixError,
	planDisableCodexImageGeneration,
	providerPrefixFromModelRef,
} from "../codex-image-generation-fix";

/** A settings snapshot with the given custom API providers and no Codex override. */
function snapshot(
	providers: NarraForkSettings["customApiProviders"],
	codex?: NarraForkSettings["codex"],
): NarraForkSettings {
	const base = structuredClone(settings) as NarraForkSettings;
	base.customApiProviders = providers;
	base.openaiProviders = [];
	base.anthropicProviders = [];
	base.geminiProviders = [];
	base.codex = codex;
	return base;
}

function codexProvider(
	id: string,
	prefix: string,
	overrides: Partial<NonNullable<NarraForkSettings["customApiProviders"]>[number]> = {},
): NonNullable<NarraForkSettings["customApiProviders"]>[number] {
	return {
		id,
		name: `Provider ${prefix}`,
		prefix,
		apiKey: "test-key",
		baseUrl: "https://example.invalid/backend-api/codex",
		defaultModel: "gpt-5.6-sol",
		protocol: "codex-native",
		codexImageGeneration: true,
		...overrides,
	};
}

describe("providerPrefixFromModelRef", () => {
	test("takes the prefix from a full model reference", () => {
		expect(providerPrefixFromModelRef("codex:gpt-5.6-sol")).toBe("codex");
		expect(providerPrefixFromModelRef("myrelay:gpt-5.6-sol")).toBe("myrelay");
	});

	test("accepts a bare prefix and trims it", () => {
		expect(providerPrefixFromModelRef("  myrelay  ")).toBe("myrelay");
	});

	test("keeps only the FIRST segment so a channel-qualified model still resolves", () => {
		// NUG-style ids carry a channel: `nug:codex:gpt-5.6-sol`. The provider is the
		// first segment; splitting on the last colon would address nothing.
		expect(providerPrefixFromModelRef("nug:codex:gpt-5.6-sol")).toBe("nug");
	});
});

describe("planDisableCodexImageGeneration — built-in Codex adapter", () => {
	test("writes codex.useImageGeneration for the reserved `codex` prefix", () => {
		const current = snapshot([], { useImageGeneration: true });
		const { result, next } = planDisableCodexImageGeneration(current, "codex:gpt-5.6-sol");
		expect(result).toEqual({
			target: "builtin-codex",
			prefix: "codex",
			providerName: "Codex",
			changed: true,
		});
		expect(next?.codex?.useImageGeneration).toBe(false);
		// The planner must not mutate the snapshot it was handed.
		expect(current.codex?.useImageGeneration).toBe(true);
	});

	test("treats an absent flag as enabled (the runtime default)", () => {
		const { result, next } = planDisableCodexImageGeneration(snapshot([], {}), "codex");
		expect(result.changed).toBe(true);
		expect(next?.codex?.useImageGeneration).toBe(false);
	});

	test("is idempotent when already off — reports no change and persists nothing", () => {
		const { result, next } = planDisableCodexImageGeneration(
			snapshot([], { useImageGeneration: false }),
			"codex",
		);
		expect(result.changed).toBe(false);
		expect(next).toBeUndefined();
	});

	test("preserves other codex settings while flipping the flag", () => {
		const current = snapshot([], { useImageGeneration: true, useWebSearch: true });
		const { next } = planDisableCodexImageGeneration(current, "codex");
		expect(next?.codex?.useWebSearch).toBe(true);
		expect(next?.codex?.useImageGeneration).toBe(false);
	});
});

describe("planDisableCodexImageGeneration — custom API provider", () => {
	test("writes the provider's flag and re-derives the openaiProviders mirror", () => {
		// The mirror is what `createProviderByName` reads, so persisting only
		// customApiProviders would look correct in settings and change nothing at
		// runtime — the exact failure this assertion guards.
		const current = snapshot([codexProvider("p1", "myrelay")]);
		const { result, next } = planDisableCodexImageGeneration(current, "myrelay:gpt-5.6-sol");
		expect(result).toEqual({
			target: "custom-api-provider",
			prefix: "myrelay",
			providerName: "Provider myrelay",
			changed: true,
		});
		expect(next?.customApiProviders?.[0]?.codexImageGeneration).toBe(false);
		const mirrored = next?.openaiProviders?.find((p) => p.prefix === "myrelay");
		expect(mirrored?.codexImageGeneration).toBe(false);
		expect(mirrored?.apiMode).toBe("codex");
	});

	test("touches only the addressed provider", () => {
		const current = snapshot([codexProvider("p1", "relay-a"), codexProvider("p2", "relay-b")]);
		const { next } = planDisableCodexImageGeneration(current, "relay-b");
		const byPrefix = new Map(next?.customApiProviders?.map((p) => [p.prefix, p]) ?? []);
		expect(byPrefix.get("relay-b")?.codexImageGeneration).toBe(false);
		expect(byPrefix.get("relay-a")?.codexImageGeneration).toBe(true);
	});

	test("is idempotent when the provider already has it off", () => {
		const current = snapshot([codexProvider("p1", "myrelay", { codexImageGeneration: false })]);
		const { result, next } = planDisableCodexImageGeneration(current, "myrelay");
		expect(result.changed).toBe(false);
		expect(next).toBeUndefined();
	});

	test("also applies to the other OpenAI-family protocols", () => {
		// `responses-compatible` relays fronting a Codex upstream can refuse the tool
		// too; the flag is read by the same OpenAI provider adapter.
		const current = snapshot([
			codexProvider("p1", "myrelay", { protocol: "responses-compatible" }),
		]);
		const { result } = planDisableCodexImageGeneration(current, "myrelay");
		expect(result.changed).toBe(true);
	});

	test("falls back to the prefix when the provider has no display name", () => {
		const current = snapshot([codexProvider("p1", "myrelay", { name: "" })]);
		expect(planDisableCodexImageGeneration(current, "myrelay").result.providerName).toBe("myrelay");
	});

	test("derives providers from the legacy arrays when customApiProviders is absent", () => {
		// Settings written before the canonical array existed still have to be
		// fixable; derivation is the same path the settings PATCH uses.
		const base = structuredClone(settings) as NarraForkSettings;
		base.customApiProviders = undefined;
		base.anthropicProviders = [];
		base.geminiProviders = [];
		base.codex = undefined;
		base.openaiProviders = [
			{
				id: "p1",
				name: "Legacy Relay",
				prefix: "legacy",
				apiKey: "test-key",
				baseUrl: "https://example.invalid/backend-api/codex",
				defaultModel: "gpt-5.6-sol",
				apiMode: "codex",
				codexImageGeneration: true,
			},
		];
		const { result, next } = planDisableCodexImageGeneration(base, "legacy:gpt-5.6-sol");
		expect(result.changed).toBe(true);
		expect(next?.openaiProviders?.[0]?.codexImageGeneration).toBe(false);
	});
});

describe("planDisableCodexImageGeneration — refuses to guess", () => {
	test("rejects an unknown prefix", () => {
		const current = snapshot([codexProvider("p1", "myrelay")]);
		expect(() => planDisableCodexImageGeneration(current, "nope:some-model")).toThrow(
			CodexImageGenerationFixError,
		);
		try {
			planDisableCodexImageGeneration(current, "nope");
		} catch (err) {
			expect((err as CodexImageGenerationFixError).reason).toBe("unknown_provider");
		}
	});

	test("rejects an empty reference", () => {
		expect(() => planDisableCodexImageGeneration(snapshot([]), "   ")).toThrow(
			CodexImageGenerationFixError,
		);
	});

	test("rejects a provider whose protocol never sends Codex native tools", () => {
		// Writing codexImageGeneration on an Anthropic or Gemini provider would be a
		// silent no-op, so the user must be told the fix does not apply.
		for (const protocol of [
			"anthropic-compatible",
			"anthropic-official",
			"gemini-compatible",
		] as const) {
			const current = snapshot([codexProvider("p1", "other", { protocol })]);
			try {
				planDisableCodexImageGeneration(current, "other");
				throw new Error(`expected ${protocol} to be rejected`);
			} catch (err) {
				expect(err).toBeInstanceOf(CodexImageGenerationFixError);
				expect((err as CodexImageGenerationFixError).reason).toBe("unsupported_protocol");
			}
		}
	});
});
