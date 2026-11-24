/**
 * Browser fixture of the team page (P4): the real `TeamPageView` (top bar, teams list, board,
 * activity, approvals) against the test server's team and narrator routes
 * (`team-page.browser.test.ts`). The coordinator's conversation is a stand-in: the narrator
 * panel has its own browser suites. Live refresh rides the app's own narrator socket.
 */
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { AppShell, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import narratorEn from "../../locales/en/narrator.json";
import projectsEn from "../../locales/en/projects.json";
import narratorZh from "../../locales/zh-CN/narrator.json";
import projectsZh from "../../locales/zh-CN/projects.json";
import { ProjectTeamsList } from "./ProjectTeamsList";
import { TeamPageView } from "./TeamPageView";

const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	// `narrator`: the coordinator's sharing panel in the members drawer (M1).
	resources: {
		en: { projects: projectsEn, narrator: narratorEn },
		"zh-CN": { projects: projectsZh, narrator: narratorZh },
	},
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

let root: Root | null = null;
let queryClient: QueryClient | null = null;
let mounted: React.ReactNode = null;
let scheme: "light" | "dark" = "light";
/** The app sidebar's width (the real shell's navbar: 250–480 px, hidden on phones). */
let navWidth = 250;
const opened: string[] = [];

function render(): void {
	if (!root || !queryClient) return;
	root.render(
		<I18nextProvider i18n={instance}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme={scheme}>
					<Notifications />
					{/* The app's shell: alt layout, a sidebar from the small breakpoint up, md padding. */}
					<AppShell
						layout="alt"
						header={{ height: 0 }}
						navbar={{ width: navWidth, breakpoint: "sm", collapsed: { mobile: true } }}
						padding="md"
					>
						<AppShell.Navbar data-testid="app-sidebar">
							<div style={{ padding: 12 }}>Sidebar</div>
						</AppShell.Navbar>
						<AppShell.Main data-testid="page-frame" style={{ height: "100dvh" }}>
							{mounted}
						</AppShell.Main>
					</AppShell>
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

/** Whether the page's queries have all been asked and none is fetching. */
export function idle(): boolean {
	return (
		!!queryClient &&
		queryClient.isFetching() === 0 &&
		queryClient.getQueryCache().getAll().length > 0
	);
}

/** Mount the team page as a member or onlooker sees it (the token says who). */
export function openTeam(
	projectId: string,
	teamId: string,
	canCreateTeam: boolean,
	sidebarWidth = 250,
): void {
	narratorWSManager.connect();
	navWidth = sidebarWidth;
	mount(
		<TeamPageView
			projectId={projectId}
			teamId={teamId}
			canCreateTeam={canCreateTeam}
			conversation={
				<div data-testid="conversation-stand-in" style={{ padding: 16, height: "100%" }}>
					Coordinator conversation
					<textarea
						data-testid="composer-stand-in"
						aria-label="Message"
						style={{ display: "block", marginTop: 8, width: "100%", maxWidth: 360 }}
					/>
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

/** Mark the conversation's element, to tell later whether it is still the same node. */
export function markConversation(): void {
	const element = document.querySelector("[data-testid=conversation-stand-in]") as
		| (HTMLElement & { __mark?: number })
		| null;
	if (element) element.__mark = 1;
}

/** Whether the conversation is still the node `markConversation` marked (never remounted). */
export function conversationKept(): boolean {
	const element = document.querySelector("[data-testid=conversation-stand-in]") as
		| (HTMLElement & { __mark?: number })
		| null;
	return element?.__mark === 1;
}

/** The data-testid of the focused element, or null. */
export function focused(): string | null {
	return document.activeElement?.getAttribute("data-testid") ?? null;
}

/** The width (px) of the element a selector names (the first visible), or 0. */
export function widthOf(selector: string): number {
	const element = [...document.querySelectorAll<HTMLElement>(selector)].find(
		(candidate) => candidate.getBoundingClientRect().width > 0,
	);
	return element ? element.getBoundingClientRect().width : 0;
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
