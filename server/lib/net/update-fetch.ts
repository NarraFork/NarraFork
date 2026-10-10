import { createHash } from "node:crypto";
import { settings } from "../settings";
import { OutboundProxyConfigurationError, outboundFetch } from "./outbound-fetch";
import { applyProxyExemptions, resolveOverride } from "./proxy";
import { ambientNoProxy } from "./proxy-env";

export interface UpdateFetchContext {
	/** Internal transport cache key; never persist or return proxy credentials. */
	key: string;
	fetch(url: string, init?: RequestInit): Promise<Response>;
	isCurrent(): boolean;
}

function capturePolicy() {
	const override = settings.update?.proxy;
	const policy = !override || override.mode === "default" ? settings.proxy : override;
	if (policy?.mode === "custom" && !policy.url?.trim())
		throw new OutboundProxyConfigurationError({ code: "INVALID_OUTBOUND_PROXY_URL" });
	const proxy = resolveOverride(override);
	const key = createHash("sha256")
		.update(JSON.stringify([proxy ?? null, ambientNoProxy()]))
		.digest("hex");
	return { proxy, key };
}

/** Freeze a request family's policy; redirects still apply target-specific exemptions. */
export function createUpdateFetchContext(): UpdateFetchContext {
	const { proxy, key } = capturePolicy();
	return {
		key,
		fetch: async (url, init) => {
			try {
				// Bun-specific init fields cannot relax the update trust boundary.
				const securedInit = { ...init, tls: { rejectUnauthorized: true } };
				return await outboundFetch(url, securedInit, {
					proxyUrl: applyProxyExemptions(proxy, url),
					tlsRejectUnauthorized: true,
					retryPolicy: "never",
				});
			} catch (error) {
				if (init?.signal?.aborted) throw init.signal.reason;
				if (error instanceof OutboundProxyConfigurationError) throw error;
				// Native proxy errors may contain userinfo. Do not expose them to logs/UI.
				throw new Error("Update transport request failed");
			}
		},
		isCurrent: () => {
			try {
				return key === capturePolicy().key;
			} catch {
				return false;
			}
		},
	};
}

/** Single-request adapter. Multi-request operations should capture one context instead. */
export function updateFetch(url: string, init?: RequestInit): Promise<Response> {
	return createUpdateFetchContext().fetch(url, init);
}

/** Legacy tools and update-server requests never follow a redirect to another authority. */
export async function fetchUpdateSameOrigin(
	url: string,
	init: RequestInit = {},
	context: UpdateFetchContext = createUpdateFetchContext(),
): Promise<Response> {
	const initial = new URL(url);
	if (!["http:", "https:"].includes(initial.protocol) || initial.username || initial.password)
		throw new Error("Invalid update request URL");
	let current = initial;
	for (let redirects = 0; redirects <= 5; redirects++) {
		init.signal?.throwIfAborted();
		const response = await context.fetch(current.toString(), { ...init, redirect: "manual" });
		if (response.redirected || (response.url && response.url !== current.toString())) {
			await response.body?.cancel().catch(() => {});
			throw new Error("Unexpected update request redirect");
		}
		if (![301, 302, 303, 307, 308].includes(response.status)) return response;
		await response.body?.cancel().catch(() => {});
		const location = response.headers.get("location");
		if (!location || redirects === 5) throw new Error("Update redirect limit reached");
		const next = new URL(location, current);
		if (next.origin !== initial.origin || next.username || next.password)
			throw new Error("Untrusted update request redirect");
		current = next;
	}
	throw new Error("Update redirect limit reached");
}

export async function readUpdateJson(response: Response, maxBytes = 1024 * 1024): Promise<unknown> {
	const declared = response.headers.get("content-length");
	if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
		void response.body?.cancel().catch(() => {});
		throw new Error("Update metadata exceeds size limit");
	}
	if (!response.body) throw new Error("Missing update metadata body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let total = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw new Error("Update metadata exceeds size limit");
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return JSON.parse(text);
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function waitForUpdate<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new DOMException("Update cancelled", "AbortError"));
		signal.addEventListener("abort", abort, { once: true });
		value.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** The timeout and parent cancellation remain active until the response body is finished. */
export async function fetchUpdateWithTimeout(
	url: string,
	options: { timeoutMs: number; signal?: AbortSignal; transport?: UpdateFetchContext },
): Promise<Response> {
	options.signal?.throwIfAborted();
	const controller = new AbortController();
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;
	const timeout = setTimeout(
		() => controller.abort(new DOMException("Update request timed out", "TimeoutError")),
		options.timeoutMs,
	);
	let disposed = false;
	const dispose = () => {
		if (!disposed) {
			disposed = true;
			clearTimeout(timeout);
		}
	};
	try {
		const pending = fetchUpdateSameOrigin(url, { signal }, options.transport);
		void pending.then(
			(response) => {
				if (signal.aborted) void response.body?.cancel().catch(() => {});
			},
			() => {},
		);
		const response = await waitForUpdate(pending, signal);
		if (!response.body) {
			dispose();
			return response;
		}
		const reader = response.body.getReader();
		let bodyController: ReadableStreamDefaultController<Uint8Array>;
		const abort = () => {
			dispose();
			void reader.cancel().catch(() => {});
			bodyController.error(signal.reason ?? new DOMException("Update cancelled", "AbortError"));
		};
		const finish = () => {
			dispose();
			signal.removeEventListener("abort", abort);
		};
		const body = new ReadableStream<Uint8Array>(
			{
				start(stream) {
					bodyController = stream;
					signal.addEventListener("abort", abort, { once: true });
					if (signal.aborted) abort();
				},
				async pull(stream) {
					try {
						const next = await waitForUpdate(reader.read(), signal);
						if (next.done) {
							finish();
							stream.close();
						} else stream.enqueue(next.value);
					} catch (error) {
						finish();
						stream.error(error);
						void reader.cancel().catch(() => {});
					}
				},
				cancel(reason) {
					finish();
					void reader.cancel(reason).catch(() => {});
				},
			},
			{ highWaterMark: 0 },
		);
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		dispose();
		throw error;
	}
}
