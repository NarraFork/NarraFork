/**
 * Browser fixture of the forest (pageless outline, F1): the outline home, a space and a focused
 * block as the router-free view hosts them (`OutlineView`), against the test server of
 * `outline-forest.browser.test.ts` (the real outline routes on the isolated SQLite, and the
 * real block watch over a WebSocket). Navigation is recorded, not followed, unless `follow`.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type {
	ListenerHandle,
	ListenerOptions,
	MessageCallback,
} from "../../../lib/narrator-ws-manager";
import {
	type OutlineWatchTransport,
	setOutlineWatchTransport,
} from "../../../lib/outline-block-watch";
import { ensureTypographyCssVars } from "../../../lib/typography-css-vars";
import outlineEn from "../../../locales/en/outline.json";
import outlineZh from "../../../locales/zh-CN/outline.json";
import { OutlineView } from "../OutlineView";
import type { OutlineTarget } from "../outline-nav";
import { requestTreeLocate, type TreeLocateTarget } from "../tree/tree-locate";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { outline: outlineEn }, "zh-CN": { outline: outlineZh } },
	interpolation: { escapeValue: false },
});

/** The block watch over a plain WebSocket to the test server (JSON frames). */
class SocketTransport implements OutlineWatchTransport {
	private socket: WebSocket | null = null;
	private listeners = new Map<number, { types: string[]; callback: MessageCallback }>();
	private changes = new Set<(connected: boolean, reconnect: boolean) => void>();
	private next = 0;
	private opened = 0;
	readonly sent: Array<Record<string, unknown>> = [];
	readonly received: Array<Record<string, unknown>> = [];

	constructor(private readonly url: string) {
		this.connect();
	}

	private connect(): void {
		const socket = new WebSocket(this.url);
		this.socket = socket;
		socket.onopen = () => {
			this.opened++;
			for (const change of this.changes) change(true, this.opened > 1);
		};
		socket.onmessage = (event) => {
			const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
			this.received.push(frame);
			for (const listener of this.listeners.values()) {
				if (listener.types.includes(String(frame.type))) listener.callback(frame);
			}
		};
		socket.onclose = () => {
			if (this.socket !== socket) return;
			for (const change of this.changes) change(false, false);
		};
	}

	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	send(message: Record<string, unknown>): boolean {
		if (!this.connected) return false;
		this.sent.push(message);
		this.socket?.send(JSON.stringify(message));
		return true;
	}

	addListener(options: ListenerOptions, callback: MessageCallback): ListenerHandle {
		const id = ++this.next;
		this.listeners.set(id, { types: options.types ?? [], callback });
		return { _id: id };
	}

	removeListener(handle: ListenerHandle): void {
		this.listeners.delete(handle._id);
	}

	onConnectionChange(callback: (connected: boolean, reconnect: boolean) => void): () => void {
		this.changes.add(callback);
		return () => this.changes.delete(callback);
	}

	/** Drop the socket and connect again (a network blip). */
	reconnect(): void {
		const old = this.socket;
		this.socket = null;
		old?.close();
		for (const change of this.changes) change(false, false);
		this.connect();
	}
}

let root: Root | null = null;
let transport: SocketTransport | null = null;
const navigations: OutlineTarget[] = [];

export function ready(): boolean {
	return true;
}

function Host({
	target,
	follow,
	layout,
}: {
	target: OutlineTarget;
	follow: boolean;
	layout: "page" | "panel";
}) {
	const [at, setAt] = useState(target);
	return (
		<OutlineView
			target={at}
			onNavigate={(to) => {
				navigations.push(to);
				if (follow) setAt(to);
			}}
			layout={layout}
			startReading
		/>
	);
}

export async function open(options: {
	target: OutlineTarget;
	user: string;
	lang?: "en" | "zh-CN";
	scheme?: "light" | "dark";
	layout?: "page" | "panel";
	/** Navigations change what is shown (as a host would). */
	follow?: boolean;
	/** Without the block watch (no socket). */
	offline?: boolean;
}): Promise<void> {
	ensureTypographyCssVars();
	await i18n.changeLanguage(options.lang ?? "en");
	if (!transport && !options.offline) {
		transport = new SocketTransport(
			`${location.origin.replace(/^http/, "ws")}/ws?user=${encodeURIComponent(options.user)}`,
		);
		setOutlineWatchTransport(transport);
	}
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
						<Host
							target={options.target}
							follow={options.follow === true}
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

/** Frames of the block watch: what was sent and what arrived. */
export function watchFrames(): {
	sent: Array<Record<string, unknown>>;
	received: Array<Record<string, unknown>>;
} {
	return { sent: transport?.sent ?? [], received: transport?.received ?? [] };
}

export function reconnect(): void {
	transport?.reconnect();
}

function titleOf(row: HTMLElement): string {
	if (row.dataset.treeKind === "block") {
		return (
			row.querySelector<HTMLElement>("[data-forest-text]")?.firstElementChild?.textContent ?? ""
		).trim();
	}
	return row.querySelector<HTMLElement>("[data-tree-title]")?.textContent ?? "";
}

/** The rows drawn, as the reader sees them: key, kind, open, title, level. */
export function rows(): Array<{
	key: string;
	kind: string;
	open: boolean;
	title: string;
	level: number;
}> {
	return [
		...document.querySelectorAll<HTMLElement>(
			"[data-testid=outline-tree] [data-tree-node], [data-testid=outline-block-tree] [data-tree-node]",
		),
	].map((row) => ({
		key: row.dataset.treeNode ?? "",
		kind: row.dataset.treeKind ?? "",
		open: row.dataset.open === "true",
		title: titleOf(row),
		level: Number(row.closest("[role=treeitem]")?.getAttribute("aria-level") ?? 0),
	}));
}

function rowTitled(title: string): HTMLElement | undefined {
	return [...document.querySelectorAll<HTMLElement>("[data-tree-node]")].find(
		(r) => titleOf(r) === title,
	);
}

/** Use the arrow of the row titled `title` (`alt`: everything inside). False without one. */
export function toggle(title: string, alt = false): boolean {
	const arrow = rowTitled(title)?.querySelector<HTMLButtonElement>("button[data-tree-toggle]");
	if (!arrow) return false;
	arrow.dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: alt }));
	return true;
}

/** Every row has its arrow, drawn (not hover-only). */
export function arrowsDrawn(): boolean {
	const all = [...document.querySelectorAll<HTMLElement>("[data-tree-node]")];
	return (
		all.length > 0 &&
		all.every((row) => {
			const arrow = row.querySelector<HTMLElement>("[data-tree-toggle]");
			if (!arrow) return false;
			const box = arrow.getBoundingClientRect();
			return box.width > 0 && box.height > 0 && getComputedStyle(arrow).visibility !== "hidden";
		})
	);
}

/** Whether the row titled `title` has a real arrow (something under it) or the faint one. */
export function arrowOf(title: string): "arrow" | "leaf" | null {
	const row = rowTitled(title);
	if (!row) return null;
	return row.querySelector("button[data-tree-toggle]") ? "arrow" : "leaf";
}

/** The block rows drawn: id, fold state, text. */
export function blockRows(): Array<{ id: string; fold: string | null; text: string }> {
	return [...document.querySelectorAll<HTMLElement>("[data-block-id]")].map((row) => ({
		id: row.dataset.blockId ?? "",
		fold: row.dataset.fold ?? null,
		text: titleOf(row),
	}));
}

/** Preview lines drawn, by the block they belong to: their text and label. */
export function previews(): Record<string, { text: string; label: string }> {
	const out: Record<string, { text: string; label: string }> = {};
	for (const line of document.querySelectorAll<HTMLElement>("[data-fold-preview]")) {
		out[line.dataset.foldOf ?? ""] = {
			text: line.querySelector<HTMLElement>("[data-fold-preview-text]")?.textContent ?? "",
			label: line.querySelector<HTMLElement>("[data-fold-preview-label]")?.textContent ?? "",
		};
	}
	return out;
}

/** What the block lists say of themselves: rows in the model, the newest seq known. */
export function forests(): Array<{ space: string; rows: number; seq: number }> {
	return [...document.querySelectorAll<HTMLElement>("[data-testid=outline-forest-blocks]")].map(
		(list) => ({
			space: list.dataset.forestSpace ?? "",
			rows: Number(list.dataset.forestRows),
			seq: Number(list.dataset.forestSeq),
		}),
	);
}

/** The "more" rows drawn: their mode, parent and words. */
export function moreRows(): Array<{ mode: string; parent: string; text: string }> {
	return [...document.querySelectorAll<HTMLElement>("[data-forest-more]")].map((row) => ({
		mode: row.dataset.forestMore ?? "",
		parent: row.dataset.forestParent ?? "",
		text: (row.textContent ?? "").trim(),
	}));
}

/** Use the first drawn "more" row of a mode. */
export function useMore(mode: string): boolean {
	const button = document.querySelector<HTMLElement>(
		`[data-forest-more="${mode}"] [data-tree-more]`,
	);
	if (!button || (button as HTMLButtonElement).disabled) return false;
	button.click();
	return true;
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

export function dblclick(selector: string): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) return false;
	element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
	return true;
}

/** Nothing is wider than the page (no sideways scrolling at a phone's width). */
export function overflowsX(): boolean {
	return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
}

export function text(): string {
	return document.body.innerText;
}

/** Type into a textarea or input as a person would (React sees the change). */
export function type(selector: string, value: string): boolean {
	const element = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
	if (!element) return false;
	const proto =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
}

export function key(
	selector: string,
	name: string,
	mods: { ctrl?: boolean; alt?: boolean } = {},
): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) return false;
	element.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: name,
			bubbles: true,
			ctrlKey: mods.ctrl === true,
			altKey: mods.alt === true,
		}),
	);
	return true;
}

/** The rows of the search drawn as a tree: level, kind, title, whether a hit. */
export function searchRows(): Array<{
	level: number;
	kind: string;
	title: string;
	hit: string | null;
}> {
	const tree = document.querySelector("[data-testid=outline-search-tree]");
	if (!tree) return [];
	return [...tree.querySelectorAll<HTMLElement>("[data-tree-node]")].map((row) => ({
		level: Number(row.closest<HTMLElement>("[role=treeitem]")?.getAttribute("aria-level") ?? 0),
		kind: row.dataset.treeKind ?? "",
		title: row.querySelector<HTMLElement>("[data-tree-title]")?.textContent ?? "",
		hit: row.dataset.searchHit ?? null,
	}));
}

/** Choose a hit of the search (its title: "show in the tree"). */
export function chooseHit(blockId: string): boolean {
	const title = document
		.querySelector<HTMLElement>(`[data-search-hit="${blockId}"]`)
		?.querySelector<HTMLElement>("[data-tree-title]");
	title?.click();
	return !!title;
}

/** Whether the tree itself (not the search) is shown. */
export function treeShown(): boolean {
	const tree = document.querySelector<HTMLElement>("[data-testid=outline-tree]");
	return !!tree && !tree.hidden && tree.offsetParent !== null;
}

/** The located row, if one is marked: its block id, and whether it is in view. */
export function located(): { id: string; inView: boolean } | null {
	const row = document.querySelector<HTMLElement>("[data-located]");
	if (!row) return null;
	const box = row.getBoundingClientRect();
	return {
		id: row.dataset.blockId ?? "",
		inView: box.top >= 0 && box.bottom <= window.innerHeight && box.height > 0,
	};
}

/** As a focused view asks for it: the request waits for the tree that mounts next. */
export function requestLocate(target: TreeLocateTarget): void {
	requestTreeLocate("page", target);
}

/** The hits the quick switcher lists: block id and words. */
export function switcherHits(): Array<{ id: string; text: string }> {
	return [
		...document.querySelectorAll<HTMLElement>("[data-testid=outline-switcher] [role=option]"),
	].map((row) => ({
		id: row.dataset.block ?? "",
		text: (row.textContent ?? "").trim(),
	}));
}

/** Any `:hover` rule in the page's stylesheets that names a part of the tree's frame. */
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
				/tree(Row|Title|Summary|Snippet|Hit|Meta|Note)|toggle|bullet|foldAll|focusHandle|preview|_row_/i.test(
					selector,
				)
			) {
				out.push(selector);
			}
		}
	}
	return out;
}

/**
 * Scroll the page from top to bottom in steps, one per frame, and say how long the frames took
 * and how large the DOM got: the forest's rows are windowed, so neither grows with the tree.
 */
export async function measureScroll(steps: number): Promise<{
	frames: number;
	p50: number;
	p95: number;
	max: number;
	maxDom: number;
	maxRows: number;
	height: number;
	blank: number;
}> {
	const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
	const height = document.documentElement.scrollHeight - window.innerHeight;
	const times: number[] = [];
	let maxDom = 0;
	let maxRows = 0;
	let blank = 0;
	window.scrollTo(0, 0);
	let last = await frame();
	for (let i = 1; i <= steps; i++) {
		window.scrollTo(0, Math.round((height * i) / steps));
		const now = await frame();
		times.push(now - last);
		last = now;
		maxDom = Math.max(maxDom, document.getElementsByTagName("*").length);
		const drawn = document.querySelectorAll("[data-forest-row]");
		maxRows = Math.max(maxRows, drawn.length);
		// A frame in which no row is in the viewport would be a blank screen.
		let seen = false;
		for (const row of drawn) {
			const box = row.getBoundingClientRect();
			if (box.bottom > 0 && box.top < window.innerHeight) {
				seen = true;
				break;
			}
		}
		if (!seen) blank++;
	}
	const sorted = [...times].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
	return {
		frames: times.length,
		p50: at(0.5),
		p95: at(0.95),
		max: sorted.at(-1) ?? 0,
		maxDom,
		maxRows,
		height,
		blank,
	};
}

export function scrollToY(y: number): number {
	window.scrollTo(0, y);
	return Math.round(window.scrollY);
}

export function domSize(): number {
	return document.getElementsByTagName("*").length;
}

/** The rows of spaces as the reader glances at them: counts, one line, read only. */
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

export function scrollY(): number {
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

/** Focus the title of the row titled `title`. */
export function focusTitle(title: string): boolean {
	const element = rowTitled(title)?.querySelector<HTMLElement>("[data-tree-title]") ?? null;
	element?.focus();
	return !!element && document.activeElement === element;
}

/** The title of the row the focus is in ("" when none). */
export function activeRow(): string {
	const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
		"[data-tree-node]",
	);
	return row ? titleOf(row) : "";
}

/** Elements of each tree that Tab reaches (tabindex >= 0, not disabled), per tree. */
export function tabStops(): number[] {
	return [...document.querySelectorAll<HTMLElement>("[role=tree]")].map(
		(tree) =>
			[...tree.querySelectorAll<HTMLElement>("a[href], button, input, [tabindex]")].filter(
				(element) =>
					element.tabIndex >= 0 &&
					!(element as HTMLButtonElement).disabled &&
					!element.closest("[data-tree-keep]"),
			).length,
	);
}

/** The tasks the "in progress" list shows (its links' text). */
export function inProgressItems(): string[] {
	return [...document.querySelectorAll<HTMLElement>("[data-in-progress-item]")].map((item) =>
		(item.textContent ?? "").trim(),
	);
}

/** What the focus is on: its test id, its tree count kind, or its tag. */
export function activeControl(): string {
	const element = document.activeElement as HTMLElement | null;
	if (!element) return "";
	if (element.dataset.testid) return element.dataset.testid;
	if (element.dataset.treeCount) return `count:${element.dataset.treeCount}`;
	return element.tagName;
}

/** Type `value` into every field `selector` matches; how many. */
export function typeAll(selector: string, value: string): number {
	const fields = [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(selector)];
	for (const field of fields) {
		const proto =
			field instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	}
	return fields.length;
}
