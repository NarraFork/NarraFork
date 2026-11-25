import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { PublicQuotaSnapshot } from "@shared/quota-snapshot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
let root: Root;
let host: HTMLElement;
let current: ReturnType<typeof useNarratorQuota>;
let payment: PaymentRequiredInfo | null;
let qc: QueryClient;
let read: ReturnType<typeof spyOn<typeof api, "quotaSnapshots">>;
const providers = [{ id: "gateway", prefix: "nug", name: "Gateway", generation: 1 }];
const noSubstatus: string[] = [];
function Harness({
	snapshot,
	initialPayment = null,
	substatus = noSubstatus,
	errorMessage,
	model = "nug:model",
}: {
	snapshot?: PublicQuotaSnapshot | null;
	initialPayment?: PaymentRequiredInfo | null;
	substatus?: string[];
	errorMessage?: string;
	model?: string;
}) {
	const [paymentRequired, setPaymentRequired] = useState(initialPayment);
	payment = paymentRequired;
	current = useNarratorQuota({
		nugProviderInfo: useNugQuota(model, providers),
		snapshot,
		paymentRequired,
		setPaymentRequired,
		narratorSubstatus: substatus,
		narratorErrorMessage: errorMessage,
	});
	return null;
}
const snapshot = (remaining: number | null, unlimited = false): PublicQuotaSnapshot => ({
	fetchedAt: 1,
	scope: "wallet",
	windows: [],
	balances: [{ unit: "USD", remaining, unlimited }],
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
	read = spyOn(api, "quotaSnapshots").mockResolvedValue({ entries: [] });
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
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

describe("snapshot-backed NUG recharge", () => {
	test.each([
		undefined,
		null,
		snapshot(null),
		snapshot(0),
		snapshot(-1),
	])("unknown or exhausted allowance keeps a direct recharge entry (%j)", async (value) => {
		await render({ snapshot: value });
		expect(current.shouldShowNugRechargeButton).toBe(true);
		expect(current.shouldShowNugRechargeInQuotaDetails).toBe(false);
		expect(current.nugRechargeOpened).toBe(false);
	});
	test.each([
		snapshot(0.000001),
		snapshot(null, true),
	])("positive or unlimited allowance keeps recharge in snapshot details (%j)", async (value) => {
		await render({ snapshot: value });
		expect(current.shouldShowNugRechargeButton).toBe(false);
		expect(current.shouldShowNugRechargeInQuotaDetails).toBe(true);
		await act(() => current.openNugRecharge());
		expect(current.nugRechargeOpened).toBe(true);
		await act(() => current.closeNugRecharge());
		expect(current.nugRechargeOpened).toBe(false);
	});
	test("payment-required overrides a positive cached allowance and opens recharge", async () => {
		await render({
			snapshot: snapshot(10),
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
	test("non-NUG models never expose NUG recharge or read another provider's snapshot", async () => {
		await render({ model: "other:model", snapshot: snapshot(0) });
		expect(current.shouldShowNugRechargeButton).toBe(false);
		expect(current.shouldShowNugRechargeInQuotaDetails).toBe(false);
		expect(read).not.toHaveBeenCalled();
	});
});
