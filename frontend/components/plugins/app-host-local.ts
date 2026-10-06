/**
 * App-level wiring for provider-facing host-local plugin UI methods.
 *
 * `provider.modelsChanged` and `models.test` are declared in `protocol.ts` and routed
 * by `host-local-router.ts`, but the ROUTER is deliberately ignorant of where model
 * state lives. This module is the half that knows: settings query keys for cache
 * invalidation, the provider-config endpoint for prefix scoping, and the model-test
 * API for actually running a test.
 *
 * Kept out of `App.tsx` so the app shell stays a clean Fast Refresh boundary; the
 * shell only has to construct this once and pass it down as `hostLocal`.
 */

import type { QueryClient } from "@tanstack/react-query";
import { pluginKeys } from "../../hooks/usePlugins";
import { api } from "../../lib/api";
import { ApiError } from "../../lib/api/client";
import { pluginsApi } from "../../lib/api/plugins";
import type { PluginUiHostLocalRouterOptions } from "./host-local-router";
import type { JsonValue } from "./protocol";
import { PluginUiHostError } from "./runtime";

/** Same default as `ModelTestDialog`, so a plugin-triggered test is comparable. */
const DEFAULT_TEST_PROMPT = "Please introduce yourself in one sentence. / 请用一句话介绍你自己。";

/**
 * The bridge response budget is 1 MiB, but a connection check never needs more than
 * the head of the model's reply — the full text stays available through the
 * diagnostics id on the host's own test dialog.
 */
const TEST_TEXT_MAX_CHARS = 20_000;

function diagnosticIdFromError(error: unknown): string | null {
	if (!(error instanceof ApiError)) return null;
	const diagnostics = error.data?.diagnostics;
	if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return null;
	const id = (diagnostics as { id?: unknown }).id;
	return typeof id === "string" ? id : null;
}

export function createAppPluginHostLocal(deps: {
	queryClient: QueryClient;
}): PluginUiHostLocalRouterOptions {
	const { queryClient } = deps;
	return {
		// The plugin refreshed its server-side catalog after adding/removing a model;
		// the host lists below the iframe derive from the settings queries, so they
		// must refetch or the change is invisible until a page reload. Same key set
		// as `PluginProviderModels.handleRefresh`.
		modelsChanged: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["settings"] }),
				queryClient.invalidateQueries({ queryKey: ["admin", "settings"] }),
			]);
		},
		testModel: async (pluginId, model, prompt): Promise<JsonValue> => {
			// Scope: the model must belong to one of the CALLING plugin's provider
			// prefixes. Without this a plugin could probe (and spend quota on) any
			// configured provider in the instance. `revalidateIfStale` because the
			// plugin may have just edited its own providers — a cached config from
			// before that edit would wrongly reject (or wrongly admit) a model.
			const config = await queryClient.ensureQueryData({
				queryKey: pluginKeys.providerConfig(pluginId),
				queryFn: () => pluginsApi.listProviderConfig(pluginId),
				revalidateIfStale: true,
			});
			const allowed = config.providers.some((provider) =>
				model.startsWith(`${provider.providerPrefix}:`),
			);
			if (!allowed) {
				throw new PluginUiHostError(
					"FORBIDDEN",
					"models.test only accepts models of the calling plugin's own providers",
					{ retryable: false },
				);
			}
			try {
				const result = await api.testModel(model, prompt ?? DEFAULT_TEST_PROMPT);
				return {
					ok: true,
					text: result.text.slice(0, TEST_TEXT_MAX_CHARS),
					diagnosticId: result.diagnostics?.id ?? null,
				};
			} catch (error) {
				// A failed test is a normal outcome (bad credentials, unreachable
				// upstream), not a bridge fault — report it as a value so the plugin
				// can render it without distinguishing error envelopes.
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					diagnosticId: diagnosticIdFromError(error),
				};
			}
		},
	};
}
