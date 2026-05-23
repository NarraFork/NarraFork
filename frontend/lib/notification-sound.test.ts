import { afterEach, describe, expect, test } from "bun:test";
import { getToken, setToken } from "./api";
import { playCustomSound } from "./notification-sound";

describe("notification sound playback", () => {
	const g = globalThis as typeof globalThis & {
		localStorage?: Storage;
		fetch: typeof fetch;
	};
	const originalFetch = g.fetch;
	const originalLocalStorage = g.localStorage;

	afterEach(() => {
		Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
		if (originalLocalStorage === undefined) {
			Reflect.deleteProperty(g, "localStorage");
		} else {
			Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
		}
	});

	test("clears stale token when custom sound fetch returns unauthorized", async () => {
		const store = new Map<string, string>();
		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => {
					store.set(key, value);
				},
				removeItem: (key: string) => {
					store.delete(key);
				},
			},
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response("", {
					status: 401,
					statusText: "Unauthorized",
				}),
			configurable: true,
		});

		setToken("stale-token");
		expect(getToken()).toBe("stale-token");

		await playCustomSound("/api/notification-sounds/sound-id");

		expect(getToken()).toBeNull();
	});
});
