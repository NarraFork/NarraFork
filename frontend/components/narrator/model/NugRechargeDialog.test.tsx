import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import narratorEn from "../../../locales/en/narrator.json";

const { window } = parseHTML("<!doctype html><html><body></body></html>");
const originals = new Map<string, PropertyDescriptor | undefined>();
const globals = {
	window,
	document: window.document,
	Document: window.Document,
	navigator: { userAgent: "Desktop" },
	HTMLElement: window.HTMLElement,
	HTMLInputElement: window.HTMLInputElement,
	Element: window.Element,
	Node: window.Node,
	Event: window.Event,
	ShadowRoot: window.ShadowRoot ?? class {},
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	getComputedStyle: () => ({ getPropertyValue: () => "", overflow: "visible" }),
	matchMedia: () => ({
		matches: false,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
	}),
	MutationObserver: window.MutationObserver,
	ResizeObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
	requestAnimationFrame: (callback: FrameRequestCallback) => {
		queueMicrotask(() => callback(performance.now()));
		return 0;
	},
	cancelAnimationFrame: () => {},
	IS_REACT_ACT_ENVIRONMENT: true,
};
Object.assign(window, { matchMedia: globals.matchMedia });
Object.assign(window.document, { fonts: { addEventListener() {}, removeEventListener() {} } });
for (const [key, value] of Object.entries(globals)) {
	originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
const { QueryClient, QueryClientProvider, notifyManager } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { MantineProvider } = await import("@mantine/core");
const { notifications } = await import("@mantine/notifications");
const { I18nextProvider } = await import("react-i18next");
const { api, ApiError } = await import("../../../lib/api");
const { NugRechargeDialog } = await import("./NugRechargeDialog");
notifyManager.setScheduler(queueMicrotask);
const i18n = createInstance();
await i18n.init({
	lng: "en",
	defaultNS: "narrator",
	initImmediate: false,
	resources: { en: { narrator: narratorEn } },
});
const BINDING = "a".repeat(43);
const PAY_URL = "https://pay.example/qr.png";
type OrderResponse = Awaited<ReturnType<typeof api.nugGetBillingOrder>>;
const order = (status = "pending"): OrderResponse => ({
	order: {
		id: "order-A",
		binding: BINDING,
		amount: "10",
		quota_amount: "10",
		provider: "mockpay",
		status,
		pay_url: PAY_URL,
		created_at: "2026-11-25",
	},
});
const quota = { balance: 35, totalGranted: 50, paymentCredentialIsPrimary: true };
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
let root: Root;
let container: HTMLElement;
let qc: QueryClientType;
let events: string[];
let config: ReturnType<typeof spyOn<typeof api, "nugGetBillingConfig">>;
let create: ReturnType<typeof spyOn<typeof api, "nugCreateBillingOrder">>;
let poll: ReturnType<typeof spyOn<typeof api, "nugGetBillingOrder">>;
let balance: ReturnType<typeof spyOn<typeof api, "nugGetQuota">>;
let resume: ReturnType<typeof spyOn<typeof api, "continueNarrator">>;
let show: ReturnType<typeof spyOn<typeof notifications, "show">>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let timeoutSpy: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>;
let clearTimeoutSpy: ReturnType<typeof spyOn<typeof globalThis, "clearTimeout">>;
let intervalSpy: ReturnType<typeof spyOn<typeof globalThis, "setInterval">>;
let clearIntervalSpy: ReturnType<typeof spyOn<typeof globalThis, "clearInterval">>;
let timers: Map<number, { callback: () => void; delay: number }>;
let intervals: Map<number, { callback: () => void; delay: number }>;
let nextTimer: number;
const nativeTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	events = [];
	timers = new Map();
	intervals = new Map();
	nextTimer = 100000;
	fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Real network forbidden"));
	config = spyOn(api, "nugGetBillingConfig").mockResolvedValue({
		enabled: true,
		providers: [{ name: "mockpay", displayName: "Mock pay" }],
		unitName: "credits",
		quotaRate: 1,
		orderMinAmount: 1,
		orderMaxAmount: 100,
		balance: 10,
		totalGranted: 20,
		pollIntervalMs: 1,
	});
	create = spyOn(api, "nugCreateBillingOrder").mockResolvedValue(order());
	poll = spyOn(api, "nugGetBillingOrder").mockResolvedValue(order());
	balance = spyOn(api, "nugGetQuota").mockResolvedValue(quota);
	resume = spyOn(api, "continueNarrator").mockImplementation(async () => {
		events.push("continue");
		return { ok: true };
	});
	show = spyOn(notifications, "show").mockImplementation(() => "notice");
	timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delay: number,
		...args: unknown[]
	) => {
		if (delay >= 1000 && delay <= 60000) {
			const id = nextTimer++;
			timers.set(id, { callback, delay });
			return id;
		}
		return nativeTimeout(callback, delay, ...args);
	}) as typeof setTimeout);
	clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
		timers.delete(id);
		nativeClearTimeout(id);
	}) as typeof clearTimeout);
	intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
		callback: () => void,
		delay: number,
	) => {
		const id = nextTimer++;
		intervals.set(id, { callback, delay });
		return id;
	}) as typeof setInterval);
	clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
		intervals.delete(id);
	}) as typeof clearInterval);
});
afterEach(async () => {
	await act(async () => root.unmount());
	qc.clear();
	container.remove();
	const realCalls = fetchSpy.mock.calls.length;
	for (const mock of [
		config,
		create,
		poll,
		balance,
		resume,
		show,
		timeoutSpy,
		clearTimeoutSpy,
		intervalSpy,
		clearIntervalSpy,
		fetchSpy,
	])
		mock.mockRestore();
	expect(realCalls).toBe(0);
});
afterAll(() => {
	notifyManager.setScheduler((callback) => setTimeout(callback, 0));
	for (const [key, value] of originals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
});
function button(text: string) {
	const found = [...document.querySelectorAll("button")].find(
		(entry) => entry.textContent?.trim() === text,
	);
	if (!found) throw new Error(`Missing button ${text}: ${document.body.textContent}`);
	return found;
}
async function mountAndCreate() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<NugRechargeDialog
							opened
							narratorId="narrator-A"
							providerId="gateway"
							paymentRequired={{ resumeAction: "continue" }}
							onClose={() => events.push("close")}
							onQuotaUpdated={() => events.push("quota")}
							onPaymentRequiredChange={(value) => {
								if (value === null) events.push("paid");
							}}
						/>
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
	await act(async () => {
		button(narratorEn.recharge.createOrder).click();
	});
}
async function fireNextTimer() {
	const pending = timers.entries().next().value;
	const interval = intervals.entries().next().value;
	const timer = pending ?? interval;
	if (!timer) return false;
	if (pending) timers.delete(pending[0]);
	expect(timer[1].delay).toBeGreaterThanOrEqual(3000);
	expect(timer[1].delay).toBeLessThanOrEqual(30000);
	await act(async () => {
		timer[1].callback();
		await Promise.resolve();
	});
	return true;
}
function qrVisible() {
	return !!document.querySelector(`img[src="${PAY_URL}"]`);
}

test.each([
	"gateway-502",
	"network",
])("%s recovers through the real Query retry, confirms quota, then signals paid once", async (failure) => {
	let attempts = 0;
	const firstAttempt = deferred<void>();
	const quotaEntered = deferred<void>();
	const quotaAnswer = deferred<Awaited<ReturnType<typeof api.nugGetQuota>>>();
	poll.mockImplementation(async () => {
		attempts++;
		if (attempts === 1) {
			firstAttempt.resolve();
			throw failure === "gateway-502"
				? new ApiError("gateway down", 502)
				: new TypeError("network unavailable");
		}
		return order("paid");
	});
	balance.mockImplementation(() => {
		quotaEntered.resolve();
		return quotaAnswer.promise;
	});
	await mountAndCreate();
	await firstAttempt.promise;
	expect(qrVisible()).toBe(true);
	expect(events).toEqual([]);
	expect(await fireNextTimer()).toBe(true);
	await quotaEntered.promise;
	expect(balance).toHaveBeenCalledWith("gateway", undefined, {
		orderId: "order-A",
		binding: BINDING,
	});
	expect(events).toEqual([]);
	await act(async () => {
		quotaAnswer.resolve(quota);
		await Promise.resolve();
	});
	expect(events).toEqual(["quota", "continue", "paid", "close"]);
	expect(create).toHaveBeenCalledTimes(1);
	expect(poll.mock.calls).toEqual(Array(2).fill(["gateway", "order-A", BINDING]));
});

test.each([
	new ApiError("binding expired", 409, { code: "NUG_PAYMENT_CONTEXT" }),
	new ApiError("wrong order", 502, { code: "NUG_PAYMENT_RESPONSE" }),
	new ApiError("permission denied", 403),
])("an explicit terminal payment error hides QR and never retries: %s", async (error) => {
	const answer = deferred<OrderResponse>();
	poll.mockReturnValue(answer.promise);
	await mountAndCreate();
	expect(qrVisible()).toBe(true);
	await act(async () => {
		answer.reject(error);
		await Promise.resolve();
	});
	expect(qrVisible()).toBe(false);
	expect(timers.size + intervals.size).toBe(0);
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["nug", "billing", "order"] });
	});
	expect(poll).toHaveBeenCalledTimes(1);
	expect(balance).not.toHaveBeenCalled();
	expect(events).toEqual([]);
});

test("persistent gateway errors consume a finite budget; explicit Retry keeps the same binding and completes", async () => {
	poll.mockRejectedValue(new ApiError("gateway unavailable", 502));
	await mountAndCreate();
	for (let step = 0; step < 80; step++) {
		if (!(await fireNextTimer())) break;
	}
	expect(poll.mock.calls.length).toBeGreaterThan(2);
	expect(poll.mock.calls.length).toBeLessThanOrEqual(18);
	expect(timers.size + intervals.size).toBe(0);
	expect(qrVisible()).toBe(true);
	expect(events).toEqual([]);
	poll.mockResolvedValue(order("paid"));
	await act(async () => {
		button(narratorEn.retry).click();
		await Promise.resolve();
	});
	expect(events).toEqual(["quota", "continue", "paid", "close"]);
	expect(create).toHaveBeenCalledTimes(1);
	expect(
		poll.mock.calls.every(
			(args) => args[0] === "gateway" && args[1] === "order-A" && args[2] === BINDING,
		),
	).toBe(true);
});
