/**
 * Browser fixture of the task board's 「转交给会话」 (outline P2 PR 10a): the real
 * `ProjectTaskBoard` against the test server's outline API
 * (`task-board-transfer.browser.test.ts`), in a colour scheme and at a width the test chooses.
 */
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import outlineEn from "../../../locales/en/outline.json";
import outlineZh from "../../../locales/zh-CN/outline.json";
import { ProjectTaskBoard } from "./TaskBoardViews";

const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	resources: { en: { outline: outlineEn }, "zh-CN": { outline: outlineZh } },
	react: { useSuspense: false },
});

let root: Root | null = null;

export function ready(): boolean {
	return true;
}

/** Mount a project's board in `scheme`, in a column `width` px wide, in `language`. */
export async function open(
	projectId: string,
	options: { scheme: "light" | "dark"; width: number; language: string },
): Promise<void> {
	await instance.changeLanguage(options.language);
	root?.unmount();
	document.documentElement.style.background = options.scheme === "dark" ? "#1a1b1e" : "#ffffff";
	root = createRoot(document.getElementById("root") as HTMLElement);
	root.render(
		<I18nextProvider i18n={instance}>
			<QueryClientProvider
				client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
			>
				<MantineProvider forceColorScheme={options.scheme}>
					<Notifications />
					<div style={{ width: options.width, boxSizing: "border-box", padding: 8 }}>
						<ProjectTaskBoard projectId={projectId} onOpenTask={() => {}} />
					</div>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
}

export function count(selector: string): number {
	return document.querySelectorAll(selector).length;
}

/** A row as the board shows it: its status group, its executor group, its text. */
export function row(title: string) {
	const el = document.querySelector<HTMLElement>(`[data-testid=task-row][data-title="${title}"]`);
	if (!el) return null;
	return {
		status: el.dataset.status ?? "",
		group:
			el.closest<HTMLElement>("[data-testid=task-board-group]")?.querySelector("p")?.textContent ??
			"",
		text: el.textContent ?? "",
	};
}

/** Click a row's menu button. */
export function openMenu(title: string): boolean {
	const button = document.querySelector<HTMLElement>(
		`[data-testid=task-row][data-title="${title}"] [data-testid=task-row-menu]`,
	);
	button?.click();
	return !!button;
}

export function click(selector: string, index = 0): boolean {
	const el = document.querySelectorAll<HTMLElement>(selector)[index];
	el?.click();
	return !!el;
}

export function textOf(selector: string): string | null {
	return document.querySelector(selector)?.textContent ?? null;
}

/** The picker: its sessions in order, its buttons' words, where it is, what it is drawn on. */
export function picker() {
	const box = document.querySelector<HTMLElement>("[data-testid=task-transfer]");
	if (!box) return null;
	const rect = box.getBoundingClientRect();
	const dropdown = box.closest<HTMLElement>(".mantine-Popover-dropdown");
	const dropRect = dropdown?.getBoundingClientRect();
	const buttons = [...box.querySelectorAll<HTMLElement>("button")].map((b) => {
		const r = b.getBoundingClientRect();
		return {
			left: r.left,
			right: r.right,
			width: r.width,
			scroll: b.scrollWidth,
			client: b.clientWidth,
		};
	});
	return {
		note: box.querySelector("[data-testid=task-transfer-note]")?.textContent ?? "",
		sessions: [...box.querySelectorAll<HTMLElement>("[data-testid=task-transfer-session]")].map(
			(s) => ({
				id: s.dataset.narratorId ?? "",
				text: s.querySelector("p")?.textContent ?? "",
				only: s.querySelector("[data-testid=task-transfer-only]")?.textContent ?? "",
				start: s.querySelector("[data-testid=task-transfer-start]")?.textContent ?? "",
			}),
		),
		empty: box.querySelector("[data-testid=task-transfer-empty]")?.textContent ?? null,
		left: Math.min(rect.left, dropRect?.left ?? rect.left),
		right: Math.max(rect.right, dropRect?.right ?? rect.right),
		buttons,
		background: dropdown ? getComputedStyle(dropdown).backgroundColor : "",
		/** 1 once the popover's opening transition is over. */
		opacity: dropdown ? Number(getComputedStyle(dropdown).opacity) : 0,
		color: getComputedStyle(box).color,
		viewport: window.innerWidth,
		pageScrollWidth: document.documentElement.scrollWidth,
	};
}

/** The notifications shown, their words. */
export function notices(): string[] {
	return [...document.querySelectorAll<HTMLElement>(".mantine-Notification-description")].map(
		(n) => n.textContent ?? "",
	);
}

/** The menu item's words (the menu is open). */
export function menuItem(testId: string): string | null {
	return document.querySelector(`[data-testid=${testId}]`)?.textContent ?? null;
}
