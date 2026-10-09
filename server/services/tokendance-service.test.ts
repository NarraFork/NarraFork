import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isLegacyTokenDancePrefixAllowed } from "../lib/settings/tokendance-prefix";
import type { NarraForkSettings } from "../lib/settings/types";

const fakeSettings = {
	server: { allowedOrigins: ["https://ui.example"] },
	tokendance: { apiKey: "", disabled: false, generation: 0 },
	agent: { hiddenModels: [], modelAggregations: [] },
} as unknown as NarraForkSettings;
let saves = 0;
mock.module("../lib/settings", () => ({
	settings: fakeSettings,
	saveSettings: (next: NarraForkSettings) => {
		saves++;
		Object.assign(fakeSettings, next);
	},
}));
const service = await import("./tokendance-service");
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let ownerCount = 0;
function start(snapshot?: unknown) {
	const owner = `owner-${++ownerCount}`;
	const result = service.startTokenDanceOAuth(
		owner,
		new URL("https://ui.example/base/settings/providers/tokendance/callback"),
		snapshot,
	);
	return { ...result, owner };
}
function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), { status });
}
function fetchMock(fn: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) =>
		fn(String(url), init),
	) as unknown as typeof fetch;
}
beforeEach(async () => {
	Date.now = originalNow;
	await service.deleteTokenDanceConnection();
	saves = 0;
	fakeSettings.agent = {
		hiddenModels: [],
		modelAggregations: [],
	} as unknown as NarraForkSettings["agent"];
});
afterAll(() => {
	globalThis.fetch = originalFetch;
	Date.now = originalNow;
});

function createPayment(
	owner: string,
	input: Omit<Parameters<typeof service.createTokenDancePaymentSession>[1], "billingInstance">,
) {
	const billingInstance = service.getTokenDanceConnection().billingInstance;
	if (!billingInstance) throw new Error("Missing billing instance");
	return service.createTokenDancePaymentSession(owner, {
		...input,
		billingInstance,
	});
}
function connectBilling() {
	fakeSettings.tokendance = {
		apiKey: "billing-secret-key",
		disabled: false,
		generation: (fakeSettings.tokendance?.generation ?? 0) + 1,
	};
	return fakeSettings.tokendance.generation;
}
function paymentFixture(overrides: Record<string, unknown> = {}) {
	const seconds = Math.floor(Date.now() / 1000);
	return {
		session: {
			id: "pay-1",
			amount: 10,
			status: "pending",
			payment_url: "https://pay.example/qr",
			alipay_url: "alipays://platformapi/startapp?appId=20000067",
			status_url: "https://tokendance.space/portal/api/v1/payment/sessions/pay-1",
			created_at: seconds - 1,
			expired_at: seconds + 600,
			...overrides,
		},
	};
}
describe("TokenDance billing", () => {
	test.each([
		"create",
		"status",
		"final-status",
	] as const)("paid via %s returns while balance is pending and ignores its late disconnected result", async (source) => {
		const generation = connectBilling();
		const now = Date.now();
		Date.now = () => now;
		const owner = `nonblocking-${generation}`;
		const input = { amount: 10, generation, requestId: "h".repeat(43) };
		const fixture = paymentFixture();
		if (source !== "create") {
			fetchMock(() => json(fixture));
			await createPayment(owner, input);
			Date.now = () => (source === "final-status" ? fixture.session.expired_at * 1000 : now + 3001);
		}
		let finish!: (value: Response) => void;
		fetchMock((url) =>
			url.endsWith("/user/balance")
				? new Promise((resolve) => {
						finish = resolve;
					})
				: json({ session: { ...fixture.session, status: "paid" } }),
		);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const payment =
				source === "create"
					? createPayment(owner, input)
					: service.getTokenDancePaymentSession(owner, "pay-1");
			const result = await Promise.race([
				payment,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error("paid response blocked on balance")), 100);
				}),
			]);
			expect(result.status).toBe("paid");
			expect(service.getTokenDanceBalance()).toMatchObject({ loading: true, balance: null });
			const oldBalance = service.refreshTokenDanceBalance();
			await service.deleteTokenDanceConnection();
			connectBilling();
			fetchMock(() => json({ balance: { credits: 99, credits_used: 0, balance: 99 } }));
			await service.refreshTokenDanceBalance();
			finish(json({ balance: { credits: 1, credits_used: 0, balance: 1 } }));
			await oldBalance;
			expect(service.getTokenDanceBalance()).toMatchObject({ balance: 99, hasError: false });
		} finally {
			clearTimeout(timeout);
			finish?.(json({ balance: { credits: 0, credits_used: 0, balance: 0 } }));
			await service.deleteTokenDanceConnection();
		}
	});
	test.each([
		"paid",
		"pending",
	] as const)("full 24-hour order retains final %s query after creation TTL and has bounded grace", async (status) => {
		const generation = connectBilling();
		const now = Math.floor(Date.now() / 1000) * 1000;
		Date.now = () => now;
		const seconds = now / 1000;
		const fixture = paymentFixture({ created_at: seconds, expired_at: seconds + 86400 });
		fetchMock(() => json(fixture));
		const owner = `full-day-${generation}`;
		const input = { amount: 10, generation, requestId: "v".repeat(43) };
		const session = await createPayment(owner, input);
		expect(session.expiresAt - session.createdAt).toBe(86400000);
		Date.now = () => session.expiresAt + 1000;
		fetchMock((url) =>
			url.endsWith("/user/balance")
				? json({ balance: { credits: 10, credits_used: 0, balance: 10 } })
				: json({ session: { ...fixture.session, status, paid_at: seconds + 86400 } }),
		);
		const result = await service.getTokenDancePaymentSession(owner, session.id);
		expect(result.status).toBe(status === "paid" ? "paid" : "expired");
		expect(await createPayment(owner, input)).toEqual(result);
		await service.getTokenDancePaymentSession(owner, session.id);
		expect(globalThis.fetch).toHaveBeenCalledTimes(status === "paid" ? 2 : 1);
		Date.now = () => session.expiresAt + 10 * 60_000;
		await expect(service.getTokenDancePaymentSession(owner, session.id)).rejects.toHaveProperty(
			"statusCode",
			404,
		);
		if (status === "paid") await service.refreshTokenDanceBalance();
	});
	test.each([
		"create",
		"status",
	] as const)("paid via %s survives rejected balance refresh", async (source) => {
		const generation = connectBilling();
		const now = Date.now();
		const owner = `rejected-balance-${generation}`;
		const input = { amount: 10, generation, requestId: "a".repeat(43) };
		const fixture = paymentFixture();
		if (source === "status") {
			fetchMock(() => json(fixture));
			await createPayment(owner, input);
			Date.now = () => now + 3001;
		}
		fetchMock((url) =>
			url.endsWith("/user/balance")
				? Promise.reject(new Error("balance network failure"))
				: json({ session: { ...fixture.session, status: "paid" } }),
		);
		const result =
			source === "create"
				? await createPayment(owner, input)
				: await service.getTokenDancePaymentSession(owner, "pay-1");
		expect(result.status).toBe("paid");
		await service.refreshTokenDanceBalance();
		expect(service.getTokenDanceBalance()).toMatchObject({ hasError: true, loading: false });
		expect((await service.getTokenDancePaymentSession(owner, "pay-1")).status).toBe("paid");
	});
	test("uncertain creates keep their original 24-hour deduplication TTL", async () => {
		const generation = connectBilling();
		const now = Date.now();
		Date.now = () => now;
		fetchMock(() => json({ error: "uncertain" }, 502));
		const owner = `uncertain-ttl-${generation}`;
		const input = { amount: 10, generation, requestId: "c".repeat(43) };
		await expect(createPayment(owner, input)).rejects.toThrow("TokenDance");
		Date.now = () => now + 86400000 - 1;
		await expect(createPayment(owner, input)).rejects.toThrow("TokenDance");
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		Date.now = () => now + 86400000;
		fetchMock(() => json(paymentFixture()));
		expect((await createPayment(owner, input)).status).toBe("pending");
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
	test("expiry GETs joining pre-expiry pending request share one fresh final paid query", async () => {
		const generation = connectBilling();
		const now = Date.now();
		const fixture = paymentFixture();
		Date.now = () => now;
		fetchMock(() => json(fixture));
		const owner = `boundary-${generation}`;
		const session = await createPayment(owner, {
			amount: 10,
			generation,
			requestId: "j".repeat(43),
		});
		const queryTimes: number[] = [];
		let finishBefore!: (value: Response) => void;
		let finishFinal!: (value: Response) => void;
		let finalStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			finalStarted = resolve;
		});
		fetchMock((url) => {
			if (url.endsWith("/user/balance"))
				return json({ balance: { credits: 50, credits_used: 0, balance: 50 } });
			queryTimes.push(Date.now());
			if (queryTimes.length === 1)
				return new Promise((resolve) => {
					finishBefore = resolve;
				});
			return new Promise((resolve) => {
				finishFinal = resolve;
				finalStarted();
			});
		});
		Date.now = () => now + 3001;
		const before = service.getTokenDancePaymentSession(owner, session.id);
		Date.now = () => session.expiresAt + 1;
		const afterOne = service.getTokenDancePaymentSession(owner, session.id);
		const afterTwo = service.getTokenDancePaymentSession(owner, session.id);
		finishBefore(json(fixture));
		await started;
		expect(queryTimes).toHaveLength(2);
		expect(queryTimes[0]).toBeLessThan(session.expiresAt);
		expect(queryTimes[1]).toBeGreaterThan(session.expiresAt);
		finishFinal(
			json({
				session: { ...fixture.session, status: "paid", paid_at: Math.floor(now / 1000) + 10 },
			}),
		);
		const results = await Promise.all([before, afterOne, afterTwo]);
		expect(results.map((value) => value.status)).toEqual(["paid", "paid", "paid"]);
		await service.getTokenDancePaymentSession(owner, session.id);
		expect(queryTimes).toHaveLength(2);
		await service.refreshTokenDanceBalance();
		expect(service.getTokenDanceBalance().balance).toBe(50);
	});
	test("billing instance is stable during process lifetime and an old instance cannot create orders", async () => {
		const generation = connectBilling();
		const marker = service.getTokenDanceConnection().billingInstance;
		expect(marker).toMatch(/^[a-f0-9]{32}$/);
		fetchMock(() => json(paymentFixture()));
		await expect(
			service.createTokenDancePaymentSession("restart-owner", {
				amount: 10,
				generation,
				requestId: "k".repeat(43),
				billingInstance: marker === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32),
			}),
		).rejects.toHaveProperty("statusCode", 409);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		await service.setTokenDanceDisabled(true);
		expect(service.getTokenDanceConnection().billingInstance).toBe(marker);
	});
	test.each([
		"paid",
		"pending",
		"failed-request",
	] as const)("one final expiry query handles %s without replay", async (result) => {
		const generation = connectBilling();
		const now = Date.now();
		const fixture = paymentFixture();
		fetchMock(() => json(fixture));
		const owner = `final-${generation}`;
		await createPayment(owner, { amount: 10, generation, requestId: "q".repeat(43) });
		Date.now = () => now + 601000;
		fetchMock((url) => {
			if (url.endsWith("/user/balance"))
				return json({ balance: { credits: 20, credits_used: 0, balance: 20 } });
			if (result === "failed-request") return json({ error: "billing-secret-key" }, 502);
			return json({
				session: {
					...fixture.session,
					status: result,
					...(result === "paid" ? { paid_at: Math.floor(now / 1000) + 10 } : {}),
				},
			});
		});
		if (result === "failed-request") {
			for (let i = 0; i < 2; i++)
				await expect(service.getTokenDancePaymentSession(owner, "pay-1")).rejects.toHaveProperty(
					"code",
					"TOKENDANCE_PAYMENT_EXPIRED_UNCONFIRMED",
				);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		} else {
			const [one, two] = await Promise.all([
				service.getTokenDancePaymentSession(owner, "pay-1"),
				service.getTokenDancePaymentSession(owner, "pay-1"),
			]);
			expect(one.status).toBe(result === "paid" ? "paid" : "expired");
			expect(two).toEqual(one);
			await service.getTokenDancePaymentSession(owner, "pay-1");
			expect(globalThis.fetch).toHaveBeenCalledTimes(result === "paid" ? 2 : 1);
			if (result === "paid") {
				await service.refreshTokenDanceBalance();
				expect(service.getTokenDanceBalance().balance).toBe(20);
			}
		}
	});
	test("pending orders never schedule automatic polling", async () => {
		const generation = connectBilling();
		const delays: number[] = [];
		const setTimer = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: TimerHandler,
			delay?: number,
		) => {
			delays.push(delay ?? 0);
			return setTimer(fn, delay);
		}) as typeof setTimeout);
		try {
			fetchMock(() => json(paymentFixture()));
			await createPayment("no-background-owner", {
				amount: 10,
				generation,
				requestId: "n".repeat(43),
			});
			expect(delays).toEqual([30000]);
			expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		} finally {
			timer.mockRestore();
		}
	});
	test.each([
		"create",
		"status",
	] as const)("paid via %s invalidates an earlier in-flight balance request without stale overwrite", async (source) => {
		const generation = connectBilling();
		const now = Date.now();
		let finish!: (value: Response) => void;
		let balanceCalls = 0;
		let paid = source === "create";
		fetchMock((url) => {
			if (url.endsWith("/user/balance")) {
				balanceCalls++;
				if (balanceCalls === 1)
					return new Promise((resolve) => {
						finish = resolve;
					});
				return json({ balance: { credits: 100, credits_used: 1, balance: 99 } });
			}
			return json(paymentFixture({ status: paid ? "paid" : "pending" }));
		});
		const stale = service.refreshTokenDanceBalance();
		await createPayment("fresh-balance-owner", {
			amount: 10,
			generation,
			requestId: "s".repeat(43),
		});
		if (source === "status") {
			paid = true;
			Date.now = () => now + 3001;
			await service.getTokenDancePaymentSession("fresh-balance-owner", "pay-1");
		}
		expect(balanceCalls).toBe(2);
		await service.refreshTokenDanceBalance();
		expect(service.getTokenDanceBalance()).toMatchObject({ balance: 99, hasError: false });
		finish(json({ balance: { credits: 1, credits_used: 1, balance: 0 } }));
		await stale;
		expect(service.getTokenDanceBalance()).toMatchObject({
			balance: 99,
			hasError: false,
			updatedAt: expect.any(Number),
		});
		expect(Date.now()).toBeGreaterThanOrEqual(now);
	});
	test.each([
		"balance",
		"payment_create",
		"payment_status",
	] as const)("slow %s logs only fixed operation, duration and generation", async (operation) => {
		const generation = connectBilling();
		const now = Date.now();
		const input = { amount: 10, generation, requestId: "w".repeat(43) };
		if (operation === "payment_status") {
			fetchMock(() => json(paymentFixture()));
			await createPayment(`slow-${generation}`, input);
			Date.now = () => now + 3001;
		}
		let clock = 0;
		const timing = spyOn(performance, "now").mockImplementation(() => clock);
		const warnings: unknown[][] = [];
		const warn = spyOn(console, "warn").mockImplementation((...args) => {
			warnings.push(args);
		});
		try {
			fetchMock(() => {
				clock = 2500;
				return json({ error: "billing-secret-key" }, 500);
			});
			if (operation === "balance") await service.refreshTokenDanceBalance();
			else if (operation === "payment_create")
				await expect(createPayment(`slow-${generation}`, input)).rejects.toThrow("TokenDance");
			else await service.getTokenDancePaymentSession(`slow-${generation}`, "pay-1");
			expect(warnings).toEqual([
				["[TokenDance] Slow billing operation", { operation, elapsedMs: 2500, generation }],
			]);
		} finally {
			timing.mockRestore();
			warn.mockRestore();
		}
	});
	test("slow cancellation still logs timing without credentials or error content", async () => {
		connectBilling();
		let clock = 0;
		const timing = spyOn(performance, "now").mockImplementation(() => clock);
		const warnings: unknown[][] = [];
		const warn = spyOn(console, "warn").mockImplementation((...args) => {
			warnings.push(args);
		});
		try {
			fetchMock(() => new Promise(() => {}));
			const task = service.refreshTokenDanceBalance();
			clock = 2500;
			await service.deleteTokenDanceConnection();
			await task;
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.[1]).toMatchObject({ operation: "balance", elapsedMs: 2500 });
			expect(JSON.stringify(warnings)).not.toContain("billing-secret-key");
		} finally {
			timing.mockRestore();
			warn.mockRestore();
		}
	});
	test("24-hour session lifetime boundary is allowed without automatic background work", async () => {
		const generation = connectBilling();
		const seconds = Math.floor(Date.now() / 1000);
		fetchMock(() => json(paymentFixture({ expired_at: seconds + 86399 })));
		const session = await createPayment("day-boundary-owner", {
			amount: 10,
			generation,
			requestId: "d".repeat(43),
		});
		expect(session.expiresAt - session.createdAt).toBe(86400000);
	});
	test("balance supports zero/negative micro-units and merges stale-while-revalidate requests", async () => {
		connectBilling();
		let finish!: (value: Response) => void;
		fetchMock((url, init) => {
			expect(url).toEndWith("/portal/api/v1/user/balance");
			expect(init?.redirect).toBe("error");
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer billing-secret-key");
			return new Promise((resolve) => {
				finish = resolve;
			});
		});
		expect(service.getTokenDanceBalance()).toMatchObject({ loading: true, balance: null });
		service.getTokenDanceBalance();
		const task = service.refreshTokenDanceBalance();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		finish(json({ balance: { credits: 0, credits_used: 5, balance: -5 } }));
		expect(await task).toMatchObject({
			credits: 0,
			creditsUsed: 5,
			balance: -5,
			loading: false,
			hasError: false,
		});
		service.getTokenDanceBalance();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
	test.each([
		null,
		{ credits: 1.5, credits_used: 0, balance: 0 },
		{ credits: 1, credits_used: 0, balance: "secret" },
		{ credits: 10, credits_used: 5, balance: 6 },
	])("invalid balance stays null and failures are rate limited (%j)", async (balance) => {
		connectBilling();
		fetchMock(() => json({ balance }));
		expect(await service.refreshTokenDanceBalance()).toMatchObject({
			balance: null,
			hasError: true,
		});
		for (let i = 0; i < 10; i++) service.getTokenDanceBalance();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
	test("balance TTL expiration revalidates once and preserves stale amounts on failure", async () => {
		connectBilling();
		const now = Date.now();
		Date.now = () => now;
		fetchMock(() => json({ balance: { credits: 20, credits_used: 10, balance: 10 } }));
		await service.refreshTokenDanceBalance();
		Date.now = () => now + 30001;
		fetchMock(() => json({ error: "billing-secret-key" }, 500));
		expect(service.getTokenDanceBalance()).toMatchObject({ balance: 10, loading: true });
		await service.refreshTokenDanceBalance();
		expect(service.getTokenDanceBalance()).toMatchObject({
			balance: 10,
			loading: false,
			hasError: true,
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
	test("late balance cannot overwrite a new connection", async () => {
		connectBilling();
		let finish!: (value: Response) => void;
		fetchMock(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const task = service.refreshTokenDanceBalance();
		await service.deleteTokenDanceConnection();
		finish(json({ balance: { credits: 1, credits_used: 0, balance: 1 } }));
		await task;
		expect(service.getTokenDanceBalance()).toMatchObject({ balance: null, loading: false });
	});
	test("confirmed payment is deduplicated including concurrent and conflicting retries", async () => {
		const generation = connectBilling();
		fetchMock(() => json(paymentFixture()));
		const input = { amount: 10, generation, requestId: "x".repeat(43) };
		const [one, two] = await Promise.all([
			createPayment("billing-owner", input),
			createPayment("billing-owner", input),
		]);
		expect(one).toEqual(two);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(await createPayment("billing-owner", input)).toEqual(one);
		await expect(createPayment("billing-owner", { ...input, amount: 11 })).rejects.toHaveProperty(
			"statusCode",
			409,
		);
		await expect(service.getTokenDancePaymentSession("other-owner", one.id)).rejects.toHaveProperty(
			"statusCode",
			404,
		);
		expect(JSON.stringify(one)).not.toContain("status_url");
	});
	test("failed/uncertain creates never POST again for same request", async () => {
		const generation = connectBilling();
		fetchMock(() => json({ error: "billing-secret-key" }, 502));
		const input = { amount: 10, generation, requestId: "f".repeat(43) };
		for (let i = 0; i < 2; i++)
			await expect(createPayment("failed-owner", input)).rejects.toThrow(
				"TokenDance billing request failed",
			);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
	test.each([
		{ status_url: "https://evil.example/portal/api/v1/payment/sessions/pay-1" },
		{ status_url: "https://tokendance.space/portal/api/v1/payment/sessions/pay-1?key=x" },
		{ payment_url: "javascript:alert(1)" },
		{ payment_url: "https://user:password@pay.example/qr" },
		{ payment_url: "https://pay.example/billing-secret-key" },
		{ alipay_url: "alipays://evil/startapp" },
		{ amount: 11 },
		{ status: "unknown" },
		{ status: "paid", paid_at: 1 },
		{ expired_at: Number.MAX_SAFE_INTEGER },
		{ expired_at: Math.floor(Date.now() / 1000) + 86401 },
	])("rejects unsafe or inconsistent payment fields (%j)", async (overrides) => {
		const generation = connectBilling();
		fetchMock(() => json(paymentFixture(overrides)));
		await expect(
			createPayment(`unsafe-${generation}`, {
				amount: 10,
				generation,
				requestId: "u".repeat(43),
			}),
		).rejects.toThrow("Invalid TokenDance");
	});
	test("only server-confirmed paid refreshes balance; status polls merge and throttle", async () => {
		const generation = connectBilling();
		const now = Date.now();
		Date.now = () => now;
		let status = "pending";
		fetchMock((url) =>
			url.endsWith("/user/balance")
				? json({ balance: { credits: 10, credits_used: 0, balance: 10 } })
				: json(
						paymentFixture({
							status,
							...(status === "paid" ? { paid_at: Math.floor(Date.now() / 1000) } : {}),
						}),
					),
		);
		const session = await createPayment("poll-owner", {
			amount: 10,
			generation,
			requestId: "p".repeat(43),
		});
		service.setTokenDanceRecoveryAction("top_up_balance", generation);
		await service.getTokenDancePaymentSession("poll-owner", session.id);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		Date.now = () => now + 3001;
		await Promise.all([
			service.getTokenDancePaymentSession("poll-owner", session.id),
			service.getTokenDancePaymentSession("poll-owner", session.id),
		]);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		expect(service.getTokenDanceConnection().recoveryAction).toBe("top_up_balance");
		status = "paid";
		Date.now = () => now + 6002;
		expect((await service.getTokenDancePaymentSession("poll-owner", session.id)).status).toBe(
			"paid",
		);
		expect(globalThis.fetch).toHaveBeenCalledTimes(4);
		expect(service.getTokenDanceConnection().recoveryAction).toBeUndefined();
	});
	test.each([
		"reauthorize_api_key",
		"api_key_quota",
	] as const)("paid preserves unrelated recovery %s", async (action) => {
		const generation = connectBilling();
		service.setTokenDanceRecoveryAction(action, generation);
		fetchMock((url) =>
			url.endsWith("/user/balance")
				? json({ balance: { credits: 1, credits_used: 0, balance: 1 } })
				: json(paymentFixture({ status: "paid" })),
		);
		await createPayment(`recovery-${generation}`, {
			amount: 10,
			generation,
			requestId: "r".repeat(43),
		});
		expect(service.getTokenDanceConnection().recoveryAction).toBe(action);
	});
	test("late create is cancelled on disconnect and never becomes an accessible order", async () => {
		const generation = connectBilling();
		let finish!: (value: Response) => void;
		fetchMock(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const task = createPayment("late-owner", {
			amount: 10,
			generation,
			requestId: "l".repeat(43),
		});
		await service.deleteTokenDanceConnection();
		finish(json(paymentFixture()));
		await expect(task).rejects.toThrow("TokenDance");
		await expect(service.getTokenDancePaymentSession("late-owner", "pay-1")).rejects.toHaveProperty(
			"statusCode",
			404,
		);
	});
	test("owner request budget and response size limit bound failed creates", async () => {
		const generation = connectBilling();
		fetchMock(() => new Response("x".repeat(65537)));
		for (let i = 0; i < 10; i++)
			await expect(
				createPayment("budget-owner", {
					amount: 10,
					generation,
					requestId: `${i}`.padStart(43, "b"),
				}),
			).rejects.toThrow("TokenDance");
		await expect(
			createPayment("budget-owner", {
				amount: 10,
				generation,
				requestId: "z".repeat(43),
			}),
		).rejects.toHaveProperty("statusCode", 429);
		expect(globalThis.fetch).toHaveBeenCalledTimes(10);
	});
	test("malformed paid status cannot mark a pending session paid or refresh balance", async () => {
		const generation = connectBilling();
		const now = Date.now();
		Date.now = () => now;
		fetchMock(() => json(paymentFixture()));
		await createPayment("invalid-paid-owner", {
			amount: 10,
			generation,
			requestId: "i".repeat(43),
		});
		Date.now = () => now + 3001;
		fetchMock(() =>
			json(paymentFixture({ status: "paid", amount: 11, paid_at: Math.floor(Date.now() / 1000) })),
		);
		expect((await service.getTokenDancePaymentSession("invalid-paid-owner", "pay-1")).status).toBe(
			"pending",
		);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
	test("expiry stops polling and disabled connections invalidate old orders", async () => {
		const generation = connectBilling();
		const now = Date.now();
		fetchMock(() => json(paymentFixture()));
		const session = await createPayment("expire-owner", {
			amount: 10,
			generation,
			requestId: "e".repeat(43),
		});
		Date.now = () => now + 601000;
		expect((await service.getTokenDancePaymentSession("expire-owner", session.id)).status).toBe(
			"expired",
		);
		await service.getTokenDancePaymentSession("expire-owner", session.id);
		expect(globalThis.fetch).toHaveBeenCalledTimes(2);
		await service.setTokenDanceDisabled(true);
		await expect(
			service.getTokenDancePaymentSession("expire-owner", session.id),
		).rejects.toHaveProperty("statusCode", 404);
	});
});

describe("TokenDance backend", () => {
	test("refresh and reauthorization preserve initialized collection and user visibility choices", async () => {
		fakeSettings.tokendance = {
			apiKey: "existing-platform-key",
			disabled: false,
			generation: 100,
			modelCollectionInitialized: true,
		};
		fakeSettings.agent.hiddenModels = ["tokendance:kimi-k3", "other:hidden"];
		fetchMock((url) =>
			url.endsWith("/auth/keys")
				? json({ key: "new-platform-key" })
				: json({
						data: [
							{ id: "glm-5", name: "Enabled manually", supported_protocols: ["openai:responses"] },
							{
								id: "future-new-model",
								name: "New model",
								supported_protocols: ["openai:responses"],
							},
						],
					}),
		);
		await service.refreshTokenDanceModels();
		expect(fakeSettings.tokendance.modelCollectionInitialized).toBe(true);
		expect(fakeSettings.agent.hiddenModels).toEqual(["tokendance:kimi-k3", "other:hidden"]);
		const flow = start();
		await service.completeTokenDanceOAuth(flow.owner, flow.flowId, "one-time-code");
		expect(fakeSettings.tokendance.modelCollectionInitialized).toBe(true);
		expect(fakeSettings.agent.hiddenModels).toEqual(["tokendance:kimi-k3", "other:hidden"]);
		expect(service.getTokenDanceCatalogModels().map((model) => model.id)).toEqual([
			"glm-5",
			"future-new-model",
		]);
	});
	test.each([
		"top_up_balance",
		"reauthorize_api_key",
		"api_key_quota",
	] as const)("refresh preserves %s even when its error body never finishes", async (action) => {
		fakeSettings.tokendance = { apiKey: "secret-refresh-key", disabled: false, generation: 100 };
		let cancelled = false;
		fetchMock(
			() =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{
						status: 429,
						headers: { "TokenDance-Recovery-Action": action, "Content-Length": "999999999" },
					},
				),
		);
		try {
			await service.refreshTokenDanceModels();
			throw new Error("Expected recovery error");
		} catch (error) {
			expect(error).toHaveProperty("extra.recoveryAction", action);
		}
		expect(service.getTokenDanceConnection().recoveryAction).toBe(action);
		expect(cancelled).toBe(true);
	});
	test("public DTO omits key and ordinary settings explicitly override spread", () => {
		fakeSettings.tokendance = { apiKey: "secret-never-return", disabled: false, generation: 100 };
		expect(JSON.stringify(service.getTokenDanceConnection())).not.toContain("secret-never-return");
		const source = readFileSync(new URL("../routes/settings.ts", import.meta.url), "utf8");
		expect(source).toContain("tokendance: getTokenDanceConnection()");
		expect(source).toContain('new Set(["codex", "tokendance"])');
	});
	test.each([
		"not-a-url",
		"https://evil.example/settings/providers/tokendance/callback",
		"https://ui.example/other",
		"https://ui.example/settings/providers/tokendance/callback?code=private-code",
	])("invalid callback has a distinct safe diagnostic code (%s)", (callback) => {
		try {
			service.validateTokenDanceCallback(
				callback,
				"https://ui.example/api/tokendance/oauth/start",
				"https://ui.example",
			);
			throw new Error("Expected callback rejection");
		} catch (error) {
			expect(error).toMatchObject({ statusCode: 400, code: "TOKENDANCE_CALLBACK_INVALID" });
		}
	});
	test("browser same-origin callbacks survive proxy Host rewrites without trusting other sites", () => {
		const callback = "https://public.example/nf/settings/providers/tokendance/callback";
		const internal = "http://127.0.0.1:7778/api/tokendance/oauth/start";
		expect(
			service.validateTokenDanceCallback(
				callback,
				internal,
				"https://public.example",
				"same-origin",
			).href,
		).toBe(callback);
		for (const site of [undefined, "same-site", "cross-site", "none", "same-origin, cross-site"]) {
			expect(() =>
				service.validateTokenDanceCallback(callback, internal, "https://public.example", site),
			).toThrow();
		}
		for (const invalid of [
			"https://evil.example/settings/providers/tokendance/callback",
			"https://public.example/other",
			`${callback}?code=private-code`,
			`${callback}#private-key`,
			"https://user:password@public.example/settings/providers/tokendance/callback",
		]) {
			expect(() =>
				service.validateTokenDanceCallback(
					invalid,
					internal,
					"https://public.example",
					"same-origin",
				),
			).toThrow();
		}
		expect(() =>
			service.validateTokenDanceCallback(callback, internal, undefined, "same-origin"),
		).toThrow();
	});
	test("callback origin/path is controlled and loopback dev/subpaths work", () => {
		expect(
			service.validateTokenDanceCallback(
				"http://localhost:7778/base/settings/providers/tokendance/callback",
				"http://localhost:7779/api/tokendance/oauth/start",
				"http://localhost:7778",
			).pathname,
		).toStartWith("/base/");
		expect(() =>
			service.validateTokenDanceCallback(
				"https://evil.example/settings/providers/tokendance/callback",
				"https://server.example/api/x",
				"https://evil.example",
			),
		).toThrow();
		expect(() =>
			service.validateTokenDanceCallback(
				"https://ui.example/other",
				"https://server.example/api/x",
				"https://ui.example",
			),
		).toThrow();
		expect(() =>
			service.validateTokenDanceCallback(
				"https://ui.example/settings/providers/tokendance/callback?code=secret",
				"https://server.example/api/x",
				"https://ui.example",
			),
		).toThrow();
	});
	test("PKCE challenge and fixed attribution; snapshot owner-only one-time claim does not consume flow", async () => {
		const snapshot = {
			draft: { openaiProviders: [{ apiKey: "unsaved-other-key" }] },
			baseline: {},
			addPage: {},
		};
		const flow = start(snapshot);
		const auth = new URL(flow.authorizeUrl);
		expect(auth.origin).toBe("https://tokendance.space");
		expect(auth.searchParams.get("app_url")).toBe("https://tokendanceconnect.narrafork.dev/");
		expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
		expect(new URL(auth.searchParams.get("callback_url") as string).searchParams.get("state")).toBe(
			flow.flowId,
		);
		expect(() => service.restoreTokenDanceDraft("wrong", flow.flowId)).toThrow();
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId)).toEqual({
			status: "pending",
			draftSnapshot: snapshot,
		});
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId)).toEqual({ status: "pending" });
		fetchMock((_url, init) =>
			init?.method === "POST" ? json({ key: "key-private" }) : json({ data: [] }),
		);
		expect(
			(await service.completeTokenDanceOAuth(flow.owner, flow.flowId, "opaque-code")).connected,
		).toBe(true);
	});
	test("reject TokenDance draft fields and oversized snapshot before redirect", () => {
		expect(() => start({ draft: { tokendance: { apiKey: "bad" } }, baseline: {} })).toThrow();
		expect(() =>
			start({ draft: { nested: [{ prefix: "tokendance", apiKey: "bad" }] }, baseline: {} }),
		).not.toThrow();
		expect(() => start({ draft: { text: "x".repeat(1024 * 1024) }, baseline: {} })).toThrow();
	});
	test("consume exchange once under concurrency; persist before catalog; safe recovery", async () => {
		const flow = start({ draft: {}, baseline: {} });
		let resolve!: (value: Response) => void;
		fetchMock((_url, init) =>
			init?.method === "POST"
				? new Promise((r) => {
						resolve = r;
					})
				: new Response("secret-upstream", {
						status: 402,
						headers: { "TokenDance-Recovery-Action": "top_up_balance" },
					}),
		);
		const first = service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code-private");
		await expect(
			service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code-private"),
		).rejects.toThrow("already consumed");
		resolve(json({ key: "key-private" }));
		const result = await first;
		expect(result).toEqual({
			connected: true,
			modelsRefreshed: false,
			refreshError: "TokenDance model refresh failed",
			recoveryAction: "top_up_balance",
		});
		expect(saves).toBe(1);
		expect(JSON.stringify(result)).not.toContain("secret-upstream");
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId).status).toBe("completed");
	});
	test("failed and cancelled exchanges retain snapshots without replay", async () => {
		const flow = start({ draft: { value: 1 }, baseline: {} });
		fetchMock(() => json({ message: "sensitive-code" }, 400));
		await expect(service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code")).rejects.toThrow(
			"authorization failed",
		);
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId).status).toBe("failed");
		await expect(service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code")).rejects.toThrow(
			"already consumed",
		);
		const cancelled = start({ draft: {}, baseline: {} });
		service.cancelTokenDanceOAuth(cancelled.owner, cancelled.flowId);
		expect(service.restoreTokenDanceDraft(cancelled.owner, cancelled.flowId).status).toBe(
			"cancelled",
		);
	});
	test("delete invalidates late complete and preserves owner snapshot", async () => {
		const flow = start({ draft: {}, baseline: {} });
		let resolve!: (value: Response) => void;
		fetchMock(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const pending = service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code");
		await service.deleteTokenDanceConnection();
		resolve(json({ key: "late-key-private" }));
		await expect(pending).rejects.toThrow();
		expect(service.getTokenDanceConnection().connected).toBe(false);
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId)).toEqual({
			status: "cancelled",
			draftSnapshot: { draft: {}, baseline: {} },
		});
	});
	test("catalog filters non-conversation entries, sends attribution, and ignores late refresh", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 501 };
		fetchMock((_url, init) => {
			expect(new Headers(init?.headers).get("X-App-URL")).toBe(
				"https://tokendanceconnect.narrafork.dev/",
			);
			return json({
				data: [
					{
						id: "chat",
						name: "Chat",
						context_length: 100000,
						supported_protocols: ["openai:responses"],
					},
					{ id: "image", supported_protocols: ["image:generation"] },
				],
			});
		});
		expect((await service.refreshTokenDanceModels()).map((m) => m.id)).toEqual(["chat"]);
		let resolve!: (value: Response) => void;
		fetchMock(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const pending = service.refreshTokenDanceModels();
		await service.deleteTokenDanceConnection();
		resolve(json({ data: [{ id: "late", supported_protocols: ["openai:responses"] }] }));
		await expect(pending).rejects.toThrow();
		expect(service.getTokenDanceConnection().models).toEqual([]);
	});
	test("bounded exchange rejects huge success/error bodies", async () => {
		fetchMock(() => new Response("x".repeat(65537)));
		const flow = start();
		await expect(service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code")).rejects.toThrow(
			"request failed",
		);
		expect(saves).toBe(0);
	});
	test("expiry and restart unavailable flow are explicit", () => {
		const flow = start({ draft: {}, baseline: {} });
		Date.now = () => originalNow() + 600001;
		expect(() => service.restoreTokenDanceDraft(flow.owner, flow.flowId)).toThrow(
			"expired or unavailable",
		);
		expect(() => service.restoreTokenDanceDraft(flow.owner, "never-existed")).toThrow(
			"expired or unavailable",
		);
	});
	test("delete cleans settings references and cancels runtime requests", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 600 };
		fakeSettings.agent.defaultModel = "tokendance:chat";
		fakeSettings.agent.hiddenModels = ["tokendance:chat", "other:chat"];
		fakeSettings.agent.modelAggregations = [
			{ id: "x", name: "X", routingMode: "priority", models: ["tokendance:chat"] },
		];
		const controller = new AbortController();
		service.registerTokenDanceRequest(controller, 600);
		await service.deleteTokenDanceConnection();
		expect(controller.signal.aborted).toBe(true);
		expect(fakeSettings.agent.defaultModel).toBe("");
		expect(fakeSettings.agent.hiddenModels).toEqual(["other:chat"]);
		expect(fakeSettings.agent.modelAggregations).toEqual([]);
	});
	test("delete clears only known model references and preserves unrelated prefix-like strings", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 700 };
		fakeSettings.agent = {
			...fakeSettings.agent,
			defaultModel: "tokendance:vendor:opaque/id",
			summaryModel: "tokendance:chat",
			translationModel: "other:translation",
			promptOptimizeModel: "tokendance:chat",
			defaultSystemPrompt: "tokendance: respond briefly",
			commandWhitelist: [{ pattern: "tokendance: command pattern", enabled: true }],
			customRetryRules: [{ id: "retry", keyword: "tokendance: retry keyword", enabled: true }],
			customModels: [
				{ value: "tokendance:chat", label: "Platform" },
				{ value: "other:chat", label: "Other" },
			],
			modelCards: [
				{ modelKey: "tokendance:chat" },
				{ modelKey: "other:chat", notes: "tokendance: keep this note" },
			],
			modelContextWindows: { "tokendance:chat": 200000, "other:chat": 100000 },
			subagentModels: { explore: "tokendance:chat", plan: "other:chat" },
			subagentAllowedModels: {
				explore: ["tokendance:chat", "other:chat"],
				plan: [],
				general: [],
				search: [],
				review: [],
			},
			hiddenModels: ["tokendance:chat", "other:chat"],
			providerOrder: ["tokendance", "other"],
			disabledProviders: ["tokendance", "other"],
			modelAggregations: [
				{
					id: "mixed",
					name: "tokendance: label",
					routingMode: "priority",
					models: ["tokendance:chat", "other:chat"],
				},
			],
		} as unknown as NarraForkSettings["agent"];
		const unrelated = structuredClone({
			prompt: fakeSettings.agent.defaultSystemPrompt,
			commands: fakeSettings.agent.commandWhitelist,
			retries: fakeSettings.agent.customRetryRules,
		});
		await service.deleteTokenDanceConnection();
		expect({
			prompt: fakeSettings.agent.defaultSystemPrompt,
			commands: fakeSettings.agent.commandWhitelist,
			retries: fakeSettings.agent.customRetryRules,
		}).toEqual(unrelated);
		expect(fakeSettings.agent.defaultModel).toBe("");
		expect(fakeSettings.agent.summaryModel).toBe("");
		expect(fakeSettings.agent.translationModel).toBe("other:translation");
		expect(fakeSettings.agent.promptOptimizeModel).toBe("");
		expect(fakeSettings.agent.customModels).toEqual([{ value: "other:chat", label: "Other" }]);
		expect(fakeSettings.agent.modelCards).toEqual([
			{ modelKey: "other:chat", notes: "tokendance: keep this note" },
		]);
		expect(fakeSettings.agent.modelContextWindows).toEqual({ "other:chat": 100000 });
		expect(fakeSettings.agent.subagentModels).toEqual({ explore: "", plan: "other:chat" });
		expect(fakeSettings.agent.subagentAllowedModels.explore).toEqual(["other:chat"]);
		expect(fakeSettings.agent.providerOrder).toEqual(["other"]);
		expect(fakeSettings.agent.disabledProviders).toEqual(["other"]);
		expect(fakeSettings.agent.modelAggregations).toEqual([
			{ id: "mixed", name: "tokendance: label", routingMode: "priority", models: ["other:chat"] },
		]);
	});
	test("persisted catalog survives runtime cache invalidation and disabled refresh", async () => {
		const catalog = [
			{
				id: "restored",
				name: "Restored",
				context_length: 100,
				supported_protocols: ["openai:responses"],
			},
		];
		fakeSettings.tokendance = {
			apiKey: "key-private",
			disabled: true,
			generation: 800,
			models: catalog,
		};
		expect(service.getTokenDanceCatalogModels()).toEqual(catalog);
		fetchMock(() => json({ data: catalog }));
		await service.refreshTokenDanceModels();
		expect(fakeSettings.tokendance.models).toEqual(catalog);
		expect(service.getTokenDanceConnection().disabled).toBe(true);
		expect((await service.setTokenDanceDisabled(false)).models).toEqual(catalog);
		expect((await service.setTokenDanceDisabled(true)).models).toEqual(catalog);
	});
	test("deep snapshots are rejected and legacy custom TokenDance drafts preserved", () => {
		let nested: Record<string, unknown> = {};
		for (let index = 0; index < 70; index++) nested = { child: nested };
		expect(() => start({ draft: nested, baseline: {} })).toThrow("too complex");
		const legacy = {
			draft: {
				customApiProviders: [{ prefix: "tokendance", apiKey: "user-unsaved-key" }],
				hiddenModels: ["tokendance:chat"],
			},
			baseline: {},
		};
		expect(service.validateTokenDanceSnapshot(legacy)).toEqual(legacy);
	});
	test("legacy prefix permits unchanged ID only until the platform is connected", () => {
		const existing = [{ id: "manual", prefix: "tokendance" }] as const;
		expect(isLegacyTokenDancePrefixAllowed(existing[0], existing, false)).toBe(true);
		expect(isLegacyTokenDancePrefixAllowed(existing[0], existing, true)).toBe(false);
		expect(
			isLegacyTokenDancePrefixAllowed({ id: "new", prefix: "tokendance" }, existing, false),
		).toBe(false);
		expect(
			isLegacyTokenDancePrefixAllowed({ id: "manual", prefix: "codex" }, existing, false),
		).toBe(false);
	});
	test("legacy prefix conflict fails before exchange without mutating existing key", () => {
		fakeSettings.customApiProviders = [
			{ prefix: "tokendance", apiKey: "old-private-key" },
		] as NarraForkSettings["customApiProviders"];
		expect(() => start()).toThrow("Rename the existing custom provider");
		expect(fakeSettings.customApiProviders?.[0]?.apiKey).toBe("old-private-key");
		fakeSettings.customApiProviders = [];
	});
	test("only strict key envelope accepted; body cannot spoof recovery action", async () => {
		const flow = start();
		fetchMock(() => json({ api_key: "must-not-accept" }));
		await expect(service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code")).rejects.toThrow(
			"authorization failed",
		);
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 900 };
		fetchMock(() => json({ recovery_action: "top_up_balance" }, 402));
		await expect(service.refreshTokenDanceModels()).rejects.toThrow("model refresh failed");
		expect(service.getTokenDanceConnection().recoveryAction).toBeUndefined();
	});
	test("runtime recovery is generation checked and successful refresh clears it", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 901 };
		service.setTokenDanceRecoveryAction("top_up_balance", 900);
		expect(service.getTokenDanceConnection().recoveryAction).toBeUndefined();
		service.setTokenDanceRecoveryAction("top_up_balance", 901);
		expect(service.getTokenDanceConnection().recoveryAction).toBe("top_up_balance");
		fetchMock(() => json({ data: [] }));
		await service.refreshTokenDanceModels();
		expect(service.getTokenDanceConnection().recoveryAction).toBeUndefined();
	});
	test("new authorization cancels runtime requests from the prior generation", async () => {
		fakeSettings.tokendance = { apiKey: "old-key-private", disabled: false, generation: 902 };
		const old = new AbortController();
		service.registerTokenDanceRequest(old, 902);
		const flow = start();
		fetchMock((_url, init) =>
			init?.method === "POST" ? json({ key: "new-key-private" }) : json({ data: [] }),
		);
		await service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code");
		expect(old.signal.aborted).toBe(true);
		expect(fakeSettings.tokendance.apiKey).toBe("new-key-private");
	});
	test("request timeout also bounds a stalled response reader", async () => {
		const timeout = globalThis.setTimeout;
		const originalClear = globalThis.clearTimeout;
		globalThis.setTimeout = ((callback: () => void, delay: number) =>
			delay === 30_000 ? timeout(callback, 5) : timeout(callback, delay)) as typeof setTimeout;
		try {
			fetchMock(
				() =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('{"key":'));
							},
						}),
					),
			);
			const flow = start();
			await expect(
				service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code"),
			).rejects.toThrow("request failed");
			expect(saves).toBe(0);
		} finally {
			globalThis.setTimeout = timeout;
			globalThis.clearTimeout = originalClear;
		}
	});
	test("catalog and snapshot storage are bounded; mounted paths may contain dots", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 910 };
		fetchMock(() =>
			json({
				data: Array.from({ length: 1002 }, (_, index) => ({
					id: `model-${index}`,
					supported_protocols: ["openai:responses"],
				})),
			}),
		);
		expect((await service.refreshTokenDanceModels()).length).toBe(1000);
		expect(
			service.validateTokenDanceCallback(
				"https://ui.example/code.server/%E4%B8%AD/settings/providers/tokendance/callback",
				"https://server.example/api/x",
				"https://ui.example",
			).pathname,
		).toContain("code.server");
	});
	test("HTTPS same-authority proxy upgrade is allowed, external origins remain refused", () => {
		expect(
			service.validateTokenDanceCallback(
				"https://app.example/prefix/settings/providers/tokendance/callback",
				"http://app.example/api/start",
				"https://app.example",
			).origin,
		).toBe("https://app.example");
		expect(() =>
			service.validateTokenDanceCallback(
				"https://evil.example/settings/providers/tokendance/callback",
				"http://app.example/api/start",
				"https://evil.example",
			),
		).toThrow();
	});
	test("fixed targets explicitly reject redirect and exchange only approved fields", async () => {
		const flow = start();
		fetchMock((url, init) => {
			expect(init?.redirect).toBe("error");
			if (init?.method === "POST") {
				expect(url).toBe("https://tokendance.space/portal/api/v1/auth/keys");
				const body = JSON.parse(String(init.body));
				expect(Object.keys(body).sort()).toEqual([
					"code",
					"code_challenge_method",
					"code_verifier",
				]);
				expect(body.code_verifier.length).toBe(43);
				expect(body.code_challenge_method).toBe("S256");
				return json({ key: "key-private" });
			}
			expect(url).toBe("https://tokendance.space/gateway/v1/models");
			return json({ data: [] });
		});
		await service.completeTokenDanceOAuth(flow.owner, flow.flowId, "code");
	});
	test("model normalization retains supported protocols after unknowns and rejects unsafe IDs", async () => {
		fakeSettings.tokendance = { apiKey: "key-private", disabled: false, generation: 950 };
		fetchMock(() =>
			json({
				data: [
					{
						id: "chat",
						supported_protocols: [
							...Array.from({ length: 20 }, (_, index) => `unknown-${index}`),
							"openai:responses",
						],
					},
					{ id: "chat", supported_protocols: ["openai:responses"] },
					{ id: "namespace:chat", supported_protocols: ["openai:responses"] },
					{ id: "secret", name: "key-private", supported_protocols: ["openai:responses"] },
					{
						id: Buffer.from("key-private").toString("base64"),
						supported_protocols: ["openai:responses"],
					},
				],
			}),
		);
		expect(await service.refreshTokenDanceModels()).toEqual([
			{ id: "chat", name: "chat", context_length: 0, supported_protocols: ["openai:responses"] },
			{
				id: "namespace:chat",
				name: "namespace:chat",
				context_length: 0,
				supported_protocols: ["openai:responses"],
			},
			{
				id: "secret",
				name: "key-********vate",
				context_length: 0,
				supported_protocols: ["openai:responses"],
			},
		]);
	});
	test("draft model-reference maps and ordinary custom headers are allowed", () => {
		const snapshot = {
			draft: {
				modelContextWindows: { "tokendance:vendor:opaque/id": 200000 },
				customApiProviders: [
					{ prefix: "manual", extraHeaders: { "x-tokendance-feature": "preview" } },
				],
			},
			baseline: {},
		};
		const flow = start(snapshot);
		expect(service.restoreTokenDanceDraft(flow.owner, flow.flowId).draftSnapshot).toEqual(snapshot);
		expect(() =>
			start({ draft: { nested: { tokenDance: { apiKey: "injected-key" } } }, baseline: {} }),
		).toThrow();
		expect(() =>
			start({ draft: { nested: { tokenDanceApiKey: "injected-key" } }, baseline: {} }),
		).toThrow();
	});
	test("per-owner, global flow and total snapshot budgets are enforced", () => {
		let now = originalNow() + 10_000_000;
		Date.now = () => now;
		const callback = new URL("https://ui.example/settings/providers/tokendance/callback");
		try {
			for (let index = 0; index < 10; index++)
				service.startTokenDanceOAuth("limited-owner", callback);
			expect(() => service.startTokenDanceOAuth("limited-owner", callback)).toThrow("Too many");
			now += 600001;
			const memoryFlows = Array.from({ length: 9 }, () =>
				start({ draft: { text: "v".repeat(900_000) }, baseline: {} }),
			);
			expect(() => start({ draft: { text: "v".repeat(900_000) }, baseline: {} })).toThrow(
				"storage is full",
			);
			const first = memoryFlows[0];
			if (first) service.restoreTokenDanceDraft(first.owner, first.flowId);
			expect(() => start({ draft: { text: "v".repeat(900_000) }, baseline: {} })).not.toThrow();
			now += 600001;
			for (let index = 0; index < 100; index++) start();
			expect(() => start()).toThrow("Too many");
			now += 600001;
			start(); // Eager cleanup releases all expired snapshots and flows.
		} finally {
			Date.now = originalNow;
		}
	});
});
