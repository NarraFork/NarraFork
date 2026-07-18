import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "./client";
import { api } from "./index";
import { type RetryFailedCompactResponse, shouldClearEditDraft } from "./narrators";

describe("narrators API", () => {
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

	test("keeps the edit draft unless the request explicitly succeeds", () => {
		expect(shouldClearEditDraft(true)).toBe(true);
		expect(shouldClearEditDraft(false)).toBe(false);
		expect(shouldClearEditDraft({ ok: true })).toBe(false);
	});

	test("maps edit-and-regenerate ok:false to false", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(JSON.stringify({ ok: false }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			configurable: true,
		});
		expect(await api.editAndRegenerate("narrator-1", "message-1", "draft", false)).toBe(false);
	});

	test("preserves the COW retry ID contract", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		Object.defineProperty(g, "fetch", {
			value: async (input: RequestInfo | URL, init?: RequestInit) => {
				requestUrl = String(input);
				requestInit = init;
				return new Response(
					JSON.stringify({
						ok: true,
						messageId: "compact-new",
						oldMessageId: "compact-old",
						replacedMessageId: "compact-old",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
			configurable: true,
		});

		const result: RetryFailedCompactResponse = await api.retryFailedCompact(
			"narrator-1",
			"compact-old",
			"provider:model",
		);
		expect(result).toEqual({
			ok: true,
			messageId: "compact-new",
			oldMessageId: "compact-old",
			replacedMessageId: "compact-old",
		});
		expect(requestUrl).toBe("/api/narrators/narrator-1/compact/compact-old/retry");
		expect(requestInit?.method).toBe("POST");
		expect(JSON.parse(String(requestInit?.body))).toEqual({ model: "provider:model" });
	});

	test("accepts the legacy same-ID retry response without aliases", async () => {
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () =>
				new Response(JSON.stringify({ ok: true, messageId: "compact-old" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			configurable: true,
		});

		expect(await api.retryFailedCompact("narrator-1", "compact-old")).toEqual({
			ok: true,
			messageId: "compact-old",
		});
	});

	test("surfaces structured narrator message errors", async () => {
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
						code: "NARRATOR_MESSAGE_TOO_LONG",
						reason: "Narrator message is too long",
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
			await api.sendNarratorMessage("narrator-1", "hello world");
			throw new Error("expected narrator message send to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(413);
			expect((err as Error).message).toBe("Narrator message is too long");
			expect((err as ApiError).data?.code).toBe("NARRATOR_MESSAGE_TOO_LONG");
		}
	});
});
