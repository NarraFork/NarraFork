import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, getToken, setToken } from "./client";
import { api } from "./index";

describe("upload APIs", () => {
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

	test("surfaces structured avatar upload unauthorized errors", async () => {
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
				new Response(
					JSON.stringify({
						code: "UNAUTHORIZED",
						reason: "Authentication required",
					}),
					{
						status: 401,
						statusText: "Unauthorized",
						headers: { "content-type": "application/json" },
					},
				),
			configurable: true,
		});

		setToken("avatar-token");

		try {
			await api.uploadAvatar(new File(["avatar"], "avatar.png", { type: "image/png" }));
			throw new Error("expected avatar upload to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(401);
			expect((err as Error).message).toBe("Authentication required");
			expect((err as ApiError).data?.code).toBe("UNAUTHORIZED");
		}
		expect(getToken()).toBeNull();
	});

	test("surfaces structured notification sound upload errors", async () => {
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
						code: "UPLOAD_FAILED",
						reason: "Notification sound exceeds the allowed size",
					}),
					{
						status: 413,
						statusText: "Payload Too Large",
						headers: { "content-type": "application/json" },
					},
				),
			configurable: true,
		});

		try {
			await api.uploadNotificationSound(new File(["sound"], "ding.mp3", { type: "audio/mpeg" }));
			throw new Error("expected notification sound upload to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(413);
			expect((err as Error).message).toBe("Notification sound exceeds the allowed size");
			expect((err as ApiError).data?.code).toBe("UPLOAD_FAILED");
		}
	});
});
