import { afterAll, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { ProviderBalanceSnapshot } from "@shared/provider-balance";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { providerBalanceKey } from "../../hooks/useProviderBalance";
import en from "../../locales/en/settings.json";
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
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { settings: en } }, defaultNS: "settings" });
function render(
	role: string,
	dirty = false,
	generation: string | null = "A",
	status: ProviderBalanceSnapshot["status"] = "supported",
	queryState: "cached" | "loading" | "error" = "cached",
	capabilityEnabled?: boolean,
) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["auth", "me"], { role });
	client.setQueryData(["settings"], {
		providerBalanceGenerations: generation ? { p: generation } : {},
		...(capabilityEnabled === undefined
			? {}
			: { providerBalanceCapability: { enabled: capabilityEnabled } }),
	});
	client.setQueryData(providerBalanceKey("p", "A"), {
		generation: "A",
		status,
		adapter: "new-api",
		balance: null,
		fetchedAt: 0,
		attemptedAt: 0,
		error: null,
	} satisfies ProviderBalanceSnapshot);
	if (queryState === "loading") client.removeQueries({ queryKey: providerBalanceKey("p", "A") });
	if (queryState === "error")
		client
			.getQueryCache()
			.find({ queryKey: providerBalanceKey("p", "A") })
			?.setState({ status: "error", error: new Error("private transport exception") });
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider>
						<ProviderBalanceStatus providerId="p" dirty={dirty} />
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	} finally {
		client.clear();
	}
}

test("admin can rediscover saved supported/unsupported configuration", () => {
	for (const status of ["supported", "unsupported", "error"] as const) {
		const html = render("admin", false, "A", status);
		expect(html).toContain("Rediscover balance");
		expect(html).not.toContain("disabled=");
	}
});
test("dirty draft blocks probe and clearly identifies saved values", () => {
	const html = render("admin", true);
	expect(html).toContain("disabled=");
	expect(html).toContain("Save changes before rediscovering balance");
});
test("ordinary users cannot probe, pending probes cannot double-submit", () => {
	expect(render("user")).not.toContain("Rediscover balance");
	expect(render("admin", false, "A", "probing")).toContain("disabled=");
});
test("initial loading and HTTP errors disable probing without exposing raw errors", () => {
	for (const state of ["loading", "error"] as const) {
		const html = render("admin", false, "A", "supported", state);
		expect(html).toContain("disabled=");
		expect(html).not.toContain("private transport exception");
	}
});
test("noncandidate official providers show no unsupported status or operation", () => {
	const html = render("admin", false, null);
	expect(html).not.toContain("Rediscover balance");
	expect(html).not.toContain("Balance discovery not supported");
});
test("a disabled capability plugin removes the row and its rediscover action", () => {
	const html = render("admin", false, "A", "error", "cached", false);
	// Mantine still emits its style tags around a null render, so assert on the content.
	expect(html).not.toContain("Rediscover balance");
	expect(html).not.toContain("Balance discovery failed");
	expect(html).not.toContain("plugin");
	// Enabled, and an unknown answer (older server), both keep the row.
	expect(render("admin", false, "A", "supported", "cached", true)).toContain("Rediscover balance");
	expect(render("admin", false, "A", "supported")).toContain("Rediscover balance");
});
