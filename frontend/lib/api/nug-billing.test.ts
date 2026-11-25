import { afterEach, expect, mock, test } from "bun:test";

const calls: Array<{ path: string; init?: RequestInit }> = [];
let response: unknown;
mock.module("./client", () => ({
	request: async (path: string, init?: RequestInit) => {
		calls.push({ path, init });
		return response;
	},
	pickRequestOptions: (options?: RequestInit) => options ?? {},
	apiBase: () => "/api",
	authorizedFetch: () => {
		throw new Error("Unexpected transport");
	},
	readFetchError: async () => "failed",
	ApiError: class ApiError extends Error {
		constructor(
			message: string,
			public status: number,
			public data?: Record<string, unknown>,
		) {
			super(message);
		}
	},
}));
mock.module("./narrators", () => ({ parseContentDispositionFileName: () => undefined }));
const { miscApi } = await import("./misc");
const binding = "a".repeat(43);
const orderId = "same order/id";
const boundOrder = () => ({
	order: {
		id: orderId,
		binding,
		amount: "10",
		quota_amount: "10",
		status: "pending",
		provider: "mockpay",
		created_at: "2026-11-25",
	},
});
afterEach(() => {
	calls.length = 0;
	response = undefined;
});

test("create, poll, repay and the post-payment balance retain the opaque order context", async () => {
	response = boundOrder();
	expect(
		(await miscApi.nugCreateBillingOrder("gateway", { amount: 10, provider: "mockpay" })).order
			.binding,
	).toBe(binding);
	await miscApi.nugGetBillingOrder("gateway", orderId, binding);
	await miscApi.nugRepayBillingOrder("gateway", orderId, binding);
	response = { balance: 11, totalGranted: 22, paymentCredentialIsPrimary: false };
	const controller = new AbortController();
	expect(
		(await miscApi.nugGetQuota("gateway", { signal: controller.signal }, { orderId, binding }))
			.paymentCredentialIsPrimary,
	).toBe(false);
	expect(calls.map((call) => call.path)).toEqual([
		"/nug/providers/gateway/billing/orders",
		`/nug/providers/gateway/billing/orders/${encodeURIComponent(orderId)}?binding=${binding}`,
		`/nug/providers/gateway/billing/orders/${encodeURIComponent(orderId)}/repay?binding=${binding}`,
		`/nug/providers/gateway/quota?orderId=${encodeURIComponent(orderId)}&binding=${binding}`,
	]);
	expect(calls[2]?.init?.method).toBe("POST");
	expect(calls[3]?.init?.signal).toBe(controller.signal);
});

test("an old backend without a binding cannot expose a payment QR and missing client contexts never issue RPCs", async () => {
	response = { order: { id: orderId, pay_url: "https://pay.example/unsafe-old-context" } };
	const pending = miscApi.nugCreateBillingOrder("gateway", { amount: 10, provider: "mockpay" });
	await expect(pending).rejects.toThrow("payment context");
	await expect(pending).rejects.toMatchObject({
		status: 409,
		data: { code: "NUG_PAYMENT_CONTEXT" },
	});
	calls.length = 0;
	expect(() => miscApi.nugGetBillingOrder("gateway", orderId, "")).toThrow("payment context");
	expect(() => miscApi.nugRepayBillingOrder("gateway", orderId, "invalid")).toThrow(
		"payment context",
	);
	expect(() => miscApi.nugGetQuota("gateway", undefined, { orderId, binding: "" })).toThrow(
		"payment context",
	);
	expect(calls).toEqual([]);
});

test.each([
	"poll",
	"repay",
])("%s refuses an order or binding substituted by a stale response", async (stage) => {
	for (const order of [
		{ ...boundOrder().order, id: "another-order" },
		{ ...boundOrder().order, binding: "b".repeat(43) },
	]) {
		response = { order };
		const task =
			stage === "poll"
				? miscApi.nugGetBillingOrder("gateway", orderId, binding)
				: miscApi.nugRepayBillingOrder("gateway", orderId, binding);
		await expect(task).rejects.toThrow("does not match");
		await expect(task).rejects.toMatchObject({
			status: 409,
			data: { code: "NUG_PAYMENT_RESPONSE" },
		});
	}
});

test("a legacy unbound quota response cannot masquerade as the paid account's balance", async () => {
	response = { balance: 11, totalGranted: 22 };
	await expect(miscApi.nugGetQuota("gateway", undefined, { orderId, binding })).rejects.toThrow(
		"balance context",
	);
	// Existing non-payment quota consumers keep their original response contract.
	expect(await miscApi.nugGetQuota("gateway")).toEqual({ balance: 11, totalGranted: 22 });
});
