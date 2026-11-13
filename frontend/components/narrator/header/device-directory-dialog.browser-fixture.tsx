import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { api } from "../../../lib/api";
import commonTranslations from "../../../locales/en/common.json";
import narratorTranslations from "../../../locales/en/narrator.json";
import { DeviceDirectoryDialog } from "./DeviceDirectoryDialog";
import "@mantine/core/styles.css";

// Only transport is replaced: the dialog, hooks, modal and remote browser are real.
export const requests: Array<string | null> = [];
export const switches: unknown[] = [];
export let closeCount = 0;
const context = { revision: 1, deviceId: "local", cwd: "/server", contextKey: "fixture" };
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
});
queryClient.setQueryData(["workspaceContext", "fixture-narrator"], context);
api.browseNarratorDevice = async (_narratorId, _deviceId, path) => {
	requests.push(path ?? null);
	if (path?.includes("missing")) throw new Error(`Directory not found: ${path}`);
	const canonical = path ?? "/remote/home";
	const sep = canonical.includes("\\") ? "\\" : "/";
	return {
		path: canonical,
		parent: sep === "\\" ? "C:\\" : "/remote",
		sep,
		truncated: false,
		entries: Array.from({ length: 180 }, (_, index) => ({
			name: `directory-${String(index).padStart(3, "0")}`,
			path: `${canonical}${sep}directory-${String(index).padStart(3, "0")}`,
			isDirectory: true,
		})),
	};
};
// No mutation is needed by layout assertions. Unexpected confirmation fails closed.
api.switchWorkspaceContext = async (_narratorId, input) => {
	switches.push(input);
	throw new Error("Unexpected fixture workspace switch");
};

const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	resources: { en: { narrator: narratorTranslations, common: commonTranslations } },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
	<MantineProvider defaultColorScheme="dark">
		<QueryClientProvider client={queryClient}>
			<I18nextProvider i18n={i18n}>
				<DeviceDirectoryDialog
					narratorId="fixture-narrator"
					deviceId="fixture-remote"
					deviceName="Fixture device"
					onClose={() => closeCount++}
				/>
			</I18nextProvider>
		</QueryClientProvider>
	</MantineProvider>,
);
