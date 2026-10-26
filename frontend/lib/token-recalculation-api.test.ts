import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError } from "./api/client";
import { tokenRecalculationApi } from "./token-recalculation-api";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const requests: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
	requests.length = 0;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => "admin-token" },
	});
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		return Response.json({ job: null });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("token recalculation API", () => {
	test("loads the single job with auth and a cancellable request", async () => {
		const controller = new AbortController();
		expect(await tokenRecalculationApi.get(controller.signal)).toEqual({ job: null });
		expect(requests[0].url).toBe("/api/usage-history/token-recalculation");
		expect(requests[0].init?.signal).toBe(controller.signal);
		expect(new Headers(requests[0].init?.headers).get("Authorization")).toBe("Bearer admin-token");
	});

	test("sends UTC calendar dates unchanged and omits unbounded dates", async () => {
		await tokenRecalculationApi.start({ startDate: "2026-09-01", endDate: "2026-09-30" });
		await tokenRecalculationApi.start({ startDate: "2026-09-01" });
		await tokenRecalculationApi.start({});
		expect(requests.map(({ url }) => url)).toEqual(
			Array(3).fill("/api/usage-history/token-recalculation"),
		);
		expect(requests.map(({ init }) => init?.method)).toEqual(["POST", "POST", "POST"]);
		expect(requests.map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
			{ startDate: "2026-09-01", endDate: "2026-09-30" },
			{ startDate: "2026-09-01" },
			{},
		]);
		expect(new Headers(requests[0].init?.headers).get("Content-Type")).toBe("application/json");
	});

	test("cancels only the selected job and encodes its ID", async () => {
		await tokenRecalculationApi.cancel("job/id");
		expect(requests[0].url).toBe("/api/usage-history/token-recalculation/job%2Fid/cancel");
		expect(requests[0].init?.method).toBe("POST");
	});

	test("retains structured conflicts instead of silently starting again", async () => {
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: async () =>
				Response.json({ code: "CONFLICT", reason: "A job is already running" }, { status: 409 }),
		});
		try {
			await tokenRecalculationApi.start({});
			throw new Error("Expected rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).status).toBe(409);
			expect((error as ApiError).message).toBe("A job is already running");
		}
	});
});
