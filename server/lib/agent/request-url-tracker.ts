import { AsyncLocalStorage } from "node:async_hooks";

/** A single captured outbound request. */
export interface CapturedRequest {
	url: string;
	method: string;
}

/** Per-call collector for outbound request URLs. */
type UrlStore = CapturedRequest[];

const storage = new AsyncLocalStorage<UrlStore>();

/** Max number of URLs to retain per capture (bounds memory on long failover loops). */
const MAX_CAPTURED_URLS = 100;

/**
 * Record an outbound request URL if we are inside a capture context.
 *
 * Called from every provider `pfetch` (the single outbound `fetch` chokepoint).
 * Outside a capture context this is a single `getStore()` null-check, so it adds
 * negligible overhead to normal narrator runs.
 */
export function recordRequestUrl(url: string, method?: string): void {
	const store = storage.getStore();
	if (!store) return;
	if (store.length >= MAX_CAPTURED_URLS) return;
	store.push({ url, method: (method ?? "GET").toUpperCase() });
}

/**
 * Create a capture scope. Run the given async function inside `run`; every
 * outbound request URL issued during it (across any provider, including retries
 * and `/v1` fallbacks) is collected into `urls`, readable whether the function
 * resolves or throws.
 */
export function createUrlCapture(): {
	urls: CapturedRequest[];
	run<T>(fn: () => Promise<T>): Promise<T>;
} {
	const urls: UrlStore = [];
	return {
		urls,
		run: (fn) => storage.run(urls, fn),
	};
}
