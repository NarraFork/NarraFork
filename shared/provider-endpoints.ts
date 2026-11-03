/**
 * Multi-endpoint settings for custom API providers.
 *
 * A provider keeps its primary `baseUrl`; `baseUrls` lists extra mirrors that
 * serve the same API under the same path layout. The server picks one per
 * request according to `ProviderEndpointPolicy` and fails over to the others
 * before a response starts. Shared so the settings UI and the server agree on
 * defaults and on what counts as "the endpoint list".
 */

import { z } from "zod";

/**
 * - `sticky`: keep the current endpoint until it fails or another one is
 *   consistently faster by `stickySwitchRatio` (protects upstream prompt caches).
 * - `lowest-latency`: always prefer the lowest measured latency.
 * - `ordered`: primary first, mirrors in listed order; latency is ignored.
 */
export type EndpointSelectionStrategy = "sticky" | "lowest-latency" | "ordered";

export interface EndpointFailoverConditions {
	/** Connection refused/reset, DNS or TLS failure. */
	network?: boolean;
	/** No response headers within `headerTimeoutMs`. */
	timeout?: boolean;
	/** HTTP 5xx. */
	serverError?: boolean;
	/** HTTP 429. */
	rateLimit?: boolean;
	/** Any other HTTP 4xx (401/403/404/400…). Retries the next endpoint without marking it unhealthy. */
	clientError?: boolean;
}

export interface ProviderEndpointPolicy {
	strategy?: EndpointSelectionStrategy;
	/** Sticky only: switch when another endpoint is this much faster (0.3 = 30%). */
	stickySwitchRatio?: number;
	failoverOn?: EndpointFailoverConditions;
	/** Abort an attempt that has not received headers after this long; 0 disables. */
	headerTimeoutMs?: number;
	/** Base time an endpoint stays out of rotation after a failure. */
	cooldownSec?: number;
	/** Active latency probe interval; 0 disables probing (passive measurement only). */
	probeIntervalSec?: number;
}

export type ResolvedEndpointPolicy = Required<Omit<ProviderEndpointPolicy, "failoverOn">> & {
	failoverOn: Required<EndpointFailoverConditions>;
};

export const DEFAULT_ENDPOINT_POLICY: ResolvedEndpointPolicy = {
	strategy: "sticky",
	stickySwitchRatio: 0.3,
	failoverOn: {
		network: true,
		// Off by default: an upstream that is merely slow (large prompt, gateway that sends
		// headers with the first token) has usually started billing, so resending it to a
		// mirror pays twice. Admins whose gateways send headers early can opt in.
		timeout: false,
		serverError: true,
		rateLimit: true,
		clientError: false,
	},
	headerTimeoutMs: 30_000,
	cooldownSec: 60,
	probeIntervalSec: 300,
};

export const ENDPOINT_POLICY_LIMITS = {
	maxBaseUrls: 16,
	headerTimeoutMs: { min: 0, max: 600_000 },
	cooldownSec: { min: 0, max: 3600 },
	/** Values between 1 and `min` are rounded up so probes cannot hammer an upstream. */
	probeIntervalSec: { min: 30, max: 86_400 },
	stickySwitchRatio: { min: 0, max: 0.95 },
} as const;

/** An http(s) URL without embedded credentials: the only form a provider endpoint may take. */
export function isHttpEndpointUrl(value: string): boolean {
	try {
		const url = new URL(value.trim());
		return (
			(url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
		);
	} catch {
		return false;
	}
}

/** Wire validation for one endpoint URL (mirrors in settings, URLs in import payloads). */
export const endpointUrlSchema = z
	.string()
	.trim()
	.max(500)
	.refine(isHttpEndpointUrl, "must be an http(s) URL without credentials");

/** Wire validation for `endpointPolicy`, shared by the settings PATCH and provider import. */
export const endpointPolicySchema = z.object({
	strategy: z.enum(["sticky", "lowest-latency", "ordered"]).optional(),
	stickySwitchRatio: z
		.number()
		.min(ENDPOINT_POLICY_LIMITS.stickySwitchRatio.min)
		.max(ENDPOINT_POLICY_LIMITS.stickySwitchRatio.max)
		.optional(),
	failoverOn: z
		.object({
			network: z.boolean().optional(),
			timeout: z.boolean().optional(),
			serverError: z.boolean().optional(),
			rateLimit: z.boolean().optional(),
			clientError: z.boolean().optional(),
		})
		.optional(),
	headerTimeoutMs: z
		.number()
		.int()
		.min(ENDPOINT_POLICY_LIMITS.headerTimeoutMs.min)
		.max(ENDPOINT_POLICY_LIMITS.headerTimeoutMs.max)
		.optional(),
	cooldownSec: z
		.number()
		.int()
		.min(ENDPOINT_POLICY_LIMITS.cooldownSec.min)
		.max(ENDPOINT_POLICY_LIMITS.cooldownSec.max)
		.optional(),
	probeIntervalSec: z
		.number()
		.int()
		.min(0)
		.max(ENDPOINT_POLICY_LIMITS.probeIntervalSec.max)
		.optional(),
});

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function resolveEndpointPolicy(policy?: ProviderEndpointPolicy): ResolvedEndpointPolicy {
	const d = DEFAULT_ENDPOINT_POLICY;
	const limits = ENDPOINT_POLICY_LIMITS;
	const probe = finiteOr(policy?.probeIntervalSec, d.probeIntervalSec);
	return {
		strategy: policy?.strategy ?? d.strategy,
		stickySwitchRatio: clamp(
			finiteOr(policy?.stickySwitchRatio, d.stickySwitchRatio),
			limits.stickySwitchRatio.min,
			limits.stickySwitchRatio.max,
		),
		failoverOn: { ...d.failoverOn, ...policy?.failoverOn },
		headerTimeoutMs: clamp(
			finiteOr(policy?.headerTimeoutMs, d.headerTimeoutMs),
			limits.headerTimeoutMs.min,
			limits.headerTimeoutMs.max,
		),
		cooldownSec: clamp(
			finiteOr(policy?.cooldownSec, d.cooldownSec),
			limits.cooldownSec.min,
			limits.cooldownSec.max,
		),
		probeIntervalSec:
			probe <= 0 ? 0 : clamp(probe, limits.probeIntervalSec.min, limits.probeIntervalSec.max),
	};
}

/** Trim and drop trailing slashes so prefix matching against built URLs is exact. */
export function normalizeEndpointUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

/** Primary first, then mirrors; blanks and duplicates removed. */
export function listProviderEndpoints(config: { baseUrl?: string; baseUrls?: string[] }): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of [config.baseUrl ?? "", ...(config.baseUrls ?? [])]) {
		const url = normalizeEndpointUrl(raw);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		out.push(url);
	}
	return out;
}

/** Live state of one endpoint as reported to the settings UI. */
export interface EndpointStatus {
	url: string;
	/** Smoothed probe round-trip (comparable across endpoints). */
	probeLatencyMs: number | null;
	/** Smoothed time-to-headers of real requests (includes upstream processing). */
	requestLatencyMs: number | null;
	healthy: boolean;
	/** Epoch ms until which the endpoint is out of rotation. */
	cooldownUntil: number | null;
	consecutiveFailures: number;
	lastError: string | null;
	lastProbeAt: number | null;
	/** True for the endpoint the next request will try first. */
	preferred: boolean;
}

export interface ProviderEndpointsStatus {
	providerId: string;
	strategy: EndpointSelectionStrategy;
	endpoints: EndpointStatus[];
}
