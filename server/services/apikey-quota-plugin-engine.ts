import {
	APIKEY_QUOTA_COMMAND_ID,
	APIKEY_QUOTA_PLUGIN_ID,
	type ApikeyQuotaCommandInput,
	type ApikeyQuotaCommandOutput,
	apikeyQuotaCommandInputSchema,
	apikeyQuotaCommandOutputSchema,
} from "@shared/apikey-quota-plugin";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { resolveProxyForUrl } from "../lib/net/proxy";
import type { JsonValue } from "../lib/plugins/protocol";
import { BalanceProbeRequestError } from "../lib/provider-balance-adapters";
import {
	builtinProviderBalanceEngine,
	type ProviderBalanceProbeInput,
	type ProviderBalanceQueryEngine,
	type ProviderBalanceRefreshInput,
} from "../lib/provider-balance-engine";
import type { CustomApiProviderConfig } from "../lib/settings";
import { getHttpUserAgent, resolveHttpUserAgent } from "../lib/user-agent";
import {
	type PluginCommandInvokeContext,
	PluginCommandRegistryError,
} from "./plugin-command-registry";
import { pluginPlatformServices } from "./plugin-platform-services";

/**
 * Quota queries answered by the bundled `apikey-quota` plugin.
 *
 * This engine is deliberately thin: it does not own a process, a connection or a restart
 * policy. Host-internal queries use the shared command registry, not Agent tools. The runtime
 * still owns process lifecycle, timeouts and health accounting; this adapter retains the
 * existing provider.use authorization before sending credentials to the command.
 *
 * Decision table:
 * - `ok` / `unsupported` -> authoritative; the bundled adapters do not run.
 * - `failed` -> the existing transient/unsupported probe error.
 * - plugin **disabled** -> `plugin_disabled`, a deterministic error. The plugin owns this
 *   capability, so a disabled plugin means the feature is off: falling back here would keep
 *   answering quota queries that the administrator switched off. See `pluginDisabled` below.
 * - plugin unavailable for any *other* reason (not registered, crashed, output fails
 *   validation) -> bundled adapters, which is the pre-plugin behaviour. An enabled but broken
 *   plugin must not take the whole feature down with it.
 */
const FULL_COMMAND_ID = `${APIKEY_QUOTA_PLUGIN_ID}/${APIKEY_QUOTA_COMMAND_ID}`;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Error codes that mean "an administrator disabled this plugin", not "the plugin broke".
 *
 * Activation is refused by the manager (`PLUGIN_NOT_ENABLED`); the command adapter also
 * rejects a disabled lifecycle state (`PLUGIN_DISABLED`). Both are
 * configuration states, so both must surface instead of silently falling back.
 */
const PLUGIN_DISABLED_CODES = new Set(["PLUGIN_NOT_ENABLED", "PLUGIN_DISABLED"]);

/** The command-registry slice this engine needs; tests inject a fake. */
export interface QuotaCommandInvoker {
	invoke(
		commandId: string,
		pluginId: string,
		input: JsonValue | undefined,
		context: PluginCommandInvokeContext,
	): Promise<{ output?: unknown }>;
}

/** The manager slice this engine needs: activation starts the command backend. */
export interface QuotaPluginActivator {
	activate(pluginId: string, options?: Record<string, unknown>): Promise<unknown>;
	/**
	 * Optional read of the plugin's lifecycle state. The real manager provides it; a test double
	 * may omit it, in which case the capability is treated as available (the pre-existing
	 * behaviour for anything that cannot be asked).
	 */
	getStatus?(pluginId: string): Promise<{ desiredState?: string } | undefined>;
}

export interface ApikeyQuotaEngineOptions {
	commands?: QuotaCommandInvoker;
	activator?: QuotaPluginActivator;
	fallback?: ProviderBalanceQueryEngine;
	onDiagnostic?: (message: string, detail: Record<string, unknown>) => void;
}

export type ApikeyQuotaEngine = ProviderBalanceQueryEngine & {
	/** Kept for the host shutdown sequence; the registry owns the process now. */
	dispose(): Promise<void>;
};

/**
 * The three things one plugin call can produce.
 *
 * `disabled` is deliberately its own outcome rather than an "unavailable" variant: the caller
 * has to turn it into an error instead of falling back, which is the whole point of the
 * distinction.
 */
type PluginCall =
	| { outcome: "answer"; answer: ApikeyQuotaCommandOutput }
	| { outcome: "disabled" }
	| { outcome: "unavailable" };

/**
 * The plugin's answer, or `undefined` when the bundled adapters should answer instead.
 *
 * Throws for `disabled`: the capability belongs to the plugin, so a disabled plugin is a
 * deterministic "not available right now", never a reason to answer the same question from
 * the in-process adapters.
 */
function usableAnswer(call: PluginCall): ApikeyQuotaCommandOutput | undefined {
	if (call.outcome === "disabled") throw new BalanceProbeRequestError("plugin_disabled");
	return call.outcome === "answer" ? call.answer : undefined;
}

/** Is this refusal "an administrator disabled the plugin" rather than "the plugin broke"? */
function pluginDisabled(error: unknown): boolean {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" && PLUGIN_DISABLED_CODES.has(code);
}

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

/**
 * Whether the quota-query capability is currently switched on.
 *
 * The settings projection asks this so the provider page can hide the site-quota fields and the
 * balance row entirely while the plugin is disabled: leaving them on screen would offer controls
 * that cannot work. An unknown answer counts as enabled, which is the safe direction — the
 * capability then reports itself when a query actually runs.
 */
export async function isApikeyQuotaCapabilityEnabled(): Promise<boolean> {
	const status = await installedActivator
		?.getStatus?.(APIKEY_QUOTA_PLUGIN_ID)
		.catch(() => undefined);
	return status?.desiredState !== "disabled";
}

/** Authorize this host-internal command without registering an Agent tool. */
export async function invokeApikeyQuotaCommand(
	input: ApikeyQuotaCommandInput,
	context: PluginCommandInvokeContext,
) {
	context.signal?.throwIfAborted();
	const { runtimeSupervisor, stateStore, capabilityBroker, pluginCommandRegistry } =
		pluginPlatformServices;
	const state = await stateStore.getState(APIKEY_QUOTA_PLUGIN_ID);
	if (state?.desiredState === "disabled") {
		throw new PluginCommandRegistryError("PLUGIN_DISABLED", "Quota plugin is disabled");
	}
	const runtime = runtimeSupervisor.get(APIKEY_QUOTA_PLUGIN_ID);
	const installationId =
		state?.installationId ?? state?.authorityInstallationId ?? state?.current?.hash;
	if (!runtime || runtime.state !== "active" || !installationId) {
		throw new PluginCommandRegistryError("HOST_UNAVAILABLE", "Quota plugin is not active", true);
	}
	const diagnostics = runtime.getDiagnostics();
	const host = capabilityBroker.withCallContext({
		plugin: {
			pluginId: APIKEY_QUOTA_PLUGIN_ID,
			packageVersion: diagnostics.pluginVersion,
			installationId,
			runtimeId: diagnostics.runtimeId,
			runtimeGeneration: diagnostics.generation,
			contributionId: APIKEY_QUOTA_COMMAND_ID,
		},
		invocation: { kind: "plugin_background", source: "internal" },
		requestId: context.requestId,
		correlationId: context.correlationId,
		deadlineAt: context.deadlineAt,
	});
	const requestBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
	const authorization = await capabilityBroker.authorize({
		context: host,
		capability: "provider.use",
		methodId: `commands.invoke:${FULL_COMMAND_ID}`,
		constraints: { maxBytes: requestBytes },
		requestBytes,
		responseBytes: 0,
	});
	if (!authorization.allowed) {
		throw new PluginCommandRegistryError(
			authorization.error?.code ?? "PERMISSION_DENIED",
			"Capability broker denied the quota command",
		);
	}
	context.signal?.throwIfAborted();
	return pluginCommandRegistry.invoke(FULL_COMMAND_ID, APIKEY_QUOTA_PLUGIN_ID, input, context);
}

export function createApikeyQuotaEngine(options: ApikeyQuotaEngineOptions = {}): ApikeyQuotaEngine {
	const fallback = options.fallback ?? builtinProviderBalanceEngine;
	const diagnose =
		options.onDiagnostic ?? ((message, detail) => logger.info(`[apikey-quota] ${message}`, detail));

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

	/** One plugin call through the shared registry. */
	async function callPlugin(
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<PluginCall> {
		signal.throwIfAborted();
		try {
			await activator()?.activate(APIKEY_QUOTA_PLUGIN_ID, {
				reason: `onCommand:${FULL_COMMAND_ID}`,
				automatic: true,
			});
		} catch (error) {
			if (pluginDisabled(error)) {
				diagnose("plugin is disabled; capability reported as unavailable", {
					command: FULL_COMMAND_ID,
				});
				return { outcome: "disabled" };
			}
			signal.throwIfAborted();
			diagnose("plugin activation failed", { error: errorName(error) });
			return { outcome: "unavailable" };
		}
		try {
			const commandInput = apikeyQuotaCommandInputSchema.parse(input);
			const context: PluginCommandInvokeContext = {
				requestId: generateId(),
				deadlineAt: new Date(Date.now() + REQUEST_TIMEOUT_MS).toISOString(),
				signal,
				timeoutMs: REQUEST_TIMEOUT_MS,
			};
			const result = options.commands
				? await options.commands.invoke(
						FULL_COMMAND_ID,
						APIKEY_QUOTA_PLUGIN_ID,
						commandInput,
						context,
					)
				: await invokeApikeyQuotaCommand(commandInput, context);
			const parsed = apikeyQuotaCommandOutputSchema.safeParse(result.output);
			if (!parsed.success) {
				diagnose("plugin output failed validation", {
					command: FULL_COMMAND_ID,
					issues: parsed.error.issues.length,
				});
				return { outcome: "unavailable" };
			}
			return { outcome: "answer", answer: parsed.data };
		} catch (error) {
			if (pluginDisabled(error)) {
				diagnose("plugin is disabled; capability reported as unavailable", {
					command: FULL_COMMAND_ID,
				});
				return { outcome: "disabled" };
			}
			signal.throwIfAborted();
			diagnose("plugin call failed", { command: FULL_COMMAND_ID, error: errorName(error) });
			return { outcome: "unavailable" };
		}
	}

	return {
		id: `plugin:${APIKEY_QUOTA_PLUGIN_ID}`,

		async probe(input: ProviderBalanceProbeInput) {
			if (input.fetch) return seamFallback("probe", input);
			const call = await callPlugin(
				{
					mode: "probe",
					baseUrl: input.config.baseUrl,
					apiKey: input.config.apiKey,
					...siteQuotaFields(input.config),
					...connectionFields(input),
				},
				input.signal,
			);
			const answer = usableAnswer(call);
			if (answer?.status === "ok") {
				// A discovery answer without its endpoint could not be persisted or refreshed.
				if (!answer.adapter || !answer.root) {
					diagnose("plugin probe answer is missing adapter/root", { command: FULL_COMMAND_ID });
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
			const call = await callPlugin(
				{
					mode: "refresh",
					baseUrl: input.config.baseUrl,
					apiKey: input.config.apiKey,
					...siteQuotaFields(input.config),
					adapter: input.adapter,
					root: input.root,
					...connectionFields(input),
				},
				input.signal,
			);
			const answer = usableAnswer(call);
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

/**
 * The site-account credit credentials, forwarded per call exactly like the inference key.
 *
 * Sending them only when set keeps the command input identical to the pre-existing shape for
 * every provider that queries a key's allowance, so the plugin's own validation cannot start
 * rejecting inputs the bundled path accepts.
 */
function siteQuotaFields(config: CustomApiProviderConfig): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	if (config.quotaSiteUrl?.trim()) fields.siteUrl = config.quotaSiteUrl.trim();
	if (config.quotaAccessToken?.trim()) fields.accessToken = config.quotaAccessToken.trim();
	if (config.quotaUserId?.trim()) fields.userId = config.quotaUserId.trim();
	return fields;
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
	// The cache's per-request timeout is a real transport bound, so it crosses the boundary
	// verbatim instead of the plugin silently using its own default.
	if (typeof input.requestTimeoutMs === "number" && Number.isFinite(input.requestTimeoutMs)) {
		fields.timeoutMs = input.requestTimeoutMs;
	}
	return fields;
}

function errorName(error: unknown): string {
	if (error instanceof Error) {
		// Registry errors carry a fixed code (INVALID_PARAMS, TIMEOUT, …) that is far more
		// actionable than the class name when a plugin call is rejected.
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? `${error.name}:${code}` : error.name;
	}
	return "unknown";
}
