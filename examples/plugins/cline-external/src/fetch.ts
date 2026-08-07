/**
 * Proxy-aware fetch for this plugin's outbound calls.
 *
 * ## Why the plugin implements its own
 *
 * The host has two proxy layers and neither is usable here:
 *
 * - `server/lib/net/proxy.ts` imports `../settings`, which transitively reaches the
 *   settings barrel, Drizzle and `bun:sqlite`. Bundling that into a plugin would pull the
 *   whole host into a process that is supposed to be independent of it.
 *   does not use.
 *
 * So the proxy is applied here, from the value the host sends in `hostHints` on every
 * provider call (see `host-hints.ts`).
 *
 * ## Why agents are cached
 *
 * `ProxyAgent` owns a connection pool. Constructing one per request would discard keep-alive
 * and pay a fresh TLS handshake to the proxy on every call. The host sends the same proxy
 * for every request, so a single-entry cache keyed by URL is enough; a changed proxy
 * replaces the entry and the previous agent is closed so its sockets are not leaked.
 */

import { ProxyAgent } from "undici";

let cached: { url: string; agent: ProxyAgent } | undefined;

/**
 * The agent for `url`, reusing the cached one when the proxy has not changed.
 *
 * Closing the superseded agent is fire-and-forget: a close failure must not fail the
 * request that triggered the swap, and the process exits soon enough that a leaked socket
 * on that path is bounded.
 */
function agentFor(url: string): ProxyAgent {
	if (cached?.url === url) return cached.agent;
	const previous = cached?.agent;
	const agent = new ProxyAgent(url);
	cached = { url, agent };
	if (previous) void previous.close().catch(() => undefined);
	return agent;
}

/** Drop the cached agent. Called on deactivate so a restart does not reuse a stale pool. */
export function resetProxyAgents(): void {
	const previous = cached?.agent;
	cached = undefined;
	if (previous) void previous.close().catch(() => undefined);
}

/**
 * Default ceiling on how long one request may go without a response.
 *
 * Applies to the non-streaming calls (token refresh, user info, balance, model catalogs),
 * which are awaited by a command the user is waiting on and carry no signal of their own. An
 * upstream that accepts the connection and then says nothing would otherwise hang that command
 * forever. Streaming calls pass their operation's signal instead, because a long-running
 * completion is not a stall — see `startChat`.
 *
 * 60s is generous for endpoints that return a small JSON body; the point is that a hang ends.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * A request was abandoned because upstream did not respond in time.
 *
 * Distinct from `AbortError` on purpose: an abort means the user or the host cancelled, which
 * `classifyClineError` reports as `cancelled` and the host treats as an intentional stop. A
 * timeout is an upstream failure and must surface as a retryable transport error instead.
 */
export class RequestTimeoutError extends Error {
	override readonly name = "RequestTimeoutError";
	constructor(url: string, timeoutMs: number) {
		// Only the origin and path are included: query strings on these endpoints can carry
		// identifiers, and this message reaches logs.
		super(`request to ${safeLabel(url)} timed out after ${timeoutMs}ms`);
	}
}

/** Origin + pathname only, so a message never leaks query parameters or credentials. */
function safeLabel(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "upstream";
	}
}

/**
 * `fetch` with the host's proxy applied when there is one.
 *
 * A caller-supplied `signal` (a streaming operation's cancellation) takes precedence and is
 * used as-is. Without one, a `DEFAULT_REQUEST_TIMEOUT_MS` abort is attached so no call can
 * hang indefinitely; pass `timeoutMs: 0` to opt out deliberately.
 *
 * The timeout covers reaching a response, not draining its body — the timer is cleared once
 * headers arrive, so a slow-but-progressing download is not cut off mid-flight.
 *
 * SECURITY: `proxyUrl` may carry credentials in its userinfo component. It is never logged
 * and never returned; it only reaches `ProxyAgent`.
 */
export async function pfetch(
	url: string,
	init: RequestInit | undefined,
	proxyUrl: string | undefined,
	options?: { timeoutMs?: number },
): Promise<Response> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	// `dispatcher` is an undici extension to RequestInit that Bun honours. It is not in the
	// DOM types, hence the cast.
	const dispatched = (extra?: RequestInit): RequestInit =>
		({
			...init,
			...extra,
			...(proxyUrl ? { dispatcher: agentFor(proxyUrl) } : {}),
		}) as RequestInit;

	if (init?.signal || timeoutMs <= 0) return fetch(url, dispatched());

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		return await fetch(url, dispatched({ signal: controller.signal }));
	} catch (error) {
		// Translate our own abort, so a stall is not reported to the host as a cancellation.
		if (timedOut) throw new RequestTimeoutError(url, timeoutMs);
		throw error;
	} finally {
		// Cleared on both paths: a completed request must not leave a pending timer holding
		// the event loop open, and a fired one has nothing left to cancel.
		clearTimeout(timer);
	}
}
