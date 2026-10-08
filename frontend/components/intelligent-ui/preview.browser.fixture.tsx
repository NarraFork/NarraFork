import "@mantine/core/styles.css";
import { RenderLodCtx } from "@frontend/components/narrator/lod/RenderLodCtx";
import { notifyPluginThemeChanged } from "@frontend/components/plugins/host-presentation";
import { clearToken, setToken } from "@frontend/lib/api/client";
import { mantineTheme } from "@frontend/lib/mantine-theme";
import { MantineProvider, v8CssVariablesResolver } from "@mantine/core";
import { createInstance } from "i18next";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { IntelligentUICard } from "./IntelligentUICard";
import { fileReference } from "./test-fixtures";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	resources: {
		en: {
			narrator: {
				intelligentUi: {
					title: "UI",
					currentFiles: "Current files",
					open: "Open preview",
					reload: "Refresh from files",
					loading: "Building files",
					loadFailed: "Build failed",
					renderFailed: "Render failed",
					staticPreview: "Shared preview unavailable",
					untrustedPreview:
						"Do not preview secret files or enter passwords or tokens; code may navigate away.",
					navigationStopped: "Preview navigated away; a request may already have been sent.",
					historyUnavailable: "Current files · history rollback unavailable",
				},
			},
		},
	},
});
setToken("fixture-private-token");

function Fixture() {
	const [scheme, setScheme] = useState<"light" | "dark">("dark");
	const [mounted, setMounted] = useState(true);
	const [shared, setShared] = useState(false);
	Object.assign(window, {
		previewFixture: {
			theme: setScheme,
			mount: setMounted,
			share: setShared,
			logout: clearToken,
			login: () => setToken("fixture-private-token"),
			switchAccount: () => setToken("fixture-other-account"),
			tokens: (css: string) => {
				let style = document.getElementById("fixture-theme");
				if (!style) {
					style = document.createElement("style");
					style.id = "fixture-theme";
					document.head.appendChild(style);
				}
				style.textContent = css;
				notifyPluginThemeChanged();
			},
		},
	});
	return (
		<I18nextProvider i18n={i18n}>
			<MantineProvider
				theme={mantineTheme}
				cssVariablesResolver={v8CssVariablesResolver}
				forceColorScheme={scheme}
			>
				<RenderLodCtx.Provider value={{ lod: 5, interactive: !shared }}>
					{mounted && (
						<IntelligentUICard
							narratorId="narrator/id"
							file={fileReference}
							publicSummary={shared}
							height={88}
						/>
					)}
				</RenderLodCtx.Provider>
			</MantineProvider>
		</I18nextProvider>
	);
}
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
