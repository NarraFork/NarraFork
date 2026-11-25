/**
 * Browser fixture of the team page (the redesign R): the real `TeamPageView` (header, 等你处理,
 * work list, activity, work item drawer) against the test server's team and narrator routes
 * (`team-page.browser.test.ts`), and the project page's teams section. The coordinator's
 * conversation is a stand-in whose composer takes the text the page asks to add (as the real
 * composer does): the narrator panel has its own browser suites. Live refresh rides the app's
 * own narrator socket. The shell carries the phone's menu buttons (inline and floating fallback)
 * as the app does.
 */
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "../../styles/nav-collapsed.css";
import { AppShell, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createBrowserHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import i18next from "i18next";
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { listenComposerAppend } from "../../lib/composer-append-queue";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import narratorEn from "../../locales/en/narrator.json";
import navEn from "../../locales/en/nav.json";
import projectsEn from "../../locales/en/projects.json";
import narratorZh from "../../locales/zh-CN/narrator.json";
import navZh from "../../locales/zh-CN/nav.json";
import projectsZh from "../../locales/zh-CN/projects.json";
import { MobileNavFallback } from "../nav/MobileNavButton";
import { MobileNavContext } from "../nav/nav-render-context";
import { ProjectTeamCards } from "../project/ProjectTeamCards";
import { CreateTeamModal } from "./CreateTeamModal";
import { TeamPageView } from "./TeamPageView";

const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	// `narrator`: the coordinator's sharing panel in the members drawer (M1); `nav`: the menu button.
	resources: {
		en: { projects: projectsEn, narrator: narratorEn, nav: navEn },
		"zh-CN": { projects: projectsZh, narrator: narratorZh, nav: navZh },
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
/** The phone drawer's toggle, as the app shell hands it to the menu buttons. */
const mobileNav = { opened: false, toggle: () => opened.push("menu") };
// The team communication drawer uses real browser Back without replacing the fixture page.
const router = createRouter({ routeTree: createRootRoute(), history: createBrowserHistory() });

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
						<MobileNavContext.Provider value={mobileNav}>
							<AppShell.Main data-testid="page-frame" style={{ height: "100dvh" }}>
								<RouterContextProvider router={router}>{mounted}</RouterContextProvider>
							</AppShell.Main>
							<MobileNavFallback />
						</MobileNavContext.Provider>
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

/** The coordinator's conversation stand-in: its composer takes appended text like the real one. */
function StandInConversation({ teamId }: { teamId: string }) {
	const [draft, setDraft] = useState("");
	useEffect(
		() => listenComposerAppend(teamId, (text) => setDraft((value) => value + text)),
		[teamId],
	);
	return (
		// Laid out like the narrator panel: the composer at the bottom.
		<div
			data-testid="conversation-stand-in"
			style={{
				padding: 16,
				height: "100%",
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
			}}
		>
			Coordinator conversation
			<textarea
				data-testid="composer-stand-in"
				aria-label="Message"
				value={draft}
				onChange={(event) => setDraft(event.currentTarget.value)}
				style={{ display: "block", marginTop: "auto", width: "100%", maxWidth: 360 }}
			/>
		</div>
	);
}

/** Mount the team page as a member or onlooker sees it (the token says who). */
export function openTeam(projectId: string, teamId: string, sidebarWidth = 250): void {
	narratorWSManager.connect();
	navWidth = sidebarWidth;
	mount(
		<TeamPageView
			projectId={projectId}
			teamId={teamId}
			conversation={<StandInConversation teamId={teamId} />}
			onOpenSession={(id) => opened.push(`session:${id}`)}
			onOpenCoordinatorSession={() => opened.push(`full:${teamId}`)}
			onBack={() => opened.push("back")}
			onDisbanded={(id) => opened.push(`disbanded:${id}`)}
		/>,
	);
}

/** Mount the project page's teams section. */
/** The project page's team cards with its 「新团队」 dialog (R2), as the project page wires them. */
function ProjectTeamsSection({ projectId, canCreate }: { projectId: string; canCreate: boolean }) {
	const [creating, setCreating] = useState(false);
	return (
		<div style={{ padding: 12 }}>
			<ProjectTeamCards
				projectId={projectId}
				canCreate={canCreate}
				onOpenTeam={(id) => opened.push(`team:${id}`)}
				onCreate={() => setCreating(true)}
			/>
			{creating && (
				<CreateTeamModal
					projectId={projectId}
					opened
					onClose={() => setCreating(false)}
					onCreated={(team) => {
						setCreating(false);
						opened.push(`team:${team.id}`);
					}}
				/>
			)}
		</div>
	);
}

export function openProjectTeams(projectId: string, canCreate: boolean): void {
	mount(<ProjectTeamsSection projectId={projectId} canCreate={canCreate} />);
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

/** The value of a text field. */
export function value(selector: string): string | null {
	return document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value ?? null;
}

/** The work list group a row is in (`needsYou`, `inProgress`, `review`), or null. */
export function groupOf(itemId: string): string | null {
	const row = document.querySelector(`[data-testid=team-work-row][data-item-id="${itemId}"]`);
	const group = row?.closest<HTMLElement>("[data-testid^=team-group-]");
	return group?.dataset.testid?.replace("team-group-", "") ?? null;
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

/**
 * Whether a tap at the centre of the (first visible) element would reach it, i.e. nothing such
 * as a floating button lies on top of it.
 */
export function tappable(selector: string): boolean {
	const element = [...document.querySelectorAll<HTMLElement>(selector)].find(
		(candidate) => candidate.getBoundingClientRect().width > 0,
	);
	if (!element) return false;
	const rect = element.getBoundingClientRect();
	const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
	return !!hit && element.contains(hit);
}

export function click(selector: string): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	element?.click();
	return !!element;
}

export function type(selector: string, value: string): void {
	const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
	if (!input) throw new Error(`no ${selector}`);
	const prototype =
		input instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
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
