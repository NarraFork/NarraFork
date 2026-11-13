import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import type { BackgroundTaskListItem } from "@shared/background-task-list";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import enNarrator from "../../../locales/en/narrator.json";
import zhNarrator from "../../../locales/zh-CN/narrator.json";
import { BackgroundTasksPanel } from "./BackgroundTasksDrawer";
import classes from "./BackgroundTasksDrawer.module.css";

export const output = "Build output remains selectable and copyable.\nSecond output line.";
export const command = `bun run build --filter frontend --output-directory /workspace/${"long-path-segment/".repeat(12)}`;
export const unbrokenCommand = `./${"unbroken-command".repeat(40)}`;

declare global {
	interface Window {
		backgroundTaskFixture: {
			tasks: BackgroundTaskListItem[];
			cancelled: string[];
			opened: string[];
			copied: string[];
			refreshes: number;
			beforeOpen: number;
		};
	}
}

function task(id: string, overrides: Partial<BackgroundTaskListItem>): BackgroundTaskListItem {
	return {
		id,
		type: "bash",
		backgroundKind: "task",
		status: "running",
		effectiveStatus: "running",
		currentNarratorStatus: null,
		activeChildTaskCount: 0,
		canCancelActiveWork: true,
		command,
		exitCode: null,
		toolUseId: `tool-${id}`,
		subagentNarratorId: null,
		subagentType: null,
		alias: null,
		title: null,
		output,
		outputBytes: output.length,
		outputTruncated: false,
		outputPreviewTruncated: false,
		startedAt: "2026-01-01T00:00:00Z",
		completedAt: null,
		createdAt: "2026-01-01T00:00:00Z",
		legacy: false,
		...overrides,
	};
}

const root = createRoot(document.getElementById("root") as HTMLElement);
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	resources: { en: { narrator: enNarrator }, "zh-CN": { narrator: zhNarrator } },
	react: { useSuspense: false },
});
let generation = 0;
export async function start(language: string, panelWidth: number, chromeless: boolean) {
	await instance.changeLanguage(language);
	generation++;
	queryClient.clear();
	window.backgroundTaskFixture = {
		tasks: [
			task("command", {}),
			task("unbroken", { command: unbrokenCommand }),
			task("agent", {
				type: "agent",
				command: null,
				title: `Investigate ${"LongUnbrokenSubagentTitle".repeat(12)}`,
				effectiveStatus: "child_running",
				activeChildTaskCount: 12,
				subagentNarratorId: "child",
			}),
			task("transfer", {
				type: "transfer",
				command: null,
				title: `/workspace/${"long-transfer-path/".repeat(16)}`,
				effectiveStatus: "paused",
				output: "PausedTransferReason".repeat(30),
				canCancelActiveWork: false,
			}),
			task("service", { command: "bun run dev", backgroundKind: "service" }),
		],
		cancelled: [],
		opened: [],
		copied: [],
		refreshes: 0,
		beforeOpen: 0,
	};
	root.render(
		<I18nextProvider i18n={instance}>
			<MantineProvider forceColorScheme="dark">
				<QueryClientProvider client={queryClient}>
					<div id="surface" style={{ width: panelWidth, maxWidth: "100%" }}>
						<BackgroundTasksPanel
							key={generation}
							narratorId="parent"
							chromeless={chromeless}
							onOpenSubagent={() => window.backgroundTaskFixture.beforeOpen++}
						/>
					</div>
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
}

export const selectors = { header: `.${classes.header}`, summary: `.${classes.summary}` };
export function snapshot() {
	const surface = document.getElementById("surface");
	if (!surface) throw new Error("Missing task surface");
	return {
		surfaceWidth: surface.clientWidth,
		surfaceScrollWidth: surface.scrollWidth,
		documentWidth: document.documentElement.clientWidth,
		documentScrollWidth: document.documentElement.scrollWidth,
		rows: [...surface.querySelectorAll<HTMLElement>(selectors.header)].map((header) => {
			const identity = header.querySelector<HTMLElement>(`.${classes.identity}`);
			const actions = header.querySelector<HTMLElement>(`.${classes.actions}`);
			const summary = header.querySelector<HTMLElement>(selectors.summary);
			if (!identity || !actions || !summary) throw new Error("Incomplete task header");
			const rect = summary.getBoundingClientRect();
			return {
				text: summary.textContent,
				width: rect.width,
				height: rect.height,
				lineHeight: Number.parseFloat(getComputedStyle(summary).lineHeight),
				clientWidth: summary.clientWidth,
				scrollWidth: summary.scrollWidth,
				summaryTop: rect.top,
				identityTop: identity.getBoundingClientRect().top,
				identityBottom: identity.getBoundingClientRect().bottom,
				actionsBottom: actions.getBoundingClientRect().bottom,
				icons: [...identity.querySelectorAll("svg")].map((icon) => ({
					width: icon.getBoundingClientRect().width,
					expected: Number(icon.getAttribute("width")),
				})),
				buttons: [...actions.querySelectorAll("button")].map(
					(button) => button.getBoundingClientRect().width,
				),
			};
		}),
	};
}
