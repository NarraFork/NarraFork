import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PublicQuotaSnapshot } from "@shared/quota-snapshot";
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import type { PaymentRequiredInfo } from "../useNarratorPanelWS";
import { useNarratorQuota } from "./use-narrator-quota";
import { useNugQuota } from "./use-nug-quota";

const { window } = parseHTML("<html><body></body></html>");
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
	window,
	document: window.document,
	navigator: window.navigator,
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
const providers = [{ id: "gateway", prefix: "nug", name: "Gateway" }];
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
	act(() => root.render(<Harness {...props} />));
beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
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
	test("persisted provider still recovers when current model no longer resolves to NUG", async () => {
		await render({
			model: "other:model",
			substatus: ["payment_required"],
			errorMessage: JSON.stringify({ type: "payment_required", providerId: "gateway" }),
		});
		expect(payment).toMatchObject({ providerId: "gateway", resumeAction: "retry" });
		expect(current.nugRechargeOpened).toBe(true);
	});
	test("non-NUG models never expose NUG recharge from another snapshot", async () => {
		await render({ model: "other:model", snapshot: snapshot(0) });
		expect(current.shouldShowNugRechargeButton).toBe(false);
		expect(current.shouldShowNugRechargeInQuotaDetails).toBe(false);
	});
});
