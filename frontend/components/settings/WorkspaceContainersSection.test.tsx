import { expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import en from "../../locales/en/settings.json";
import zh from "../../locales/zh-CN/settings.json";
import { WorkspaceContainersSection } from "./WorkspaceContainersSection";

for (const [language, locale] of Object.entries({ en, "zh-CN": zh })) {
	for (const enabled of [false, true]) {
		test(`${language}: container settings remain available with stored tree snapshots=${enabled}`, async () => {
			const client = new QueryClient();
			const i18n = createInstance();
			await i18n.init({
				lng: language,
				defaultNS: "settings",
				resources: { [language]: { settings: locale } },
			});
			client.setQueryData(["settings"], { workspace: { treeSnapshotsEnabled: enabled } });
			client.setQueryData(["health"], { platform: "linux" });
			client.setQueryData(["podmanStatus"], { installed: true, version: "5.0" });
			try {
				const html = renderToStaticMarkup(
					<I18nextProvider i18n={i18n}>
						<QueryClientProvider client={client}>
							<MantineProvider env="test">
								<WorkspaceContainersSection />
							</MantineProvider>
						</QueryClientProvider>
					</I18nextProvider>,
				);
				const { document } = parseHTML(`<html><body>${html}</body></html>`);
				expect(document.body.textContent).toContain(locale.containersSubSection);
				expect(document.querySelector("button")?.textContent).toBe(locale.podmanManage);
				expect(document.body.textContent).toContain("5.0");
				expect(document.body.textContent).not.toContain(locale.treeSnapshotsEnabled);
				expect(document.querySelector('[role="switch"]')).toBeNull();
			} finally {
				client.clear();
			}
		});
	}
}
