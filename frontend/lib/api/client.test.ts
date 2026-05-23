import { afterEach, describe, expect, test } from "bun:test";
import {
	getErrorMessage,
	getToken,
	readFetchError,
	readFetchErrorMessage,
	setToken,
} from "./client";

const g = globalThis as typeof globalThis & { localStorage?: Storage };
const originalLocalStorage = g.localStorage;

afterEach(() => {
	if (originalLocalStorage === undefined) {
		Reflect.deleteProperty(g, "localStorage");
	} else {
		Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
	}
});

function installMapLocalStorage(): Map<string, string> {
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
	return store;
}

describe("getErrorMessage", () => {
	test("prefers fallback reason over generic error code", () => {
		expect(
			getErrorMessage(
				{
					error: "FEATURE_DISABLED",
					reason: "Opening the system file manager is not supported on this platform.",
					code: "FS_REVEAL_UNSUPPORTED",
				},
				"Request failed",
			),
		).toBe("Opening the system file manager is not supported on this platform.");
	});

	test("uses message when reason is absent", () => {
		expect(
			getErrorMessage(
				{
					error: { code: -32603, message: "internal" },
					message: "MCP tools are unavailable in this backend.",
				},
				"Request failed",
			),
		).toBe("MCP tools are unavailable in this backend.");
	});

	test("uses nested JSON-RPC error message when no top-level message exists", () => {
		expect(
			getErrorMessage(
				{ error: { code: -32603, message: "JSON-RPC bridge failed" } },
				"Request failed",
			),
		).toBe("JSON-RPC bridge failed");
	});

	test("falls back through error, code, then provided fallback", () => {
		expect(getErrorMessage({ error: "boom" }, "Request failed")).toBe("boom");
		expect(getErrorMessage({ code: "FEATURE_DISABLED" }, "Request failed")).toBe(
			"FEATURE_DISABLED",
		);
		expect(getErrorMessage({}, "Request failed")).toBe("Request failed");
	});

	test("reads structured fetch error responses", async () => {
		const response = new Response(
			JSON.stringify({
				code: "FS_PREVIEW_TOO_LARGE",
				reason: "File too large to preview",
			}),
			{
				status: 413,
				statusText: "Payload Too Large",
				headers: { "content-type": "application/json" },
			},
		);
		const error = await readFetchError(response);
		expect(error.message).toBe("File too large to preview");
		expect(error.data.code).toBe("FS_PREVIEW_TOO_LARGE");
		expect(error.data.reason).toBe("File too large to preview");
	});

	test("reads structured fetch error messages", async () => {
		const response = new Response(
			JSON.stringify({
				code: "FS_PREVIEW_TOO_LARGE",
				reason: "File too large to preview",
			}),
			{
				status: 413,
				statusText: "Payload Too Large",
				headers: { "content-type": "application/json" },
			},
		);
		expect(await readFetchErrorMessage(response)).toBe("File too large to preview");
	});

	test("clears stale token when structured fetch error returns 401", async () => {
		installMapLocalStorage();
		setToken("stale-token");
		expect(getToken()).toBe("stale-token");
		const response = new Response(
			JSON.stringify({
				code: "UNAUTHORIZED",
				reason: "Authentication required",
			}),
			{
				status: 401,
				statusText: "Unauthorized",
				headers: { "content-type": "application/json" },
			},
		);
		expect(await readFetchErrorMessage(response)).toBe("Authentication required");
		expect(getToken()).toBeNull();
	});
});
