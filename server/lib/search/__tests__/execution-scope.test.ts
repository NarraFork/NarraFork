import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { isRuntimeToolAllowed, resolveRuntimePolicy } from "../../../services/agent-runtime/policy";
import { webSearchTool } from "../../agent/tools/web-search";
import type { ToolContext } from "../../agent/types";
import { settings } from "../../settings";
import {
	consumeSearchExecutionTurn,
	getSearchExecutionScope,
	matchesSearchExecutionScope,
	SearchExecutionBudgetExceededError,
	withSearchExecutionScope,
} from "../execution-scope";
import { isNativeSearchChannelFirstEnabled, shouldUseNativeSearch } from "../native";
import * as router from "../router";

const options = { provider: "scope_official", model: "claude-opus-5", maxTurns: 2 };
let savedProviders: typeof settings.anthropicProviders;
let savedSearch: typeof settings.search;
beforeEach(() => {
	savedProviders = settings.anthropicProviders;
	savedSearch = settings.search;
	settings.anthropicProviders = [
		{
			id: "scope",
			name: "scope",
			prefix: options.provider,
			apiKey: "test",
			baseUrl: "https://example.invalid",
			defaultModel: options.model,
			officialApi: true,
		},
	];
	settings.search = {
		...settings.search,
		customProviders: settings.search?.customProviders ?? [],
		channels: [{ id: "native", kind: "native", enabled: false }],
	};
});
afterEach(() => {
	settings.anthropicProviders = savedProviders;
	settings.search = savedSearch;
});

describe("search execution scope", () => {
	test("restores parent state, isolates concurrent and nested budgets", async () => {
		await Promise.all(
			[1, 2].map((maxTurns) =>
				withSearchExecutionScope({ ...options, maxTurns }, async () => {
					await Promise.resolve();
					const scope = getSearchExecutionScope();
					expect(scope?.remainingTurns).toBe(maxTurns);
					consumeSearchExecutionTurn();
					withSearchExecutionScope({ ...options, maxTurns: 5 }, () => {
						consumeSearchExecutionTurn();
						expect(getSearchExecutionScope()?.remainingTurns).toBe(4);
					});
					expect(getSearchExecutionScope()).toBe(scope);
					expect(scope?.remainingTurns).toBe(maxTurns - 1);
				}),
			),
		);
		expect(getSearchExecutionScope()).toBeUndefined();
	});

	test("throws on exhausted budgets and restores scope after failure", () => {
		expect(() =>
			withSearchExecutionScope({ ...options, maxTurns: 1 }, () => {
				consumeSearchExecutionTurn();
				consumeSearchExecutionTurn();
			}),
		).toThrow(SearchExecutionBudgetExceededError);
		expect(getSearchExecutionScope()).toBeUndefined();
		expect(() => withSearchExecutionScope({ ...options, maxTurns: 0 }, () => {})).toThrow();
	});

	test("native ordering override matches only the selected model and respects optout", () => {
		expect(isNativeSearchChannelFirstEnabled()).toBe(false);
		withSearchExecutionScope(options, () => {
			expect(
				matchesSearchExecutionScope(options.provider, `${options.provider}:${options.model}`),
			).toBe(true);
			expect(isNativeSearchChannelFirstEnabled()).toBe(true);
			expect(isNativeSearchChannelFirstEnabled(undefined, options.provider, "different")).toBe(
				false,
			);
			expect(isNativeSearchChannelFirstEnabled(undefined, "different", options.model)).toBe(false);
			expect(shouldUseNativeSearch(options.provider, options.model)).toBe(false);
			expect(webSearchTool.isAvailable?.()).toBe(true);
			const selected = settings.anthropicProviders?.[0];
			if (!selected) throw new Error("Missing test provider");
			selected.nativeSearch = false;
			expect(isNativeSearchChannelFirstEnabled()).toBe(false);
			expect(webSearchTool.isAvailable?.()).toBe(false);
		});
	});

	test("inline native scope hides function search and respects provider optout", () => {
		const savedCodex = settings.codex;
		try {
			settings.codex = { ...settings.codex, useWebSearch: true };
			withSearchExecutionScope({ provider: "codex", model: "gpt-5.4", maxTurns: 1 }, () => {
				expect(shouldUseNativeSearch("codex", "gpt-5.4")).toBe(true);
				expect(webSearchTool.isAvailable?.()).toBe(false);
				settings.codex = { ...settings.codex, useWebSearch: false };
				expect(shouldUseNativeSearch("codex", "gpt-5.4")).toBe(false);
			});
		} finally {
			settings.codex = savedCodex;
		}
	});

	test("search runtime allows WebSearch but fails closed outside a supported native provider", async () => {
		const runtimePolicy = resolveRuntimePolicy({ variant: "subagent", subagentType: "search" });
		expect(runtimePolicy.searchOnly).toBe(true);
		expect(isRuntimeToolAllowed(runtimePolicy, "WebSearch")).toBe(true);
		const result = await webSearchTool.execute({ query: "test" }, {
			provider: "unsupported",
			model: "unknown",
			runtimePolicy,
			signal: new AbortController().signal,
		} as ToolContext);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("no native side-request");
	});

	test("side requests bypass global routing both in scope and in search-only runtime", async () => {
		const native = spyOn(router, "executeNativeSearch").mockResolvedValue({
			channelId: "native",
			channelLabel: "Native",
			text: "native result",
			attempts: [],
		});
		const ordinary = spyOn(router, "executeSearch").mockImplementation(async () => {
			throw new Error("Ordinary routing must not run");
		});
		try {
			const ctx = {
				provider: options.provider,
				model: options.model,
				signal: new AbortController().signal,
			} as ToolContext;
			const scoped = await withSearchExecutionScope(options, () =>
				webSearchTool.execute({ query: "scope query" }, ctx),
			);
			expect(scoped.output).toBe("native result");
			const searchOnly = await webSearchTool.execute(
				{ query: "runtime query" },
				{
					...ctx,
					runtimePolicy: resolveRuntimePolicy({ variant: "subagent", subagentType: "search" }),
				},
			);
			expect(searchOnly.output).toBe("native result");
			expect(native).toHaveBeenCalledTimes(2);
			expect(native.mock.calls[0][0].provider).toBe(options.provider);
			expect(ordinary).not.toHaveBeenCalled();
		} finally {
			native.mockRestore();
			ordinary.mockRestore();
		}
	});

	test("scope rejects a mismatched tool context before routing", async () => {
		const result = await withSearchExecutionScope(options, () =>
			webSearchTool.execute({ query: "test" }, {
				provider: "other",
				model: options.model,
				signal: new AbortController().signal,
			} as ToolContext),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("does not match");
	});
});
