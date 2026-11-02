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
import { PluginToolRegistryError } from "./plugin-tool-registry";

/**
 * The quota-query engine that prefers the out-of-process `com.narrafork.apikey-quota`
 * plugin and falls back to the bundled adapters when the plugin cannot answer.
 *
 * Who answers what:
 * - plugin answers (`ok` / `unsupported`) -> authoritative, the builtin path is not run.
 * - plugin not installed, disabled, or not activated -> builtin runs, so behaviour is
 *   identical to before the extraction on deployments that never install the plugin.
 * - plugin output fails validation -> builtin runs; a broken plugin cannot poison the cache.
 */
const FULL_TOOL_ID = `${APIKEY_QUOTA_PLUGIN_ID}/${APIKEY_QUOTA_TOOL_ID}`;
const INVOCATION = { kind: "plugin_background", source: "internal" } as const;

/** Registry-level failures mean "this plugin cannot answer right now", not "the probe failed". */
const UNAVAILABLE_CODES = new Set([
	"NOT_FOUND",
	"HOST_UNAVAILABLE",
	"PLUGIN_DISABLED",
	"PERMISSION_DENIED",
	"PROTOCOL_ERROR",
	"TIMEOUT",
	"CONFLICT",
	"PAYLOAD_TOO_LARGE",
	"INVALID_PARAMS",
]);

type ToolInvoker = Pick<typeof pluginPlatformServices.toolRegistry, "list" | "invoke">;

export interface ApikeyQuotaEngineOptions {
	toolRegistry?: ToolInvoker;
	fallback?: ProviderBalanceQueryEngine;
	onDiagnostic?: (message: string, detail: Record<string, unknown>) => void;
}

export function createApikeyQuotaEngine(
	options: ApikeyQuotaEngineOptions = {},
): ProviderBalanceQueryEngine {
	const registry = options.toolRegistry ?? pluginPlatformServices.toolRegistry;
	const fallback = options.fallback ?? builtinProviderBalanceEngine;
	const diagnose =
		options.onDiagnostic ?? ((message, detail) => logger.info(`[apikey-quota] ${message}`, detail));

	/** One plugin call. `undefined` means the plugin could not answer at all. */
	async function callPlugin(
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<ApikeyQuotaToolOutput | undefined> {
		const available = registry
			.list(APIKEY_QUOTA_PLUGIN_ID)
			.some((tool) => tool.fullId === FULL_TOOL_ID && tool.status === "available");
		if (!available) return undefined;
		try {
			const result = await registry.invoke(FULL_TOOL_ID, input, {
				invocation: { ...INVOCATION },
				permission: { behavior: "allow" },
				signal,
			});
			if (result.isError) {
				diagnose("plugin returned an error result", { tool: FULL_TOOL_ID });
				return undefined;
			}
			const parsed = apikeyQuotaToolOutputSchema.safeParse(parseJson(result.output));
			if (!parsed.success) {
				diagnose("plugin output failed validation", {
					tool: FULL_TOOL_ID,
					issues: parsed.error.issues.length,
				});
				return undefined;
			}
			return parsed.data;
		} catch (error) {
			const code = error instanceof PluginToolRegistryError ? error.code : "UNKNOWN";
			// An install that simply does not have the plugin is not worth a log line per probe.
			if (!UNAVAILABLE_CODES.has(code)) {
				diagnose("plugin call failed", { tool: FULL_TOOL_ID, code });
			}
			return undefined;
		}
	}

	return {
		id: `plugin:${APIKEY_QUOTA_PLUGIN_ID}`,

		async probe(input: ProviderBalanceProbeInput) {
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
	};
}

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
	return fields;
}

function parseJson(output: string): unknown {
	try {
		return JSON.parse(output) as unknown;
	} catch {
		return undefined;
	}
}
