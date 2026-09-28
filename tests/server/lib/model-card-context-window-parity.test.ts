import { describe, expect, test } from "bun:test";
import {
	getModelMaxCompletionTokens,
	resolveModelContextWindow,
	settings,
} from "../../../server/lib/settings";

/**
 * Parity baseline for the model-card migration.
 *
 * The context window used to come from a hardcoded table plus an unconditional
 * `startsWith` fuzzy match. That fuzzy match silently covered a large set of
 * ids the table never listed (`claude-opus-4-6-thinking`, dated snapshots, …).
 * Model cards match strictly by design — exact key, alias, date-suffix-stripped,
 * then only explicitly declared prefixes — so a naive port drops every one of
 * those ids to the default fallback.
 *
 * Nothing reports that. The model still answers; auto-compact just fires at the
 * wrong time (far too early for a 1M model, never for a sub-default one). So the
 * old table and the old lookup are duplicated verbatim below as an independent
 * oracle, and every id both implementations can see must agree.
 *
 * Copied from server/lib/settings/provider.ts as of the pre-migration revision.
 * It is deliberately a copy: asserting the new implementation against itself
 * proves nothing.
 */

interface LegacyModelContextConfig {
	contextLength: number;
	maxCompletionTokens?: number;
}

const LEGACY_BUILTIN_CONTEXT_WINDOWS: Record<string, number | LegacyModelContextConfig> = {
	// Builtin Codex models (GPT-5.5 and newer only)
	"gpt-6-astra": { contextLength: 1_050_000, maxCompletionTokens: 128_000 },
	"gpt-5.6-sol": { contextLength: 372_000, maxCompletionTokens: 128_000 },
	"gpt-5.6-terra": { contextLength: 372_000, maxCompletionTokens: 128_000 },
	"gpt-5.6-luna": { contextLength: 372_000, maxCompletionTokens: 128_000 },
	"gpt-5.5": { contextLength: 272_000, maxCompletionTokens: 128_000 },
	// Common third-party models
	"deepseek-chat": 64_000,
	"deepseek-reasoner": 64_000,
	// Claude 4.5 — the oldest generation still carried. These three windows are
	// asserted by the cards themselves now; before the pre-4.5 models were
	// dropped they were inherited from the `claude-sonnet-4` / `claude-opus-4`
	// base rows (and Haiku 4.5 had no base row at all, so it fell back to 128k).
	"claude-opus-4-5": 200_000,
	"claude-opus-4.5": 200_000,
	"claude-sonnet-4-5": 200_000,
	"claude-sonnet-4.5": 200_000,
	"claude-haiku-4-5": 200_000,
	"claude-haiku-4.5": 200_000,
	// Claude 4.6+ / 5 series and Fable/Mythos — 1M context.
	"claude-sonnet-4-6": 1_000_000,
	"claude-opus-4-6": 1_000_000,
	"claude-sonnet-4.6": 1_000_000,
	"claude-opus-4.6": 1_000_000,
	"claude-sonnet-4-7": 1_000_000,
	"claude-opus-4-7": 1_000_000,
	"claude-sonnet-4.7": 1_000_000,
	"claude-opus-4.7": 1_000_000,
	"claude-sonnet-4-8": 1_000_000,
	"claude-opus-4-8": 1_000_000,
	"claude-sonnet-4.8": 1_000_000,
	"claude-opus-4.8": 1_000_000,
	"claude-sonnet-5": 1_000_000,
	"claude-opus-5": 1_000_000,
	"claude-fable-5": 1_000_000,
	"claude-mythos-5": 1_000_000,
	"claude-mythos-preview": 1_000_000,
	// Google Gemini models — 3 series and newer.
	"gemini-3-pro-preview": { contextLength: 1_048_576, maxCompletionTokens: 65_536 },
	"gemini-3-flash-preview": { contextLength: 1_048_576, maxCompletionTokens: 65_536 },
};

/** Verbatim copy of the pre-migration `getBuiltinModelContextWindow`. */
function legacyBuiltinContextWindow(model: string): number | null {
	const bareModel = model;
	const candidateModels = [bareModel];
	const channelIdx = bareModel.indexOf(":");
	if (channelIdx > 0 && channelIdx < bareModel.length - 1) {
		candidateModels.push(bareModel.slice(channelIdx + 1));
	}

	for (const candidate of candidateModels) {
		const builtinConfig = LEGACY_BUILTIN_CONTEXT_WINDOWS[candidate];
		if (builtinConfig !== undefined) {
			return typeof builtinConfig === "number" ? builtinConfig : builtinConfig.contextLength;
		}
	}

	const sortedEntries = Object.entries(LEGACY_BUILTIN_CONTEXT_WINDOWS).sort(
		(a, b) => b[0].length - a[0].length,
	);
	for (const candidate of candidateModels) {
		const normalizedBare = candidate.toLowerCase();
		for (const [pattern, config] of sortedEntries) {
			if (normalizedBare.startsWith(pattern)) {
				return typeof config === "number" ? config : config.contextLength;
			}
		}
	}

	return null;
}

/**
 * Verbatim copy of the pre-migration `getModelMaxCompletionTokens`.
 *
 * Its fuzzy loop walks `Object.entries` in INSERTION order and only accepts
 * object-shaped rows — unlike the window lookup above, which sorts by pattern
 * length descending. The asymmetry is load-bearing for ids like
 * `gpt-5.1-codex-max-2026-01-01`, so it is reproduced rather than tidied.
 */
function legacyMaxCompletionTokens(model: string): number | null {
	const bareModel = model;

	const builtinConfig = LEGACY_BUILTIN_CONTEXT_WINDOWS[bareModel];
	if (builtinConfig !== undefined) {
		if (typeof builtinConfig === "object") {
			return builtinConfig.maxCompletionTokens ?? null;
		}
		return null;
	}

	const normalizedBare = bareModel.toLowerCase();
	for (const [pattern, config] of Object.entries(LEGACY_BUILTIN_CONTEXT_WINDOWS)) {
		if (normalizedBare.startsWith(pattern) && typeof config === "object") {
			return config.maxCompletionTokens ?? null;
		}
	}

	return null;
}

/**
 * Ids the table never lists but the fuzzy match used to resolve. Each one is a
 * real shape: `-thinking` is how Antigravity names its Claude models, the dated
 * forms are vendor snapshot ids, `-latest` is an alias channel.
 */
const FUZZY_MATCHED_IDS = [
	"claude-opus-4-6-thinking",
	"claude-sonnet-4-6-thinking",
	"claude-opus-4-8-thinking",
	"claude-sonnet-4.6-thinking",
	"claude-opus-4-5-thinking",
	"claude-haiku-4-5-thinking",
	"gpt-6-astra-2026-09-03",
	"gpt-5.6-sol-20260101",
	"claude-sonnet-4-5-20260101",
	"deepseek-chat-latest",
	"deepseek-reasoner-preview",
	"gemini-3-pro-preview-latest",
	"claude-mythos-preview-20260101",
];

const ALL_PROBE_IDS = [...Object.keys(LEGACY_BUILTIN_CONTEXT_WINDOWS), ...FUZZY_MATCHED_IDS];

/**
 * The probe runs with an empty user-override map so the card layer is the only
 * thing under test. `modelContextWindows` would otherwise win outright and mask
 * a regression in the layer below it.
 */
function withoutUserOverrides<T>(fn: () => T): T {
	const original = settings.agent.modelContextWindows;
	settings.agent.modelContextWindows = {};
	try {
		return fn();
	} finally {
		settings.agent.modelContextWindows = original;
	}
}

describe("model card context-window parity with the legacy builtin table", () => {
	test("every table key resolves to the same window as before", () => {
		withoutUserOverrides(() => {
			const mismatches: string[] = [];
			for (const model of Object.keys(LEGACY_BUILTIN_CONTEXT_WINDOWS)) {
				const expected = legacyBuiltinContextWindow(model);
				const actual = resolveModelContextWindow(model, "").contextWindow;
				if (expected !== actual) {
					mismatches.push(`${model}: expected ${expected}, got ${actual}`);
				}
			}
			expect(mismatches).toEqual([]);
		});
	});

	test("ids that only the fuzzy match used to cover still resolve identically", () => {
		withoutUserOverrides(() => {
			const mismatches: string[] = [];
			for (const model of FUZZY_MATCHED_IDS) {
				const expected = legacyBuiltinContextWindow(model);
				// A guard on the oracle itself: if the legacy lookup returns null for
				// one of these, the id no longer probes what it was added to probe.
				expect(expected).not.toBeNull();
				const actual = resolveModelContextWindow(model, "").contextWindow;
				if (expected !== actual) {
					mismatches.push(`${model}: expected ${expected}, got ${actual}`);
				}
			}
			expect(mismatches).toEqual([]);
		});
	});

	test("maxCompletionTokens matches the legacy lookup for every probe id", () => {
		withoutUserOverrides(() => {
			const mismatches: string[] = [];
			for (const model of ALL_PROBE_IDS) {
				const expected = legacyMaxCompletionTokens(model);
				const actual = getModelMaxCompletionTokens(model, "");
				if (expected !== actual) {
					mismatches.push(`${model}: expected ${expected}, got ${actual}`);
				}
			}
			expect(mismatches).toEqual([]);
		});
	});

	test("the 4.6+ 1M rows and the 4.5 200k rows do not bleed into each other", () => {
		withoutUserOverrides(() => {
			expect(resolveModelContextWindow("claude-opus-4-8", "").contextWindow).toBe(1_000_000);
			expect(resolveModelContextWindow("claude-sonnet-4-8", "").contextWindow).toBe(1_000_000);
			// 4.5 is the oldest generation kept, and it is genuinely 200k. It used to
			// inherit that from a `claude-opus-4` base row; now it states it itself.
			expect(resolveModelContextWindow("claude-opus-4-5", "").contextWindow).toBe(200_000);
			expect(resolveModelContextWindow("claude-sonnet-4-5", "").contextWindow).toBe(200_000);
			expect(resolveModelContextWindow("claude-haiku-4-5", "").contextWindow).toBe(200_000);
		});
	});

	test("models older than the retained generations resolve to the fallback", () => {
		withoutUserOverrides(() => {
			// Claude pre-4.5, Gemini pre-3 and GPT pre-5 were removed outright, so
			// they must land on the generic default rather than a stale card.
			for (const retired of [
				"gpt-4o",
				"gpt-4",
				"gpt-3.5-turbo",
				"gpt-5-codex",
				"gpt-5.1-codex",
				"gpt-5.2-codex",
				"gpt-5.3-codex",
				"gpt-5.4",
				"gpt-5.4-mini",
				"o1",
				"o1-mini",
				"o3-mini",
				"claude-3-5-sonnet",
				"claude-3-opus",
				"claude-3-7-sonnet",
				"claude-sonnet-4-20250514",
				"gemini-2.5-pro",
				"gemini-2.0-flash",
				"gemini-1.5-pro",
			]) {
				const resolved = resolveModelContextWindow(retired, "");
				expect(resolved.source).toBe("fallback");
				expect(resolved.contextWindow).toBe(272_000);
			}
		});
	});

	test("Astra retains its 1.05M window for dated snapshots", () => {
		withoutUserOverrides(() => {
			expect(resolveModelContextWindow("gpt-6-astra", "").contextWindow).toBe(1_050_000);
			expect(resolveModelContextWindow("gpt-6-astra-2026-09-03", "").contextWindow).toBe(1_050_000);
		});
	});
});
