/**
 * Browser fixture of the team page (P4): the real `TeamPageView` (top bar, teams list, board,
 * activity, approvals) against the test server's team and narrator routes
 * (`team-page.browser.test.ts`). The coordinator's conversation is a stand-in: the narrator
 * panel has its own browser suites. Live refresh rides the app's own narrator socket.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import projectsEn from "../../locales/en/projects.json";
import projectsZh from "../../locales/zh-CN/projects.json";
import { ProjectTeamsList } from "./ProjectTeamsList";
import { TeamPageView } from "./TeamPageView";

const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	resources: { en: { projects: projectsEn }, "zh-CN": { projects: projectsZh } },
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

let root: Root | null = null;
let queryClient: QueryClient | null = null;
let mounted: React.ReactNode = null;
let scheme: "light" | "dark" = "light";
const opened: string[] = [];

function render(): void {
	if (!root || !queryClient) return;
	root.render(
		<I18nextProvider i18n={instance}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme={scheme}>
					<div data-testid="page-frame" style={{ height: "100vh", display: "flex" }}>
						<div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
							{mounted}
						</div>
					</div>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
}

function mount(node: React.ReactNode): void {
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	root?.unmount();
	root = createRoot(document.getElementById("root") as HTMLElement);
	mounted = node;
	render();
}

export function ready(): boolean {
	return true;
}

/** Mount the team page as a member or onlooker sees it (the token says who). */
export function openTeam(projectId: string, teamId: string, canCreateTeam: boolean): void {
	narratorWSManager.connect();
	mount(
		<TeamPageView
			projectId={projectId}
			teamId={teamId}
			canCreateTeam={canCreateTeam}
			conversation={
				<div data-testid="conversation-stand-in" style={{ padding: 16, height: "100%" }}>
					Coordinator conversation
				</div>
			}
			onOpenSession={(id) => opened.push(`session:${id}`)}
			onOpenTeam={(id) => opened.push(`team:${id}`)}
			onBack={() => opened.push("back")}
		/>,
	);
}

/** Mount the project page's teams section. */
export function openProjectTeams(projectId: string, canCreate: boolean): void {
	mount(
		<div style={{ padding: 12 }}>
			<ProjectTeamsList
				projectId={projectId}
				canCreate={canCreate}
				onOpenTeam={(id) => opened.push(`team:${id}`)}
			/>
		</div>,
	);
}

export function setScheme(next: "light" | "dark"): void {
	scheme = next;
	render();
}

export async function setLanguage(lng: "en" | "zh-CN"): Promise<void> {
	await instance.changeLanguage(lng);
}

export function openedTargets(): string[] {
	return [...opened];
}

export function socketConnected(): boolean {
	return narratorWSManager.connected;
}

export function count(selector: string): number {
	return document.querySelectorAll(selector).length;
}

export function attr(selector: string, name: string): string | null {
	return document.querySelector(selector)?.getAttribute(name) ?? null;
}

export function text(selector: string): string | null {
	return document.querySelector(selector)?.textContent ?? null;
}

/** The column a card is in, or null when the card is not shown. */
export function columnOf(itemId: string): string | null {
	const card = document.querySelector(`[data-testid=team-card][data-item-id="${itemId}"]`);
	return card?.closest<HTMLElement>("[data-testid=team-column]")?.dataset.column ?? null;
}

/** Whether a visible element lies inside the viewport's width and the page does not scroll sideways. */
export function fitsWidth(selector: string): { found: boolean; inside: boolean; scrolls: boolean } {
	const element = [...document.querySelectorAll<HTMLElement>(selector)].find(
		(candidate) => candidate.getBoundingClientRect().width > 0,
	);
	const rect = element?.getBoundingClientRect();
	return {
		found: !!rect,
		inside: !!rect && rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5,
		scrolls: document.documentElement.scrollWidth > window.innerWidth + 1,
	};
}

/** The page's background and text colours (the body Mantine paints). */
export function colors(): { scheme: string | null; background: string; color: string } {
	const style = getComputedStyle(document.body);
	return {
		scheme: document.documentElement.getAttribute("data-mantine-color-scheme"),
		background: style.backgroundColor,
		color: style.color,
	};
}

export function click(selector: string): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	element?.click();
	return !!element;
}

export function type(selector: string, value: string): void {
	const input = document.querySelector<HTMLInputElement>(selector);
	if (!input) throw new Error(`no ${selector}`);
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Whether the element a selector names is absent, hidden, or slid out of the viewport. */
export function gone(selector: string): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) return true;
	const style = getComputedStyle(element);
	const rect = element.getBoundingClientRect();
	return (
		style.display === "none" ||
		style.visibility === "hidden" ||
		Number(style.opacity) === 0 ||
		rect.width === 0 ||
		rect.left >= window.innerWidth - 1
	);
}
