import "@mantine/core/styles.css";
import { Container, MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { ConfirmDialogProvider } from "../../../frontend/components/common/ConfirmDialogProvider";
import { ContextMemoryManager } from "../../../frontend/components/context-memory/ContextMemoryManager";
import enCommon from "../../../frontend/locales/en/common.json";
import enSettings from "../../../frontend/locales/en/settings.json";
import zhCommon from "../../../frontend/locales/zh-CN/common.json";
import zhSettings from "../../../frontend/locales/zh-CN/settings.json";

// Real components, CSS, HTTP transport and confirmation dialog; no geometry or API stubs.
const i18n = createInstance();
await i18n.init({
	lng: new URL(location.href).searchParams.get("lang") ?? "en",
	fallbackLng: "en",
	resources: {
		en: { common: enCommon, settings: enSettings },
		"zh-CN": { common: zhCommon, settings: zhSettings },
	},
});
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const root = document.getElementById("root");
if (!root) throw new Error("Missing browser fixture root");
createRoot(root).render(
	<MantineProvider defaultColorScheme="dark">
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={client}>
				<ConfirmDialogProvider>
					<Container size="sm" py="md">
						<ContextMemoryManager userId={root.dataset.userId ?? ""} />
					</Container>
				</ConfirmDialogProvider>
			</QueryClientProvider>
		</I18nextProvider>
	</MantineProvider>,
);
