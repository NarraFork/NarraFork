import "@mantine/core/styles.css";
import { RenderLodCtx } from "@frontend/components/narrator/lod/RenderLodCtx";
import { setToken } from "@frontend/lib/api/client";
import { mantineTheme } from "@frontend/lib/mantine-theme";
import { MantineProvider, v8CssVariablesResolver } from "@mantine/core";
import type { IntelligentUiKitNotice } from "@shared/intelligent-ui-kit";
import { createInstance } from "i18next";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { IntelligentUICard } from "./IntelligentUICard";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	// As in the app: React escapes on render, so interpolated values are passed through.
	interpolation: { escapeValue: false },
	resources: {
		en: {
			narrator: {
				intelligentUi: {
					title: "UI",
					loading: "Loading runtime",
					loadFailed: "Load failed",
					renderFailed: "Render failed",
					staticPreview: "Shared preview unavailable",
					streaming: "Generating {{title}}",
					expand: "Expand",
					sendFailed: "Send failed",
					linkConfirm: "Open {{url}}?",
					linkOpen: "Open",
					cancel: "Cancel",
					kit: {
						title: "Component kit",
						buildPrompt: "Build a component kit?",
						updatePrompt: "Update the component kit?",
						confirm: "Confirm",
						dismiss: "Not now",
						approved: "Confirmed",
						failed: "Request failed",
						state: { builtin: "Built-in", unbuilt: "Unbuilt", stale: "Stale", ready: "Ready" },
					},
				},
			},
		},
	},
});
setToken("fixture-private-token");

/** The props a `render` tool row passes down, driven by the test like a stream would. */
function Fixture() {
	const [inline, setInline] = useState({ source: "", live: true });
	const [kit, setKit] = useState<IntelligentUiKitNotice | undefined>(undefined);
	Object.assign(window, {
		inlineFixture: {
			stream: (source: string, live: boolean) => setInline({ source, live }),
			kit: setKit,
		},
	});
	return (
		<I18nextProvider i18n={i18n}>
			<MantineProvider
				theme={mantineTheme}
				cssVariablesResolver={v8CssVariablesResolver}
				forceColorScheme="light"
			>
				<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
					<div id="card" style={{ width: 720 }}>
						<IntelligentUICard
							narratorId="n1"
							file={null}
							inline={{ ...inline, title: "Plans" }}
							kit={kit}
							height={400}
						/>
					</div>
				</RenderLodCtx.Provider>
			</MantineProvider>
		</I18nextProvider>
	);
}
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
