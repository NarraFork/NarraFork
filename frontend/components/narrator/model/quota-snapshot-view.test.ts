import { expect, test } from "bun:test";
import type { PublicQuotaSnapshot } from "@shared/quota-snapshot";
import { createInstance } from "i18next";
import locale from "../../../locales/en/narrator.json";
import { quotaSnapshotText, quotaSnapshotView } from "./quota-snapshot-view";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { narrator: locale } }, defaultNS: "narrator" });
const t = i18n.t.bind(i18n);
const snapshot: PublicQuotaSnapshot = {
	fetchedAt: 1,
	scope: "account",
	plan: "Pro",
	windows: [
		{ kind: "5h", usedRatio: 0.8, resetsAt: 1_800_000 },
		{ kind: "weekly", usedRatio: null, resetsAt: null },
	],
	balances: [{ unit: "USD", remaining: 9.999999, total: 100 }],
};

test("maps public windows, resets, balances and plan using the shared severity thresholds", () => {
	const view = quotaSnapshotView(snapshot, "Provider", t);
	expect(view.title).toBe("Provider");
	expect(view.windows[0]).toMatchObject({
		remainingPercent: 20,
		resetAt: 1_800_000,
		level: "warning",
	});
	expect(view.windows[1]).toMatchObject({ remainingPercent: null, level: "unknown" });
	expect(view.rows).toContainEqual({ label: "Plan", value: "Pro" });
	expect(view.unavailableText).toBe("9.999999 USD");
	expect(view.level).toBe("critical");
});

test("unknown quota is never represented as zero and an exhausted balance is explicit", () => {
	expect(quotaSnapshotText(null, t).balance).toBe("Quota unknown");
	const view = quotaSnapshotView(
		{ ...snapshot, windows: [], balances: [{ unit: "CNY", remaining: 0 }] },
		"",
		t,
	);
	expect(view.level).toBe("exhausted");
	expect(view.unavailableText).toBe("0 CNY");
	expect(quotaSnapshotView({ ...snapshot, balances: [], windows: [] }, "", t).level).toBe(
		"unknown",
	);
});

test("unlimited balances do not become zero or exhausted", () => {
	const value = {
		...snapshot,
		windows: [],
		balances: [{ unit: "requests", remaining: 0, unlimited: true }],
	};
	expect(quotaSnapshotView(value, "", t).level).toBe("ok");
	expect(quotaSnapshotText(value, t).balance).toBe("Unlimited requests");
});

test("preserves stale values and safe errors without looking at template-private detail", () => {
	const value = { ...snapshot, error: "Quota refresh failed", detail: { secret: "NEVER RENDER" } };
	const text = quotaSnapshotText(value, t);
	expect(text.detailsText).not.toContain("Quota refresh failed");
	expect(text.detailsText).toContain("Last refresh failed");
	expect(text.detailsText).toContain("figures may be out of date");
	expect(text.detailsText).toContain("9.999999 USD");
	expect(text.detailsText).not.toContain("NEVER RENDER");
	expect(text.detailsText).toContain("1970-01-01T00:30:00.000Z");
	expect(quotaSnapshotView({ ...snapshot, hasError: true }, "", t).failed).toBe(true);
});

test("public totals retain total and consumed amounts without losing micro-unit precision", () => {
	const view = quotaSnapshotView(
		{ ...snapshot, windows: [], balances: [{ unit: "CNY", remaining: 9.999999, total: 10 }] },
		"",
		t,
	);
	expect(view.rows).toContainEqual({ label: "Total (CNY)", value: "10 CNY" });
	expect(view.rows).toContainEqual({ label: "Used (CNY)", value: "0.000001 CNY" });
	const zero = quotaSnapshotView(
		{ ...snapshot, windows: [], balances: [{ unit: "requests", remaining: 0, total: 0 }] },
		"",
		t,
	);
	expect(zero.rows).toContainEqual({ label: "Used (requests)", value: "0 requests" });
	for (const balance of [
		{ unit: "USD", remaining: null, total: 10 },
		{ unit: "USD", remaining: 0, total: Number.POSITIVE_INFINITY },
		{ unit: "USD", remaining: 0, total: 10, unlimited: true },
	]) {
		expect(
			quotaSnapshotView({ ...snapshot, windows: [], balances: [balance] }, "", t).rows.some((row) =>
				row.label.startsWith("Used"),
			),
		).toBe(false);
	}
});

test("expired allowances hide spendable numbers without fabricating zero or a reset", () => {
	const value = { ...snapshot, expiresAt: 2_000 };
	const before = quotaSnapshotView(value, "Provider", t, 1_999);
	expect(before.windows[0]?.remainingPercent).toBe(20);
	expect(before.rows.some((row) => row.label === "Expires at")).toBe(true);
	const expired = quotaSnapshotView(value, "Provider", t, 2_000);
	expect(expired.unavailableText).toBe("Subscription expired");
	expect(expired.level).toBe("exhausted");
	expect(expired.windows).toEqual([]);
	expect(expired.rows.map((row) => row.label)).toEqual(["Plan", "Expires at"]);
	expect(quotaSnapshotText(value, t, 2_000).balance).toBe("Subscription expired");
	expect(quotaSnapshotText(value, t, 2_000).detailsText).not.toContain("USD");
	expect(snapshot.balances[0]?.remaining).toBe(9.999999);
	for (const expiresAt of [undefined, Number.NaN]) {
		const unknownExpiry = quotaSnapshotView({ ...snapshot, expiresAt }, "Provider", t, 9_000);
		expect(unknownExpiry.windows.length).toBe(2);
		expect(unknownExpiry.unavailableText).not.toContain("expired");
	}
});

test("period amounts remain attached to their named window with currency and micro-unit precision", () => {
	const value: PublicQuotaSnapshot = {
		...snapshot,
		balances: [],
		windows: [
			{
				kind: "other",
				label: "daily",
				usedRatio: 0.2,
				resetsAt: null,
				used: 2,
				total: 10,
				remaining: 8,
				unit: "USD",
			},
			{
				kind: "weekly",
				usedRatio: 0.08,
				resetsAt: null,
				used: 4,
				total: 50,
				remaining: 46,
				unit: "USD",
			},
			{ kind: "monthly", usedRatio: null, resetsAt: null },
			{
				kind: "other",
				label: "Micro",
				usedRatio: 0.0000001,
				resetsAt: null,
				total: 10,
				remaining: 9.999999,
				unit: "CNY",
			},
		],
	};
	const view = quotaSnapshotView(value, "Provider", t, 1_000);
	expect(view.windows[0]).toMatchObject({ used: 2, limit: 10, remainingAmount: 8, unit: "USD" });
	expect(view.windows[1]).toMatchObject({ used: 4, limit: 50, remainingAmount: 46 });
	expect(view.windows[2]).toMatchObject({ used: null, limit: null, remainingAmount: null });
	expect(view.windows[3]?.used).toBe(0.000001);
	const text = quotaSnapshotText(value, t, 1_000).detailsText;
	expect(text).toContain("Daily: 80% left · Used 2 USD / 10 USD · Remaining 8 USD");
	expect(text).toContain("Weekly: 92% left · Used 4 USD / 50 USD · Remaining 46 USD");
	expect(text).toContain("0.000001 CNY");
	expect(view.rows.some((row) => row.label === "USD")).toBe(false);
});

test("named periods stay distinct and do not invent reset times", () => {
	const view = quotaSnapshotView(
		{
			...snapshot,
			balances: [],
			windows: [
				{ kind: "other", label: "daily", usedRatio: 0.3, resetsAt: null },
				{ kind: "weekly", label: "weekly", usedRatio: 0.5, resetsAt: null },
				{ kind: "monthly", label: "monthly", usedRatio: null, resetsAt: null },
			],
		},
		"Provider",
		t,
		1_000,
	);
	expect(view.windows.map((window) => window.label)).toEqual(["Daily", "Weekly", "Monthly"]);
	expect(view.windows.map((window) => window.resetAt)).toEqual([null, null, null]);
	expect(view.windows[2]?.remainingPercent).toBeNull();
});

test("clamps out-of-range windows and leaves non-finite numbers unknown", () => {
	const view = quotaSnapshotView(
		{
			...snapshot,
			windows: [
				{ kind: "other", label: "Custom", usedRatio: 1.2, resetsAt: null },
				{ kind: "monthly", usedRatio: Number.NaN, resetsAt: null },
			],
		},
		"",
		t,
	);
	expect(view.windows[0]).toMatchObject({ label: "Custom", usedPercent: 100, level: "exhausted" });
	expect(view.windows[1]?.usedPercent).toBeNull();
});

test("plugin details and exact amounts remain separate from the summary and quota constraints", () => {
	const value: PublicQuotaSnapshot = {
		fetchedAt: 1,
		scope: "wallet",
		details: "Saved subscription",
		windows: [],
		balances: [
			{
				id: "wallet",
				unit: "USD",
				remaining: 0.000000000001,
				remainingText: "0.000000000001",
				quota: "required",
			},
			{
				id: "history",
				label: "Previous period",
				unit: "USD",
				remaining: 0,
				used: 4,
				window: "monthly",
				windowStart: 1_000,
				display: "detail",
				quota: "none",
			},
		],
	};
	const view = quotaSnapshotView(value, "Provider", t);
	expect(view.unavailableText).toBe("0.000000000001 USD");
	expect(view.level).toBe("ok");
	expect(view.rows).toContainEqual({
		id: "balance:1:history",
		label: "Previous period",
		value: "0 USD",
	});
	expect(view.rows).toContainEqual({
		id: "balance:1:history:used",
		label: "Used (USD)",
		value: "4 USD",
	});
	expect(view.rows.some((row) => row.id === "balance:1:history:window-start")).toBe(true);
	expect(view.rows).toContainEqual({ label: "Details", value: "Saved subscription" });
	expect(quotaSnapshotView({ ...value, available: false }, "Provider", t).level).toBe("exhausted");
	expect(quotaSnapshotText({ ...value, available: false }, t).balance).toBe("Account unavailable");
});

test("required balances constrain independently and unknown alternatives never prove exhaustion", () => {
	const alternatives: PublicQuotaSnapshot = {
		fetchedAt: 1,
		scope: "wallet",
		windows: [],
		balances: [
			{ unit: "USD", remaining: 0, quota: "alternative" },
			{ unit: "credits", remaining: null, quota: "alternative" },
		],
	};
	expect(quotaSnapshotView(alternatives, "", t).level).toBe("unknown");
	expect(
		quotaSnapshotView(
			{
				...alternatives,
				balances: [...alternatives.balances, { unit: "CNY", remaining: 5, quota: "alternative" }],
			},
			"",
			t,
		).level,
	).toBe("ok");
	expect(
		quotaSnapshotView(
			{
				...alternatives,
				balances: [
					...alternatives.balances,
					{ unit: "requests", remaining: 0, quota: "required", display: "detail" },
				],
			},
			"",
			t,
		).level,
	).toBe("exhausted");
});

test("a rounded full window with positive credit remains critical until explicitly rate-limited", () => {
	const value: PublicQuotaSnapshot = {
		fetchedAt: 1,
		scope: "key",
		windows: [{ kind: "5h", usedRatio: 1, remaining: 0.000001, resetsAt: null }],
		balances: [],
	};
	expect(quotaSnapshotView(value, "", t).windows[0]?.level).toBe("critical");
	expect(
		quotaSnapshotView(
			{
				...value,
				windows: value.windows.map((window) => ({ ...window, status: "rate-limited" as const })),
			},
			"",
			t,
		).windows[0]?.level,
	).toBe("exhausted");
});
