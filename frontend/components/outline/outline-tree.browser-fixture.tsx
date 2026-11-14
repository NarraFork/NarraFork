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
import { requestTreeLocate, type TreeLocateTarget } from "./tree/tree-locate";

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
export function arrowsDrawn(within = "body"): boolean {
	const rows = [...document.querySelectorAll<HTMLElement>(`${within} [data-tree-node]`)];
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

/**
 * The tree holds only tree items; a group belongs to the tree item it is in, and holds tree
 * items (an open page's group holds the page).
 */
export function ariaOwnedWell(): boolean {
	const tree = document.querySelector("[role=tree]");
	if (!tree) return false;
	const items = (parent: Element) =>
		[...parent.children].every((child) => child.getAttribute("role") === "treeitem");
	if (!items(tree)) return false;
	for (const group of tree.querySelectorAll("[role=group]")) {
		const owner = group.parentElement;
		if (owner?.getAttribute("role") !== "treeitem") return false;
		const page = owner.querySelector(":scope > [data-tree-node]")?.getAttribute("data-tree-kind");
		if (page !== "page" && !items(group)) return false;
	}
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Readability F: what a row says, the search drawn as a tree, locating, scrolling
// ─────────────────────────────────────────────────────────────────────────────

/** What each space row says: its counts, its one line, whether it is marked read only. */
export function glance(): Array<{
	title: string;
	waiting: string | null;
	doing: string | null;
	readOnly: boolean;
	summary: string | null;
	/** What comes first in the row's end: `waiting`, `doing`, or neither. */
	first: string | null;
}> {
	return [...document.querySelectorAll<HTMLElement>("[data-tree-kind=space]")].map((row) => {
		const item = row.closest("[role=treeitem]");
		return {
			title: row.querySelector<HTMLElement>("[data-tree-title]")?.textContent ?? "",
			waiting: row.querySelector<HTMLElement>("[data-tree-count=waiting]")?.textContent ?? null,
			doing: row.querySelector<HTMLElement>("[data-tree-count=doing]")?.textContent ?? null,
			readOnly: row.querySelector("[data-tree-read-only]") !== null,
			summary:
				item?.querySelector<HTMLElement>(
					":scope > * [data-tree-summary], :scope > [data-tree-summary]",
				)?.textContent ?? null,
			first: row.querySelector<HTMLElement>("[data-tree-count]")?.dataset.treeCount ?? null,
		};
	});
}

/** The rows of the search drawn as a tree: level, kind, title, whether a hit, marked words. */
export function searchRows(): Array<{
	level: number;
	kind: string;
	title: string;
	hit: string | null;
	marks: string[];
}> {
	const tree = document.querySelector("[data-testid=outline-search-tree]");
	if (!tree) return [];
	return [...tree.querySelectorAll<HTMLElement>("[data-tree-node]")].map((row) => {
		const item = row.closest<HTMLElement>("[role=treeitem]");
		const snippet = item?.querySelector<HTMLElement>(":scope > [data-search-snippet]");
		return {
			level: Number(item?.getAttribute("aria-level") ?? 0),
			kind: row.dataset.treeKind ?? "",
			title: row.querySelector<HTMLElement>("[data-tree-title]")?.textContent ?? "",
			hit: row.dataset.searchHit ?? null,
			marks: [...row.querySelectorAll("mark"), ...(snippet?.querySelectorAll("mark") ?? [])].map(
				(mark) => mark.textContent ?? "",
			),
		};
	});
}

/** Choose a hit of the search (its title: "show in the tree"). */
export function chooseHit(blockId: string): boolean {
	const row = document.querySelector<HTMLElement>(`[data-search-hit="${blockId}"]`);
	const title = row?.querySelector<HTMLElement>("[data-tree-title]");
	title?.click();
	return !!title;
}

/** Whether the tree itself (not the search) is shown. */
export function treeShown(): boolean {
	const tree = document.querySelector<HTMLElement>("[data-testid=outline-tree]");
	return !!tree && !tree.hidden && tree.offsetParent !== null;
}

/** The located row, if one is marked: a block's id or a node's key, and whether it is in view. */
export function located(): { id: string; inView: boolean } | null {
	const row = document.querySelector<HTMLElement>("[data-located]");
	if (!row) return null;
	const box = row.getBoundingClientRect();
	return {
		id: row.dataset.blockId ?? row.dataset.treeNode ?? "",
		inView: box.top >= 0 && box.bottom <= window.innerHeight && box.height > 0,
	};
}

/** Whether a block's row is drawn in an open page. */
export function hasBlock(pageId: string, blockId: string): boolean {
	return blockRows(pageId).some((row) => row.id === blockId);
}

/** As a focused page asks for it: the request waits for the tree that mounts next. */
export function requestLocate(target: TreeLocateTarget): void {
	requestTreeLocate("page", target);
}

export function scrollY(): number {
	return Math.round(window.scrollY);
}

export function scrollToY(y: number): number {
	window.scrollTo(0, y);
	return Math.round(window.scrollY);
}

/** The first tree row at or below the top of the view: its key and where its top is. */
export function topRow(): { key: string; top: number } | null {
	for (const row of document.querySelectorAll<HTMLElement>(
		"[data-testid=outline-tree] [data-tree-node]",
	)) {
		const box = row.getBoundingClientRect();
		if (box.height > 0 && box.bottom > 0) {
			return { key: row.dataset.treeNode ?? "", top: Math.round(box.top) };
		}
	}
	return null;
}

/** The scroll anchor kept for the home tree of the outline page, as stored. */
export function storedAnchor(): string | null {
	return sessionStorage.getItem("narrafork_outline_tree_scroll:page:all");
}

/** The labels of a page's preview lines, by the block they belong to. */
export function previewLabels(pageId: string): Record<string, string> {
	const page = document.querySelector(`[data-tree-page="${pageId}"]`);
	const out: Record<string, string> = {};
	for (const line of page?.querySelectorAll<HTMLElement>("[data-fold-preview]") ?? []) {
		out[line.dataset.foldOf ?? ""] =
			line.querySelector<HTMLElement>("[data-fold-preview-label]")?.textContent ?? "";
	}
	return out;
}

/** Whether an open page says it shows only part of itself. */
export function partial(pageId: string): boolean {
	return document.querySelector(`[data-tree-page="${pageId}"] [data-tree-partial]`) !== null;
}

/** Any `:hover` rule in the page's stylesheets that names a part of the tree (there must be none). */
export function hoverRules(): string[] {
	const out: string[] = [];
	for (const sheet of document.styleSheets) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		for (const rule of rules) {
			const selector = (rule as CSSStyleRule).selectorText ?? "";
			if (
				selector.includes(":hover") &&
				/tree(Row|Title|Summary|Snippet|Hit|Meta|Note)/.test(selector)
			) {
				out.push(selector);
			}
		}
	}
	return out;
}
