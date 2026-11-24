/**
 * Browser fixture for the details panel's subagent-terminals row: the REAL
 * `SubagentTerminalsList` inside the same label/value layout as the panel's `DetailRow`
 * (a nowrap Group with a shrink-proof label and a `minWidth: 0` value box), light or dark.
 */
import { Box, Group, MantineProvider, Text } from "@mantine/core";
import { createInstance } from "i18next";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { SubagentTerminalsList } from "./SubagentTerminalsList";

import "@mantine/core/styles.css";

const params = new URLSearchParams(location.search);
const scheme = params.get("scheme") === "dark" ? "dark" : "light";
const lng = params.get("lng") === "zh-CN" ? "zh-CN" : "en";
const canOpen = params.get("canOpen") === "1";

const i18n = createInstance();
await i18n.init({
	lng,
	fallbackLng: "en",
	defaultNS: "narrator",
	resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
	interpolation: { escapeValue: false },
});

const long = "a-very-long-terminal-name-that-would-not-fit-on-a-phone-screen";
const terminals = [
	{
		id: "t1",
		name: "dev",
		cwd: "/repo/.worktrees/a",
		createdAt: "2026-11-17T00:00:00.000Z",
		narratorId: "w1",
		narratorTitle: "Build the settings page and check it in the browser at every width",
		subagentType: "worker",
	},
	{
		id: "t2",
		name: long,
		cwd: null,
		createdAt: "2026-11-17T00:01:00.000Z",
		narratorId: "w2",
		narratorTitle: null,
		subagentType: "worker",
	},
];

function App() {
	return (
		<I18nextProvider i18n={i18n}>
			<MantineProvider forceColorScheme={scheme}>
				<Box p="md" data-testid="panel" style={{ background: "var(--mantine-color-body)" }}>
					<Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
						<Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
							{i18n.t("details.subagentTerminals")}
						</Text>
						<Box style={{ flex: 1, minWidth: 0, textAlign: "right" }}>
							<SubagentTerminalsList
								terminals={terminals}
								truncated={false}
								canOpen={canOpen}
								onOpenSession={() => {}}
							/>
						</Box>
					</Group>
				</Box>
			</MantineProvider>
		</I18nextProvider>
	);
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<App />);

/** Every box inside the panel that reaches past the panel's right edge. */
export function overflowReport() {
	const panel = document.querySelector('[data-testid="panel"]') as HTMLElement | null;
	if (!panel) return null;
	const right = panel.getBoundingClientRect().right + 0.5;
	const escaping = [...panel.querySelectorAll("*")]
		.filter((node) => node.getBoundingClientRect().right > right)
		.map((node) => (node as HTMLElement).className || node.tagName);
	return {
		rows: panel.querySelectorAll('[data-testid="subagent-terminal-row"]').length,
		buttons: panel.querySelectorAll("button").length,
		docScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		escaping,
	};
}
