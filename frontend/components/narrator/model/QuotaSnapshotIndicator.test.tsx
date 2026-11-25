import { expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { PublicQuotaSnapshot } from "@shared/quota-snapshot";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import locale from "../../../locales/en/narrator.json";
import { QuotaSnapshotIndicator } from "./QuotaSnapshotIndicator";
import { quotaSnapshotText, quotaSnapshotView } from "./quota-snapshot-view";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { narrator: locale } }, defaultNS: "narrator" });
function render(snapshot: PublicQuotaSnapshot | null) {
	return renderToStaticMarkup(
		<I18nextProvider i18n={i18n}>
			<MantineProvider>
				<QuotaSnapshotIndicator snapshot={snapshot} title="Provider quota" now={1_000} />
			</MantineProvider>
		</I18nextProvider>,
	);
}

test("renders window glyphs with balances, plan and resets in the accessible summary", () => {
	const html = render({
		scope: "key",
		fetchedAt: 1,
		plan: "Pro",
		windows: [{ kind: "5h", usedRatio: 0.25, resetsAt: 61_000 }],
		balances: [{ unit: "USD", remaining: 12.5 }],
	});
	expect(html).toContain("data-quota-bar=");
	expect(html).toContain("75% left");
	expect(html).toContain("12.5 USD");
	expect(html).toContain("Plan: Pro");
	expect(html).toContain("Resets in 1m");
});

test("renders unknown instead of zero and supports balance-only unlimited snapshots", () => {
	expect(render(null)).toContain("Quota unknown");
	const html = render({
		scope: "wallet",
		fetchedAt: 1,
		windows: [],
		balances: [{ unit: "requests", remaining: null, unlimited: true }],
	});
	expect(html).toContain("Unlimited requests");
	expect(html).not.toContain("data-quota-bar=");
});

test("period percentages keep the spending, dollar limit and remaining amount accessible", () => {
	const html = render({
		scope: "subscription",
		fetchedAt: 1,
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
		],
		balances: [],
	});
	expect(html).toContain("Daily");
	expect(html).toContain("80% left");
	expect(html).toContain("Used 2 USD / 10 USD");
	expect(html).toContain("Remaining 8 USD");
});

test("uncapped subscription periods never invent a zero limit or remaining allowance", () => {
	const html = render({
		scope: "subscription",
		fetchedAt: 1,
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
			{ kind: "monthly", label: "monthly", usedRatio: null, resetsAt: null, used: 0, unit: "USD" },
		],
		balances: [],
	});
	expect(html).toContain("Monthly");
	expect(html).toContain("Used 2 USD / 10 USD");
	expect(html).toContain("Remaining 8 USD");
	expect(html).not.toContain("/ 0 USD");
	expect(html).not.toContain("Remaining 0 USD");
});
test("expired plans render unavailable instead of positive quota bars or spendable amounts", () => {
	const html = render({
		scope: "subscription",
		fetchedAt: 1,
		expiresAt: 1_000,
		plan: "Pro",
		windows: [{ kind: "other", label: "daily", usedRatio: 0.3, resetsAt: null }],
		balances: [{ unit: "USD", remaining: 7, total: 10 }],
	});
	expect(html).toContain("Subscription expired");
	expect(html).not.toContain("7 USD");
	expect(html).not.toContain("data-quota-bar=");
	expect(html).toContain("Expires at");
});

test("failed refresh marks previous window values stale without losing known values", () => {
	const html = render({
		scope: "key",
		fetchedAt: 1,
		hasError: true,
		windows: [{ kind: "weekly", usedRatio: 0.9, resetsAt: null }],
		balances: [],
	});
	expect(html).toContain("10% left");
	expect(html).toContain("figures may be out of date");
});

test("the API's safe error code uses the localized failure hint, not internal identifiers", () => {
	const snapshot: PublicQuotaSnapshot = {
		scope: "key",
		fetchedAt: 1,
		error: "quota_unavailable",
		hasError: true,
		windows: [],
		balances: [],
	};
	const t = (key: string, options?: Record<string, unknown>) => String(i18n.t(key, options));
	expect(quotaSnapshotView(snapshot, "Provider quota", t).failureDetail).toBeNull();
	expect(quotaSnapshotText(snapshot, t).detailsText).not.toContain("quota_unavailable");
	const html = render(snapshot);
	expect(html).not.toContain("quota_unavailable");
	expect(html).toContain("figures may be out of date");
});

test("disabled quota plugins keep their localized reason and prior balance without exposing error text", () => {
	const snapshot: PublicQuotaSnapshot = {
		scope: "wallet",
		fetchedAt: 1,
		error: "plugin_not_enabled",
		hasError: true,
		windows: [],
		balances: [{ unit: "USD", remaining: 12 }],
	};
	const t = (key: string, options?: Record<string, unknown>) => String(i18n.t(key, options));
	expect(quotaSnapshotView(snapshot, "Provider quota", t).failureDetail).toBe(
		"Quota plugin is disabled",
	);
	const html = render(snapshot);
	expect(html).toContain("12 USD");
	expect(html).not.toContain("plugin_not_enabled");
	const privateError = { ...snapshot, error: "private-account@example.invalid" };
	expect(quotaSnapshotView(privateError, "Provider quota", t).failureDetail).toBeNull();
	expect(render(privateError)).not.toContain(privateError.error);
});
