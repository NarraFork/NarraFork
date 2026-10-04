import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { ContextCompositionModal } from "./ContextCompositionModal";

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
				<ContextCompositionModal opened onClose={() => {}} narratorId="fixture" />
			</MantineProvider>
		</QueryClientProvider>
	</I18nextProvider>,
);
