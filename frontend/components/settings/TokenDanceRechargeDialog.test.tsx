import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { TokenDancePaymentSession, TokenDancePublicConnection } from "@shared/tokendance";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { api } from "../../lib/api";
import { openTokenDanceRecharge, TOKENDANCE_RECOVERY_EVENT } from "../../lib/tokendance-recovery";
import errors from "../../locales/en/errors.json";
import narratorEn from "../../locales/en/narrator.json";
import settings from "../../locales/en/settings.json";
import errorsZh from "../../locales/zh-CN/errors.json";
import narratorZh from "../../locales/zh-CN/narrator.json";
import { ConfirmDialogContext } from "../common/confirm-dialog-context";

const original = new Map<string, PropertyDescriptor | undefined>();
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(window, {
	matchMedia: () => ({
		matches: false,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
	}),
});
const globals = {
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	window,
	document: window.document,
	navigator: { userAgent: "Desktop" },
	HTMLElement: window.HTMLElement,
	HTMLInputElement: window.HTMLInputElement,
	Element: window.Element,
	Node: window.Node,
	Event: window.Event,
	ShadowRoot: window.ShadowRoot ?? class {},
	getComputedStyle: () => ({ getPropertyValue: () => "", overflow: "visible" }),
	matchMedia: window.matchMedia,
	ResizeObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
	original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
(window.document as unknown as Record<string, unknown>).oninput = null;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { formatTokenDanceMoney, useTokenDanceBalance } = await import(
	"../../hooks/useTokenDanceBalance"
);
const { createRoot } = await import("react-dom/client");
const { MantineProvider } = await import("@mantine/core");
const { I18nextProvider } = await import("react-i18next");
const { TokenDanceRechargeDialog } = await import("./TokenDanceRechargeDialog");
const { TokenDanceSection } = await import("../providers/TokenDanceSection");
const { TokenDanceRecoveryHost } = await import("./TokenDanceRecoveryHost");
const { createRouter, createMemoryHistory, createRootRoute, createRoute, RouterProvider } =
	await import("@tanstack/react-router");
const i18n = createInstance();
await i18n.init({
	lng: "en",
	defaultNS: "errors",
	initImmediate: false,
	resources: { en: { errors, settings } },
});
let root: Root;
let qc: QueryClientType;
let container: HTMLElement;
let closed: number;
let paid: number;
const connection: TokenDancePublicConnection = {
	connected: true,
	disabled: false,
	generation: 7,
	billingInstance: "0123456789abcdef0123456789abcdef",
	name: "TD",
	models: [],
};
const session = (
	status: TokenDancePaymentSession["status"] = "pending",
): TokenDancePaymentSession => ({
	id: "order",
	generation: 7,
	amount: 10,
	status,
	paymentUrl: "https://pay.example.test/order",
	alipayUrl: "alipays://platformapi/startapp?appId=1",
	createdAt: Date.now(),
	expiresAt: Date.now() + 60_000,
});
const balance = {
	generation: 7,
	credits: 10_000_000,
	creditsUsed: 1,
	balance: 9_999_999,
	updatedAt: Date.now(),
	loading: false,
	hasError: false,
};
let create: ReturnType<typeof spyOn<typeof api, "tokenDanceCreatePayment">>;
let poll: ReturnType<typeof spyOn<typeof api, "tokenDancePaymentSession">>;
let refresh: ReturnType<typeof spyOn<typeof api, "tokenDanceRefreshBalance">>;
let getBalance: ReturnType<typeof spyOn<typeof api, "tokenDanceBalance">>;
let getConnection: ReturnType<typeof spyOn<typeof api, "tokenDanceConnection">>;
let timers: Map<number, { callback: () => void; delay: number }>;
let nextTimer: number;
let intervals: Map<number, { callback: () => void; delay: number }>;
let intervalSpy: ReturnType<typeof spyOn<typeof globalThis, "setInterval">>;
let clearIntervalSpy: ReturnType<typeof spyOn<typeof globalThis, "clearInterval">>;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let timerSpy: ReturnType<typeof spyOn<typeof globalThis, "setTimeout">>;
let clearSpy: ReturnType<typeof spyOn<typeof globalThis, "clearTimeout">>;
const nativeTimeout = globalThis.setTimeout;
const nativeClear = globalThis.clearTimeout;
beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	qc.setQueryData(["auth", "me"], { id: "admin", role: "admin" });
	closed = 0;
	paid = 0;
	globals.navigator.userAgent = "Desktop";
	fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("Real network calls forbidden"),
	);
	create = spyOn(api, "tokenDanceCreatePayment").mockResolvedValue({ session: session() });
	poll = spyOn(api, "tokenDancePaymentSession").mockResolvedValue({ session: session() });
	refresh = spyOn(api, "tokenDanceRefreshBalance").mockResolvedValue(balance);
	getBalance = spyOn(api, "tokenDanceBalance").mockResolvedValue(balance);
	getConnection = spyOn(api, "tokenDanceConnection").mockResolvedValue(connection);
	timers = new Map();
	intervals = new Map();
	nextTimer = 100000;
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
	timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
		cb: () => void,
		delay: number,
		...args: unknown[]
	) => {
		if (delay >= 3000 && delay < 120000) {
			const id = nextTimer++;
			timers.set(id, { callback: cb, delay });
			return id;
		}
		return nativeTimeout(cb, delay, ...args);
	}) as typeof setTimeout);
	clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
		timers.delete(id);
		nativeClear(id);
	}) as typeof clearTimeout);
});
afterEach(async () => {
	await act(() => root.unmount());
	qc.clear();
	container.remove();
	const networkCalls = fetchSpy.mock.calls.length;
	for (const mock of [
		create,
		poll,
		refresh,
		getBalance,
		getConnection,
		timerSpy,
		clearSpy,
		fetchSpy,
		intervalSpy,
		clearIntervalSpy,
	])
		mock.mockRestore();
	expect(networkCalls).toBe(0);
});
afterAll(() => {
	for (const [key, descriptor] of original) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
async function settle() {
	await act(async () => {
		await new Promise((resolve) => nativeTimeout(resolve, 15));
	});
}
async function render(opened = true, generation = 7) {
	await act(() =>
		root.render(
			<QueryClientProvider client={qc}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<StrictMode>
							<TokenDanceRechargeDialog
								opened={opened}
								generation={generation}
								onClose={() => closed++}
								onPaid={() => paid++}
							/>
						</StrictMode>
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
	await settle();
}
function button(label: string) {
	const el = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
	if (!el) throw new Error(`Missing ${label}: ${container.textContent}`);
	return el;
}
async function confirm() {
	await act(async () => {
		button(errors.tokendanceRechargeConfirm).click();
		await Promise.resolve();
	});
	await settle();
}
async function tick(delay: number) {
	const found = [...timers.entries()].reverse().find(([, timer]) => timer.delay === delay);
	if (!found) throw new Error(`Missing timer ${delay}`);
	timers.delete(found[0]);
	await act(async () => {
		found[1].callback();
		await Promise.resolve();
	});
	await settle();
}
async function renderSection() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<ConfirmDialogContext.Provider value={{ confirm: async () => true }}>
							<TokenDanceSection
								connection={connection}
								onLogin={async () => {}}
								onChanged={async () => {}}
								onDeleted={() => {}}
								hiddenModels={new Set()}
								modelContextWindows={{}}
								onToggleHidden={() => {}}
								onContextWindowChange={() => {}}
							/>
						</ConfirmDialogContext.Provider>
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
	await settle();
}
async function inputAmount(value: string) {
	const input = container.querySelector("input");
	if (!input) throw new Error("Missing amount input");
	await act(async () => {
		input.dispatchEvent(new window.Event("focusin", { bubbles: true }));
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		if (setter) setter.call(input, value);
		else input.value = value;
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
		input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
	});
}
async function renderHost() {
	const route = createRootRoute({ component: TokenDanceRecoveryHost });
	const providers = createRoute({
		getParentRoute: () => route,
		path: "/settings/providers",
		validateSearch: (search) => ({ provider: search.provider }),
	});
	const index = createRoute({ getParentRoute: () => route, path: "/", component: () => null });
	const router = createRouter({
		routeTree: route.addChildren([providers, index]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();
	await act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<RouterProvider router={router} />
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
	await settle();
	return router;
}
async function recovery(action = "top_up_balance") {
	await act(async () => {
		window.dispatchEvent(
			new window.CustomEvent(TOKENDANCE_RECOVERY_EVENT, { detail: { action, narratorId: "n1" } }),
		);
	});
	await settle();
}
describe("TokenDance recharge behavior", () => {
	it.each([
		undefined,
		"invalid",
	])("missing or malformed billing marker %s never creates an order", async (billingInstance) => {
		getConnection.mockResolvedValue({ ...connection, billingInstance });
		await render();
		expect(container.textContent).toContain(errors.tokendanceRechargeBackendNotReady);
		expect(container.textContent).not.toContain(errors.tokendanceRechargeConfirm);
		expect(create).not.toHaveBeenCalled();
	});
	it("opening waits for a fresh connection and sends its marker rather than a cached one", async () => {
		qc.setQueryData(["tokendance", "connection", "admin"], connection);
		let resolve!: (value: TokenDancePublicConnection) => void;
		getConnection.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await render();
		expect(container.textContent).not.toContain(errors.tokendanceRechargeConfirm);
		expect(create).not.toHaveBeenCalled();
		const fresh = { ...connection, billingInstance: "fedcba9876543210fedcba9876543210" };
		await act(async () => {
			resolve(fresh);
		});
		await settle();
		await confirm();
		expect(create.mock.calls[0][0].billingInstance).toBe(fresh.billingInstance);
		expect(closed).toBe(0);
	});
	it.each([
		{ ...connection, generation: 5 },
		{ ...connection, generation: 6, disabled: true },
	])("ignores outdated connection cache until the opening's fresh read completes (%j)", async (cached) => {
		qc.setQueryData(["settings"], { tokendance: connection });
		qc.setQueryData(["tokendance", "connection", "admin"], cached);
		let resolve!: (value: TokenDancePublicConnection) => void;
		getConnection.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await render();
		expect(closed).toBe(0);
		expect(create).not.toHaveBeenCalled();
		expect(container.textContent).not.toContain(errors.tokendanceRechargeConfirm);
		await act(async () => {
			resolve(connection);
		});
		await settle();
		expect(closed).toBe(0);
		await confirm();
		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0][0].generation).toBe(connection.generation);
	});
	it("closes when the fresh opening read confirms that the connection is disabled", async () => {
		qc.setQueryData(["tokendance", "connection", "admin"], connection);
		getConnection.mockResolvedValue({ ...connection, disabled: true });
		await render();
		expect(closed).toBeGreaterThan(0);
		expect(create).not.toHaveBeenCalled();
	});
	it("a billing instance change aborts the old dialog without rebuilding its order", async () => {
		await render();
		await confirm();
		const signal = create.mock.calls[0][1]?.signal;
		await act(async () => {
			qc.setQueryData(["tokendance", "connection", "admin"], {
				...connection,
				billingInstance: "fedcba9876543210fedcba9876543210",
			});
		});
		await settle();
		expect(signal?.aborted).toBe(true);
		expect(closed).toBeGreaterThan(0);
		expect(create).toHaveBeenCalledTimes(1);
	});
	it("billing marker changes in settings also abort the old order", async () => {
		qc.setQueryData(["settings"], { tokendance: connection });
		await render();
		await confirm();
		const signal = create.mock.calls[0][1]?.signal;
		await act(async () => {
			qc.setQueryData(["settings"], {
				tokendance: { ...connection, billingInstance: "fedcba9876543210fedcba9876543210" },
			});
		});
		await settle();
		expect(signal?.aborted).toBe(true);
		expect(closed).toBeGreaterThan(0);
		expect(create).toHaveBeenCalledTimes(1);
	});
	it("an expiry-time paid confirmation refreshes once, including a suspended browser", async () => {
		create.mockResolvedValue({ session: { ...session(), expiresAt: Date.now() - 1 } });
		poll.mockResolvedValue({ session: session("paid") });
		await render();
		await confirm();
		expect(poll).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(paid).toBe(1);
		expect(container.textContent).toContain(errors.tokendancePayment_paid);
	});
	it("shows a clear success and amount immediately while balance refresh is pending", async () => {
		let resolve!: (value: typeof balance) => void;
		refresh.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await render();
		await confirm();
		poll.mockResolvedValue({ session: session("paid") });
		await tick(3000);
		expect(container.textContent).toContain(errors.tokendancePayment_paid);
		expect(container.textContent).toContain(
			i18n.t("tokendanceRechargeSuccess", { amount: "¥10.00" }),
		);
		expect(container.textContent).not.toContain(errors.tokendanceRechargeNotice);
		expect(container.textContent).not.toContain(errors.tokendanceRecoveryDismiss);
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("a")).toBeNull();
		expect(paid).toBe(1);
		await act(async () => {
			resolve(balance);
		});
		await settle();
		await act(() => button(errors.tokendanceRechargeDone).click());
		expect(closed).toBe(1);
		expect(paid).toBe(1);
	});
	it.each([
		"rejected",
		"hasError",
	] as const)("balance refresh %s keeps confirmed payment successful", async (failure) => {
		if (failure === "rejected") refresh.mockRejectedValue(new Error("PRIVATE BALANCE ERROR"));
		else refresh.mockResolvedValue({ ...balance, hasError: true });
		create.mockResolvedValue({ session: session("paid") });
		await render();
		await confirm();
		expect(container.textContent).toContain(errors.tokendancePayment_paid);
		expect(container.textContent).toContain(errors.tokendanceRechargeBalanceDelayed);
		expect(container.textContent).not.toContain(errors.tokendanceRechargeFailed);
		expect(container.textContent).not.toContain("PRIVATE");
		expect(container.textContent).not.toContain(errors.tokendanceRechargeNotice);
		expect(button(errors.tokendanceRechargeDone)).toBeTruthy();
		expect(create).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(paid).toBe(1);
	});
	it.each([
		"failed",
		"closed",
		"refunded",
		"expired",
		"pending",
	] as const)("final expiry status %s never credits and does not repoll", async (status) => {
		create.mockResolvedValue({ session: { ...session(), expiresAt: Date.now() - 1 } });
		poll.mockResolvedValue({ session: session(status) });
		await render();
		await confirm();
		expect(poll).toHaveBeenCalledTimes(1);
		expect(refresh).not.toHaveBeenCalled();
		expect(paid).toBe(0);
		expect(container.textContent).toContain(
			errors[`tokendancePayment_${status === "pending" ? "expired" : status}`],
		);
		expect([...timers.values()].some((timer) => timer.delay === 3000)).toBe(false);
	});
	it("final query failure offers safe verification advice rather than blind recharge", async () => {
		create.mockResolvedValue({ session: { ...session(), expiresAt: Date.now() - 1 } });
		poll.mockRejectedValue(new Error("PRIVATE final status failure"));
		await render();
		await confirm();
		expect(container.textContent).toContain(errors.tokendancePaymentUnconfirmed);
		expect(container.textContent).not.toContain("PRIVATE");
		expect(container.textContent).not.toContain(errors.tokendancePayment_expired);
		expect(container.querySelector("a")?.getAttribute("href")).toBe("https://tokendance.space/");
		expect(poll).toHaveBeenCalledTimes(1);
		expect(refresh).not.toHaveBeenCalled();
	});
	it("final query is capped at thirty seconds and a late paid result is ignored", async () => {
		let resolve!: (value: { session: TokenDancePaymentSession }) => void;
		create.mockResolvedValue({ session: { ...session(), expiresAt: Date.now() - 1 } });
		poll.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await render();
		await confirm();
		const signal = poll.mock.calls[0][1]?.signal;
		expect(container.textContent).toContain(errors.tokendancePaymentFinalCheck);
		await tick(30000);
		expect(signal?.aborted).toBe(true);
		expect(container.textContent).toContain(errors.tokendancePaymentUnconfirmed);
		await act(async () => {
			resolve({ session: session("paid") });
		});
		await settle();
		expect(refresh).not.toHaveBeenCalled();
		expect(paid).toBe(0);
		expect(poll).toHaveBeenCalledTimes(1);
	});
	it("closing during the final check aborts it and ignores a paid response", async () => {
		let resolve!: (value: { session: TokenDancePaymentSession }) => void;
		create.mockResolvedValue({ session: { ...session(), expiresAt: Date.now() - 1 } });
		poll.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await render();
		await confirm();
		const signal = poll.mock.calls[0][1]?.signal;
		await act(async () => {
			button(errors.tokendanceRecoveryDismiss).click();
		});
		expect(signal?.aborted).toBe(true);
		await act(async () => {
			resolve({ session: session("paid") });
		});
		await settle();
		expect(refresh).not.toHaveBeenCalled();
		expect(paid).toBe(0);
	});
	it.each([
		"actor",
		"generation",
		"billing",
	] as const)("%s changes abort an in-flight final check", async (change) => {
		let resolve!: (value: { session: TokenDancePaymentSession }) => void;
		create.mockResolvedValue({ session: { ...session(), expiresAt: Date.now() - 1 } });
		poll.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await render();
		await confirm();
		const signal = poll.mock.calls[0][1]?.signal;
		await act(async () => {
			if (change === "actor") qc.setQueryData(["auth", "me"], { id: "other", role: "admin" });
			else
				qc.setQueryData(["tokendance", "connection", "admin"], {
					...connection,
					...(change === "generation"
						? { generation: 8 }
						: { billingInstance: "fedcba9876543210fedcba9876543210" }),
				});
		});
		await settle();
		expect(signal?.aborted).toBe(true);
		await act(async () => {
			resolve({ session: session("paid") });
		});
		await settle();
		expect(refresh).not.toHaveBeenCalled();
		expect(paid).toBe(0);
		expect(create).toHaveBeenCalledTimes(1);
	});
	it("expiry and normal-poll callbacks racing at the exact deadline make one final query", async () => {
		create.mockResolvedValue({ session: { ...session(), expiresAt: Date.now() + 10000 } });
		await render();
		await confirm();
		const normalPoll = [...timers.values()].find((timer) => timer.delay === 3000);
		const expiry = [...timers.values()].find((timer) => timer.delay > 5000 && timer.delay < 15000);
		if (!normalPoll || !expiry) throw new Error("Missing polling and expiry timers");
		const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 10000);
		try {
			await act(async () => {
				normalPoll.callback();
				expiry.callback();
			});
			await settle();
		} finally {
			clock.mockRestore();
		}
		expect(poll).toHaveBeenCalledTimes(1);
		expect(refresh).not.toHaveBeenCalled();
		expect(container.textContent).toContain(errors.tokendancePayment_expired);
	});
	it("a pending response batched with expiry cannot cancel the final check", async () => {
		const initial = session();
		create.mockResolvedValue({ session: initial });
		let resolveRegular!: (value: { session: TokenDancePaymentSession }) => void;
		let resolveFinal!: (value: { session: TokenDancePaymentSession }) => void;
		poll.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolveRegular = done;
				}),
		);
		poll.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolveFinal = done;
				}),
		);
		await render();
		await confirm();
		const normal = [...timers.values()].find((timer) => timer.delay === 3000);
		const expiry = [...timers.values()].find((timer) => timer.delay > 40000);
		if (!normal || !expiry) throw new Error("Missing poll and expiry callbacks");
		await act(async () => {
			normal.callback();
			resolveRegular({ session: { ...initial } });
			await Promise.resolve();
			expiry.callback();
			await Promise.resolve();
		});
		await settle();
		expect(poll).toHaveBeenCalledTimes(2);
		expect(poll.mock.calls[1][1]?.signal?.aborted).toBe(false);
		expect(container.textContent).toContain(errors.tokendancePaymentFinalCheck);
		await act(async () => {
			resolveFinal({ session: { ...initial, status: "paid" } });
		});
		await settle();
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(paid).toBe(1);
	});
	it("ships all five narrator balance labels in both languages", () => {
		for (const key of [
			"tokendanceBalance",
			"tokendanceBalanceUnknown",
			"tokendanceBalanceDetails",
			"tokendanceBalanceStale",
			"tokendanceAdminRechargeRequired",
		] as const) {
			expect(narratorEn[key]).toBeTruthy();
			expect(narratorZh[key]).toBeTruthy();
		}
	});
	it("cold balance loading polls at three seconds then returns to thirty seconds", async () => {
		getBalance.mockResolvedValueOnce({ ...balance, balance: null, loading: true });
		await renderSection();
		expect(container.textContent).toContain("Balance: Unknown");
		const interval = [...intervals.values()].find((timer) => timer.delay === 3000);
		if (!interval) throw new Error("Missing cold balance interval");
		await act(async () => {
			interval.callback();
		});
		await settle();
		expect(getBalance).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("Balance: ¥9.999999");
		expect([...intervals.values()].some((timer) => timer.delay === 3000)).toBe(false);
		expect([...intervals.values()].some((timer) => timer.delay === 30000)).toBe(true);
		expect(refresh).not.toHaveBeenCalled();
	});
	it("loading errors retain the normal read polling interval without a forced refresh", async () => {
		getBalance.mockResolvedValue({ ...balance, loading: true, hasError: true });
		await renderSection();
		expect([...intervals.values()].some((timer) => timer.delay === 3000)).toBe(false);
		expect(refresh).not.toHaveBeenCalled();
	});
	it("hasError refresh response displays a safe failure and preserves known stale balance", async () => {
		refresh.mockResolvedValue({ ...balance, hasError: true });
		await renderSection();
		await act(async () => {
			button(settings.tokendance.refreshBalance).click();
		});
		await settle();
		expect(container.textContent).toContain(settings.tokendance.balanceRefreshFailed);
		expect(container.textContent).toContain(settings.tokendance.balanceStale);
		expect(container.textContent).toContain("Balance: ¥9.999999");
		expect(create).not.toHaveBeenCalled();
	});
	it("cached zero balance warns without creating an order", async () => {
		getBalance.mockResolvedValue({ ...balance, balance: 0 });
		await renderSection();
		expect(container.textContent).toContain(settings.tokendance.balanceInsufficient);
		expect(create).not.toHaveBeenCalled();
	});
	it("secure hex request IDs work when randomUUID is unavailable", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
		Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
		try {
			await render();
			await confirm();
			expect(create.mock.calls[0][0].requestId).toMatch(/^[a-f0-9]{32}$/);
		} finally {
			if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
			else Reflect.deleteProperty(crypto, "randomUUID");
		}
	});
	it("entropy failures restore the confirmation lock and show only a generic error", async () => {
		const entropy = spyOn(crypto, "getRandomValues").mockImplementationOnce(() => {
			throw new Error("PRIVATE entropy detail");
		});
		try {
			await render();
			await confirm();
			expect(create).not.toHaveBeenCalled();
			expect(container.textContent).toContain(errors.tokendanceRechargeFailed);
			expect(container.textContent).not.toContain("PRIVATE");
			expect(button(errors.tokendanceRechargeConfirm).disabled).toBe(false);
		} finally {
			entropy.mockRestore();
		}
		await confirm();
		expect(create).toHaveBeenCalledTimes(1);
	});
	it("global recharge entry opens UI but never pays or creates automatically", async () => {
		await renderHost();
		await act(async () => {
			openTokenDanceRecharge(window);
		});
		await settle();
		expect(container.textContent).toContain(errors.tokendanceRechargeConfirm);
		expect(create).not.toHaveBeenCalled();
		await act(async () => {
			button(errors.tokendanceRecoveryDismiss).click();
		});
		await settle();
		expect(container.textContent).not.toContain(errors.tokendanceRechargeConfirm);
		await act(async () => {
			openTokenDanceRecharge(window);
		});
		await settle();
		expect(create).not.toHaveBeenCalled();
	});
	it("a preloaded settings marker does not dismiss the first recovery prompt on its fresh read", async () => {
		qc.setQueryData(["settings"], { tokendance: connection });
		await renderHost();
		await recovery();
		expect(container.textContent).toContain(errors.tokendanceRecoveryTopUp);
		expect(create).not.toHaveBeenCalled();
		await act(async () => {
			button(errors.tokendanceRechargeTitle).click();
		});
		await settle();
		expect(container.textContent).toContain(errors.tokendanceRechargeConfirm);
	});
	it("recovery action requires explicit recharge and duplicate dismissed events do not reopen", async () => {
		await renderHost();
		await recovery();
		expect(create).not.toHaveBeenCalled();
		expect(container.textContent).toContain(errors.tokendanceRecoveryTopUp);
		await act(async () => {
			button(errors.tokendanceRecoveryDismiss).click();
		});
		await recovery();
		expect(container.textContent).not.toContain(errors.tokendanceRecoveryTopUp);
	});
	it("recovery recharge button opens same confirmation dialog", async () => {
		await renderHost();
		await recovery();
		await act(async () => {
			button(errors.tokendanceRechargeTitle).click();
		});
		await settle();
		expect(container.textContent).toContain(errors.tokendanceRechargeConfirm);
		expect(create).not.toHaveBeenCalled();
	});
	it("ordinary global recharge entry contacts administrator without payment controls", async () => {
		qc.setQueryData(["auth", "me"], { id: "ordinary", role: "user" });
		await renderHost();
		await act(async () => {
			openTokenDanceRecharge(window);
		});
		await settle();
		expect(container.textContent).toContain(errors.tokendanceRecoveryAdminRequired);
		expect(getConnection).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(container.textContent).not.toContain(errors.tokendanceRechargeConfirm);
	});
	it("quota warning remains a quota warning and navigation selects TokenDance", async () => {
		const router = await renderHost();
		await recovery("api_key_quota");
		expect(container.textContent).toContain(errors.tokendanceRecoveryQuota);
		await act(async () => {
			button(errors.tokendanceRecoveryManage).click();
		});
		await settle();
		expect(router.state.location.pathname).toBe("/settings/providers");
		expect(router.state.location.search).toMatchObject({ provider: "tokendance" });
	});
	it("credential changes dismiss the recovery prompt", async () => {
		await renderHost();
		await recovery();
		await act(async () => {
			qc.setQueryData(["tokendance", "connection", "admin"], { ...connection, generation: 8 });
		});
		await settle();
		expect(container.textContent).not.toContain(errors.tokendanceRecoveryTopUp);
	});
	it.each(["0", "1.5", "100001", ""])("rejects invalid integer amount %s", async (value) => {
		await render();
		await inputAmount(value);
		expect(button(errors.tokendanceRechargeConfirm).disabled).toBe(true);
		expect(create).not.toHaveBeenCalled();
	});
	it("shows unknown balance rather than zero and opens recharge without creating", async () => {
		getBalance.mockResolvedValue({ ...balance, balance: null, credits: null, creditsUsed: null });
		await renderSection();
		expect(container.textContent).toContain("Balance: Unknown");
		await act(async () => {
			button(settings.tokendance.recharge).click();
		});
		await settle();
		expect(container.textContent).toContain(errors.tokendanceRechargeConfirm);
		expect(create).not.toHaveBeenCalled();
	});
	it("shows zero and micro-CNY totals separately", async () => {
		getBalance.mockResolvedValue({ ...balance, balance: 0 });
		await renderSection();
		expect(container.textContent).toContain("Balance: ¥0.00");
		expect(container.textContent).toContain("Total consumed: ¥0.000001");
	});
	it("ordinary users see balance but no refresh or recharge button", async () => {
		qc.setQueryData(["auth", "me"], { id: "ordinary", role: "user" });
		await renderSection();
		expect(container.textContent).toContain("Balance: ¥9.999999");
		expect(container.textContent).not.toContain(settings.tokendance.refreshBalance);
		expect(
			[...container.querySelectorAll("button")].some(
				(b) => b.textContent === settings.tokendance.recharge,
			),
		).toBe(false);
	});
	it("ships all recharge and payment labels in both languages", () => {
		for (const key of Object.keys(errors).filter((key) =>
			/^tokendance(Recharge|Payment)/.test(key),
		)) {
			expect((errorsZh as Record<string, unknown>)[key]).toBeTruthy();
		}
	});
	it("distinguishes unknown, zero and micro-CNY precision", () => {
		expect(formatTokenDanceMoney(null)).toBeUndefined();
		expect(formatTokenDanceMoney(0)).toBe("¥0.00");
		expect(formatTokenDanceMoney(1)).toBe("¥0.000001");
		expect(formatTokenDanceMoney(1_234_567)).toBe("¥1.234567");
	});
	it("creates only after confirmation, deduplicates clicks and renders local QR", async () => {
		await render();
		expect(create).not.toHaveBeenCalled();
		await act(async () => {
			button(errors.tokendanceRechargeConfirm).click();
			button(errors.tokendanceRechargeConfirm).click();
			await Promise.resolve();
		});
		await settle();
		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0][0]).toMatchObject({
			amount: 10,
			generation: 7,
			billingInstance: connection.billingInstance,
		});
		expect(container.querySelector("img")?.getAttribute("src")).toStartWith("data:image/svg+xml");
		expect(container.querySelector("a")).toBeNull();
		expect(poll).not.toHaveBeenCalled();
	});
	it("reuses a confirmed request ID after a safe generic network failure", async () => {
		create.mockRejectedValueOnce(new Error("SECRET RAW UPSTREAM"));
		await render();
		await confirm();
		expect(container.textContent).not.toContain("SECRET");
		await confirm();
		expect(create.mock.calls[0][0].requestId).toBe(create.mock.calls[1][0].requestId);
	});
	it("exposes Alipay only as an explicit mobile click and never a paymentUrl link", async () => {
		globals.navigator.userAgent = "iPhone";
		await render();
		await confirm();
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("a")?.getAttribute("href")).toBe(session().alipayUrl);
	});
	it("asks mobile users without Alipay URL to scan on desktop", async () => {
		globals.navigator.userAgent = "Android";
		create.mockResolvedValue({ session: { ...session(), alipayUrl: undefined } });
		await render();
		await confirm();
		expect(container.querySelector("a")).toBeNull();
		expect(container.textContent).toContain(errors.tokendanceRechargeDesktop);
	});
	it("polls after three seconds and only paid refreshes once", async () => {
		await render();
		await confirm();
		expect(poll).not.toHaveBeenCalled();
		await tick(3000);
		expect(poll).toHaveBeenCalledTimes(1);
		expect(refresh).not.toHaveBeenCalled();
		poll.mockResolvedValue({ session: session("paid") });
		await tick(3000);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(paid).toBe(1);
		expect(qc.getQueryData<typeof balance>(["tokendance", "balance", 7])).toEqual(balance);
		expect([...timers.values()].some((timer) => timer.delay === 3000)).toBe(false);
	});
	it.each([
		"failed",
		"closed",
		"refunded",
		"expired",
	] as const)("stops on %s without crediting", async (status) => {
		poll.mockResolvedValue({ session: session(status) });
		await render();
		await confirm();
		await tick(3000);
		expect(refresh).not.toHaveBeenCalled();
		expect(paid).toBe(0);
		expect([...timers.values()].some((timer) => timer.delay === 3000)).toBe(false);
	});
	it("performs one final check for already expired pending orders", async () => {
		create.mockResolvedValue({ session: { ...session(), expiresAt: Date.now() - 1 } });
		await render();
		await confirm();
		expect(container.textContent).toContain(errors.tokendancePayment_expired);
		expect(poll).toHaveBeenCalledTimes(1);
		expect(refresh).not.toHaveBeenCalled();
	});
	it("close aborts pending create and reopening does not silently create an order", async () => {
		let resolve!: (value: { session: TokenDancePaymentSession }) => void;
		create.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await render();
		await confirm();
		const signal = create.mock.calls[0][1]?.signal;
		await act(() => button(errors.tokendanceRecoveryDismiss).click());
		expect(signal?.aborted).toBe(true);
		await render(false);
		await act(() => resolve({ session: session() }));
		await render();
		expect(create).toHaveBeenCalledTimes(1);
		expect(container.querySelector("img")).toBeNull();
	});
	it("actor changes abort the old order and close the dialog", async () => {
		await render();
		await confirm();
		const signal = create.mock.calls[0][1]?.signal;
		await act(() => qc.setQueryData(["auth", "me"], { id: "other", role: "admin" }));
		await settle();
		expect(signal?.aborted).toBe(true);
		expect(closed).toBeGreaterThan(0);
		expect(container.querySelector("img")).toBeNull();
	});
	it("connection generation changes abort the order", async () => {
		await render();
		await confirm();
		const signal = create.mock.calls[0][1]?.signal;
		await act(() =>
			qc.setQueryData(["tokendance", "connection", "admin"], { ...connection, generation: 8 }),
		);
		await settle();
		expect(signal?.aborted).toBe(true);
		expect(closed).toBeGreaterThan(0);
	});
	it("settings credential changes abort the current order immediately", async () => {
		await render();
		await confirm();
		const signal = create.mock.calls[0][1]?.signal;
		await act(async () => {
			qc.setQueryData(["settings"], { tokendance: { ...connection, generation: 8 } });
		});
		await settle();
		expect(signal?.aborted).toBe(true);
		expect(container.querySelector("img")).toBeNull();
	});
	it("disabled connection aborts pending polling", async () => {
		await render();
		await confirm();
		const signal = create.mock.calls[0][1]?.signal;
		await act(async () => {
			qc.setQueryData(["tokendance", "connection", "admin"], { ...connection, disabled: true });
		});
		await settle();
		expect(signal?.aborted).toBe(true);
		expect([...timers.values()].some((timer) => timer.delay === 3000)).toBe(false);
	});
	it("local expiry aborts an in-flight poll without marking paid", async () => {
		poll.mockImplementationOnce(() => new Promise(() => {}));
		await render();
		await confirm();
		await tick(3000);
		const signal = poll.mock.calls[0][1]?.signal;
		const expiry = [...timers.values()].find((timer) => timer.delay > 40000);
		if (!expiry) throw new Error("Missing expiry timer");
		await act(async () => {
			expiry.callback();
		});
		await settle();
		expect(signal?.aborted).toBe(true);
		expect(container.textContent).toContain(errors.tokendancePayment_expired);
		expect(refresh).not.toHaveBeenCalled();
	});
	it("stale-generation paid results cannot credit the current account", async () => {
		poll.mockResolvedValue({ session: { ...session("paid"), generation: 8 } });
		await render();
		await confirm();
		await tick(3000);
		expect(refresh).not.toHaveBeenCalled();
		expect(paid).toBe(0);
		expect([...timers.values()].some((timer) => timer.delay === 3000)).toBe(false);
	});
	it("oversized desktop QR data offers only a fixed official website fallback", async () => {
		create.mockResolvedValue({
			session: { ...session(), paymentUrl: `https://example.test/${"a".repeat(10000)}` },
		});
		await render();
		await confirm();
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toContain(errors.tokendanceRechargeQrUnavailable);
		expect(container.querySelector("a")?.getAttribute("href")).toBe("https://tokendance.space/");
		expect(container.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
	});
	it("QR encoder version-limit failure also provides the fixed website fallback", async () => {
		create.mockResolvedValue({
			session: { ...session(), paymentUrl: `https://pay.example.test/${"a".repeat(600)}` },
		});
		await render();
		await confirm();
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toContain(errors.tokendanceRechargeQrUnavailable);
		expect(container.querySelector("a")?.getAttribute("href")).toBe("https://tokendance.space/");
	});
	it.each(["1", "100000"])("accepts integer boundary %s CNY", async (value) => {
		await render();
		await inputAmount(value);
		await confirm();
		expect(create.mock.calls[0][0].amount).toBe(Number(value));
	});
	it("ordinary users cannot create payments", async () => {
		qc.setQueryData(["auth", "me"], { id: "user", role: "user" });
		await render();
		expect(container.querySelector("button")).toBeNull();
		expect(create).not.toHaveBeenCalled();
	});
	it("hides mismatching generation balances", async () => {
		function Summary() {
			const query = useTokenDanceBalance(8);
			return <div>{formatTokenDanceMoney(query.data?.balance) ?? "Unknown"}</div>;
		}
		await act(() =>
			root.render(
				<QueryClientProvider client={qc}>
					<Summary />
				</QueryClientProvider>,
			),
		);
		await settle();
		expect(container.textContent).toBe("Unknown");
	});
});
