/**
 * Browser fixture of the task board (outline P2 PR 5): the real `SessionTaskBoard` and
 * `ProjectTaskBoard`, against the test server's outline API (`task-board.browser.test.ts`). The
 * session board's live refresh rides the app's own narrator socket, as in the app.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import type { OutlineBoardTask } from "@shared/outline-task-board";
import { typographyMetrics } from "@shared/pretext-layout/pretext-fonts";
import { setTypography, type TypographySettings } from "@shared/pretext-layout/typography";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import outlineEn from "../../../locales/en/outline.json";
import { ProjectTaskBoard, SessionTaskBoard } from "./TaskBoardViews";

const instance = i18next.createInstance();
await instance
	.use(initReactI18next)
	.init({ lng: "en", resources: { en: { outline: outlineEn } }, react: { useSuspense: false } });

let root: Root | null = null;
let queryClient: QueryClient | null = null;
const opened: string[] = [];

function mount(node: React.ReactNode): void {
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	root?.unmount();
	root = createRoot(document.getElementById("root") as HTMLElement);
	root.render(
		<I18nextProvider i18n={instance}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider>
					<div style={{ width: 720, padding: 12 }}>{node}</div>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
}

const onOpenTask = (task: OutlineBoardTask) => opened.push(task.id);

export function ready(): boolean {
	return true;
}

/** Mount a session's board (its dock tab's content). */
export function openSession(narratorId: string): void {
	narratorWSManager.connect();
	mount(<SessionTaskBoard narratorId={narratorId} onOpenTask={onOpenTask} />);
}

/** Mount a project's board (the project page's Tasks view). */
export function openProject(projectId: string): void {
	mount(<ProjectTaskBoard projectId={projectId} onOpenTask={onOpenTask} />);
}

/** Whether the narrator socket is connected. */
export function socketConnected(): boolean {
	return narratorWSManager.connected;
}

/** Tasks the board asked its host to open in the outline. */
export function openedTasks(): string[] {
	return [...opened];
}

/** The rows the board shows: title, status, the executor group, badges. */
export function rows(): Array<{ title: string; status: string; group: string; badges: string[] }> {
	return [...document.querySelectorAll<HTMLElement>("[data-testid=task-row]")].map((row) => ({
		title: row.dataset.title ?? "",
		status: row.closest<HTMLElement>("[data-testid=task-board-status]")?.dataset.status ?? "",
		group:
			row.closest<HTMLElement>("[data-testid=task-board-group]")?.querySelector("p")?.textContent ??
			"",
		badges: [...row.querySelectorAll<HTMLElement>("[data-testid^=task-badge-]")].map(
			(badge) => badge.dataset.testid ?? "",
		),
	}));
}

export function row(title: string) {
	return rows().find((r) => r.title === title) ?? null;
}

export function count(selector: string): number {
	return document.querySelectorAll(selector).length;
}

/** Type into a textarea or input the way a person does (React sees the change). */
export function type(selector: string, text: string): boolean {
	const element = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
	if (!element) return false;
	const proto =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, text);
	element.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
}

/** Text of the element a test id names (the first), or null. */
export function textOf(testId: string): string | null {
	return document.querySelector(`[data-testid=${testId}]`)?.textContent ?? null;
}

/** Set the reader's typography (外观 · 排版), as the sliders do. */
export function applyTypography(next: Partial<TypographySettings>): void {
	setTypography(next);
}

/**
 * A task row's title and meta text: computed size and line box (px), with what the
 * conversation measures the body and xs roles with.
 */
export function rowTypography(title: string) {
	const row = document.querySelector(`[data-testid=task-row][data-title="${title}"]`);
	const texts = row ? [...row.querySelectorAll("p")] : [];
	const px = (el: Element | undefined) => {
		if (!el) return null;
		const cs = getComputedStyle(el);
		return { size: Number.parseFloat(cs.fontSize), line: Number.parseFloat(cs.lineHeight) };
	};
	const m = typographyMetrics();
	return {
		title: px(texts.find((p) => p.textContent === title)),
		address: px(texts.find((p) => getComputedStyle(p).fontFamily.includes("monospace"))),
		expected: {
			body: { size: m.size.sm, line: m.line.body },
			xs: { size: m.size.xs, line: m.line.xs },
		},
	};
}
