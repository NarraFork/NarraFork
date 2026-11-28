import "@mantine/core/styles.css";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import {
	endDrag,
	moveDrag,
	PANEL_DROP_PRIORITY,
	registerPanelDropTarget,
	startDragManual,
} from "@frontend/lib/panel-drag";
import en from "@frontend/locales/en/narrator.json";
import zh from "@frontend/locales/zh-CN/narrator.json";
import { MantineProvider } from "@mantine/core";
import type { CommunicationScope } from "@shared/narrator-communication";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DockviewPanelApi } from "dockview-react";
import i18next from "i18next";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { DockviewNarratorPanelVisibilityProvider } from "../narrator-panel-visibility";
import { CommunicationTopologyPanel } from "./CommunicationTopologyPanel";

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
	lng: "en",
	resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});
const root = createRoot(document.getElementById("root") as HTMLElement);
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const opened: string[] = [];
let lowerPriorityDrops = 0;
registerPanelDropTarget({
	id: "fixture-workspace",
	priority: PANEL_DROP_PRIORITY.dock,
	hitTest: () => true,
	onDrop: () => {
		lowerPriorityDrops++;
	},
});
export function fallbackDrops() {
	return lowerPriorityDrops;
}
const visibilityListeners = new Set<() => void>();
const panelApi = {
	isVisible: true,
	onDidVisibilityChange: (callback: () => void) => {
		visibilityListeners.add(callback);
		return {
			dispose: () => {
				visibilityListeners.delete(callback);
			},
		};
	},
};
let composerMounts = 0;
let composerUnmounts = 0;
function PersistentComposer() {
	useEffect(() => {
		composerMounts++;
		return () => {
			composerUnmounts++;
		};
	}, []);
	return (
		<textarea
			data-testid="persistent-composer"
			defaultValue="Unsent draft"
			style={{ display: "block", width: "100%", height: 48, boxSizing: "border-box" }}
		/>
	);
}
export function composerLifecycle() {
	return { mounts: composerMounts, unmounts: composerUnmounts };
}
export function setPanelVisible(visible: boolean) {
	panelApi.isVisible = visible;
	for (const callback of visibilityListeners) callback();
}
export function mount(width = 1024, height = 820, team = false, withComposer = false) {
	localStorage.setItem("narrafork_token", "fixture-token");
	const scope: CommunicationScope = team
		? { kind: "team", projectId: "project-a", teamId: "team-a" }
		: { kind: "narrator", narratorId: "root" };
	root.render(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme="dark">
					<div id="frame" style={{ width, height, maxWidth: "100vw" }}>
						{withComposer && <PersistentComposer />}
						<div style={{ height: withComposer ? "calc(100% - 48px)" : "100%" }}>
							<DockviewNarratorPanelVisibilityProvider
								api={panelApi as unknown as DockviewPanelApi}
							>
								<CommunicationTopologyPanel
									scope={scope}
									onOpenNarrator={(id) => opened.push(id)}
								/>
							</DockviewNarratorPanelVisibilityProvider>
						</div>
					</div>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
	narratorWSManager.connect();
}
export function resize(width: number, height = 820) {
	const frame = document.getElementById("frame");
	if (frame) {
		frame.style.width = `${width}px`;
		frame.style.height = `${height}px`;
	}
}
export async function language(language: "en" | "zh-CN") {
	await i18n.changeLanguage(language);
}
export function sidebarDrop(id: string, target: string, kind: "narrator" | "tool" = "narrator") {
	const rect = document.querySelector(`[data-topology-node="${target}"]`)?.getBoundingClientRect();
	if (!rect) throw new Error("Missing target");
	startDragManual(kind === "tool" ? "__spec__" : id, id, 0, 0);
	moveDrag(rect.x + rect.width / 2, rect.y + rect.height / 2);
	endDrag();
}
export function openedSessions() {
	return [...opened];
}
export function disconnect() {
	narratorWSManager.disconnect();
}
export function ready() {
	return true;
}
