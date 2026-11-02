import {
	APIKEY_QUOTA_PLUGIN_ID,
	APIKEY_QUOTA_TOOL_ID,
	type ApikeyQuotaToolOutput,
	apikeyQuotaToolOutputSchema,
} from "@shared/apikey-quota-plugin";
import { logger } from "../lib/logger";
import { resolveProxyForUrl } from "../lib/net/proxy";
import { BalanceProbeRequestError } from "../lib/provider-balance-adapters";
import {
	builtinProviderBalanceEngine,
	type ProviderBalanceProbeInput,
	type ProviderBalanceQueryEngine,
	type ProviderBalanceRefreshInput,
} from "../lib/provider-balance-engine";
import { getHttpUserAgent, resolveHttpUserAgent } from "../lib/user-agent";
import { pluginPlatformServices } from "./plugin-platform-services";

/**
 * Quota queries answered by the bundled `apikey-quota` plugin.
 *
 * This engine is deliberately thin: it does not own a process, a connection or a restart
 * policy. It calls the plugin through the *same* tool registry every other plugin tool goes
 * through (`pluginToolRegistry.invoke` with a `plugin_background` principal), so the process
 * lifecycle, capability check, byte limits, timeouts and health accounting are the shared
 * ones. What stays here is only what is specific to this feature: the decision table that maps
 * a plugin answer onto the provider-balance DTO, and the fallback to the bundled adapters.
 *
 * Decision table:
 * - `ok` / `unsupported` -> authoritative; the bundled adapters do not run.
 * - `failed` -> the existing transient/unsupported probe error.
 * - plugin disabled, unavailable, not registered, or output fails validation -> bundled
 *   adapters, which is exactly the pre-plugin behaviour. Nothing is reported to the user.
 */
const FULL_TOOL_ID = `${APIKEY_QUOTA_PLUGIN_ID}/${APIKEY_QUOTA_TOOL_ID}`;
const REQUEST_TIMEOUT_MS = 15_000;

/** The tool-registry slice this engine needs; tests inject a fake. */
export interface QuotaToolInvoker {
	invoke(
		fullId: string,
		input: unknown,
		options?: Record<string, unknown>,
	): Promise<{ output?: unknown; isError?: unknown }>;
}

/** The manager slice this engine needs: activation is what registers the tool. */
export interface QuotaPluginActivator {
	activate(pluginId: string, options?: Record<string, unknown>): Promise<unknown>;
}

export interface ApikeyQuotaEngineOptions {
	tools?: QuotaToolInvoker;
	activator?: QuotaPluginActivator;
	fallback?: ProviderBalanceQueryEngine;
	onDiagnostic?: (message: string, detail: Record<string, unknown>) => void;
}

export type ApikeyQuotaEngine = ProviderBalanceQueryEngine & {
	/** Kept for the host shutdown sequence; the registry owns the process now. */
	dispose(): Promise<void>;
};

/**
 * Activation hook.
 *
 * `PluginManager` imports the platform services, so importing it back into this module would
 * close a cycle. The host installs the activator once at startup instead; until then the engine
 * simply has no plugin to activate and answers from the bundled adapters.
 */
let installedActivator: QuotaPluginActivator | undefined;

export function setApikeyQuotaActivation(activator: QuotaPluginActivator | undefined): void {
	installedActivator = activator;
}

export function createApikeyQuotaEngine(options: ApikeyQuotaEngineOptions = {}): ApikeyQuotaEngine {
	const fallback = options.fallback ?? builtinProviderBalanceEngine;
	const diagnose =
		options.onDiagnostic ?? ((message, detail) => logger.info(`[apikey-quota] ${message}`, detail));

	const tools = (): QuotaToolInvoker => options.tools ?? pluginPlatformServices.toolRegistry;
	const activator = (): QuotaPluginActivator | undefined => options.activator ?? installedActivator;

	/**
	 * `probe`/`refresh` accept an injected `fetch`, which exists so tests can stub transport
	 * without a network. That seam cannot cross into another process, so such a call runs the
	 * bundled engine in-process and says so; production never sets it.
	 */
	function seamFallback(
		mode: "probe",
		input: ProviderBalanceProbeInput,
	): ReturnType<ProviderBalanceQueryEngine["probe"]>;
	function seamFallback(
		mode: "refresh",
		input: ProviderBalanceRefreshInput,
	): ReturnType<ProviderBalanceQueryEngine["refresh"]>;
	function seamFallback(
		mode: "probe" | "refresh",
		input: ProviderBalanceProbeInput | ProviderBalanceRefreshInput,
	) {
		diagnose("injected transport seam runs in-process", { mode, reason: "fetch-not-serializable" });
		return mode === "probe"
			? fallback.probe(input as ProviderBalanceProbeInput)
			: fallback.refresh(input as ProviderBalanceRefreshInput);
	}

	/** One plugin call through the shared registry. `undefined` means "no usable answer". */
	async function callPlugin(
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<ApikeyQuotaToolOutput | undefined> {
		try {
			// Activation is what registers the tool; the manager treats a repeat call as a
			// no-op, so this is safe on every probe.
			await activator()?.activate(APIKEY_QUOTA_PLUGIN_ID, {
				reason: `onTool:${FULL_TOOL_ID}`,
				automatic: true,
			});
		} catch (error) {
			diagnose("plugin activation failed", { error: errorName(error) });
			return undefined;
		}
		try {
			const result = await tools().invoke(FULL_TOOL_ID, input, {
				invocation: { kind: "plugin_background", source: "internal" },
				signal,
				timeoutMs: REQUEST_TIMEOUT_MS,
			});
			const output = typeof result?.output === "string" ? result.output : undefined;
			if (result?.isError === true || output === undefined) {
				diagnose("plugin returned no usable output", { tool: FULL_TOOL_ID });
				return undefined;
			}
			const parsed = apikeyQuotaToolOutputSchema.safeParse(parseJson(output));
			if (!parsed.success) {
				diagnose("plugin output failed validation", {
					tool: FULL_TOOL_ID,
					issues: parsed.error.issues.length,
				});
				return undefined;
			}
			return parsed.data;
		} catch (error) {
			// A disabled, crashed or unresponsive plugin must not wedge the balance cache: this
			// round is answered by the bundled adapters.
			diagnose("plugin call failed", { tool: FULL_TOOL_ID, error: errorName(error) });
			return undefined;
		}
	}

	return {
		id: `plugin:${APIKEY_QUOTA_PLUGIN_ID}`,

		async probe(input: ProviderBalanceProbeInput) {
			if (input.fetch) return seamFallback("probe", input);
			const answer = await callPlugin(
				{
					mode: "probe",
					baseUrl: input.config.baseUrl,
					apiKey: input.config.apiKey,
					...connectionFields(input),
				},
				input.signal,
			);
			if (answer?.status === "ok") {
				// A discovery answer without its endpoint could not be persisted or refreshed.
				if (!answer.adapter || !answer.root) {
					diagnose("plugin probe answer is missing adapter/root", { tool: FULL_TOOL_ID });
					return fallback.probe(input);
				}
				return { adapter: answer.adapter, root: answer.root, balance: answer.balance };
			}
			if (answer?.status === "unsupported") return null;
			if (answer?.status === "failed") throw new BalanceProbeRequestError(answer.kind);
			return fallback.probe(input);
		},

		async refresh(input: ProviderBalanceRefreshInput) {
			if (input.fetch) return seamFallback("refresh", input);
			const answer = await callPlugin(
				{
					mode: "refresh",
					baseUrl: input.config.baseUrl,
					apiKey: input.config.apiKey,
					adapter: input.adapter,
					root: input.root,
					...connectionFields(input),
				},
				input.signal,
			);
			if (answer?.status === "ok") return answer.balance;
			if (answer?.status === "unsupported") throw new BalanceProbeRequestError("unsupported");
			if (answer?.status === "failed") throw new BalanceProbeRequestError(answer.kind);
			return fallback.refresh(input);
		},

		/** The process belongs to the runtime supervisor, so there is nothing to tear down here. */
		async dispose() {},
	};
}

/**
 * The one engine the host installs. Module-level so any later teardown hook can reach it
 * without threading it through call sites.
 */
export const builtinApikeyQuotaEngine = createApikeyQuotaEngine();

/** The connection facts the plugin needs, mirroring what the host transport would send. */
function connectionFields(input: ProviderBalanceProbeInput): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	const extra = input.config.extraHeaders;
	if (extra && Object.keys(extra).length > 0) fields.headers = extra;
	fields.userAgent = resolveHttpUserAgent({
		mode: input.config.userAgentMode,
		custom: input.config.customUserAgent,
		fallback: getHttpUserAgent(),
	});
	// `config.proxy` is an override policy, not a URL: resolve it for this target exactly
	// as the bundled transport does, so the plugin honours the same policy. A plugin that
	// silently ignored the policy would bypass a corporate proxy after the switch.
	const proxyUrl = resolveProxyForUrl(input.config.baseUrl, input.config.proxy);
	if (proxyUrl) fields.proxy = proxyUrl;
	if (typeof input.config.tlsRejectUnauthorized === "boolean") {
		fields.tlsRejectUnauthorized = input.config.tlsRejectUnauthorized;
	}
	// The cache's per-request timeout is a real transport bound, so it crosses the boundary
	// verbatim instead of the plugin silently using its own default.
	if (typeof input.requestTimeoutMs === "number" && Number.isFinite(input.requestTimeoutMs)) {
		fields.timeoutMs = input.requestTimeoutMs;
	}
	return fields;
}

function parseJson(output: string): unknown {
	try {
		return JSON.parse(output) as unknown;
	} catch {
		return undefined;
	}
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}
