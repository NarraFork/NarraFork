import { expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import en from "../../locales/en/settings.json";
import { CUSTOM_API_PROTOCOL_OPTIONS, CustomApiProviderSection } from "./CustomApiProviderSection";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { settings: en } }, defaultNS: "settings" });

for (const { value: protocol } of CUSTOM_API_PROTOCOL_OPTIONS) {
	test(`tool image setting is visible and defaults off for ${protocol}`, () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		try {
			const html = renderToStaticMarkup(
				<QueryClientProvider client={client}>
					<I18nextProvider i18n={i18n}>
						<MantineProvider>
							<CustomApiProviderSection
								provider={{
									id: "test",
									name: "Test",
									prefix: "test",
									apiKey: "",
									baseUrl: "",
									defaultModel: "",
									codexAccountId: "",
									protocol,
								}}
								onProvidersChange={() => {}}
								openAIProviderModelsMap={{}}
								anthropicProviderModelsMap={{}}
								geminiProviderModelsMap={{}}
								hiddenModels={new Set()}
								onToggleHidden={() => {}}
								onBatchToggleHidden={() => {}}
								modelProtocols={{ "test:model": "completions-compatible" }}
								onModelProtocolChange={() => {}}
								customModels={[]}
								onCustomModelsChange={() => {}}
							/>
						</MantineProvider>
					</I18nextProvider>
				</QueryClientProvider>,
			);
			expect(html).toContain(en.toolResultImages);
			expect(html).toContain(en.toolResultImagesDesc);
			expect(html).toContain('value="off"');
		} finally {
			client.clear();
		}
	});
}
