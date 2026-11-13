/**
 * Browser fixture of the task board's 「交给团队」 (outline P2 PR 10c-3): the real
 * `SessionTaskBoard` against the test server's outline API (`task-board-hand-out.browser.test.ts`),
 * in a colour scheme, width and language the test chooses.
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
import { SessionTaskBoard } from "./TaskBoardViews";

const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	resources: { en: { outline: outlineEn }, "zh-CN": { outline: outlineZh } },
	react: { useSuspense: false },
	// As the app's (`lib/i18n.ts`): React escapes what it renders.
	interpolation: { escapeValue: false },
});

let root: Root | null = null;

export function ready(): boolean {
	return true;
}

/** Mount a session's board in `scheme`, in a column `width` px wide, in `language`. */
export async function open(
	narratorId: string,
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
						<SessionTaskBoard narratorId={narratorId} onOpenTask={() => {}} />
					</div>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
}

export function count(selector: string): number {
	return document.querySelectorAll(selector).length;
}

/** A row as the board shows it: its status, whether it waits for a prerequisite, its text. */
export function row(title: string) {
	const el = document.querySelector<HTMLElement>(`[data-testid=task-row][data-title="${title}"]`);
	if (!el) return null;
	return {
		status: el.dataset.status ?? "",
		text: el.textContent ?? "",
	};
}

/** The open menu: its items' test ids and words, and where its dropdown is. */
export function menu() {
	const dropdown = document.querySelector<HTMLElement>(".mantine-Menu-dropdown");
	if (!dropdown) return null;
	const rect = dropdown.getBoundingClientRect();
	return {
		items: [...dropdown.querySelectorAll<HTMLElement>("[data-testid^=task-action-]")].map(
			(item) => ({
				id: item.dataset.testid ?? "",
				text: item.textContent ?? "",
			}),
		),
		left: rect.left,
		right: rect.right,
		background: getComputedStyle(dropdown).backgroundColor,
		opacity: Number(getComputedStyle(dropdown).opacity),
		viewport: window.innerWidth,
		pageScrollWidth: document.documentElement.scrollWidth,
	};
}

export function click(selector: string): boolean {
	const el = document.querySelector<HTMLElement>(selector);
	el?.click();
	return !!el;
}

/** The notifications shown: their titles and words. */
export function notices(): Array<{ title: string; text: string }> {
	return [...document.querySelectorAll<HTMLElement>(".mantine-Notification-root")].map((n) => ({
		title: n.querySelector(".mantine-Notification-title")?.textContent ?? "",
		text: n.querySelector(".mantine-Notification-description")?.textContent ?? "",
	}));
}
