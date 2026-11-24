import { afterAll, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { ProviderQuotaSnapshot } from "@shared/provider-quota";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { providerQuotaKey } from "../../hooks/useProviderQuota";
import en from "../../locales/en/narrator.json";
import zh from "../../locales/zh-CN/narrator.json";
import { ProviderBalanceStatus } from "./ProviderBalanceStatus";

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: { getItem: () => null },
});
afterAll(() => {
	if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});
const instances = { en: createInstance(), "zh-CN": createInstance() };
for (const [lng, instance] of Object.entries(instances)) {
	await instance.init({
		lng,
		resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
		defaultNS: "narrator",
	});
}
function render(
	role: string,
	dirty = false,
	generation: string | null = "A",
	status: ProviderQuotaSnapshot["status"] = "supported",
	queryState: "cached" | "loading" | "error" = "cached",
	overrides: Partial<ProviderQuotaSnapshot> | boolean = {},
	locale: keyof typeof instances = "en",
	capabilityEnabled?: boolean,
) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["auth", "me"], { role });
	client.setQueryData(["settings"], {
		providerQuotaGenerations: generation ? { p: generation } : {},
		...(typeof overrides === "boolean"
			? { providerBalanceCapability: { enabled: overrides } }
			: capabilityEnabled === undefined
				? {}
				: { providerBalanceCapability: { enabled: capabilityEnabled } }),
	});
	client.setQueryData(providerQuotaKey("p", "A"), {
		providerId: "p",
		targetId: "custom-api/p",
		generation: "A",
		sourceId: "third.party:source",
		status,
		data: null,
		fetchedAt: 0,
		attemptedAt: 0,
		error: null,
		stale: false,
		version: 1,
		...(typeof overrides === "object" ? overrides : {}),
	} satisfies ProviderQuotaSnapshot);
	if (queryState === "loading") client.removeQueries({ queryKey: providerQuotaKey("p", "A") });
	if (queryState === "error")
		client
			.getQueryCache()
			.find({ queryKey: providerQuotaKey("p", "A") })
			?.setState({ status: "error", error: new Error("private transport exception") });
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={instances[locale]}>
					<MantineProvider env="test" withCssVariables={false} withGlobalClasses={false}>
						<ProviderBalanceStatus providerId="p" dirty={dirty} />
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	} finally {
		client.clear();
	}
}

test("admin can refresh supported quotas and rediscover saved unsupported/error configurations", () => {
	for (const status of ["supported", "unsupported", "error"] as const) {
		const html = render("admin", false, "A", status);
		expect(html).toContain(status === "supported" ? "Refresh quota" : "Rediscover quota");
		expect(html).not.toContain("disabled=");
	}
});
test("dirty draft blocks refresh and clearly identifies saved values", () => {
	const html = render("admin", true);
	expect(html).toContain("disabled=");
	expect(html).toContain("Save changes before refreshing quota");
});
test("ordinary users cannot refresh or probe, pending probes cannot double-submit", () => {
	expect(render("user")).not.toContain("Refresh quota");
	expect(render("user", false, "A", "unsupported")).not.toContain("Rediscover quota");
	expect(render("admin", false, "A", "probing")).toContain("disabled=");
});
test("initial loading and HTTP errors disable refresh without exposing raw errors", () => {
	for (const state of ["loading", "error"] as const) {
		const html = render("admin", false, "A", "supported", state);
		expect(html).toContain("disabled=");
		expect(html).not.toContain("private transport exception");
	}
});
test("providers outside the Custom API identity map show no quota source operation", () => {
	const html = render("admin", false, null);
	expect(html).not.toContain("Refresh quota");
	expect(html).not.toContain("Quota not supported");
});
test.each([
	["admin", "en"],
	["user", "en"],
	["admin", "zh-CN"],
	["user", "zh-CN"],
] as const)("unavailable sources leave no status, empty area, actions or cached quota (%s, %s)", (role, locale) => {
	const unavailableStates: Partial<ProviderQuotaSnapshot>[] = [
		{ status: "unavailable", sourceId: null, error: null },
		{ status: "unavailable", error: "unavailable" },
		{ status: "supported", error: "unavailable" },
		{ status: "error", error: "unavailable" },
	];
	const cachedData = {
		amounts: [{ id: "wallet", unit: "credits", remaining: 19.5 }],
		windows: [{ id: "hour", used: 25, limit: 100, remaining: 75, resetAt: null }],
		planName: "Old account plan",
	};
	for (const state of unavailableStates) {
		for (const data of [null, cachedData]) {
			for (const queryState of ["cached", "error"] as const) {
				const html = render(
					role,
					queryState === "error",
					"A",
					state.status,
					queryState,
					{ ...state, data, fetchedAt: 1, stale: true },
					locale,
				);
				expect(html).toBe("");
			}
		}
	}
});
test.each([
	["admin", "en"],
	["user", "en"],
	["admin", "zh-CN"],
	["user", "zh-CN"],
] as const)("supported quota recovers after reinstall, including zero and unavailable accounts (%s, %s)", (role, locale) => {
	const data = {
		amounts: [{ id: "wallet", unit: "USD", remaining: 0 }],
		windows: [],
		available: false,
	};
	expect(
		render(role, false, "A", "unavailable", "cached", { data, error: "unavailable" }, locale),
	).toBe("");
	const html = render(role, false, "A", "supported", "cached", { data, version: 3 }, locale);
	const translate = instances[locale].t;
	expect(html).toContain("USD 0");
	expect(html).toContain(translate("providerQuota.supported"));
	expect(html).toContain(translate("providerQuota.accountUnavailable"));
	if (role === "admin") {
		expect(html).toContain(translate("providerQuota.refresh"));
		expect(html).not.toContain("disabled=");
	} else {
		expect(html).not.toContain(translate("providerQuota.refresh"));
		expect(html).not.toContain(translate("providerQuota.probe"));
	}
});
test("third-party amount values stay visible and marked stale after transport failure", () => {
	const html = render("user", false, "A", "supported", "error", {
		data: { amounts: [{ id: "wallet", unit: "credits", remaining: 19.5 }], windows: [] },
		fetchedAt: 1,
	});
	expect(html).toContain("credits 19.5");
	expect(html).toContain(en.quotaPanel.staleHint);
});
test("replacing the same provider account does not render the previous balance", () => {
	const html = render("admin", false, "B", "supported", "cached", {
		data: { amounts: [{ id: "wallet", unit: "credits", remaining: 19.5 }], windows: [] },
		fetchedAt: 1,
	});
	expect(html).not.toContain("credits 19.5");
});
test.each([
	["admin", "en"],
	["user", "en"],
	["admin", "zh-CN"],
	["user", "zh-CN"],
] as const)("capability disable hides cached quota and re-enable restores saved values (%s, %s)", (role, locale) => {
	const cached = {
		data: {
			amounts: [{ id: "wallet", unit: "USD", remaining: 19.5 }],
			windows: [],
			scope: "wallet",
			planName: "Saved group",
		},
	};
	expect(render(role, true, "A", "supported", "cached", cached, locale, false)).toBe("");
	const restored = render(role, false, "A", "supported", "cached", cached, locale, true);
	expect(restored).toContain("USD 19.5");
	expect(restored).toContain("Saved group");
	expect(restored).toContain(instances[locale].t("providerQuota.scopes.wallet"));
});

test("a disabled capability hides the whole quota row; enabled and older settings keep it", () => {
	expect(render("admin", false, "A", "error", "cached", false)).toBe("");
	expect(render("admin", false, "A", "supported", "cached", true)).toContain("Refresh quota");
	expect(render("admin", false, "A", "supported")).toContain("Refresh quota");
});
