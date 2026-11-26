import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { usePluginOverlayVisibility } from "../../hooks/usePluginOverlayVisibility";
import { pluginKeys } from "../../hooks/usePlugins";
import { setToken } from "../../lib/api/client";
import i18n from "../../lib/i18n";
import { mantineTheme } from "../../lib/mantine-theme";
import pluginStrings from "../../locales/en/plugins.json";
import { pluginContributionStore } from "./PluginContributionStore";
import { PluginOverlayHost } from "./PluginOverlayHost";
import { PluginUiRuntimeProvider } from "./PluginUiRuntimeProvider";
import { pluginOverlayBoundsStore } from "./plugin-overlay-bounds";
import { usePluginUiRuntime } from "./plugin-ui-runtime-context";
import { resolvePluginUiContribution } from "./registry";
import type { PluginContributionRecord } from "./types";

export interface OverlayBrowserControls {
	reload: (index?: number) => void;
	/** The per-user preference write behind the Settings → Appearance switch. */
	setOverlayHidden: (pluginId: string, hidden: boolean) => void;
	remove: (kind: "disabled" | "uninstalled") => void;
	inspect: () => {
		sessions: { id: string; status: string; backendId?: string }[];
		bounds: string[];
	};
}

declare global {
	interface Window {
		overlayFixture: OverlayBrowserControls;
	}
}

// The production UI preference query is scoped to an authenticated principal.
// This credential is accepted only by the test's isolated loopback stub.
setToken("fixture-user-token");
const scenario = new URLSearchParams(location.search).get("scenario") ?? "normal";
const records: PluginContributionRecord[] = Array.from(
	{ length: scenario.startsWith("full") ? 2 : 1 },
	(_, index) => ({
		pluginId: `fixture-${scenario}-${index}`,
		contributionId: "pet",
		version: "1.0.0",
		hash: "a".repeat(64),
		title: `Overlay ${index}`,
		entryPath: scenario === "missing" ? "missing.js" : "entry.js",
		scope: "global",
		surfaces: ["overlay"],
		availability: "available",
	}),
);
pluginContributionStore.applyRecords(records);
const instanceId = (index = 0) => `overlay:${records[index].pluginId}:pet`;

function Fixture() {
	const runtime = usePluginUiRuntime();
	const { setHidden, settled } = usePluginOverlayVisibility();
	const [clicks, setClicks] = useState(0);
	useEffect(() => {
		// Hidden/cold-start checks must not race the initial scoped preference read.
		if (!settled) return;
		// Only drive public production operations; never write the bounds store or
		// fake a session/port. Tests read state to verify the real lifecycle cleanup.
		window.overlayFixture = {
			reload: (index = 0) => runtime.reloadSession(instanceId(index)),
			setOverlayHidden: setHidden,
			remove: (kind) =>
				pluginContributionStore.applyRecords(
					kind === "disabled"
						? records.map((record) => ({ ...record, availability: "disabled" }))
						: [],
				),
			inspect: () => ({
				sessions: runtime.getSessions().map((record) => ({
					id: record.params.panelInstanceId,
					status: record.snapshot.status,
					backendId: record.materialized?.backendSessionId,
				})),
				bounds: Object.keys(pluginOverlayBoundsStore.getSnapshot()),
			}),
		};
	}, [runtime, setHidden, settled]);
	return (
		<>
			<button
				id="underlay"
				type="button"
				onClick={() => setClicks((value) => value + 1)}
				style={{ position: "fixed", inset: 0, width: "100%", background: "rgb(17, 93, 151)" }}
			>
				Underlying application: <span id="clicks">{clicks}</span>
			</button>
			<PluginOverlayHost />
		</>
	);
}

// Bun.build has no Vite import.meta.glob transform; seed the real i18n instance
// with its production namespace instead of invoking the Vite resource loader.
await i18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	resources: { en: { plugins: pluginStrings } },
	interpolation: { escapeValue: false },
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing overlay fixture root");
const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 5_000, retry: false } },
});
// This fixture supplies a ready contribution snapshot, unlike the cold-start suite.
// Seed its Query owner too; the real overlay no longer has a separate fetch path.
queryClient.setQueryData(
	pluginKeys.uiContributions,
	records.map(({ availability, ...record }) => ({ ...record, status: availability })),
);
createRoot(root).render(
	<I18nextProvider i18n={i18n}>
		<MantineProvider theme={mantineTheme} defaultColorScheme="dark">
			<QueryClientProvider client={queryClient}>
				<PluginUiRuntimeProvider
					resolveContribution={resolvePluginUiContribution}
					defaultTimeoutMs={3_000}
				>
					<Fixture />
				</PluginUiRuntimeProvider>
			</QueryClientProvider>
		</MantineProvider>
	</I18nextProvider>,
);
