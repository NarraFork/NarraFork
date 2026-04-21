import { ApiError, BASE, getToken } from "./client";
import type { StorageCategoryResult, StorageScanResult } from "./types";

	text: string,
	model?: string,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	const token = getToken();
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ text, model }),
		signal,
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(err.error ?? "Request failed");
	}
	if (!res.body) throw new Error("No response body");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let currentEvent = "chunk";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });

		const lines = buf.split("\n");
		buf = lines.pop() ?? "";

		for (const line of lines) {
			if (line.startsWith("event:")) {
				currentEvent = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				const data = line.slice(5).trimStart();
				if (currentEvent === "error") throw new Error(data || "Unknown error");
				if (currentEvent === "done") return;
				yield data;
			}
		}
	}
}

/**
 * Scan storage via SSE stream.
 * Calls onProgress for status updates, onCategory for each scanned category,
 * and resolves with the complete result.
 */
export function scanStorageStream(callbacks: {
	onProgress?: (message: string) => void;
	onCategory?: (data: StorageCategoryResult) => void;
	signal?: AbortSignal;
}): Promise<StorageScanResult> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;

		fetch(`${BASE}/storage/scan`, { headers, signal: callbacks.signal })
			.then((response) => {
				if (!response.ok) {
					reject(new ApiError("Scan failed", response.status));
					return;
				}
				const reader = response.body?.getReader();
				if (!reader) {
					reject(new ApiError("No response body", 500));
					return;
				}

				const decoder = new TextDecoder();
				let buffer = "";

				const pump = (): void => {
					reader
						.read()
						.then(({ done, value }) => {
							if (done) return;
							buffer += decoder.decode(value, { stream: true });
							const lines = buffer.split("\n");
							buffer = lines.pop() ?? "";

							let eventType = "";
							for (const line of lines) {
								if (line.startsWith("event:")) {
									eventType = line.slice(6).trim();
								} else if (line.startsWith("data:")) {
									const jsonStr = line.slice(5).trim();
									if (!jsonStr) continue;
									try {
										const parsed = JSON.parse(jsonStr);
										if (eventType === "progress") {
											callbacks.onProgress?.(parsed.message);
										} else if (eventType === "category") {
											callbacks.onCategory?.(parsed);
										} else if (eventType === "complete") {
											reader.cancel().catch(() => {});
											resolve(parsed as StorageScanResult);
											return;
										} else if (eventType === "error") {
											reader.cancel().catch(() => {});
											reject(new ApiError(parsed.error ?? "Scan failed", 500));
											return;
										}
									} catch {
										// skip malformed JSON
									}
								} else if (line.trim() === "") {
									// Empty line marks end of SSE event — reset for next event
									eventType = "";
								}
							}
							pump();
						})
						.catch(reject);
				};
				pump();
			})
			.catch(reject);
	});
}
