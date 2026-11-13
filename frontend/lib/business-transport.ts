import type {
	BusinessTransport,
	BusinessUploadOptions,
} from "@shared/remote-access/business-transport";
import { leaveForStartupPageIfStarting } from "./pwa";
import { buildWsUrl } from "./ws";

/** Native implementation. The remote build substitutes this entire module. */
export const businessTransport: BusinessTransport = {
	async request(path, init) {
		const response = await fetch(path, init);
		leaveForStartupPageIfStarting(response);
		return response;
	},
	upload: nativeUpload,
	openSocket(path, credential) {
		return new WebSocket(buildWsUrl(path, credential));
	},
};

function nativeUpload(
	path: string,
	body: BodyInit,
	options?: BusinessUploadOptions,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const signal = options?.signal;
		if (signal?.aborted) return reject(new DOMException("Upload cancelled", "AbortError"));
		const xhr = new XMLHttpRequest();
		xhr.open("POST", path);
		const headers = new Headers(options?.headers);
		if (body instanceof FormData) headers.delete("content-type");
		headers.forEach((value, key) => {
			xhr.setRequestHeader(key, value);
		});
		if (options?.onProgress) {
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable && event.total > 0)
					options.onProgress?.(event.loaded / event.total);
			};
		}
		const abort = () => xhr.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const cleanup = () => signal?.removeEventListener("abort", abort);
		xhr.onload = () => {
			cleanup();
			const responseHeaders = new Headers();
			for (const line of xhr
				.getAllResponseHeaders()
				.trim()
				.split(/[\r\n]+/)) {
				const index = line.indexOf(":");
				if (index > 0)
					responseHeaders.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
			}
			resolve(
				new Response([204, 205, 304].includes(xhr.status) ? null : xhr.responseText, {
					status: xhr.status,
					statusText: xhr.statusText,
					headers: responseHeaders,
				}),
			);
		};
		xhr.onerror = () => {
			cleanup();
			reject(new TypeError("Network request failed"));
		};
		xhr.ontimeout = () => {
			cleanup();
			reject(new DOMException("Request timed out", "TimeoutError"));
		};
		xhr.onabort = () => {
			cleanup();
			reject(new DOMException("Upload cancelled", "AbortError"));
		};
		xhr.send(body as XMLHttpRequestBodyInit);
	});
}
