import { AsyncLocalStorage } from "node:async_hooks";

export type NetworkErrorCategory =
	| "http"
	| "dns"
	| "connection_refused"
	| "connection_reset"
	| "timeout"
	| "tls"
	| "proxy"
	| "aborted"
	| "network";

export interface CapturedErrorDetails {
	name?: string;
	message: string;
	category?: NetworkErrorCategory;
	code?: string;
	errno?: string | number;
	syscall?: string;
	path?: string;
	address?: string;
	port?: string | number;
	hostname?: string;
	status?: number;
	reason?: string;
	cause?: CapturedErrorDetails;
}

/** A bounded, sanitized outbound request attempt captured for diagnostics. */
export interface CapturedRequest {
	sequence: number;
	url: string;
	method: string;
	route?: "direct" | "proxy";
	proxyUrl?: string;
	requestBodyBytes?: number;
	verbose?: boolean;
	durationMs?: number;
	outcome?: "success" | "http_error" | "network_error" | "aborted";
	category?: NetworkErrorCategory;
	status?: number;
	statusText?: string;
	responseHeaders?: Record<string, string>;
	error?: CapturedErrorDetails;
}

/** Per-call collector for outbound request attempts. */
type UrlStore = CapturedRequest[];

interface CaptureStore {
	requests: UrlStore;
	verbose: boolean;
}

const storage = new AsyncLocalStorage<CaptureStore>();

/** Max number of attempts to retain per capture (bounds memory on failover loops). */
const MAX_CAPTURED_URLS = 100;

/**
 * Start recording a request attempt inside the current capture scope. The returned
 * callback mutates that bounded entry once the request resolves or rejects.
 */
export function recordRequestAttempt(
	request: Omit<CapturedRequest, "sequence">,
): ((update: Partial<CapturedRequest>) => void) | undefined {
	const store = storage.getStore();
	if (!store || store.requests.length >= MAX_CAPTURED_URLS) return undefined;
	const entry: CapturedRequest = { sequence: store.requests.length + 1, ...request };
	store.requests.push(entry);
	let completed = false;
	return (update) => {
		if (completed) return;
		completed = true;
		Object.assign(entry, update);
	};
}

/** Backwards-compatible URL-only capture for callers not yet using diagnostic fetch. */
export function recordRequestUrl(url: string, method?: string): void {
	recordRequestAttempt({ url, method: (method ?? "GET").toUpperCase() });
}

/** Whether the current async capture explicitly allows raw HTTP verbose output. */
export function isVerboseRequestCaptureEnabled(): boolean {
	return storage.getStore()?.verbose ?? false;
}

/**
 * Create a capture scope. `requests` is the preferred name; `urls` remains an
 * alias for existing API consumers. Verbose is opt-in because the transport writes
 * raw headers (including Authorization) directly to stdout.
 */
export function createUrlCapture(options: { verbose?: boolean } = {}): {
	urls: CapturedRequest[];
	requests: CapturedRequest[];
	verbose: boolean;
	run<T>(fn: () => Promise<T>): Promise<T>;
} {
	const requests: UrlStore = [];
	const verbose = options.verbose === true;
	return {
		urls: requests,
		requests,
		verbose,
		run: (fn) => storage.run({ requests, verbose }, fn),
	};
}
