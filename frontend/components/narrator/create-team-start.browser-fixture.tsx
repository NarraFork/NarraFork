/**
 * Browser fixture of the new-session dialog's "start as a team" option: the real
 * `CreateNarratorModal` against the test server's project, team and narrator routes
 * (`create-team-start.browser.test.ts`). There is no router here, so the created team is
 * observed through `onTeamCreated` instead of the team page opening.
 */
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import type { TeamDetail } from "@shared/project-teams";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import commonEn from "../../locales/en/common.json";
import narratorEn from "../../locales/en/narrator.json";
import narratorsEn from "../../locales/en/narrators.json";
import projectsEn from "../../locales/en/projects.json";
import commonZh from "../../locales/zh-CN/common.json";
import narratorZh from "../../locales/zh-CN/narrator.json";
import narratorsZh from "../../locales/zh-CN/narrators.json";
import projectsZh from "../../locales/zh-CN/projects.json";
import { CreateNarratorModal } from "./CreateNarratorModal";

const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	resources: {
		en: { common: commonEn, narrator: narratorEn, narrators: narratorsEn, projects: projectsEn },
		"zh-CN": {
			common: commonZh,
			narrator: narratorZh,
			narrators: narratorsZh,
			projects: projectsZh,
		},
	},
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

let root: Root | null = null;
const created: TeamDetail[] = [];
let closed = 0;

export function ready(): boolean {
	return true;
}

/** Open the new-session dialog on a directory, as the sidebar or the dashboard would. */
export function openDialog(cwd: string): void {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	root?.unmount();
	root = createRoot(document.getElementById("root") as HTMLElement);
	root.render(
		<I18nextProvider i18n={instance}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme="light">
					<Notifications />
					<CreateNarratorModal
						opened
						initialCwd={cwd}
						onClose={() => {
							closed++;
						}}
						onTeamCreated={(team) => created.push(team)}
					/>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
}

export async function setLanguage(lng: "en" | "zh-CN"): Promise<void> {
	await instance.changeLanguage(lng);
}

export function createdTeams(): Array<{ id: string; projectId: string; name: string }> {
	return created.map((team) => ({ id: team.id, projectId: team.projectId, name: team.name }));
}

export function closedCount(): number {
	return closed;
}

export function count(selector: string): number {
	return document.querySelectorAll(selector).length;
}

export function text(selector: string): string | null {
	return document.querySelector(selector)?.textContent ?? null;
}

export function attr(selector: string, name: string): string | null {
	return document.querySelector(selector)?.getAttribute(name) ?? null;
}

/** Whether the "start as a team" choice can be picked (its radio is not disabled). */
export function teamOptionEnabled(): boolean | null {
	const input = document.querySelector<HTMLInputElement>(
		'[data-testid=create-mode] input[value="team"]',
	);
	return input ? !input.disabled : null;
}

export function chooseMode(mode: "session" | "team"): boolean {
	const input = document.querySelector<HTMLInputElement>(
		`[data-testid=create-mode] input[value="${mode}"]`,
	);
	input?.click();
	return !!input;
}

export function click(selector: string): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	element?.click();
	return !!element;
}

export function isDisabled(selector: string): boolean | null {
	const element = document.querySelector<HTMLButtonElement>(selector);
	return element ? element.disabled || element.hasAttribute("data-disabled") : null;
}

export function type(selector: string, value: string): void {
	const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
	if (!input) throw new Error(`no ${selector}`);
	const proto =
		input instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}
