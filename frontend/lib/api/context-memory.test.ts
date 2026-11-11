import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { api } from "./index";

const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeAll(() =>
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => "session-token" },
	}),
);
afterAll(() => {
	if (storage) Object.defineProperty(globalThis, "localStorage", storage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
afterEach(() => fetchSpy?.mockRestore());

describe("context memory transport", () => {
	test("encodes scopes/cursors and forwards cancellation without a mutable principal", async () => {
		expect(api.listContextMemories).toBeFunction();
		fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ items: [], nextCursor: null }),
		);
		const controller = new AbortController();
		const signal = controller.signal;
		await api.listContextMemories({ kind: "project", id: "project /?#" }, "cursor /", signal);
		const [url, options] = fetchSpy.mock.calls[0];
		const parsed = new URL(String(url), "http://localhost");
		expect(parsed.pathname).toBe("/api/context-memory");
		expect(Object.fromEntries(parsed.searchParams)).toEqual({
			scope: "project",
			scopeId: "project /?#",
			limit: "20",
			cursor: "cursor /",
		});
		expect(options?.signal?.aborted).toBe(false);
		controller.abort();
		expect(options?.signal?.aborted).toBe(true);
	});
	test("detail and audit are separate reads; writes preserve versions and never auto-confirm", async () => {
		expect(api.proposeContextMemory).toBeFunction();
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(async () => Response.json({}), { preconnect: globalThis.fetch.preconnect }),
		);
		const id = "memory /?#";
		await api.getContextMemory(id);
		await api.getContextMemoryEvents(id);
		await api.proposeContextMemory({
			scope: { kind: "user" },
			key: "key",
			content: "内容",
			expiresAt: null,
		});
		await api.reviseContextMemory(id, { expectedVersion: 7, content: "新内容", expiresAt: null });
		await api.decideContextMemory(id, { expectedVersion: 8, action: "confirm" });
		await api.forgetContextMemory(id, 9);
		expect(fetchSpy).toHaveBeenCalledTimes(6);
		const calls = fetchSpy.mock.calls;
		expect(calls[0][0]).toBe(`/api/context-memory/${encodeURIComponent(id)}`);
		expect(calls[1][0]).toBe(`/api/context-memory/${encodeURIComponent(id)}/events`);
		expect(JSON.parse(String(calls[2][1]?.body))).not.toHaveProperty("status");
		expect(JSON.parse(String(calls[3][1]?.body)).expectedVersion).toBe(7);
		expect(JSON.parse(String(calls[4][1]?.body))).toEqual({
			expectedVersion: 8,
			action: "confirm",
		});
		expect(calls[5][1]?.method).toBe("DELETE");
		expect(JSON.parse(String(calls[5][1]?.body))).toEqual({ expectedVersion: 9 });
	});
});

test("memory responses have a byte ceiling before JSON parsing", async () => {
	fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ content: "x".repeat(300000) }),
	);
	await expect(api.getContextMemory("oversized")).rejects.toThrow(/limit|large|exceed/i);
});

test("every memory request carries a deadline as well as caller cancellation", async () => {
	const deadline = spyOn(AbortSignal, "timeout");
	fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ items: [], nextCursor: null }),
	);
	try {
		await api.listContextMemories({ kind: "user" });
		expect(deadline).toHaveBeenCalledWith(30000);
	} finally {
		deadline.mockRestore();
	}
});
