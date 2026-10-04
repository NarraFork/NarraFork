import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError } from "./client";
import { type SystemLifecycleStatus, systemLifecycleApi } from "./system-lifecycle";

const globals = new Map<string, PropertyDescriptor | undefined>();
const calls: { url: string; method?: string; signal?: AbortSignal | null }[] = [];
const status: SystemLifecycleStatus = {
	phase: "idle",
	shutdownRequested: false,
	coordination: {
		phase: "idle",
		scheduled: false,
		pendingBackgroundBashCount: 0,
		pendingOrdinaryExecutionCount: 0,
		resumableExecutionCount: 0,
		pausedToolCount: 0,
		blockers: [],
	},
};
let responseBody: unknown;
let responseStatus: number;
function install(key: string, value: unknown) {
	globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
beforeEach(() => {
	calls.length = 0;
	responseBody = status;
	responseStatus = 200;
	install("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
	install("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), method: init?.method, signal: init?.signal });
		return new Response(JSON.stringify(responseBody), {
			status: responseStatus,
			headers: { "content-type": "application/json" },
		});
	});
});
afterEach(() => {
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

describe("system lifecycle API", () => {
	test("status is a bare response and passes query cancellation through", async () => {
		const controller = new AbortController();
		expect(await systemLifecycleApi.getSystemLifecycleStatus(controller.signal)).toEqual(status);
		expect(calls[0]).toEqual({
			url: "/api/system/lifecycle/status",
			method: undefined,
			signal: controller.signal,
		});
	});
	test("all actions POST to their endpoint and preserve the success envelope", async () => {
		const expected = { success: true as const, status };
		responseBody = expected;
		for (const action of [
			systemLifecycleApi.prepareSystemRecovery,
			systemLifecycleApi.shutdownSystem,
			systemLifecycleApi.cancelSystemRecovery,
		])
			expect(await action()).toEqual(expected);
		expect(calls.map(({ url, method }) => [url, method])).toEqual([
			["/api/system/lifecycle/prepare", "POST"],
			["/api/system/lifecycle/shutdown", "POST"],
			["/api/system/lifecycle/cancel", "POST"],
		]);
	});
	test("409 conflicts expose the backend message without success handling", async () => {
		responseStatus = 409;
		responseBody = { success: false, error: "Preparation is in progress" };
		try {
			await systemLifecycleApi.shutdownSystem();
			throw new Error("Expected conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).status).toBe(409);
			expect((error as Error).message).toBe("Preparation is in progress");
		}
	});
});
