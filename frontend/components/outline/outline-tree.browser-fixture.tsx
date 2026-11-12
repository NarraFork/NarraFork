/**
 * Browser fixture of the connected outline (readability E): the outline home and a space as the
 * router-free view hosts them (`OutlineView`), against the test server of
 * `outline-tree.browser.test.ts` (the real outline routes on the isolated SQLite). Navigation is
 * recorded, not followed: the tree never leaves itself to read.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { ensureTypographyCssVars } from "../../lib/typography-css-vars";
import outlineEn from "../../locales/en/outline.json";
import outlineZh from "../../locales/zh-CN/outline.json";
import { OutlineView } from "./OutlineView";
import type { OutlineTarget } from "./outline-nav";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { outline: outlineEn }, "zh-CN": { outline: outlineZh } },
	interpolation: { escapeValue: false },
});

let root: Root | null = null;
const navigations: OutlineTarget[] = [];

export function ready(): boolean {
	return true;
}

export async function open(options: {
	target: OutlineTarget;
	lang?: "en" | "zh-CN";
	scheme?: "light" | "dark";
	layout?: "page" | "panel";
}): Promise<void> {
	ensureTypographyCssVars();
	await i18n.changeLanguage(options.lang ?? "en");
	const element = document.getElementById("root") as HTMLElement;
	root?.unmount();
	root = createRoot(element);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const scheme = options.scheme ?? "light";
	document.body.style.background = scheme === "dark" ? "#1a1b1e" : "#ffffff";
	root.render(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={client}>
				<MantineProvider forceColorScheme={scheme}>
					<div style={{ padding: 16 }} data-testid="tree-host">
						<OutlineView
							target={options.target}
							onNavigate={(to) => navigations.push(to)}
							layout={options.layout ?? "page"}
						/>
					</div>
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
}

export function navigated(): OutlineTarget[] {
	return navigations;
}

/** The rows of the tree as the reader sees them: node key, kind, open, title. */
export function rows(): Array<{ key: string; kind: string; open: boolean; title: string }> {
	return [...document.querySelectorAll<HTMLElement>("[data-tree-node]")].map((row) => ({
		key: row.dataset.treeNode ?? "",
		kind: row.dataset.treeKind ?? "",
		open: row.dataset.open === "true",
		title: row.querySelector<HTMLElement>("[data-tree-title]")?.textContent ?? "",
	}));
}

/** Toggle the row whose title is `title` (its arrow). False when there is no such row. */
export function toggle(title: string): boolean {
	const row = [...document.querySelectorAll<HTMLElement>("[data-tree-node]")].find(
		(r) => r.querySelector("[data-tree-title]")?.textContent === title,
	);
	const arrow = row?.querySelector<HTMLButtonElement>("[data-tree-toggle]");
	if (!arrow) return false;
	arrow.click();
	return true;
}

/** Every row has its arrow, drawn (not hover-only). */
export function arrowsDrawn(): boolean {
	const rows = [...document.querySelectorAll<HTMLElement>("[data-tree-node]")];
	return (
		rows.length > 0 &&
		rows.every((row) => {
			const arrow = row.querySelector<HTMLElement>("[data-tree-toggle]");
			if (!arrow) return false;
			const box = arrow.getBoundingClientRect();
			return box.width > 0 && box.height > 0 && getComputedStyle(arrow).visibility !== "hidden";
		})
	);
}

/** The block rows of an open page: id, fold state, text. */
export function blockRows(
	pageId: string,
): Array<{ id: string; fold: string | null; text: string }> {
	const page = document.querySelector(`[data-tree-page="${pageId}"]`);
	if (!page) return [];
	return [...page.querySelectorAll<HTMLElement>("[data-block-id]")].map((row) => ({
		id: row.dataset.blockId ?? "",
		fold: row.dataset.fold ?? null,
		text: (row.textContent ?? "").trim(),
	}));
}

/** Preview lines of an open page (closed rows' one line). */
export function previews(pageId: string): string[] {
	const page = document.querySelector(`[data-tree-page="${pageId}"]`);
	return page
		? [...page.querySelectorAll<HTMLElement>("[data-fold-preview]")].map(
				(p) => p.dataset.foldOf ?? "",
			)
		: [];
}

export function count(selector: string): number {
	return document.querySelectorAll(selector).length;
}

export function click(selector: string): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) return false;
	element.click();
	return true;
}

/** Nothing is wider than the page (no sideways scrolling at a phone's width). */
export function overflowsX(): boolean {
	return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
}

export function text(): string {
	return document.body.innerText;
}

/**
 * The widest indentation of an open page's block rows: the page's own inset (the tree's levels)
 * plus a row's indent.
 */
export function maxIndent(pageId: string): number {
	const page = document.querySelector<HTMLElement>(`[data-tree-page="${pageId}"]`);
	if (!page) return -1;
	const inset = Number.parseFloat(getComputedStyle(page).paddingInlineStart) || 0;
	let max = inset;
	for (const row of page.querySelectorAll<HTMLElement>("[data-block-id]")) {
		const indent = row.firstElementChild as HTMLElement | null;
		max = Math.max(max, inset + (indent?.getBoundingClientRect().width ?? 0));
	}
	return max;
}

/** Open pages shown with their content, and those kept fresh by a subscription. */
export function openPages(): { shown: string[]; live: string[] } {
	const pages = [...document.querySelectorAll<HTMLElement>("[data-tree-page]")];
	return {
		shown: pages.map((p) => p.dataset.treePage ?? ""),
		live: pages.filter((p) => p.dataset.live !== undefined).map((p) => p.dataset.treePage ?? ""),
	};
}

/** The title of the focused element (keyboard navigation of the tree). */
export function focusedTitle(): string | null {
	const active = document.activeElement as HTMLElement | null;
	return active?.matches("[data-tree-title]") ? (active.textContent ?? "") : null;
}

/** Focus the title of the row titled `title`. */
export function focusTitle(title: string): boolean {
	const element = [...document.querySelectorAll<HTMLElement>("[data-tree-title]")].find(
		(e) => e.textContent === title,
	);
	element?.focus();
	return element !== undefined && document.activeElement === element;
}

/** Type into a textarea or input as a person would (React sees the change). */
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

export function activeInside(selector: string): boolean {
	const host = document.querySelector(selector);
	return !!host && host.contains(document.activeElement);
}
