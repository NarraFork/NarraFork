/**
 * Browser fixture for the typography-dock overflow regression.
 *
 * Mounts the REAL `<DockviewSurface>` (theme + default renderer), the REAL
 * `AppearanceDockPanel` (shared tool-panel shell/header) and the REAL
 * `AppearancePanel` sliders, and reports every horizontally overflowing box in
 * the surface. Nothing here mocks layout: the assertion is a measurement against
 * real Chromium, which is the only place a shrink-to-fit box that escapes its
 * scroll container is observable.
 */

import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import chatTranslations from "../../locales/en/chat.json";
import commonTranslations from "../../locales/en/common.json";
import narratorTranslations from "../../locales/en/narrator.json";
import { DockviewSurface } from "../dockview";
import { AppearanceDockPanel } from "./dock/panels";

import "@mantine/core/styles.css";
import "dockview-react/dist/styles/dockview.css";
import "../dockview/theme.css";
import "../../styles/mantine-slider-marks.css";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	ns: ["narrator", "chat", "common"],
	defaultNS: "narrator",
	resources: {
		en: {
			narrator: narratorTranslations,
			chat: chatTranslations,
			common: commonTranslations,
		},
	},
});

/**
 * Seeded so the panel never issues a preferences request: its defaults are what
 * the panel must render, and the fixture stays transport-free.
 */
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
queryClient.setQueryData(["user-preferences"], {
	narratorFontScalePercent: 100,
	narratorLetterSpacingPercent: 0,
	narratorLineHeightV2Percent: 100,
	narratorParagraphScalePercent: 100,
});

export interface OverflowReport {
	/** The surface root, for reference: dockview itself must not overflow. */
	surface: { clientWidth: number; scrollWidth: number };
	/** Every element the UA would give its own horizontal scrollbar. */
	scrollers: {
		tag: string;
		className: string;
		overflowX: string;
		clientWidth: number;
		scrollWidth: number;
		text: string;
	}[];
	/** Marks rendered, so a "no overflow" result cannot come from absent marks. */
	markCount: number;
	labelCount: number;
	/** True when every mark label sits inside the panel's content box. */
	labelsInsidePanel: boolean;
	panel: { clientWidth: number; scrollWidth: number } | null;
}

function AppearanceHost() {
	return (
		<MantineProvider defaultColorScheme="dark">
			<QueryClientProvider client={queryClient}>
				<I18nextProvider i18n={i18n}>
					<div style={{ height: "100vh", width: "100%" }}>
						<DockviewSurface
							// Production's narrator dock keeps every panel mounted and reuses
							// the same theme; mirror that so the measurement matches the real
							// DOM shape.
							defaultRenderer="always"
							components={{ appearance: AppearanceDockPanel }}
							onReady={(api) => {
								api.addPanel({
									id: "ndock-appearance",
									component: "appearance",
									params: { narratorId: "fixture-narrator" },
								});
							}}
						/>
					</div>
				</I18nextProvider>
			</QueryClientProvider>
		</MantineProvider>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<AppearanceHost />);

/** The panel's own scroll box: `ToolPanelShell`'s flex-1 `overflow: auto` body. */
function panelScroller(): HTMLElement | null {
	const header = document.querySelector<HTMLElement>(".nf-panel-header");
	const body = header?.nextElementSibling;
	return body instanceof HTMLElement ? body : null;
}

export function overflowReport(): OverflowReport {
	const surface = document.querySelector<HTMLElement>(".dv-dockview");
	if (!surface) throw new Error("Dockview surface not mounted");
	const panel = panelScroller();
	const scrollers: OverflowReport["scrollers"] = [];
	for (const element of Array.from(surface.querySelectorAll<HTMLElement>("*"))) {
		if (element.scrollWidth <= element.clientWidth) continue;
		const style = getComputedStyle(element);
		if (style.overflowX === "visible" || style.overflowX === "hidden") continue;
		scrollers.push({
			tag: element.tagName.toLowerCase(),
			className: `${element.className}`.slice(0, 120),
			overflowX: style.overflowX,
			clientWidth: element.clientWidth,
			scrollWidth: element.scrollWidth,
			text: (element.textContent ?? "").trim().slice(0, 60),
		});
	}
	const panelBox = panel ? panel.getBoundingClientRect() : null;
	const labels = Array.from(document.querySelectorAll<HTMLElement>(".mantine-Slider-markLabel"));
	return {
		surface: { clientWidth: surface.clientWidth, scrollWidth: surface.scrollWidth },
		scrollers,
		markCount: document.querySelectorAll(".mantine-Slider-mark").length,
		labelCount: labels.length,
		labelsInsidePanel:
			!!panelBox &&
			labels.every((label) => {
				const box = label.getBoundingClientRect();
				return box.left >= panelBox.left - 0.5 && box.right <= panelBox.right + 0.5;
			}),
		panel: panel ? { clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth } : null,
	};
}
