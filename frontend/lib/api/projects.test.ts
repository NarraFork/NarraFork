import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, getToken, setToken } from "./client";
import { api } from "./index";

describe("project create stream", () => {
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

	test("surfaces structured auth errors before clone stream starts", async () => {
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
						message: "Authentication required",
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

		setToken("token-1");

		try {
			await api.createProjectStream(
				{
					name: "Project",
					repoMode: "clone",
					gitPath: "/tmp/project",
					cloneUrl: "https://example.test/repo.git",
				},
				() => {},
			);
			throw new Error("expected project stream to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as Error).message).toBe("Authentication required");
			expect((err as ApiError).data?.code).toBe("UNAUTHORIZED");
		}
		expect(getToken()).toBeNull();
	});
});
