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
