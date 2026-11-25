import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { api } from "../../../lib/api";
import { clearToken, setToken } from "../../../lib/api/client";
import type { PaymentRequiredInfo } from "../useNarratorPanelWS";
import { useNarratorQuota } from "./use-narrator-quota";
import { useNugQuota } from "./use-nug-quota";

const { window } = parseHTML("<html><body></body></html>");
const originals = new Map<string, PropertyDescriptor | undefined>();
const tokens = new Map<string, string>();
for (const [key, value] of Object.entries({
	window,
	document: window.document,
	navigator: window.navigator,
	localStorage: {
		getItem: (key: string) => tokens.get(key) ?? null,
		setItem: (key: string, value: string) => tokens.set(key, value),
		removeItem: (key: string) => tokens.delete(key),
	},
	IS_REACT_ACT_ENVIRONMENT: true,
})) {
	originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
notifyManager.setScheduler(queueMicrotask);
let root: Root;
let host: HTMLElement;
let current: ReturnType<typeof useNarratorQuota>;
let payment: PaymentRequiredInfo | null;
let qc: QueryClient;
let read: ReturnType<typeof spyOn<typeof api, "nugGetCachedQuota">>;
const providers = [{ id: "gateway", prefix: "nug", name: "Gateway", generation: 1 }];
const noSubstatus: string[] = [];
function Harness({
	initialPayment = null,
	substatus = noSubstatus,
	errorMessage,
	model = "nug:model",
}: {
	initialPayment?: PaymentRequiredInfo | null;
	substatus?: string[];
	errorMessage?: string;
	model?: string;
}) {
	const [paymentRequired, setPaymentRequired] = useState(initialPayment);
	const nugProviderInfo = useNugQuota(model, providers);
	payment = paymentRequired;
	current = useNarratorQuota({
		nugProviderInfo,
		quotaBalance: nugProviderInfo?.quotaBalance ?? null,
		detailedQuotaBalance: nugProviderInfo?.detailedQuotaBalance ?? null,
		paymentRequired,
		setPaymentRequired,
		narratorSubstatus: substatus,
		narratorErrorMessage: errorMessage,
	});
	return null;
}
const cachedQuota = (balance: number | null, detailedQuotaBalance: string | null = null) => ({
	generation: 1,
	quota: { balance, totalGranted: 50, detailedQuotaBalance, fetchedAt: 1 },
});
const render = (props: Parameters<typeof Harness>[0] = {}) =>
	act(async () => {
		root.render(
			<QueryClientProvider client={qc}>
				<Harness {...props} />
			</QueryClientProvider>,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
beforeEach(() => {
	setToken("quota-session");
	qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	read = spyOn(api, "nugGetCachedQuota").mockResolvedValue({ generation: 1, quota: null });
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	qc.clear();
	read.mockRestore();
	clearToken();
	host.remove();
});
afterAll(() => {
	notifyManager.setScheduler((callback) => setTimeout(callback, 0));
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

describe("cached NUG recharge", () => {
	test.each([
		undefined,
		null,
		0,
		-1,
	])("unknown or exhausted allowance keeps a direct recharge entry (%j)", async (value) => {
		if (value !== undefined) read.mockResolvedValue(cachedQuota(value));
		await render();
		expect(current.shouldShowNugRechargeButton).toBe(true);
		expect(current.shouldShowNugRechargeInQuotaDetails).toBe(false);
		expect(current.nugRechargeOpened).toBe(false);
		expect(read).toHaveBeenCalledWith("gateway", {
			signal: expect.any(AbortSignal),
			expectedGeneration: 1,
		});
	});
	test.each([
		0.000001, 10,
	])("positive cached allowance keeps recharge in quota details (%j)", async (value) => {
		read.mockResolvedValue(cachedQuota(value));
		await render();
		expect(current.shouldShowNugRechargeButton).toBe(false);
		expect(current.shouldShowNugRechargeInQuotaDetails).toBe(true);
		await act(() => current.openNugRecharge());
		expect(current.nugRechargeOpened).toBe(true);
		await act(() => current.closeNugRecharge());
		expect(current.nugRechargeOpened).toBe(false);
	});
	test("legacy cached quota details are preserved", async () => {
		read.mockResolvedValue(cachedQuota(10, "Wallet: 10 / 50"));
		await render();
		expect(current.quotaDetailsText).toBe("Wallet: 10 / 50");
		expect(current.hasQuotaDetailsPopover).toBe(true);
	});
	test("payment-required overrides a positive cached allowance and opens recharge", async () => {
		read.mockResolvedValue(cachedQuota(10));
		await render({
			initialPayment: { providerId: "gateway", required: 20, resumeAction: "continue" },
		});
		expect(current.shouldShowNugRechargeButton).toBe(true);
		expect(current.nugRechargeOpened).toBe(true);
	});
	test("persisted payment-required reconstructs provider and resume action after reload", async () => {
		await render({
			substatus: ["payment_required"],
			errorMessage: JSON.stringify({
				type: "payment_required",
				balance: 0,
				required: 5,
				resumeAction: "continue",
			}),
		});
		expect(payment).toEqual({
			providerId: "gateway",
			providerPrefix: "nug",
			balance: 0,
			required: 5,
			resumeAction: "continue",
		});
		expect(current.nugRechargeOpened).toBe(true);
	});
	test("重载保留失败source的opaque context，不改充当前模型的另一个source", async () => {
		const paymentContext = `npc1.${(Date.now() + 900000).toString(36)}.${"n".repeat(22)}.${"m".repeat(43)}`;
		await render({
			substatus: ["payment_required"],
			errorMessage: JSON.stringify({
				type: "payment_required",
				providerId: "failed-source",
				providerPrefix: "failed-prefix",
				paymentContext,
				resumeAction: "continue",
			}),
		});
		expect(payment).toMatchObject({
			providerId: "failed-source",
			providerPrefix: "failed-prefix",
			paymentContext,
			resumeAction: "continue",
		});
		expect(current.nugRechargeOpened).toBe(true);
	});

	test("旧数据中的私有identity不能被恢复成公开付款context", async () => {
		await render({
			substatus: ["payment_required"],
			errorMessage: JSON.stringify({
				type: "payment_required",
				providerId: "failed-source",
				paymentContext: '["private-CID","private-secret"]',
			}),
		});
		expect(payment).not.toHaveProperty("paymentContext");
		expect(payment).toMatchObject({ providerId: "failed-source" });
	});

	test("persisted provider still recovers when current model no longer resolves to NUG", async () => {
		await render({
			model: "other:model",
			substatus: ["payment_required"],
			errorMessage: JSON.stringify({ type: "payment_required", providerId: "gateway" }),
		});
		expect(payment).toMatchObject({ providerId: "gateway", resumeAction: "retry" });
		expect(current.nugRechargeOpened).toBe(true);
	});
	test("non-NUG models never expose or read another provider's cached NUG quota", async () => {
		read.mockResolvedValue(cachedQuota(0));
		await render({ model: "other:model" });
		expect(current.shouldShowNugRechargeButton).toBe(false);
		expect(current.shouldShowNugRechargeInQuotaDetails).toBe(false);
		expect(read).not.toHaveBeenCalled();
	});
});
