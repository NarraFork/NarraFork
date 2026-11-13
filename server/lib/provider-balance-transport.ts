import { outboundFetch } from "./net/outbound-fetch";
import { resolveProxyForUrl } from "./net/proxy";
import {
	type BalanceAuth,
	type BalanceFailureKind,
	BalanceProbeRequestError,
	type BalanceRequest,
} from "./provider-balance-adapters";
import type { CustomApiProviderConfig } from "./settings";
import { getHttpUserAgent, resolveHttpUserAgent } from "./user-agent";

export const BALANCE_MAX_RESPONSE_BYTES = 64 * 1024;
export const BALANCE_REQUEST_TIMEOUT_MS = 8_000;

/** An abort-ignoring transport must not hold a queue slot or publish a late response. */
function abortable<T>(
	promise: Promise<T>,
	signal: AbortSignal,
	late?: (value: T) => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const abort = () => {
			if (settled) return;
			settled = true;
			reject(new BalanceProbeRequestError("transient"));
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				if (settled) late?.(value);
				else {
					settled = true;
					resolve(value);
				}
			},
			() => {
				signal.removeEventListener("abort", abort);
				if (!settled) {
					settled = true;
					reject(new BalanceProbeRequestError("transient"));
				}
			},
		);
	});
}

const HOP_BY_HOP_HEADERS = new Set([
	"host",
	"connection",
	"content-length",
	"transfer-encoding",
	"proxy-authorization",
	"proxy-connection",
	"upgrade",
	"keep-alive",
	"trailer",
	"te",
]);

export function balanceRequestHeaders(config: CustomApiProviderConfig, auth: BalanceAuth): Headers {
	const userAgent = resolveHttpUserAgent({
		mode: config.userAgentMode,
		custom: config.customUserAgent,
		fallback: getHttpUserAgent(),
	});
	// Public site metadata must not receive even a credential-bearing custom header.
	if (auth === "none") return new Headers({ Accept: "application/json" });
	/**
	 * The site-account query authenticates as the *site*, not as the inference key. It also
	 * deliberately carries none of the provider's custom headers: those are tuned for the
	 * inference endpoint and may name a different credential or host.
	 */
	if (auth === "site-token") {
		return new Headers({
			Authorization: `Bearer ${config.quotaAccessToken?.trim() ?? ""}`,
			"New-Api-User": config.quotaUserId?.trim() ?? "",
			"User-Agent": userAgent,
			Accept: "application/json",
		});
	}
	const headers = new Headers({
		Authorization: `Bearer ${config.apiKey}`,
		"User-Agent": userAgent,
	});
	const extra = new Headers(config.extraHeaders);
	const blocked = new Set(HOP_BY_HOP_HEADERS);
	for (const name of (extra.get("Connection") ?? "").split(",")) {
		const normalized = name.trim().toLowerCase();
		if (normalized) blocked.add(normalized);
	}
	for (const [name, value] of extra) {
		if (!blocked.has(name.toLowerCase())) headers.set(name, value);
	}
	for (const name of blocked) headers.delete(name);
	headers.set("Accept", "application/json");
	return headers;
}

/**
 * Origins this provider may be asked for a balance.
 *
 * The inference base URL is the historical single answer. A separately configured site root is
 * its own origin (a site's dashboard API and its inference endpoints can be different hosts), so it
 * is allowed as a second, explicit destination — never an arbitrary one.
 */
function allowedOrigins(config: CustomApiProviderConfig): Set<string> {
	const origins = new Set<string>();
	for (const value of [config.baseUrl, config.quotaSiteUrl]) {
		if (typeof value !== "string" || value.length === 0) continue;
		try {
			origins.add(new URL(value).origin);
		} catch {
			// An unusable URL contributes no origin; the caller reports invalid_configuration.
		}
	}
	return origins;
}

/**
 * Map a non-2xx answer onto a failure kind.
 *
 * The legacy endpoints keep their original reading (404/405 means "no such endpoint here").
 * The site-account endpoint is a fixed path, so a 404 there means the site root is wrong, and
 * 401/403 mean the token or user id was rejected — both deterministic, never retried blindly.
 */
function statusFailureKind(status: number, auth: BalanceAuth): BalanceFailureKind {
	if (auth === "site-token") {
		if (status === 401 || status === 403) return "auth";
		if (status === 429 || status >= 500) return "transient";
		return "invalid_response";
	}
	return status === 404 || status === 405 ? "unsupported" : "transient";
}

export function createBalanceRequest(
	config: CustomApiProviderConfig,
	roundSignal: AbortSignal,
	options: {
		fetch?: typeof outboundFetch;
		requestTimeoutMs?: number;
	} = {},
): BalanceRequest {
	const fetcher = options.fetch ?? outboundFetch;
	const origins = allowedOrigins(config);
	return async (url, auth = "provider-key") => {
		const target = new URL(url);
		if (
			!origins.has(target.origin) ||
			target.username ||
			target.password ||
			target.search ||
			target.hash ||
			url.length > 4096
		) {
			throw new BalanceProbeRequestError("unsupported");
		}
		const controller = new AbortController();
		const signal = AbortSignal.any([roundSignal, controller.signal]);
		const timer = setTimeout(
			() => controller.abort(),
			options.requestTimeoutMs ?? BALANCE_REQUEST_TIMEOUT_MS,
		);
		let response: Response | undefined;
		try {
			if (signal.aborted) throw new BalanceProbeRequestError("transient");
			response = await abortable(
				fetcher(
					url,
					{
						method: "GET",
						headers: balanceRequestHeaders(config, auth),
						redirect: "error",
						signal,
					},
					{
						proxyUrl: resolveProxyForUrl(url, config.proxy),
						tlsRejectUnauthorized: config.tlsRejectUnauthorized,
						retryPolicy: "never",
					},
				),
				signal,
				(late) => void late.body?.cancel().catch(() => {}),
			);
			if (!response.ok) {
				throw new BalanceProbeRequestError(statusFailureKind(response.status, auth));
			}
			const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
			if (contentType && contentType !== "application/json" && !contentType.endsWith("+json")) {
				// On a fixed site path a non-JSON 200 is a wrong answer, not a missing endpoint.
				throw new BalanceProbeRequestError(
					auth === "site-token" ? "invalid_response" : "unsupported",
				);
			}
			const declaredLength = Number(response.headers.get("content-length"));
			if (declaredLength > BALANCE_MAX_RESPONSE_BYTES) {
				throw new BalanceProbeRequestError("transient");
			}
			const reader = response.body?.getReader();
			if (!reader) throw new BalanceProbeRequestError("unsupported");
			const chunks: Uint8Array[] = [];
			let length = 0;
			const cancel = () => void reader.cancel().catch(() => {});
			signal.addEventListener("abort", cancel, { once: true });
			try {
				while (true) {
					const { value, done } = await abortable(reader.read(), signal);
					if (done) break;
					length += value.byteLength;
					if (length > BALANCE_MAX_RESPONSE_BYTES) {
						throw new BalanceProbeRequestError("transient");
					}
					chunks.push(value);
				}
				const bytes = new Uint8Array(length);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				if (signal.aborted) throw new BalanceProbeRequestError("transient");
				try {
					return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
				} catch {
					throw new BalanceProbeRequestError(
						auth === "site-token" ? "invalid_response" : "unsupported",
					);
				}
			} finally {
				signal.removeEventListener("abort", cancel);
				cancel();
				reader.releaseLock();
			}
		} catch (error) {
			if (error instanceof BalanceProbeRequestError) throw error;
			throw new BalanceProbeRequestError("transient");
		} finally {
			clearTimeout(timer);
			if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
		}
	};
}
