import { afterEach, beforeEach, expect, test } from "bun:test";
import { settingsApi } from "./settings";

const originalFetch = globalThis.fetch;
const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const requests: Array<{ url: string; input?: RequestInit }> = [];
beforeEach(() => {
	requests.length = 0;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null },
	});
	globalThis.fetch = (async (url, input) => {
		requests.push({ url: String(url), input });
		return Response.json({ appearancePreferences: {} });
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (storage) Object.defineProperty(globalThis, "localStorage", storage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

test("GET and partial PATCH keep the supplied cancellation signal", async () => {
	const controller = new AbortController();
	await settingsApi.getUserPreferences({ signal: controller.signal });
	const data = {
		appearancePreferences: { narrafork_oled: false, narrafork_blur_in_ms: 0, pluginTheme: "" },
	};
	await settingsApi.updateUserPreferences(data, { signal: controller.signal });
	expect(requests.map(({ url }) => url)).toEqual([
		"/api/user-preferences",
		"/api/user-preferences",
	]);
	expect(requests[1]?.input?.method).toBe("PATCH");
	expect(JSON.parse(String(requests[1]?.input?.body))).toEqual(data);
	controller.abort();
	for (const { input } of requests) expect(input?.signal?.aborted).toBe(true);
});

test("aborting a pending PATCH rejects instead of reporting a saved preference", async () => {
	const controller = new AbortController();
	globalThis.fetch = (async (_url, input) =>
		new Promise((_resolve, reject) => {
			if (input?.signal?.aborted) reject(input.signal.reason);
			else
				input?.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
					once: true,
				});
		})) as typeof fetch;
	const pending = settingsApi.updateUserPreferences(
		{ appearancePreferences: { colorScheme: "dark" } },
		{ signal: controller.signal },
	);
	controller.abort(new Error("cancelled"));
	await expect(pending).rejects.toThrow("cancelled");
});
