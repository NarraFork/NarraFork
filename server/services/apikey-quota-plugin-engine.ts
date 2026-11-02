import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { settings } from "../lib/settings";
import { getHttpUserAgent, resolveHttpUserAgent } from "../lib/user-agent";
import { LocalProcessRunner, PluginRuntime } from "./plugin-runtime";

/**
 * Quota queries answered by the bundled `apikey-quota` plugin.
 *
 * The plugin ships with the application (`server/builtin-plugins/apikey-quota`) and runs in
 * its own process, but it is **not** an installed plugin: there is no package store record,
 * no capability grant and no admin install step, so it can be enabled by default on a fresh
 * instance. Its authority is therefore one host setting — `plugins.apikeyQuotaEnabled`.
 *
 * Decision table (deliberately identical to the previous installable-plugin version):
 * - plugin answers `ok` / `unsupported` -> authoritative, the bundled adapters do not run.
 * - `failed` -> surfaces as the existing transient/unsupported probe error.
 * - disabled, not shipped, cannot start, or output fails validation -> bundled adapters,
 *   which is exactly the pre-plugin behaviour. Nothing is reported to the user.
 */
const FULL_TOOL_ID = `${APIKEY_QUOTA_PLUGIN_ID}/${APIKEY_QUOTA_TOOL_ID}`;
const PLUGIN_DIR = join(import.meta.dir, "../builtin-plugins/apikey-quota");
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * How long the process may sit unused before it is reaped.
 *
 * Deliberately not the request timeout: quota probes are minutes apart (`providerBalanceCache`
 * refreshes on its own schedule), so a request-sized idle window would reap the process after
 * every single probe and make the plugin pay a spawn on every call. Reaping is still normal —
 * the engine restarts on demand (see `ensureRuntime`) — this just keeps a warm process for the
 * common interval instead of one that is almost always gone.
 */
const IDLE_TIMEOUT_MS = 5 * 60_000;

/** The slice of `PluginRuntime` this engine needs; tests inject a fake. */
export interface QuotaPluginRuntime {
	start(signal?: AbortSignal): Promise<void>;
	request<T = unknown>(method: string, params?: unknown, options?: unknown): Promise<T>;
	shutdown(): Promise<void>;
	/** Fires when the process goes away on its own (idle reap, crash, broken pipe). */
	onClose?(handler: (error?: Error) => void): () => void;
}

export interface ApikeyQuotaEngineOptions {
	/** Defaults to `settings.plugins.apikeyQuotaEnabled`. */
	isEnabled?: () => boolean;
	/** Defaults to spawning the bundled package over stdio. */
	createRuntime?: () => QuotaPluginRuntime;
	fallback?: ProviderBalanceQueryEngine;
	onDiagnostic?: (message: string, detail: Record<string, unknown>) => void;
}

export interface BuiltinApikeyQuotaEngine extends ProviderBalanceQueryEngine {
	/** Stops the plugin process; called from the host shutdown sequence. */
	dispose(): Promise<void>;
}

export function createApikeyQuotaEngine(
	options: ApikeyQuotaEngineOptions = {},
): BuiltinApikeyQuotaEngine {
	const isEnabled = options.isEnabled ?? (() => settings.plugins?.apikeyQuotaEnabled !== false);
	const fallback = options.fallback ?? builtinProviderBalanceEngine;
	const diagnose =
		options.onDiagnostic ?? ((message, detail) => logger.info(`[apikey-quota] ${message}`, detail));

	let runtime: QuotaPluginRuntime | undefined;
	let starting: Promise<QuotaPluginRuntime | undefined> | undefined;

	/** One process for the whole host lifetime; a failed start is retried on the next probe. */
	async function ensureRuntime(signal: AbortSignal): Promise<QuotaPluginRuntime | undefined> {
		if (!isEnabled()) {
			await stopRuntime();
			return undefined;
		}
		if (runtime) return runtime;
		starting ??= (async () => {
			try {
				// `createRuntime` returning `undefined` means "no package to run" and must not
				// silently fall through to spawning the bundled one.
				const created = options.createRuntime ? options.createRuntime() : createBundledRuntime();
				if (!created) return undefined;
				await created.start(signal);
				// A reaped or crashed process must never stay cached: the next probe would send
				// into a closed pipe and fall back for the rest of the host's life.
				created.onClose?.(() => {
					if (runtime === created) runtime = undefined;
				});
				runtime = created;
				return created;
			} catch (error) {
				diagnose("failed to start builtin plugin", {
					error: error instanceof Error ? error.name : "unknown",
				});
				return undefined;
			} finally {
				starting = undefined;
			}
		})();
		return starting;
	}

	async function stopRuntime(): Promise<void> {
		const current = runtime;
		runtime = undefined;
		if (!current) return;
		await current.shutdown().catch(() => undefined);
	}

	/** One plugin call. `undefined` means the plugin could not answer at all. */
	async function callPlugin(
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<ApikeyQuotaToolOutput | undefined> {
		const active = await ensureRuntime(signal);
		if (!active) return undefined;
		try {
			const result = await active.request<{ output?: unknown; isError?: unknown }>(
				"tools.invoke",
				{ contributionId: APIKEY_QUOTA_TOOL_ID, input },
				{ signal, timeoutMs: REQUEST_TIMEOUT_MS },
			);
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
			// A crashed or unresponsive plugin must not wedge the balance cache: drop the
			// process so the next probe can start a fresh one, and answer from the bundled
			// adapters this round.
			diagnose("plugin call failed", {
				tool: FULL_TOOL_ID,
				error: error instanceof Error ? error.name : "unknown",
			});
			await stopRuntime();
			return undefined;
		}
	}

	/**
	 * `probe`/`refresh` accept an injected `fetch`, which exists so tests can stub transport
	 * without a network. A function cannot be serialized into another process, so a caller
	 * that supplies one is by definition asking for in-process transport: that call runs the
	 * bundled engine, and it says so. Production never sets this seam (`providerBalanceCache`
	 * is constructed without `fetch`), so it cannot silently downgrade a real deployment.
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

		/** Best-effort teardown for host shutdown; the process dies with the server anyway. */
		async dispose() {
			await stopRuntime();
		},
	};
}

/**
 * The one engine the host installs. Module-level so the runtime it may have started can be
 * disposed from the shutdown sequence rather than left as an orphan: on non-Windows the
 * plugin process is spawned detached, so it does not die with the server by itself.
 */
export const builtinApikeyQuotaEngine = createApikeyQuotaEngine();

/** Spawn the bundled package over stdio, mirroring how release validation starts it. */
function createBundledRuntime(): QuotaPluginRuntime | undefined {
	const entry = join(PLUGIN_DIR, "server/index.js");
	if (!existsSync(entry)) return undefined;
	const runner = new LocalProcessRunner({
		allowedCwds: [PLUGIN_DIR],
		allowUnboundedResourceUsage: process.platform === "win32",
		spawnTimeoutMs: REQUEST_TIMEOUT_MS,
		idleTimeoutMs: IDLE_TIMEOUT_MS,
	});
	return new PluginRuntime({
		pluginId: APIKEY_QUOTA_PLUGIN_ID,
		pluginVersion: "1.0.0",
		command: [process.execPath, entry],
		cwd: PLUGIN_DIR,
		runner,
		rpcProtocol: "narrafork.rpc/1",
		hostApiVersion: "1.0",
		grantedCapabilities: ["provider.use"],
		activationReason: "builtin:apikey-quota",
		timeouts: {
			handshakeMs: REQUEST_TIMEOUT_MS,
			activationMs: REQUEST_TIMEOUT_MS,
			rpcMs: REQUEST_TIMEOUT_MS,
			drainMs: 500,
			shutdownMs: 500,
			cancelGraceMs: 100,
		},
		idleTimeoutMs: IDLE_TIMEOUT_MS,
	});
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

function parseJson(output: string): unknown {
	try {
		return JSON.parse(output) as unknown;
	} catch {
		return undefined;
	}
}
