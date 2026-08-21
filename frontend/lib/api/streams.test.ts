import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "./client";

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

		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: () => null,
				setItem: () => {},
				removeItem: () => {},
			},
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(
					JSON.stringify({
					}),
					{
						status: 503,
						statusText: "Service Unavailable",
						headers: { "content-type": "application/json" },
					},
				),
			configurable: true,
		});

		try {
			await generator.next();
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(503);
		}
	});

		let fetched = false;
		Object.defineProperty(g, "fetch", {
			value: async () => {
				fetched = true;
				return new Response("");
			},
			configurable: true,
		});

		const capabilities = {
			providers: {
					routes: {
						supported: true,
						chat: false,
					},
				},
			},
		};

		);
		try {
			await generator.next();
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(501);
			expect(fetched).toBe(false);
		}
	});

		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: () => null,
				setItem: () => {},
				removeItem: () => {},
			},
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
			configurable: true,
		});

		try {
			await generator.next();
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(500);
		}
	});
});
