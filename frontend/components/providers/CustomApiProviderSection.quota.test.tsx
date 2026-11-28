import { afterAll, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { ProviderQuotaSnapshot } from "@shared/provider-quota";
import type { QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { providerQuotaKey } from "../../hooks/useProviderQuota";
import { quotaSnapshotsReadKey } from "../../hooks/useQuotaSnapshots";
import narratorEn from "../../locales/en/narrator.json";
import settingsEn from "../../locales/en/settings.json";
import narratorZh from "../../locales/zh-CN/narrator.json";
import settingsZh from "../../locales/zh-CN/settings.json";
import { CustomApiProviderSection } from "./CustomApiProviderSection";
import type { CustomApiProviderState } from "./types";

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
		defaultNS: "settings",
		resources: {
			en: { settings: settingsEn, narrator: narratorEn },
			"zh-CN": { settings: settingsZh, narrator: narratorZh },
		},
	});
}
const provider: CustomApiProviderState = {
	id: "p",
	name: "Site provider",
	prefix: "site",
	apiKey: "inference-test-key",
	baseUrl: "https://site.example/v1",
	defaultModel: "",
	protocol: "completions-compatible",
	codexAccountId: "",
	quotaSiteUrl: "https://draft-site.example",
	quotaAccessToken: "draft-site-test-token",
	quotaUserId: "12345",
};
const quota: ProviderQuotaSnapshot = {
	providerId: "p",
	targetId: "custom-api/p",
	generation: "saved",
	pushCompatible: false,
	sourceId: "io.narrafork.provider-quota:site",
	status: "supported",
	data: {
		amounts: [{ id: "credit", unit: "USD", remaining: 19.5 }],
		windows: [],
		scope: "wallet",
		planName: "Saved site group",
	},
	fetchedAt: 1,
	attemptedAt: 1,
	stale: false,
	error: null,
	version: 1,
};
function render(role: string, enabled: boolean | undefined, locale: keyof typeof instances) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["auth", "me"], { role });
	client.setQueryData(["settings"], {
		providerQuotaGenerations: { p: "saved" },
		...(enabled === undefined ? {} : { providerBalanceCapability: { enabled } }),
	});
	client.setQueryData(providerQuotaKey("p", "saved"), quota);
	client.setQueryData(quotaSnapshotsReadKey(), {
		entries: [
			{
				groupId: "p",
				prefix: "site",
				templateId: "custom-api",
				credentialId: null,
				generation: "saved",
				primary: true,
				supported: true,
				snapshot: {
					scope: "wallet",
					fetchedAt: 1,
					windows: [],
					balances: [{ unit: "USD", remaining: 19.5 }],
					plan: "Saved site group",
				},
			},
		],
	} satisfies QuotaSnapshotsResponse);
	let updates = 0;
	try {
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={instances[locale]}>
					<MantineProvider env="test" withCssVariables={false} withGlobalClasses={false}>
						<CustomApiProviderSection
							provider={provider}
							onProvidersChange={() => {
								updates++;
							}}
							openAIProviderModelsMap={{}}
							anthropicProviderModelsMap={{}}
							geminiProviderModelsMap={{}}
							hiddenModels={new Set()}
							onToggleHidden={() => {}}
							onBatchToggleHidden={() => {}}
							modelProtocols={{}}
							onModelProtocolChange={() => {}}
							isProviderDirty={() => true}
							customModels={[]}
							onCustomModelsChange={() => {}}
						/>
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
		expect(updates).toBe(0);
		return html;
	} finally {
		client.clear();
	}
}

test.each([
	["admin", "en"],
	["user", "en"],
	["admin", "zh-CN"],
	["user", "zh-CN"],
] as const)("quota row follows capability while site settings belong only to the shared extension form (%s, %s)", (role, locale) => {
	const translate = instances[locale].getFixedT(locale, "settings");
	const labels = [
		"customApiQuotaTitle",
		"customApiQuotaSiteUrl",
		"customApiQuotaAccessToken",
		"customApiQuotaUserId",
	];
	const before = { ...provider };
	const disabled = render(role, false, locale);
	for (const key of labels) expect(disabled).not.toContain(translate(key));
	expect(disabled).not.toContain("draft-site-test-token");
	expect(disabled).not.toContain("19.5 USD");
	expect(disabled).not.toContain("Saved site group");
	expect(disabled).toContain(translate("customApiKey"));
	for (const enabled of [true, undefined]) {
		const restored = render(role, enabled, locale);
		for (const key of labels) expect(restored).not.toContain(translate(key));
		expect(restored).not.toContain("https://draft-site.example");
		expect(restored).not.toContain("draft-site-test-token");
		expect(restored).toContain("19.5 USD");
		expect(restored).toContain("Saved site group");
	}
	expect(provider).toEqual(before);
});
