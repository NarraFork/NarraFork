import "@mantine/core/styles.css";
import { MantineProvider, Menu } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { ContextCompositionMenu } from "./ContextCompositionMenu";

const i18n = i18next.createInstance();
await i18n.init({
	lng: new URLSearchParams(location.search).get("lang") ?? "zh-CN",
	fallbackLng: "en",
	resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
	interpolation: { escapeValue: false },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing context fixture root");
createRoot(root).render(
	<I18nextProvider i18n={i18n}>
		<QueryClientProvider client={new QueryClient()}>
			<MantineProvider defaultColorScheme="dark">
				<div style={{ position: "fixed", bottom: 16, left: 16 }}>
					<ContextCompositionMenu
						narratorId="fixture"
						totalTokens={400_000}
						target={
							<button type="button" data-testid="context-ring">
								Context
							</button>
						}
					>
						<Menu.Label>{i18n.t("narrator:activeThresholds", { compact: 75 })}</Menu.Label>
						<Menu.Item data-testid="threshold-action">
							{i18n.t("narrator:thresholdSettings")}
						</Menu.Item>
						<Menu.Divider />
						<Menu.Item
							data-testid="compact-action"
							onClick={() => {
								document.body.dataset.compactClicked = "yes";
							}}
						>
							{i18n.t("narrator:triggerCompact")}
						</Menu.Item>
						<Menu.Item data-testid="clear-action">{i18n.t("narrator:clearContext")}</Menu.Item>
					</ContextCompositionMenu>
				</div>
			</MantineProvider>
		</QueryClientProvider>
	</I18nextProvider>,
);
