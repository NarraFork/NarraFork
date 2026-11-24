import { expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { quotaSnapshotsKey } from "../../hooks/useQuotaSnapshots";
import narrator from "../../locales/en/narrator.json";
import settings from "../../locales/en/settings.json";
import { CommandCodeSection } from "./CommandCodeSection";
import { ProviderKeysPanel } from "./ProviderKeysPanel";

const i18n = createInstance();
await i18n.init({ lng: "en", defaultNS: "settings", resources: { en: { narrator, settings } } });
function render(component: React.ReactNode, qc: QueryClient) {
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={qc}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider>{component}</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	} finally {
		qc.clear();
	}
}

test("a single key's public snapshot is shown independently of the retired embedded usage payload", () => {
	const qc = new QueryClient();
	qc.setQueryData(["provider-keys", "group"], {
		keys: [
			{
				id: "key",
				label: "Primary key",
				masked: "***",
				priority: 0,
				disabled: false,
				disabledReason: null,
				network: {},
				cooldown: null,
			},
		],
	});
	qc.setQueryData(quotaSnapshotsKey, {
		entries: [
			{
				groupId: "group",
				prefix: "group",
				templateId: "custom-api",
				credentialId: "key",
				supported: true,
				snapshot: {
					scope: "key",
					fetchedAt: 1,
					windows: [],
					balances: [{ unit: "USD", remaining: 12.5 }],
				},
			},
		],
	});
	const html = render(<ProviderKeysPanel providerId="group" />, qc);
	expect(html).toContain("12.5 USD");
	expect(html).toContain("Primary key");
	expect(html).toContain(settings.providerKeys.add);
	expect(html).toContain(settings.providerKeys.remove);
});

test("Command Code keeps usage-summary and model-management controls alongside public quota", () => {
	const qc = new QueryClient();
	qc.setQueryData(["commandcode", "usage-summary"], {
		loggedIn: true,
		summary: { totalCount: 123, totalTokens: 456, successRate: 97 },
	});
	qc.setQueryData(quotaSnapshotsKey, {
		entries: [
			{
				groupId: "CommandCode",
				prefix: "CommandCode",
				templateId: "command-code",
				credentialId: "key",
				snapshot: {
					scope: "account",
					fetchedAt: 1,
					windows: [],
					balances: [{ unit: "credits", remaining: 8 }],
				},
			},
		],
	});
	const html = render(
		<CommandCodeSection
			value={{ apiKey: "", disabled: false }}
			onChange={() => {}}
			onToggleDisabled={() => {}}
			modelProtocols={{}}
			onModelProtocolChange={() => {}}
		/>,
		qc,
	);
	expect(html).toContain("8 credits");
	expect(html).toContain("123");
	expect(html).toContain("456");
	expect(html).toContain("97");
	expect(html).toContain(settings.customApiRefreshModels);
});
