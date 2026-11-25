import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, useLayoutEffect, useSyncExternalStore } from "react";
import type { Root } from "react-dom/client";
import narratorEn from "../../../locales/en/narrator.json";
import type { PaymentRequiredInfo } from "../useNarratorPanelWS";

const { window } = parseHTML("<!doctype html><html><body></body></html>");
const originals = new Map<string, PropertyDescriptor | undefined>();
const storage = new Map<string, string>();
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
	localStorage: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => {
			storage.set(key, value);
		},
		removeItem: (key: string) => {
			storage.delete(key);
		},
	},
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
const { getAuthSnapshot, subscribeAuth, setToken, clearToken } = await import(
	"../../../lib/api/client"
);
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
const PAYMENT_CONTEXT = `npc1.${(Date.now() + 15 * 60_000).toString(36)}.${"n".repeat(22)}.${"s".repeat(43)}`;
const PAY_URL = "https://pay.example/qr.png";
type OrderResponse = Awaited<ReturnType<typeof api.nugGetBillingOrder>>;
const order = (
	status = "pending",
	overrides: Partial<OrderResponse["order"]> = {},
): OrderResponse => ({
	order: {
		id: "order-A",
		binding: BINDING,
		amount: "10",
		quota_amount: "10",
		provider: "mockpay",
		status,
		pay_url: PAY_URL,
		created_at: "2026-11-25",
		...overrides,
	},
});
const quota = { balance: 35, totalGranted: 50, paymentCredentialIsPrimary: true };
const billingConfig = {
	enabled: true,
	providers: [{ name: "mockpay", displayName: "Mock pay" }],
	unitName: "credits",
	quotaRate: 1,
	orderMinAmount: 1,
	orderMaxAmount: 100,
	balance: 10,
	totalGranted: 20,
	pollIntervalMs: 1,
};
const CONTEXT_C = PAYMENT_CONTEXT.replace("n".repeat(22), "c".repeat(22));
const C_URL = "https://pay.example/qr-C.png";
const orderC = (status = "pending") =>
	order(status, { id: "order-C", binding: "c".repeat(43), pay_url: C_URL });
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
	storage.clear();
	setToken("dialog-owner-A");
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	events = [];
	timers = new Map();
	intervals = new Map();
	nextTimer = 100000;
	fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Real network forbidden"));
	config = spyOn(api, "nugGetBillingConfig").mockResolvedValue(billingConfig);
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
	clearToken();
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
interface DialogScope {
	narratorId?: string;
	providerId?: string;
	onLayout?: (generation: number) => void;
}
function ScopeProbe({ onLayout }: Pick<DialogScope, "onLayout">) {
	const { generation } = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot);
	useLayoutEffect(() => {
		onLayout?.(generation);
	}, [onLayout, generation]);
	return null;
}
async function mountAndCreate(
	payment: PaymentRequiredInfo | null = {
		resumeAction: "continue",
		paymentContext: PAYMENT_CONTEXT,
	},
	startOrder = true,
	scope: DialogScope = {},
) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<NugRechargeDialog
							opened
							narratorId={scope.narratorId ?? "narrator-A"}
							providerId={scope.providerId ?? "gateway"}
							paymentRequired={payment}
							onClose={() => events.push("close")}
							onQuotaUpdated={() => events.push("quota")}
							onPaymentRequiredChange={(value) => {
								if (value === null) events.push("paid");
							}}
						/>
						<ScopeProbe onLayout={scope.onLayout} />
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
	if (startOrder)
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

test("失败事件缺少服务器上下文时不查询首 Key、也不能创建订单", async () => {
	await mountAndCreate({ resumeAction: "continue" }, false);
	expect(config).not.toHaveBeenCalled();
	expect(create).not.toHaveBeenCalled();
	expect(poll).not.toHaveBeenCalled();
	expect(qrVisible()).toBe(false);
	expect(document.body.textContent).toContain("充值上下文");
});

test("没有失败请求的独立充值显式使用 standalone 意图", async () => {
	await mountAndCreate(null);
	expect(config).toHaveBeenCalledWith("gateway", { mode: "standalone" });
	expect(create.mock.calls[0]?.[2]).toEqual({ mode: "standalone" });
});

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
	expect(config).toHaveBeenCalledWith("gateway", {
		mode: "request",
		narratorId: "narrator-A",
		paymentContext: PAYMENT_CONTEXT,
	});
	expect(create.mock.calls[0]?.[2]).toEqual({
		mode: "request",
		narratorId: "narrator-A",
		paymentContext: PAYMENT_CONTEXT,
	});
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

test("B 下单未返回就切到 C：C 能独立下单，迟到 B 不能覆盖 C 的 QR 或启动旧轮询", async () => {
	const lateB = deferred<OrderResponse>();
	create.mockReturnValueOnce(lateB.promise).mockResolvedValueOnce(orderC());
	poll.mockResolvedValue(orderC());
	await mountAndCreate();
	await mountAndCreate({ resumeAction: "continue", paymentContext: CONTEXT_C }, false);
	await act(async () => button(narratorEn.recharge.createOrder).click());
	expect(create.mock.calls[1]?.[2]).toEqual({
		mode: "request",
		narratorId: "narrator-A",
		paymentContext: CONTEXT_C,
	});
	expect(document.querySelector(`img[src="${C_URL}"]`)).not.toBeNull();
	await act(async () => {
		lateB.resolve(order());
	});
	expect(qrVisible()).toBe(false);
	expect(document.querySelector(`img[src="${C_URL}"]`)).not.toBeNull();
	expect(poll.mock.calls.every((args) => args[1] === "order-C" && args[2] === "c".repeat(43))).toBe(
		true,
	);
	expect(events).toEqual([]);
});

test.each([
	"paymentContext",
	"narratorId",
	"providerId",
	"authGeneration",
])("%s 变化时在 layout 前隐藏已有 B QR；旧 paid 轮询不能进入新 scope", async (change) => {
	const latePoll = deferred<OrderResponse>();
	const initialGeneration = getAuthSnapshot().generation;
	poll.mockReturnValueOnce(latePoll.promise).mockResolvedValue(orderC());
	await mountAndCreate();
	expect(qrVisible()).toBe(true);
	const payment = {
		resumeAction: "continue" as const,
		paymentContext: change === "paymentContext" ? CONTEXT_C : PAYMENT_CONTEXT,
	};
	const scope: DialogScope = {
		narratorId: change === "narratorId" ? "narrator-C" : "narrator-A",
		providerId: change === "providerId" ? "gateway-C" : "gateway",
		onLayout: () => expect(qrVisible()).toBe(false),
	};
	if (change === "narratorId" || change === "providerId") {
		config.mockImplementation(async (_source, intent) => {
			if (intent?.mode === "request" && intent.paymentContext === PAYMENT_CONTEXT)
				throw new ApiError("context belongs to the previous narrator/source", 409, {
					code: "NUG_PAYMENT_CONTEXT",
				});
			return billingConfig;
		});
	}
	if (change === "authGeneration") {
		await mountAndCreate(undefined, false, {
			onLayout: (generation) => {
				if (generation !== initialGeneration) expect(qrVisible()).toBe(false);
			},
		});
		await act(async () => {
			setToken("dialog-owner-C");
		});
	} else await mountAndCreate(payment, false, scope);
	expect(qrVisible()).toBe(false);
	await act(async () => {
		latePoll.resolve(order("paid"));
	});
	expect(balance).not.toHaveBeenCalled();
	expect(events).toEqual([]);
	create.mockResolvedValueOnce(orderC());
	await mountAndCreate({ resumeAction: "continue", paymentContext: CONTEXT_C }, true, scope);
	expect(create.mock.calls.at(-1)?.[0]).toBe(scope.providerId);
	expect(create.mock.calls.at(-1)?.[2]).toEqual({
		mode: "request",
		narratorId: scope.narratorId ?? "narrator-A",
		paymentContext: CONTEXT_C,
	});
	expect(document.querySelector(`img[src="${C_URL}"]`)).not.toBeNull();
});

test.each([
	"quota",
	"resume",
])("B 已 paid 但 %s 仍在途，切到 C 后不能更新额度、清除新失败或关闭新窗口", async (stage) => {
	const lateQuota = deferred<Awaited<ReturnType<typeof api.nugGetQuota>>>();
	const lateResume = deferred<{ ok: boolean }>();
	create.mockResolvedValueOnce(order("paid")).mockResolvedValueOnce(orderC("paid"));
	if (stage === "quota") balance.mockReturnValueOnce(lateQuota.promise);
	else
		resume.mockImplementationOnce(async () => {
			events.push("continue");
			return lateResume.promise;
		});
	await mountAndCreate();
	const beforeSwitch = [...events];
	await mountAndCreate({ resumeAction: "continue", paymentContext: CONTEXT_C }, false);
	await act(async () => {
		lateQuota.resolve(quota);
		lateResume.resolve({ ok: true });
	});
	expect(events).toEqual(beforeSwitch);
	await act(async () => button(narratorEn.recharge.createOrder).click());
	expect(events.slice(beforeSwitch.length)).toEqual(["quota", "continue", "paid", "close"]);
	expect(balance.mock.calls.at(-1)?.[2]).toEqual({ orderId: "order-C", binding: "c".repeat(43) });
});

test("跨标签 token 变化尚未触发 render 时，旧 paid quota 确认仍按 authGeneration 拒绝", async () => {
	const lateQuota = deferred<Awaited<ReturnType<typeof api.nugGetQuota>>>();
	create.mockResolvedValueOnce(order("paid"));
	balance.mockReturnValueOnce(lateQuota.promise);
	await mountAndCreate();
	await act(async () => {
		storage.set("narrafork_token", "other-tab-owner");
		lateQuota.resolve(quota);
	});
	expect(events).toEqual([]);
	expect(resume).not.toHaveBeenCalled();
});

test("standalone 同 source 的健康重排/配置刷新不清除已创建订单，后续仍查原 binding", async () => {
	await mountAndCreate(null);
	config.mockResolvedValue({ ...billingConfig, balance: 99 });
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["nug", "billing", "config"] });
	});
	await mountAndCreate(null, false);
	expect(qrVisible()).toBe(true);
	expect(await fireNextTimer()).toBe(true);
	expect(
		poll.mock.calls.every(
			(args) => args[0] === "gateway" && args[1] === "order-A" && args[2] === BINDING,
		),
	).toBe(true);
	expect(create.mock.calls[0]?.[2]).toEqual({ mode: "standalone" });
	expect(events).toEqual([]);
});
