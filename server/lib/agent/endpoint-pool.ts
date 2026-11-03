/**
 * Multi-endpoint selection and failover for custom API providers.
 *
 * Providers build every request URL as `${baseUrl}${path}`. When a provider
 * lists mirrors (`baseUrls`), `fetchWithEndpointFailover` swaps that prefix
 * for the endpoint chosen by the provider's `endpointPolicy`, and on a
 * qualifying failure retries the same request on the next endpoint. Failover
 * only happens before a response is returned: once headers arrive the stream
 * belongs to the caller, and mid-stream drops are left to the agent loop's
 * own retry.
 *
 * Latency has two sources that are deliberately kept apart:
 * - probe latency: a cheap unauthenticated GET of the base URL, comparable
 *   across endpoints, and the primary ranking signal;
 * - request latency: time-to-headers of real requests, which includes upstream
 *   model work, so it is only used for ranking when no probe data exists.
 *
 * Each provider has its own pool. Network failures and upstream outcomes are
 * tracked separately so a gateway error does not look like a broken connection.
 *
 * Providers with a single URL never touch this module's state.
 */

import {
	type EndpointFailoverConditions,
	type EndpointStatus,
	listProviderEndpoints,
	type ProviderEndpointPolicy,
	type ProviderEndpointsStatus,
	type ResolvedEndpointPolicy,
	resolveEndpointPolicy,
} from "@shared/provider-endpoints";
import { logger } from "../logger";
import { outboundFetch } from "../net/outbound-fetch";
import { resolveProxyForUrl } from "../net/proxy";
import type { ProxyOverride } from "../settings/types";

export interface EndpointPoolConfig {
	id: string;
	baseUrl?: string;
	baseUrls?: string[];
	endpointPolicy?: ProviderEndpointPolicy;
	proxy?: ProxyOverride;
	tlsRejectUnauthorized?: boolean;
}

export type EndpointFailureKind = keyof EndpointFailoverConditions;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Resolves with the round-trip in ms; rejects when the endpoint is unreachable. */
export type EndpointProbe = (
	url: string,
	config: EndpointPoolConfig,
	signal: AbortSignal,
) => Promise<number>;

interface Health {
	consecutiveFailures: number;
	cooldownUntil: number;
	lastError: string | null;
}

/** Probe latency and network reachability of one endpoint. */
interface EndpointState {
	url: string;
	probeEwma: number | null;
	lastProbeAt: number | null;
	network: Health;
}

/** Response latency and upstream health of one provider endpoint. */
interface MemberEndpointState {
	requestEwma: number | null;
	upstream: Health;
}

interface MemberState {
	endpoints: Map<string, MemberEndpointState>;
	/** Sticky choice; also the last endpoint that served this provider successfully. */
	preferred: string | null;
}

interface PoolState {
	signature: string;
	/** Latest config; probes use its connection settings. */
	config: EndpointPoolConfig;
	endpoints: EndpointState[];
	member: MemberState;
	lastUsedAt: number;
	lastProbeRoundAt: number;
	probing: Promise<void> | null;
}

const EWMA_ALPHA = 0.3;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_TICK_MS = 15_000;
/** Stop background probing for providers nobody has used for this long. */
const PROBE_IDLE_MS = 30 * 60_000;
const MAX_COOLDOWN_MULTIPLIER = 8;
const MAX_ERROR_CHARS = 300;

class EndpointHeaderTimeoutError extends Error {
	constructor(ms: number) {
		super(`No response headers within ${ms} ms`);
		this.name = "EndpointHeaderTimeoutError";
	}
}

function newHealth(): Health {
	return { consecutiveFailures: 0, cooldownUntil: 0, lastError: null };
}

function ewma(previous: number | null, sample: number): number {
	return previous === null ? sample : previous * (1 - EWMA_ALPHA) + sample * EWMA_ALPHA;
}

function classifyStatus(status: number): EndpointFailureKind | null {
	if (status === 429) return "rateLimit";
	if (status >= 500) return "serverError";
	if (status >= 400) return "clientError";
	return null;
}

function isReplayableBody(body: RequestInit["body"]): boolean {
	return !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
}

function errorMessage(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Longest configured endpoint that prefixes `url` on a path boundary. */
function matchEndpoint(url: string, endpoints: readonly string[]): string | undefined {
	let best: string | undefined;
	for (const endpoint of endpoints) {
		if (url !== endpoint && !url.startsWith(`${endpoint}/`) && !url.startsWith(`${endpoint}?`))
			continue;
		if (!best || endpoint.length > best.length) best = endpoint;
	}
	return best;
}

/**
 * Unauthenticated GET of the base URL. Any HTTP answer proves the host is
 * reachable; gateway errors mean the upstream behind it is not.
 */
export const defaultEndpointProbe: EndpointProbe = async (url, config, signal) => {
	const startedAt = performance.now();
	const response = await outboundFetch(
		url,
		{ method: "GET", signal, redirect: "manual" },
		{
			proxyUrl: resolveProxyForUrl(url, config.proxy),
			tlsRejectUnauthorized: config.tlsRejectUnauthorized,
			retryPolicy: "never",
		},
	);
	const elapsed = performance.now() - startedAt;
	void response.body?.cancel().catch(() => {});
	if (response.status === 502 || response.status === 503 || response.status === 504) {
		throw new Error(`HTTP ${response.status}`);
	}
	return elapsed;
};

export interface EndpointPoolOptions {
	now?: () => number;
	probe?: EndpointProbe;
	/** Run the background probe timer. Off in tests. */
	autoProbe?: boolean;
}

export class EndpointPool {
	private readonly pools = new Map<string, PoolState>();
	private readonly now: () => number;
	private readonly probe: EndpointProbe;
	private readonly autoProbe: boolean;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(options: EndpointPoolOptions = {}) {
		this.now = options.now ?? Date.now;
		this.probe = options.probe ?? defaultEndpointProbe;
		this.autoProbe = options.autoProbe ?? true;
	}

	/**
	 * Get (or create) the state for a provider. A changed URL list rebuilds the pool
	 * but keeps measurements for URLs that are still configured.
	 */
	private state(config: EndpointPoolConfig): PoolState {
		const key = config.id;
		const urls = listProviderEndpoints(config);
		const signature = urls.join("\n");
		const existing = this.pools.get(key);
		if (existing && existing.signature === signature) {
			existing.config = config;
			return existing;
		}
		const previous = new Map(existing?.endpoints.map((e) => [e.url, e]));
		const member = existing?.member ?? { endpoints: new Map(), preferred: null };
		if (member.preferred && !urls.includes(member.preferred)) member.preferred = null;
		for (const url of member.endpoints.keys()) {
			if (!urls.includes(url)) member.endpoints.delete(url);
		}
		const state: PoolState = {
			signature,
			config,
			endpoints: urls.map(
				(url) =>
					previous.get(url) ?? { url, probeEwma: null, lastProbeAt: null, network: newHealth() },
			),
			member,
			lastUsedAt: existing?.lastUsedAt ?? 0,
			lastProbeRoundAt: 0,
			probing: null,
		};
		this.pools.set(key, state);
		this.ensureTimer();
		return state;
	}

	private memberEndpoint(member: MemberState, url: string): MemberEndpointState {
		let entry = member.endpoints.get(url);
		if (!entry) {
			entry = { requestEwma: null, upstream: newHealth() };
			member.endpoints.set(url, entry);
		}
		return entry;
	}

	private endpoint(state: PoolState, url: string): EndpointState | undefined {
		return state.endpoints.find((e) => e.url === url);
	}

	/** An endpoint is out of rotation while either failure layer is cooling down. */
	private cooldownOf(endpoint: EndpointState, member: MemberState): number {
		const upstream = member.endpoints.get(endpoint.url)?.upstream.cooldownUntil ?? 0;
		return Math.max(endpoint.network.cooldownUntil, upstream);
	}

	private rankLatency(endpoint: EndpointState, member: MemberState): number {
		return (
			endpoint.probeEwma ??
			member.endpoints.get(endpoint.url)?.requestEwma ??
			Number.POSITIVE_INFINITY
		);
	}

	/** Endpoints in the order the next request of this member should try them. */
	order(config: EndpointPoolConfig): string[] {
		const state = this.state(config);
		const member = state.member;
		const policy = resolveEndpointPolicy(config.endpointPolicy);
		const now = this.now();
		const healthy = state.endpoints.filter((e) => this.cooldownOf(e, member) <= now);
		// Cooling endpoints stay as a last resort so a fully degraded pool still tries something.
		const cooling = state.endpoints
			.filter((e) => this.cooldownOf(e, member) > now)
			.sort((a, b) => this.cooldownOf(a, member) - this.cooldownOf(b, member));

		let ranked = healthy;
		if (policy.strategy !== "ordered") {
			// Array#sort is stable: unmeasured endpoints keep configured order behind measured ones.
			ranked = [...healthy].sort((a, b) => {
				const la = this.rankLatency(a, member);
				const lb = this.rankLatency(b, member);
				if (la === lb) return 0;
				return la < lb ? -1 : 1;
			});
		}
		if (policy.strategy === "sticky") {
			ranked = this.applySticky(state, member, config, ranked, policy);
		}
		return [...ranked, ...cooling].map((e) => e.url);
	}

	private applySticky(
		state: PoolState,
		member: MemberState,
		config: EndpointPoolConfig,
		ranked: EndpointState[],
		policy: ResolvedEndpointPolicy,
	): EndpointState[] {
		const current = ranked.find((e) => e.url === member.preferred);
		const best = ranked[0];
		if (!current || !best) {
			// No usable sticky choice: fall back to configured order rather than an
			// unmeasured latency guess, so the primary keeps priority until data exists.
			const first = ranked.some((e) => this.rankLatency(e, member) !== Number.POSITIVE_INFINITY)
				? best
				: state.endpoints.find((e) => ranked.includes(e));
			if (!first) return ranked;
			member.preferred = first.url;
			return [first, ...ranked.filter((e) => e !== first)];
		}
		const currentLatency = this.rankLatency(current, member);
		const bestLatency = this.rankLatency(best, member);
		if (
			best !== current &&
			Number.isFinite(currentLatency) &&
			Number.isFinite(bestLatency) &&
			bestLatency < currentLatency * (1 - policy.stickySwitchRatio)
		) {
			logger.info("Provider endpoint switched to a faster mirror", {
				providerId: config.id,
				from: hostOf(current.url),
				to: hostOf(best.url),
				fromMs: Math.round(currentLatency),
				toMs: Math.round(bestLatency),
			});
			member.preferred = best.url;
			return ranked;
		}
		return [current, ...ranked.filter((e) => e !== current)];
	}

	recordSuccess(config: EndpointPoolConfig, url: string, latencyMs: number): void {
		const state = this.state(config);
		const endpoint = this.endpoint(state, url);
		if (!endpoint) return;
		const member = state.member;
		const entry = this.memberEndpoint(member, url);
		entry.requestEwma = ewma(entry.requestEwma, latencyMs);
		entry.upstream = newHealth();
		// A served request also proves the network path works.
		endpoint.network = newHealth();
		member.preferred = url;
	}

	recordFailure(
		config: EndpointPoolConfig,
		url: string,
		kind: EndpointFailureKind,
		message: string,
	): void {
		const state = this.state(config);
		const endpoint = this.endpoint(state, url);
		if (!endpoint) return;
		const member = state.member;
		// Connection failures describe the network path; HTTP and header failures
		// describe this provider's upstream response.
		const health =
			kind === "network" ? endpoint.network : this.memberEndpoint(member, url).upstream;
		health.lastError = message;
		// A 4xx is about the request or credentials, not the endpoint's health; a condition
		// the admin left unchecked must not move traffic either. Both are only reported.
		const policy = resolveEndpointPolicy(config.endpointPolicy);
		if (kind === "clientError" || !policy.failoverOn[kind]) return;
		health.consecutiveFailures += 1;
		const multiplier = Math.min(2 ** (health.consecutiveFailures - 1), MAX_COOLDOWN_MULTIPLIER);
		health.cooldownUntil = this.now() + policy.cooldownSec * 1000 * multiplier;
		if (member.preferred === url) member.preferred = null;
	}

	/**
	 * Fetch through the endpoint pool. `doFetch` is the provider's normal
	 * transport (proxy, TLS, diagnostics) and is called once per attempt.
	 */
	async fetch(
		config: EndpointPoolConfig,
		input: string | URL | Request,
		init: RequestInit | undefined,
		doFetch: FetchFn,
	): Promise<Response> {
		const urls = listProviderEndpoints(config);
		if (urls.length < 2 || input instanceof Request) return doFetch(input, init);
		const requested = String(input);
		const matched = matchEndpoint(requested, urls);
		if (!matched) return doFetch(input, init);

		const suffix = requested.slice(matched.length);
		const policy = resolveEndpointPolicy(config.endpointPolicy);
		const state = this.state(config);
		state.lastUsedAt = this.now();
		this.ensureProbing(state);

		const ordered = this.order(config);
		const attempts = isReplayableBody(init?.body) ? ordered : ordered.slice(0, 1);
		for (let index = 0; index < attempts.length; index++) {
			const endpoint = attempts[index];
			const isLast = index === attempts.length - 1;
			const controller = new AbortController();
			const signal = init?.signal
				? AbortSignal.any([init.signal, controller.signal])
				: controller.signal;
			let timedOut = false;
			const timer =
				!isLast && policy.failoverOn.timeout && policy.headerTimeoutMs > 0
					? setTimeout(() => {
							timedOut = true;
							controller.abort(new EndpointHeaderTimeoutError(policy.headerTimeoutMs));
						}, policy.headerTimeoutMs)
					: undefined;
			const startedAt = performance.now();
			try {
				const response = await doFetch(`${endpoint}${suffix}`, { ...init, signal });
				clearTimeout(timer);
				const kind = classifyStatus(response.status);
				if (!kind) {
					this.recordSuccess(config, endpoint, performance.now() - startedAt);
					return response;
				}
				this.recordFailure(config, endpoint, kind, `HTTP ${response.status}`);
				if (isLast || !policy.failoverOn[kind]) return response;
				void response.body?.cancel().catch(() => {});
				this.logFailover(config, endpoint, attempts[index + 1], kind, `HTTP ${response.status}`);
			} catch (error) {
				clearTimeout(timer);
				if (init?.signal?.aborted) throw error;
				const kind: EndpointFailureKind = timedOut ? "timeout" : "network";
				const message = timedOut
					? `No response headers within ${policy.headerTimeoutMs} ms`
					: errorMessage(error);
				this.recordFailure(config, endpoint, kind, message);
				if (isLast || !policy.failoverOn[kind]) throw error;
				this.logFailover(config, endpoint, attempts[index + 1], kind, message);
			}
		}
		// Unreachable: the last attempt always returns or throws.
		throw new Error("Endpoint failover exhausted without a result");
	}

	private logFailover(
		config: EndpointPoolConfig,
		from: string,
		to: string | undefined,
		kind: EndpointFailureKind,
		reason: string,
	): void {
		logger.warn("Provider endpoint failed over to the next mirror", {
			providerId: config.id,
			from: hostOf(from),
			to: to ? hostOf(to) : undefined,
			kind,
			reason,
		});
	}

	/** Probe every endpoint of a provider now. Concurrent calls share one round. */
	probeAll(config: EndpointPoolConfig): Promise<void> {
		const state = this.state(config);
		if (state.probing) return state.probing;
		state.lastProbeRoundAt = this.now();
		const round = Promise.all(
			state.endpoints.map(async (endpoint) => {
				try {
					const ms = await this.probe(
						endpoint.url,
						state.config,
						AbortSignal.timeout(PROBE_TIMEOUT_MS),
					);
					endpoint.probeEwma = ewma(endpoint.probeEwma, ms);
					endpoint.lastProbeAt = this.now();
				} catch (error) {
					endpoint.lastProbeAt = this.now();
					// A probe that cannot get any answer means the host is unreachable; this is
					// not the request-header timeout, which is about slow upstream work.
					this.recordFailure(
						state.config,
						endpoint.url,
						"network",
						`probe: ${errorMessage(error)}`,
					);
				}
			}),
		).then(() => undefined);
		state.probing = round.finally(() => {
			state.probing = null;
		});
		return state.probing;
	}

	/** Status for the settings UI. Does not create state or probe. */
	status(config: EndpointPoolConfig): ProviderEndpointsStatus {
		const policy = resolveEndpointPolicy(config.endpointPolicy);
		const urls = listProviderEndpoints(config);
		const state = this.pools.get(config.id);
		const live = state && state.signature === urls.join("\n") ? state : undefined;
		const member = live?.member;
		const preferred = live && urls.length > 1 ? this.order(config)[0] : urls[0];
		const now = this.now();
		const endpoints: EndpointStatus[] = urls.map((url) => {
			const e = live?.endpoints.find((candidate) => candidate.url === url);
			const own = member?.endpoints.get(url);
			const cooldownUntil = Math.max(
				e?.network.cooldownUntil ?? 0,
				own?.upstream.cooldownUntil ?? 0,
			);
			return {
				url,
				probeLatencyMs: e?.probeEwma != null ? Math.round(e.probeEwma) : null,
				requestLatencyMs: own?.requestEwma != null ? Math.round(own.requestEwma) : null,
				healthy: cooldownUntil <= now,
				cooldownUntil: cooldownUntil > now ? cooldownUntil : null,
				consecutiveFailures:
					(e?.network.consecutiveFailures ?? 0) + (own?.upstream.consecutiveFailures ?? 0),
				lastError: own?.upstream.lastError ?? e?.network.lastError ?? null,
				lastProbeAt: e?.lastProbeAt ?? null,
				preferred: url === preferred,
			};
		});
		return { providerId: config.id, strategy: policy.strategy, endpoints };
	}

	private ensureProbing(state: PoolState): void {
		if (!this.autoProbe) return;
		const policy = resolveEndpointPolicy(state.config.endpointPolicy);
		// First use of a pool: measure right away so ranking has data early.
		if (policy.probeIntervalSec > 0 && state.lastProbeRoundAt === 0) {
			void this.probeAll(state.config);
		}
	}

	private ensureTimer(): void {
		if (!this.autoProbe || this.timer) return;
		this.timer = setInterval(() => this.tick(), PROBE_TICK_MS);
		(this.timer as { unref?: () => void }).unref?.();
	}

	/**
	 * Periodic maintenance (public for tests): probe pools in use, and forget pools
	 * nobody has used or probed for a while. Deleted providers fall out this way, so
	 * the pool never needs to watch settings changes.
	 */
	tick(): void {
		const now = this.now();
		for (const [key, state] of this.pools) {
			if (now - Math.max(state.lastUsedAt, state.lastProbeRoundAt) > PROBE_IDLE_MS) {
				this.pools.delete(key);
				continue;
			}
			const policy = resolveEndpointPolicy(state.config.endpointPolicy);
			if (policy.probeIntervalSec <= 0 || state.endpoints.length < 2) continue;
			if (now - state.lastUsedAt > PROBE_IDLE_MS) continue;
			if (now - state.lastProbeRoundAt < policy.probeIntervalSec * 1000) continue;
			void this.probeAll(state.config);
		}
		if (this.pools.size === 0 && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.pools.clear();
	}
}

export const endpointPool = new EndpointPool();

export function fetchWithEndpointFailover(
	config: EndpointPoolConfig,
	input: string | URL | Request,
	init: RequestInit | undefined,
	doFetch: FetchFn,
): Promise<Response> {
	return endpointPool.fetch(config, input, init, doFetch);
}
