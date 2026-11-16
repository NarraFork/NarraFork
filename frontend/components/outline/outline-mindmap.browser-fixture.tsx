/**
 * Browser fixture of the outline's two views (design §6.10, plan §10.2), against the test server
 * of `outline-mindmap.browser-harness.browser-fixture.ts` (the real outline routes and live
 * sessions). Two hosts of the real outline surface:
 *
 *   - `page`: the outline page as its route hosts it — `OutlineSurface` with the router's
 *     navigation (`useOutlineRouterNavigate`), the browser's history and the URL;
 *   - `panel`: the outline dock panel beside a session (`OutlineDockPanel` in a dockview under
 *     the session dock's provider), whose navigation is its params and its own history.
 *
 * A second person opens the bare live editor (`OutlineEditor`) in another browser context.
 * The live transport is a plain WebSocket that can be held (frames queue both ways).
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { decodeLiveFrame, LIVE_FRAME, type LiveFrame } from "@shared/outline-live-protocol";
import { headingMetrics, typographyMetrics } from "@shared/pretext-layout/pretext-fonts";
import { setTypography, type TypographySettings } from "@shared/pretext-layout/typography";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	type AnyRouter,
	createBrowserHistory,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import i18next from "i18next";
import type { Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { type OutlineOpener, useOutlineOpener } from "../../lib/outline-opener";
import { outlineRouterLink, useOutlineRouterNavigate } from "../../lib/outline-router";
import { parseOutlineBlockSearch } from "../../lib/outline-view";
import outlineEn from "../../locales/en/outline.json";
import outlineZh from "../../locales/zh-CN/outline.json";
import { DockviewSurface } from "../dockview";
import { dockPanelId } from "../narrator/dock/dock-panel-types";
import { NarratorDockProvider, useNarratorDockContext } from "../narrator/dock/NarratorDockContext";
import { OutlineDockPanel } from "../narrator/dock/OutlineDockPanel";
import { type EditSurface, liveEditSurfaces } from "./edit-surface";
import { indent, moveBlock, outdent, splitBlock } from "./editor/commands";
import { serializePM } from "./editor/convert";
import type { LiveClient, LiveTransport } from "./editor/live-client";
import { liveSessionsOn } from "./editor/live-sessions";
import { OutlineEditor } from "./editor/OutlineEditor";
import { overrideLiveTransportForTests } from "./editor/transport";
import { findBlockPos, type OutlineView } from "./editor/view";
import {
	bodySize,
	clearMeasureCache,
	frameWidth,
	measureStats,
	NODE,
	nodeSize,
} from "./mindmap/measure";
import type { MeasureRequest } from "./mindmap/measure.worker";
import { prewarmBodies, prewarmStats, setMeasureWorkerFactoryForTests } from "./mindmap/prewarm";
import { OutlineSurface } from "./OutlineSurface";
import { quickSwitcherIndexOf } from "./QuickSwitcher";
import { OutlineViewStates } from "./view-state";

const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	resources: { en: { outline: outlineEn }, "zh-CN": { outline: outlineZh } },
	react: { useSuspense: false },
});

class SocketTransport implements LiveTransport {
	connected = false;
	held = false;
	/** Tests: answer the next join with this refusal instead of the server's snapshot. */
	refuseNextJoin: string | null = null;
	private ws: WebSocket;
	private readonly frameListeners = new Set<(frame: LiveFrame) => void>();
	private readonly connListeners = new Set<(connected: boolean) => void>();
	private readonly handles = new Set<number>();
	private outQueue: Uint8Array[] = [];
	private inQueue: LiveFrame[] = [];

	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.ws.binaryType = "arraybuffer";
		this.ws.onopen = () => {
			this.connected = true;
			for (const l of this.connListeners) l(true);
		};
		this.ws.onclose = () => {
			this.connected = false;
			for (const l of this.connListeners) l(false);
		};
		this.ws.onmessage = (event) => {
			if (typeof event.data === "string") return;
			let frame = decodeLiveFrame(new Uint8Array(event.data as ArrayBuffer));
			if (!frame) return;
			if (this.refuseNextJoin && frame.kind === LIVE_FRAME.joined) {
				frame = {
					kind: LIVE_FRAME.closed,
					handle: frame.handle,
					n: 0,
					head: { code: this.refuseNextJoin },
					body: new Uint8Array(0),
				};
				this.refuseNextJoin = null;
			}
			if (this.held) this.inQueue.push(frame);
			else for (const l of this.frameListeners) l(frame);
		};
	}
	send(frame: Uint8Array): boolean {
		if (!this.connected) return false;
		if (this.held) {
			this.outQueue.push(frame.slice());
			return true;
		}
		this.ws.send(frame as Uint8Array<ArrayBuffer>);
		return true;
	}
	hold(on: boolean): void {
		this.held = on;
		if (on) return;
		const out = this.outQueue;
		this.outQueue = [];
		for (const f of out) this.send(f);
		const inn = this.inQueue;
		this.inQueue = [];
		for (const f of inn) for (const l of this.frameListeners) l(f);
	}
	onFrame(listener: (frame: LiveFrame) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}
	onConnectionChange(listener: (connected: boolean) => void): () => void {
		this.connListeners.add(listener);
		return () => this.connListeners.delete(listener);
	}
	allocateHandle(): number | null {
		for (let h = 1; h < 256; h++) {
			if (!this.handles.has(h)) {
				this.handles.add(h);
				return h;
			}
		}
		return null;
	}
	releaseHandle(handle: number): void {
		this.handles.delete(handle);
	}
}

let transport: SocketTransport | null = null;
let router: AnyRouter | null = null;
let dockApi: DockviewApi | null = null;
let opener: OutlineOpener | null = null;
let root: Root | null = null;
let bob: { client: LiveClient; view: () => OutlineView | null } | null = null;
let host: "page" | "panel" | "editor" | null = null;
const errors: string[] = [];

export function ready(): boolean {
	return true;
}

let scheme: "light" | "dark" | undefined;

function providers(children: React.ReactNode, queryClient: QueryClient) {
	return (
		<I18nextProvider i18n={instance}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider {...(scheme ? { forceColorScheme: scheme } : {})}>
					{children}
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>
	);
}

/** The outline page as its route hosts it: the URL is the focus, history is the browser's. */
function PageRoute() {
	const { spaceId, blockId } = pageRoute.useParams();
	const search = pageRoute.useSearch();
	const navigate = useOutlineRouterNavigate();
	return (
		<div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
			<OutlineSurface
				spaceId={spaceId}
				blockId={blockId}
				view={search.view}
				asOf={search.asOf}
				onNavigate={navigate}
				renderLink={outlineRouterLink}
				layout="panel"
			/>
		</div>
	);
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const pageRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/outline/$spaceId/$blockId",
	component: PageRoute,
	validateSearch: parseOutlineBlockSearch,
});

/** The session dock with an outline panel beside the chat (as `outline-dock` fixture). */
function DockSurface() {
	const dock = useNarratorDockContext();
	opener = useOutlineOpener();
	return (
		<div style={{ height: "100vh", width: "100vw" }}>
			<DockviewSurface
				apiRef={dock?.apiRef}
				components={{
					chat: (() => <div id="chat-panel" />) as React.FunctionComponent<IDockviewPanelProps>,
					outline: OutlineDockPanel as React.FunctionComponent<IDockviewPanelProps>,
				}}
				onReady={(api) => {
					dockApi = api;
					api.addPanel({
						id: dockPanelId("chat"),
						component: "chat",
						title: "Session",
						params: { panelType: "chat", narratorId: "n-fixture" },
					});
				}}
				defaultRenderer="always"
			/>
		</div>
	);
}

export interface OpenOptions {
	wsUrl: string;
	host: "page" | "panel";
	spaceId: string;
	blockId: string;
	/** The page's lens: everything (the default here) or the facts view. */
	lens?: "facts" | "all";
	/** The reader's language and colour scheme (English and light by default). */
	lang?: "en" | "zh-CN";
	scheme?: "light" | "dark";
	/** Open the page as of a commit (the read-only tree) instead of the live page. */
	asOf?: number;
}

let lens: "facts" | "all" = "all";

/** Mount a host of the outline surface on a page. */
export function open(options: OpenOptions): void {
	host = options.host;
	lens = options.lens ?? "all";
	scheme = options.scheme;
	if (options.lang) void instance.changeLanguage(options.lang);
	window.addEventListener("error", (e) => errors.push(String(e.message)));
	transport = new SocketTransport(options.wsUrl);
	overrideLiveTransportForTests(transport);
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(["settings"], { outline: { enabled: true } });
	if (options.host === "page") {
		const search = new URLSearchParams();
		if (lens === "all") search.set("view", "all");
		if (options.asOf !== undefined) search.set("asOf", String(options.asOf));
		const query = search.toString();
		window.history.replaceState(
			null,
			"",
			`/outline/${options.spaceId}/${options.blockId}${query ? `?${query}` : ""}`,
		);
		router = createRouter({
			routeTree: rootRoute.addChildren([pageRoute]),
			history: createBrowserHistory(),
		});
	} else {
		const dockRoot = createRootRoute({
			component: () => (
				<NarratorDockProvider narratorId="n-fixture">
					<DockSurface />
				</NarratorDockProvider>
			),
		});
		router = createRouter({
			routeTree: dockRoot,
			history: createMemoryHistory({ initialEntries: ["/narrators/n-fixture"] }),
		});
	}
	root = createRoot(document.getElementById("root") as HTMLElement);
	root.render(providers(<RouterProvider router={router} />, queryClient));
}

/** Panel host: open the place in an outline panel the way a tool card does. */
export function openPanel(spaceId: string, blockId: string): boolean {
	if (!opener) return false;
	return opener.open(
		{ spaceId, blockId, ...(lens === "all" ? { view: "all" as const } : {}) },
		{ newPanel: false },
	);
}

/** The second person: the bare live editor of a page (no outline page around it). */
export function openEditor(options: {
	wsUrl: string;
	pageId: string;
	spaceKey: string;
	canWrite: boolean;
}): void {
	host = "editor";
	transport = new SocketTransport(options.wsUrl);
	const queryClient = new QueryClient();
	root = createRoot(document.getElementById("root") as HTMLElement);
	flushSync(() => {
		root?.render(
			providers(
				<OutlineEditor
					pageId={options.pageId}
					focusId={options.pageId}
					spaceKey={options.spaceKey}
					canWrite={options.canWrite}
					lens="all"
					viewState={new OutlineViewStates().of(options.pageId)}
					transport={transport as LiveTransport}
					onFocus={() => {}}
					onUnavailable={(reason) => errors.push(`unavailable ${reason}`)}
					onClient={(client, view) => {
						bob = { client, view };
					}}
					premeasure={false}
				/>,
				queryClient,
			),
		);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading and driving
// ─────────────────────────────────────────────────────────────────────────────

export function surface(): EditSurface {
	const all = liveEditSurfaces();
	const s = all[all.length - 1];
	if (!s) throw new Error("no live surface");
	return s;
}

export function hasSurface(): boolean {
	const s = liveEditSurfaces().at(-1);
	return !!s && s.client.ready && s.client.status === "live";
}

export function client(): LiveClient {
	if (host === "editor") {
		if (!bob) throw new Error("editor not open");
		return bob.client;
	}
	return surface().client;
}

export function view(): OutlineView {
	if (host === "editor") {
		const v = bob?.view();
		if (!v) throw new Error("editor view not mounted");
		return v;
	}
	return surface().outline;
}

export function net(): SocketTransport {
	if (!transport) throw new Error("not open");
	return transport;
}

export function pageErrors(): string[] {
	return [...errors];
}

/** The view state's parts the acceptance compares (and the view). */
export function state() {
	surface().captureCaret();
	const s = surface().state.snapshot();
	return {
		view: s.view,
		focus: s.focus,
		collapsed: s.collapsed,
		expanded: s.expanded,
		caret: s.caret,
		blocks: s.blocks,
		layout: s.layout,
		anchor: s.anchor,
	};
}

export function setView(kind: "outline" | "map"): void {
	surface().setView(kind);
}

export function setLayout(dir: "right" | "down"): void {
	surface().setLayout(dir);
}

export function focusBlock(id: string): boolean {
	return surface().focusBlock(id);
}

/** Animations running in the editor's frame (the views' own; not tooltips or dock chrome). */
export function frameAnimations(): number {
	return surface().frame.getAnimations({ subtree: true }).length;
}

export function animating(): boolean {
	return surface().animating;
}

export function log() {
	return surface().log.map((e) => ({ ...e }));
}

export function mapState() {
	const m = surface().map;
	return {
		active: m.active,
		root: m.rootId,
		selected: m.selected,
		editing: m.editing?.id ?? null,
		tx: m.tx,
		ty: m.ty,
		scale: m.scale,
		nodesInDom: m.els.size,
	};
}

export function mapTree(): Array<{ id: string; parent: string | null }> {
	const m = surface().map;
	m.flush();
	return m.order.map((id) => ({ id, parent: m.info.get(id)?.parent ?? null }));
}

export function mapSelect(id: string): void {
	const m = surface().map;
	m.flush();
	m.select(id);
}

export function mapEdit(id: string, caret: number | "end" = "end"): void {
	const m = surface().map;
	m.flush();
	m.select(id, { reveal: true });
	m.enterEdit(id, caret);
}

export function mapFlush(): void {
	surface().map.flush();
}

export function mapFit(): void {
	surface().map.fit();
}

/** A map node's rectangle in the page's coordinates (null: no DOM). */
export function nodeRect(id: string): { x: number; y: number; w: number; h: number } | null {
	const m = surface().map;
	m.flush();
	const el = m.el(id);
	if (!el) {
		m.materialize([id]);
	}
	const e = m.el(id);
	if (!e) return null;
	const r = e.getBoundingClientRect();
	return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Where an anchor block's body is relative to the frame (outline row or map node). */
export function anchorScreen(id: string): { x: number; y: number } | null {
	const s = surface();
	if (s.state.view === "map") {
		const el = s.map.el(id)?.querySelector(".mm-body");
		if (!el) return s.map.bodyScreen(id);
		const fr = s.frame.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		return { x: r.left - fr.left, y: r.top - fr.top };
	}
	return s.rowPos(id);
}

/** Where keyboard focus is: map-stage, map-editor, outline, or something else. */
export function focusWhere(): string {
	const s = surface();
	const a = document.activeElement;
	if (a === s.map.stage) return "map-stage";
	if (s.map.editing && s.map.editing.view.pm.dom === a) return "map-editor";
	if (s.outline.pm.dom === a) return "outline";
	return (a as HTMLElement | null)?.className ?? String(a);
}

/** The block tree as the client holds it, without ids: [text, task, children]. */
export type TreeNode = [string, string | null, TreeNode[]];
export function blockTree(rootId?: string): TreeNode[] {
	const c = client();
	const walk = (id: string): TreeNode[] =>
		c.visible.children(id).map((k) => [c.textOf(k), c.visible.get(k)?.task ?? null, walk(k)]);
	return walk(rootId ?? c.pageId);
}

/** The page as an indented outline (the client's view). */
export function outline(): string {
	return client().outline(client().pageId);
}

export function text(id: string): string {
	return client().textOf(id);
}

export function kids(id: string): string[] {
	return client().visible.children(id);
}

/** Ids of blocks whose text contains `needle`. */
export function idOf(needle: string): string | null {
	const c = client();
	for (const b of c.visible.blocks.values())
		if (!b.deleted && c.textOf(b.id).includes(needle)) return b.id;
	return null;
}

/** Wait until nothing local waits to be sent or acknowledged. */
export async function idle(timeoutMs = 5000): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const c = client();
		if (c.status === "live" && c.pending.length === 0 && c.quiet) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return false;
}

/** Put the outline's cursor at a block offset (-1: end) and focus the outline. */
export function caret(blockId: string, offset = -1, head?: number): boolean {
	const v = view();
	if (head === undefined) return v.focusBlock(blockId, offset);
	v.applySelection({
		anchor: { blockId, offset },
		head: { blockId, offset: head },
		view: v,
	});
	v.pm.focus();
	return true;
}

/**
 * A programmatic caret ready for native keyboard selection. ProseMirror schedules a DOM-selection
 * repair while handling focus; native Shift+Down can otherwise run before that repair, and lose
 * its new DOM selection before selectionchange reaches the editor. Wait for the callbacks actually
 * scheduled by this focus, not a guessed delay or a private ProseMirror field.
 */
export async function caretReady(blockId: string, offset = -1, timeoutMs = 5000): Promise<boolean> {
	const dom = view().pm.dom;
	const original = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout };
	const schedule: Window["setTimeout"] = original.setTimeout;
	const cancel: Window["clearTimeout"] = original.clearTimeout;
	const pending = new Map<number, () => void>();
	const tasks: Promise<void>[] = [];
	let deadline: number | undefined;
	const capture = () => {
		window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
			if (typeof callback !== "function") return schedule.call(window, callback, delay, ...args);
			let finish = () => {};
			tasks.push(
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
			);
			const id = schedule.call(
				window,
				() => {
					try {
						callback(...args);
					} finally {
						pending.delete(id);
						finish();
					}
				},
				delay,
			);
			pending.set(id, finish);
			return id;
		}) as typeof window.setTimeout;
		window.clearTimeout = ((id?: number) => {
			cancel.call(window, id);
			if (id !== undefined) {
				pending.get(id)?.();
				pending.delete(id);
			}
		}) as typeof window.clearTimeout;
	};
	dom.addEventListener("focus", capture, { capture: true, once: true });
	try {
		let placed: boolean;
		try {
			placed = caret(blockId, offset);
		} finally {
			dom.removeEventListener("focus", capture, true);
			// Only synchronous focus setup is captured; later work uses the exact original scheduler.
			window.setTimeout = original.setTimeout;
		}
		await Promise.race([
			Promise.all(tasks),
			new Promise<never>((_, reject) => {
				deadline = schedule.call(
					window,
					() => reject(new Error("outline focus setup did not finish")),
					timeoutMs,
				);
			}),
		]);
		return placed && view().pm.hasFocus();
	} finally {
		window.setTimeout = original.setTimeout;
		window.clearTimeout = original.clearTimeout;
		if (deadline !== undefined) cancel.call(window, deadline);
	}
}

export function selection() {
	const sel = view().captureSel();
	return sel ? { anchor: sel.anchor, head: sel.head } : null;
}

/** The outline document as text (what the editor shows). */
export function viewOutline(): string {
	const lines: string[] = [];
	const walk = (node: PMNode, depth: number) => {
		node.forEach((child) => {
			if (child.type.name !== "block") return;
			const task = child.attrs.task ? `[${child.attrs.task}] ` : "";
			const body = serializePM(child.child(0))
				.split("\n")
				.join(`\n${"  ".repeat(depth + 1)}`);
			lines.push(`${"  ".repeat(depth)}- ${task}${body}`);
			if (child.childCount > 1) walk(child.child(1), depth + 1);
		});
	};
	const r = view().pm.state.doc.child(0);
	if (r.childCount > 1) walk(r.child(1), 0);
	return lines.join("\n");
}

/** Insert text through the editor at a block offset (another person typing). */
export function insertAt(blockId: string, offset: number, text: string): boolean {
	const v = view();
	const pos = v.pointToPos(v.pm.state.doc, { blockId, offset });
	if (pos == null) return false;
	v.pm.dispatch(v.pm.state.tr.insertText(text, pos));
	return true;
}

const COMMANDS = {
	moveUp: (v: OutlineView) => moveBlock(v, -1),
	moveDown: (v: OutlineView) => moveBlock(v, 1),
	indent: (v: OutlineView) => indent(v),
	outdent: (v: OutlineView) => outdent(v),
	split: (v: OutlineView) => splitBlock(v),
} as const;

/** Run an outline command with the cursor at a block offset (another person's keystroke). */
export function cmd(name: keyof typeof COMMANDS, blockId: string, offset = 0): boolean {
	const v = view();
	const pos = v.pointToPos(v.pm.state.doc, { blockId, offset });
	if (pos == null) return false;
	v.pm.updateState(
		v.pm.state.apply(
			v.pm.state.tr.setSelection(TextSelection.create(v.pm.state.doc, pos)).setMeta("remote", true),
		),
	);
	return COMMANDS[name](v)(v.pm.state, (tr) => v.pm.dispatch(tr));
}

export function deleteBlock(id: string): void {
	view().deleteBlocks([id]);
}

/** The map node editor's text, selection head and whether it is composing. */
export function nodeEditor(): {
	text: string;
	head: { blockId: string; offset: number } | null;
	composing: boolean;
} | null {
	const ed = surface().map.editing;
	if (!ed) return null;
	const s = ed.view.captureSel();
	return {
		text: ed.view.pm.state.doc.textContent,
		head: s ? { blockId: s.head.blockId, offset: s.head.offset } : null,
		composing: ed.view.pm.composing,
	};
}

/** Mark the node editor's block DOM, to tell later whether it was replaced. */
export function markNodeDom(): boolean {
	const ed = surface().map.editing;
	const el = ed?.view.pm.dom.querySelector(`[data-id="${ed.id}"]`) as
		| (HTMLElement & { __mark?: number })
		| null;
	if (!el) return false;
	el.__mark = 1;
	return true;
}

export function nodeDomKept(): boolean {
	const ed = surface().map.editing;
	const el = ed?.view.pm.dom.querySelector(`[data-id="${ed.id}"]`) as
		| (HTMLElement & { __mark?: number })
		| null;
	return el?.__mark === 1;
}

/** The text a block's node editor's document shows vs. the static node (DOM). */
export function nodeText(id: string): string {
	return surface().map.el(id)?.textContent ?? "";
}

/** Breadcrumbs: every crumb's text (the ancestors of what is focused, never its own title). */
export function crumbs(): string[] {
	return [
		...document.querySelectorAll("[data-testid=outline-surface] [data-testid=outline-crumbs] a"),
	].map((el) => el.textContent?.trim() ?? "");
}

export function clickCrumb(text: string): boolean {
	const a = [
		...document.querySelectorAll("[data-testid=outline-surface] [data-testid=outline-crumbs] a"),
	].find((el) => el.textContent?.trim() === text) as HTMLElement | undefined;
	if (!a) return false;
	a.click();
	return true;
}

export function location(): string {
	return window.location.pathname;
}

export function goBack(): void {
	window.history.back();
}

export function goForward(): void {
	window.history.forward();
}

/** Panel host: put another panel in front of the outline panel (in its group): it is hidden. */
export function coverOutlinePanel(): boolean {
	const p = dockApi?.panels.find(
		(panel) => (panel.params as Record<string, unknown>)?.panelType === "outline",
	);
	if (!dockApi || !p) return false;
	dockApi.addPanel({
		id: "cover-panel",
		component: "chat",
		title: "Cover",
		params: { panelType: "chat", narratorId: "n-fixture" },
		position: { referenceGroup: p.group },
	});
	return !p.api.isVisible;
}

/** Panel host: bring the outline panel to the front of its group again (shown). */
export function showOutlinePanel(): boolean {
	const p = dockApi?.panels.find(
		(panel) => (panel.params as Record<string, unknown>)?.panelType === "outline",
	);
	if (!p) return false;
	p.api.setActive();
	return p.api.isVisible;
}

/**
 * The unsaved-text notice on screen: its texts and why, per entry (null when none is shown; a
 * hidden panel's is not).
 */
export function unsavedNotice(): { texts: string[]; reasons: string[] } | null {
	const notice = [
		...document.querySelectorAll<HTMLElement>("[data-testid=outline-unsaved-notice]"),
	].find((el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
	if (!notice) return null;
	const entries = [...notice.querySelectorAll<HTMLElement>("[data-testid=outline-unsaved-entry]")];
	return {
		texts: entries.map(
			(e) => e.querySelector("[data-testid=outline-unsaved-text]")?.textContent ?? "",
		),
		reasons: entries.map((e) => e.dataset.reason ?? ""),
	};
}

/** The surface on screen: shown from its HTTP read, live, or not shown yet. */
export function shownFrom(): "none" | "seed" | "live" {
	const s = liveEditSurfaces().at(-1);
	if (!s) return "none";
	return s.client.ready ? "live" : s.client.seeded ? "seed" : "none";
}

/** The "connecting" badge: shown, and how often it nudged (a structural key refused). */
export function connectingBadge(): { shown: boolean; nudges: number } {
	const el = document.querySelector("[data-testid=outline-connecting]") as HTMLElement | null;
	return { shown: !!el, nudges: Number(el?.dataset.nudge ?? 0) };
}

/** Mark the DOM a later check expects to be the very same (no re-render, no flash). */
export function markShown(ids: string[]): number {
	const s = surface();
	let n = 0;
	for (const id of ids) {
		const row = s.frame.querySelector(`.nf-outline-scroller .ob-block[data-id="${id}"]`);
		if (row) {
			(row as HTMLElement & { __nfMark?: boolean }).__nfMark = true;
			n++;
		}
		const node = s.map.els.get(id)?.el;
		if (node) {
			(node as HTMLElement & { __nfMark?: boolean }).__nfMark = true;
			n++;
		}
	}
	return n;
}

/** Which of the marked rows and nodes are still the same elements. */
export function shownKept(ids: string[]): { rows: number; nodes: number } {
	const s = surface();
	let rows = 0;
	let nodes = 0;
	for (const id of ids) {
		const row = s.frame.querySelector(`.nf-outline-scroller .ob-block[data-id="${id}"]`);
		if ((row as (HTMLElement & { __nfMark?: boolean }) | null)?.__nfMark) rows++;
		const node = s.map.els.get(id)?.el as (HTMLElement & { __nfMark?: boolean }) | undefined;
		if (node?.__nfMark) nodes++;
	}
	return { rows, nodes };
}

/** Switch views and time it: the synchronous part and the longest frame within 600 ms. */
export async function timedSetView(
	kind: "outline" | "map",
): Promise<{ syncMs: number; maxFrameMs: number; wasCold: boolean }> {
	const s = surface();
	const wasCold = s.scroller.classList.contains("nf-outline-cold");
	recordFrames(true);
	await new Promise((r) => requestAnimationFrame(() => r(null)));
	const t0 = performance.now();
	s.setView(kind);
	const syncMs = performance.now() - t0;
	await new Promise((r) => setTimeout(r, 600));
	const f = recordFrames(false);
	const gaps = f.slice(1).map((t, i) => t - (f[i] as number));
	return { syncMs, maxFrameMs: Math.max(0, ...gaps), wasCold };
}

/** The outline behind the map is cold (not built or laid out since the page arrived). */
export function outlineCold(): boolean {
	return surface().scroller.classList.contains("nf-outline-cold");
}

/** The map's viewport (translation and scale). */
export function mapViewport(): { tx: number; ty: number; scale: number } {
	const m = surface().map;
	return { tx: m.tx, ty: m.ty, scale: m.scale };
}

/** Panel host: the outline panel's params. */
export function panelParams(): Record<string, unknown> | null {
	const p = dockApi?.panels.find(
		(panel) => (panel.params as Record<string, unknown>)?.panelType === "outline",
	);
	return p ? { ...(p.params as Record<string, unknown>) } : null;
}

export function clickTestId(id: string): boolean {
	const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
	if (!el || (el as HTMLButtonElement).disabled) return false;
	el.click();
	return true;
}

/** Click the toolbar's view switch (outline or map). */
export function clickView(kind: "outline" | "map"): boolean {
	const label = [...document.querySelectorAll("[data-testid=outline-view-switch] label")].find(
		(l) => l.textContent?.trim() === (kind === "map" ? "Mind map" : "Outline"),
	) as HTMLElement | undefined;
	if (!label) return false;
	label.click();
	return true;
}

/** Map statistics: layout times and measuring. */
export function mapStats() {
	const m = surface().map;
	return {
		layouts: [...m.stats.layouts],
		treeMs: [...m.stats.treeMs],
		measureMs: [...m.stats.measureMs],
		renders: [...m.stats.renders],
		nodesInDom: m.stats.nodesInDom,
		provisional: [...m.info.values()].filter((inf) => inf.provisional).length,
		measure: { ...measureStats },
		prewarm: { ...prewarmStats },
	};
}

/** How far measured node heights are from the DOM's (pretext vs. layout). */
export function nodeAccuracy(): {
	checked: number;
	maxDiffH: number;
	overH: number;
	/** Most a node's frame (arrow, bullet, checkbox) is drawn off the width measured for it. */
	maxDiffFrame: number;
	/** Nodes whose body the frame pushed past the node's padding (more than half a pixel). */
	overFrame: number;
} {
	const m = surface().map;
	let checked = 0;
	let maxDiffH = 0;
	let overH = 0;
	let maxDiffFrame = 0;
	let overFrame = 0;
	for (const [id, ne] of m.els) {
		if (m.editing?.id === id || id.startsWith("\u0000")) continue;
		const inf = m.info.get(id);
		if (!inf) continue;
		const predicted = nodeSize(bodySize(inf.content), !!inf.task).h;
		const box = ne.el.getBoundingClientRect();
		const actual = box.height / m.scale;
		const d = Math.abs(predicted - actual);
		checked++;
		if (d > maxDiffH) maxDiffH = d;
		if (d > 1) overH++;
		const frame = ne.g.el.getBoundingClientRect().width / m.scale;
		const dFrame = Math.abs(frame - frameWidth(!!inf.task));
		if (dFrame > maxDiffFrame) maxDiffFrame = dFrame;
		const right = (box.right - ne.body.getBoundingClientRect().right) / m.scale;
		if (right < NODE.padX + NODE.border - 0.5) overFrame++;
	}
	return {
		checked,
		maxDiffH: +maxDiffH.toFixed(2),
		overH,
		maxDiffFrame: +maxDiffFrame.toFixed(2),
		overFrame,
	};
}

/**
 * How far each frame icon (the checkbox, a question's mark, the folding arrow: inline SVG) sits
 * off the middle of its block's first line box, in the outline or in the map's nodes, in CSS px:
 * the icons are centred on the first line, a heading's included.
 */
export function frameOffsets(
	where: "outline" | "map",
): Array<{ id: string; part: string; heading: boolean; off: number }> {
	const map = where === "map" ? surface().map : null;
	const scale = map?.scale ?? 1;
	const blocks = map
		? [...document.querySelectorAll<HTMLElement>(".mm-node:not(.mm-more-node)")]
		: [...document.querySelectorAll<HTMLElement>(".nf-outline-scroller .ob-block")];
	const out: Array<{ id: string; part: string; heading: boolean; off: number }> = [];
	for (const block of blocks) {
		const first = block.querySelector<HTMLElement>(
			map ? ":scope > .mm-body > :first-child" : ":scope > .ob-content > :first-child",
		);
		const gutter = block.querySelector<HTMLElement>(":scope > .ob-gutter");
		if (!first || !gutter || getComputedStyle(gutter).display === "none") continue;
		const top = first.getBoundingClientRect().top;
		const line = Number.parseFloat(getComputedStyle(first).lineHeight);
		for (const svg of gutter.querySelectorAll("svg")) {
			const r = svg.getBoundingClientRect();
			if (!r.height) continue;
			out.push({
				id: block.dataset.id ?? "",
				part: svg.parentElement?.className ?? "",
				heading: /^H\d$/.test(first.tagName),
				off: +((r.top + r.height / 2 - top) / scale - line / 2).toFixed(2),
			});
		}
	}
	return out;
}

export function prewarmDone(): Promise<{ posted: number; done: number; wallMs: number }> {
	return surface()
		.prewarmDone.then(() => ({ ...prewarmStats }))
		.catch(() => ({ ...prewarmStats }));
}

export function switcherIndexStats() {
	return { ...quickSwitcherIndexOf(surface()).stats };
}

/** The quick switcher's rows: block, how it matched, local or not. */
export function switcherRows(): Array<{ id: string; via: string; local: boolean }> {
	return [...document.querySelectorAll("[data-testid=outline-switcher] [role=option]")].map(
		(el) => ({
			id: (el as HTMLElement).dataset.block ?? "",
			via: (el as HTMLElement).dataset.via ?? "",
			local: (el as HTMLElement).dataset.local === "true",
		}),
	);
}

export function switcherOpen(): boolean {
	return !!document.querySelector("[data-testid=outline-switcher]");
}

export function liveSessions() {
	return transport ? liveSessionsOn(transport).map(({ pageId, refs }) => ({ pageId, refs })) : [];
}

export function nodeGeometry() {
	return { ...NODE };
}

// ─────────────────────────────────────────────────────────────────────────────
// Typography (外观 · 排版): the outline paints with the conversation's values
// ─────────────────────────────────────────────────────────────────────────────

/** Page host: show the page as of a commit (the read-only tree), as the timeline does. */
export function showAsOf(seq: number): void {
	void router?.navigate({
		to: window.location.pathname,
		search: { view: "all", asOf: seq },
	} as never);
}

/** Explicitly warm the current typography in the Worker before exact-layout assertions. */
export async function mapTypographySettled(): Promise<void> {
	await surface().prewarm();
	surface().map.typographySettled();
	surface().map.flush();
}

/** Whether the map still treats the typography as moving (off-screen sizes kept). */
export function mapTypographyPending(): boolean {
	return surface().map.typographyPending;
}

/** Drawn nodes whose layout slot is not their drawn height (a stale size: overlap or a gap). */
export function mapSlotMismatches(): number {
	const m = surface().map;
	let mismatches = 0;
	for (const [id, ne] of m.els) {
		if (m.editing?.id === id || id.startsWith("\u0000")) continue;
		const inf = m.info.get(id);
		if (!inf) continue;
		const drawn = ne.el.getBoundingClientRect().height / m.scale;
		if (Math.abs(drawn - inf.node.h) > 1) mismatches++;
	}
	return mismatches;
}

let heldMeasurements: Array<() => void> = [];
let postedMeasureKeys: string[] = [];

/** Controlled isolated replies let browser tests release capacity one wave at a time. */
export function controlMeasureWorker(omitFirst = false): void {
	heldMeasurements = [];
	postedMeasureKeys = [];
	let omitted = false;
	setMeasureWorkerFactoryForTests(() => {
		const port = {
			onmessage: null as Worker["onmessage"],
			onerror: null as Worker["onerror"],
			postMessage(request: MeasureRequest) {
				postedMeasureKeys.push(...request.items.map((it) => it.key));
				const out = request.items
					.filter(() => {
						if (!omitFirst || omitted) return true;
						omitted = true;
						return false;
					})
					.map((it) => [it.key, 200, 24]);
				heldMeasurements.push(() =>
					port.onmessage?.call(
						port as unknown as Worker,
						new MessageEvent("message", { data: { id: request.id, out, ms: 0 } }),
					),
				);
			},
			terminate() {
				heldMeasurements = [];
			},
		};
		return port as unknown as Worker;
	});
	clearMeasureCache();
}

export function controlledMeasureState() {
	return {
		waiting: heldMeasurements.length,
		posted: postedMeasureKeys.length,
		unique: new Set(postedMeasureKeys).size,
	};
}

export function releaseMeasurements(): void {
	for (const reply of heldMeasurements.splice(0)) reply();
}

export function occupyMeasureBudget(): void {
	void prewarmBodies(
		Array.from({ length: 30 }, (_, i) => ({
			content: `outside-${i}${"y".repeat(32_000)}`,
			labelOf: (ref: string, label: string | null) => label ?? ref,
		})),
	);
}

/** A measuring Worker that takes requests and never answers (hung, or very slow). */
export function hangWorker(): void {
	setMeasureWorkerFactoryForTests(
		() => ({ postMessage() {}, terminate() {} }) as unknown as Worker,
	);
}

/** Fault injection before requests are posted; no production fallback entry is exposed. */
export function failWorker(mode: "construct" | "send" | "error" | "partial"): void {
	setMeasureWorkerFactoryForTests(() => {
		if (mode === "construct") throw new Error("injected creation failure");
		const inner =
			mode === "partial"
				? new Worker(new URL("./mindmap/measure.worker.ts", import.meta.url), { type: "module" })
				: null;
		const port = {
			onmessage: null as Worker["onmessage"],
			onerror: null as Worker["onerror"],
			postMessage(message: unknown) {
				if (mode === "send") throw new Error("injected send failure");
				if (mode === "error")
					queueMicrotask(() => port.onerror?.call(inner as Worker, new ErrorEvent("error")));
				else inner?.postMessage(message);
			},
			terminate() {
				inner?.terminate();
			},
		};
		if (inner)
			inner.onmessage = (event) => {
				const packet = event.data;
				const out = packet.out.slice(0, 1);
				port.onmessage?.call(inner, new MessageEvent("message", { data: { ...packet, out } }));
			};
		return port as unknown as Worker;
	});
	clearMeasureCache();
}

/** Restore the isolated executor and wait for its exact sizes (including a recovery repaint). */
export async function restoreWorker(): Promise<void> {
	setMeasureWorkerFactoryForTests(
		() => new Worker(new URL("./mindmap/measure.worker.ts", import.meta.url), { type: "module" }),
	);
	await surface().prewarm();
	surface().map.flush();
}

/** Set the reader's typography, as the 外观 panel's sliders do (the variables follow). */
export function applyTypography(next: Partial<TypographySettings>): void {
	setTypography(next);
}

/** What the conversation measures each role with (the expected computed styles). */
export function expectedTypography() {
	const m = typographyMetrics();
	const h = (level: 1 | 2 | 3) => {
		const hm = headingMetrics(level);
		return { size: hm.size, line: hm.lineHeight, spacing: hm.letterSpacing };
	};
	return {
		body: { size: m.size.sm, line: m.line.body, spacing: m.letterSpacing.body },
		xs: { size: m.size.xs, line: m.line.xs },
		code: { size: m.size.xs },
		codeBlock: { size: m.codeSize, line: m.line.code },
		h1: h(1),
		h2: h(2),
		h3: h(3),
	};
}

/** Computed font size, line height and letter spacing (px) of the first match. */
export function computedType(selector: string): {
	size: number;
	line: number;
	spacing: number;
	height: number;
} | null {
	const el = document.querySelector(selector);
	if (!el) return null;
	const cs = getComputedStyle(el);
	const px = (v: string) => (v === "normal" ? 0 : Number.parseFloat(v));
	return {
		size: px(cs.fontSize),
		line: px(cs.lineHeight),
		spacing: px(cs.letterSpacing),
		height: el.getBoundingClientRect().height,
	};
}

/**
 * Mind-map nodes whose text does not fit the box measured for it: drawn wider than its body
 * (a line the browser could not break where pretext did) or taller than measured.
 */
export function nodeOverflow(): Array<{ id: string; overW: number; overH: number }> {
	const m = surface().map;
	const out: Array<{ id: string; overW: number; overH: number }> = [];
	for (const [id, ne] of m.els) {
		if (m.editing?.id === id || id.startsWith("\u0000")) continue;
		const body = ne.body;
		const overW = body.scrollWidth - body.clientWidth;
		const overH = ne.el.scrollHeight - ne.el.clientHeight;
		if (overW > 0 || overH > 0) out.push({ id, overW, overH });
	}
	return out;
}

export { findBlockPos };

// ─────────────────────────────────────────────────────────────────────────────
// Measuring (performance runs: numbers are logged, never asserted)
// ─────────────────────────────────────────────────────────────────────────────

/** No Worker: the cold first switch uses clipped plain-text placeholders. */
export function disableWorker(): void {
	setMeasureWorkerFactoryForTests(null);
	clearMeasureCache();
}

/** After the next frame is painted. */
export function afterPaint(): Promise<void> {
	return new Promise((resolve) =>
		requestAnimationFrame(() => {
			const ch = new MessageChannel();
			ch.port1.onmessage = () => resolve();
			ch.port2.postMessage(0);
		}),
	);
}

const frames: number[] = [];
let recording = false;
/** Record every frame's time while on (rAF loop). */
export function recordFrames(on: boolean): number[] {
	if (on && !recording) {
		frames.length = 0;
		recording = true;
		const loop = () => {
			frames.push(performance.now());
			if (recording) requestAnimationFrame(loop);
		};
		requestAnimationFrame(loop);
	}
	if (!on) recording = false;
	return [...frames];
}

/**
 * Switch views (or direction) and resolve when the switch's second step has run and its frame
 * is painted: { sync: the call's own time, shown: until the step ran, painted }.
 */
export async function switchToPaint(op: {
	view?: "outline" | "map";
	layout?: "right" | "down";
}): Promise<{ sync: number; shown: number; painted: number }> {
	const s = surface();
	const n0 = s.log.length;
	const t0 = performance.now();
	if (op.view) s.setView(op.view);
	if (op.layout) s.setLayout(op.layout);
	const sync = performance.now() - t0;
	for (let i = 0; i < 200 && s.log.length === n0; i++) await afterPaint();
	const shown = performance.now() - t0;
	await afterPaint();
	return { sync, shown, painted: performance.now() - t0 };
}

const latencies: Array<{ key: string; ms: number }> = [];
let latencyOn = false;
/** Key-down to the next painted frame, for keys pressed in the editor's frame. */
export function recordKeyLatency(on: boolean): Array<{ key: string; ms: number }> {
	const frame = surface().frame;
	if (on && !latencyOn) {
		latencyOn = true;
		latencies.length = 0;
		frame.addEventListener(
			"keydown",
			(ev) => {
				if (!latencyOn) return;
				const t0 = performance.now();
				void afterPaint().then(() => latencies.push({ key: ev.key, ms: performance.now() - t0 }));
			},
			true,
		);
	}
	if (!on) latencyOn = false;
	return [...latencies];
}

/** Scroll the outline so a block sits in the middle of the frame. */
export function centerRow(id: string): boolean {
	const s = surface();
	const el = s.rowBody(id);
	if (!el) return false;
	const fr = s.frame.getBoundingClientRect();
	const r = el.getBoundingClientRect();
	s.scroller.scrollTop += r.top - fr.top - fr.height / 2;
	return true;
}

/**
 * The focused block shown in the surface on screen: the read-only view (seeded from the HTTP
 * read) or the live one; in the outline its row is drawn, in the map its node.
 */
export function focusShown(want: string): boolean {
	const s = liveEditSurfaces().at(-1);
	if (!s || !(s.client.ready || s.client.seeded)) return false;
	if (s.state.focus !== want || !(want === s.pageId || s.client.visible.alive(want))) return false;
	if (s.view === "map") return s.map.els.has(want);
	return s.frame.querySelector(`.nf-outline-scroller .ob-block[data-id="${want}"]`) !== null;
}

/** The surface on screen is live and takes edits. */
export function surfaceEditable(): boolean {
	const s = liveEditSurfaces().at(-1);
	return !!s && s.client.ready && s.client.editable;
}

/**
 * Enter in the quick switcher's input: to the frame after the focus is shown (read-only first:
 * from the HTTP read if the page is not live yet), and to the page being live and editable.
 */
export async function switcherEnterToFocus(
	want: string,
	timeoutMs = 10_000,
): Promise<{ ms: number; focused: boolean; editableMs: number; wasSeeded: boolean }> {
	const input = document.querySelector(
		"[data-testid=outline-switcher] input",
	) as HTMLInputElement | null;
	if (!input) return { ms: -1, focused: false, editableMs: -1, wasSeeded: false };
	const t0 = performance.now();
	input.dispatchEvent(
		new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }),
	);
	const end = t0 + timeoutMs;
	while (!focusShown(want) && performance.now() < end) await new Promise((r) => setTimeout(r, 1));
	const wasSeeded = liveEditSurfaces().at(-1)?.client.ready === false;
	await afterPaint();
	const ms = performance.now() - t0;
	const focused = focusShown(want);
	while (!surfaceEditable() && performance.now() < end) await new Promise((r) => setTimeout(r, 2));
	const editableMs = surfaceEditable() ? performance.now() - t0 : -1;
	return { ms, focused, editableMs, wasSeeded };
}

// ─────────────────────────────────────────────────────────────────────────────
// Folding (task tree readability, PR C): the default view, previews, the controls
// ─────────────────────────────────────────────────────────────────────────────

export interface FoldRowDom {
	id: string;
	/** The row's own text (its first line box), without its children's. */
	text: string;
	state: "open" | "closed" | null;
	preview: { kind: string; text: string; label: string } | null;
	quick: "expand" | "collapse" | null;
	/** Counts of what the closed row hides, by kind. */
	hidden: Record<string, number>;
	/** Markers drawn on the row (exactly one). */
	markers: number;
}

function shown(el: Element | null | undefined): el is HTMLElement {
	return el instanceof HTMLElement && el.getClientRects().length > 0;
}

/** Which surface is on screen: the live editor's outline, or the read-only tree. */
export function foldSurface(): "editor" | "tree" | "none" {
	if (document.querySelector("[data-testid=outline-block-tree]")) return "tree";
	return liveEditSurfaces().length > 0 ? "editor" : "none";
}

/** The rows on screen, in document order, as either surface draws them. */
export function foldRows(): FoldRowDom[] {
	const hiddenOf = (scope: Element): Record<string, number> => {
		const out: Record<string, number> = {};
		for (const chip of scope.querySelectorAll<HTMLElement>("[data-testid=outline-fold-hidden]")) {
			if (chip.closest(".ob-children")?.parentElement?.parentElement === scope) continue;
			out[chip.dataset.kind ?? ""] = Number(chip.textContent);
		}
		return out;
	};
	if (foldSurface() === "tree") {
		const tree = document.querySelector("[data-testid=outline-block-tree]") as HTMLElement;
		return [...tree.querySelectorAll<HTMLElement>("[data-block-id]")].map((row) => {
			const id = row.dataset.blockId as string;
			const line = tree.querySelector<HTMLElement>(`[data-fold-of="${id}"]`);
			const body = row.querySelector<HTMLElement>(".nf-type-scope");
			return {
				id,
				text: (body?.textContent ?? "").trim(),
				state: (row.dataset.fold as "open" | "closed" | undefined) ?? null,
				preview: line
					? {
							kind: line.dataset.foldPreview ?? "",
							text: line.querySelector("[data-fold-preview-text]")?.textContent ?? "",
							label: line.querySelector("[data-fold-preview-label]")?.textContent ?? "",
						}
					: null,
				quick:
					(row.querySelector<HTMLElement>("[data-fold-subtree]")?.dataset.foldSubtree as
						| "expand"
						| "collapse"
						| undefined) ?? null,
				hidden: hiddenOf(row),
				markers: row.querySelectorAll(
					":scope > a > [data-collapsed], :scope > [role=img], :scope > span > [role=img]",
				).length,
			};
		});
	}
	const v = view();
	const out: FoldRowDom[] = [];
	// The root is the page's title, not a row.
	for (const el of v.pm.dom.querySelectorAll<HTMLElement>(".ob-block .ob-block")) {
		if (!shown(el)) continue;
		const part = (cls: string) => el.querySelector<HTMLElement>(`:scope > ${cls}`);
		const line = part(".ob-preview");
		const quick = part(".ob-subtree");
		const hasKids = el.classList.contains("has-kids");
		const marks = part(".ob-marks");
		const hidden: Record<string, number> = {};
		for (const chip of marks?.querySelectorAll<HTMLElement>(".ob-fold-hidden") ?? [])
			hidden[chip.dataset.kind ?? ""] = Number(chip.textContent);
		const gutter = part(".ob-gutter") as HTMLElement;
		out.push({
			id: el.dataset.id ?? "",
			text: (el.querySelector(":scope > .ob-content > :first-child")?.textContent ?? "").trim(),
			state: hasKids ? (el.classList.contains("collapsed") ? "closed" : "open") : null,
			preview: shown(line)
				? {
						kind: line.dataset.foldPreview ?? "",
						text: shown(line.querySelector(".ob-preview-text"))
							? (line.querySelector(".ob-preview-text")?.textContent ?? "")
							: "",
						label: shown(line.querySelector(".ob-preview-label"))
							? (line.querySelector(".ob-preview-label")?.textContent ?? "")
							: "",
					}
				: null,
			quick: shown(quick) ? ((quick.dataset.foldSubtree as "expand" | "collapse") ?? null) : null,
			hidden,
			markers: [...gutter.querySelectorAll<HTMLElement>(".ob-bullet, .ob-check")].filter(shown)
				.length,
		});
	}
	return out;
}

/** The centre of a row's folding control, in the viewport (for a real click or tap). */
export function foldPoint(
	id: string,
	part: "arrow" | "quick" | "preview",
): { x: number; y: number } | null {
	let el: HTMLElement | null;
	if (foldSurface() === "tree") {
		const sel = { arrow: "[data-fold-toggle]", quick: "[data-fold-subtree]" };
		el =
			part === "preview"
				? document.querySelector(`[data-fold-of="${id}"]`)
				: document.querySelector(`[data-block-id="${id}"] ${sel[part]}`);
	} else {
		const block = view().blockEls.get(id);
		const sel = { arrow: ".ob-gutter > .ob-arrow", quick: ".ob-subtree", preview: ".ob-preview" };
		el = block?.querySelector(`:scope > ${sel[part]}`) ?? null;
	}
	if (!shown(el)) return null;
	el.scrollIntoView({ block: "nearest" });
	const r = el.getBoundingClientRect();
	// A preview line is as wide as its row: its text starts at the left.
	return { x: part === "preview" ? r.left + 12 : r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** A row's folding control (to focus it, read its name, send it keys). */
export function foldControl(id: string, part: "arrow" | "quick" | "preview"): HTMLElement | null {
	if (foldSurface() === "tree") {
		const sel = { arrow: "[data-fold-toggle]", quick: "[data-fold-subtree]" };
		return part === "preview"
			? document.querySelector(`[data-fold-of="${id}"]`)
			: document.querySelector(`[data-block-id="${id}"] ${sel[part]}`);
	}
	const block = view().blockEls.get(id);
	const sel = { arrow: ".ob-gutter > .ob-arrow", quick: ".ob-subtree", preview: ".ob-preview" };
	return block?.querySelector(`:scope > ${sel[part]}`) ?? null;
}

/** Focus a folding control; false when it is not there. */
export function foldFocus(id: string, part: "arrow" | "quick" | "preview"): boolean {
	const el = foldControl(id, part);
	if (!shown(el)) return false;
	el.focus();
	return document.activeElement === el;
}

/** Which folding control has the keyboard: `<part>:<block id>`, or what else does. */
export function foldFocused(): string {
	const a = document.activeElement as HTMLElement | null;
	if (!a) return "none";
	const editorBlock = a.closest<HTMLElement>(".ob-block");
	if (a.classList.contains("ob-arrow")) return `arrow:${editorBlock?.dataset.id}`;
	if (a.classList.contains("ob-subtree")) return `quick:${editorBlock?.dataset.id}`;
	if (a.classList.contains("ob-preview")) return `preview:${editorBlock?.dataset.id}`;
	if (a.dataset.foldToggle !== undefined)
		return `arrow:${a.closest<HTMLElement>("[data-block-id]")?.dataset.blockId}`;
	if (a.dataset.foldSubtree !== undefined)
		return `quick:${a.closest<HTMLElement>("[data-block-id]")?.dataset.blockId}`;
	if (a.dataset.foldOf !== undefined) return `preview:${a.dataset.foldOf}`;
	if (a.classList.contains("ProseMirror")) return "editor";
	return a.tagName.toLowerCase();
}

/** The accessible name, state and hint of a folding control. */
export function foldAria(id: string, part: "arrow" | "quick" | "preview") {
	const el = foldControl(id, part);
	return el
		? {
				role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
				label: el.getAttribute("aria-label"),
				expanded: el.getAttribute("aria-expanded"),
				title: el.getAttribute("title"),
				tabIndex: el.tabIndex,
			}
		: null;
}

/** The page's own control (「全部展开 / 全部收起」): what it offers, its name, where it is. */
export function foldAll(): { offers: string; label: string; x: number; y: number } | null {
	const el = document.querySelector<HTMLElement>("[data-testid=outline-fold-all]");
	if (!shown(el)) return null;
	const r = el.getBoundingClientRect();
	return {
		offers: el.dataset.foldAll ?? "",
		label: el.getAttribute("aria-label") ?? el.textContent ?? "",
		x: r.left + r.width / 2,
		y: r.top + r.height / 2,
	};
}

/** The reader's folding as this surface holds it (what is stored for them). */
export function foldState(): { expanded: string[]; collapsed: string[] } {
	const s = surface().state.snapshot();
	return { expanded: s.expanded, collapsed: s.collapsed };
}

/** Keys that reached the window while a test pressed them on a control (they must not). */
const leaked: string[] = [];
let leakWatch = false;
export function watchKeyLeaks(): void {
	leaked.length = 0;
	if (leakWatch) return;
	leakWatch = true;
	window.addEventListener("keydown", (e) => {
		// A modifier going down by itself is nobody's key.
		if (e.key === "Alt" || e.key === "Control" || e.key === "Shift" || e.key === "Meta") return;
		leaked.push(`${e.key}${e.defaultPrevented ? ":prevented" : ""}`);
	});
}
export function keyLeaks(): string[] {
	return [...leaked];
}

/** Layout facts of the fold's parts: one-line previews, nothing wider than the surface. */
export function foldLayout(): {
	overflowX: boolean;
	previews: Array<{ id: string; lines: number; cut: boolean; labelSeen: boolean }>;
	hoverRules: string[];
} {
	const lineOf = (el: HTMLElement) => Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
	const tree = foldSurface() === "tree";
	const lines = tree
		? [...document.querySelectorAll<HTMLElement>("[data-fold-preview]")]
		: [...view().pm.dom.querySelectorAll<HTMLElement>(".ob-preview")].filter(shown);
	const scroller = tree
		? (document.querySelector("[data-testid=outline-surface]") as HTMLElement)
		: surface().scroller;
	// No `:hover` rule may name a frame part (touch adjustment retargets long presses to them).
	const hoverRules: string[] = [];
	for (const sheet of document.styleSheets) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		for (const rule of rules) {
			const sel = (rule as CSSStyleRule).selectorText ?? "";
			if (
				/:hover/.test(sel) &&
				/\.ob-(arrow|bullet|check|zoom|subtree|preview|fold-hidden)/.test(sel)
			)
				hoverRules.push(sel);
		}
	}
	return {
		overflowX:
			scroller.scrollWidth > scroller.clientWidth + 1 ||
			document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
		previews: lines.map((el) => {
			const text = el.querySelector<HTMLElement>(
				tree ? "[data-fold-preview-text]" : ".ob-preview-text",
			);
			const label = el.querySelector<HTMLElement>(
				tree ? "[data-fold-preview-label]" : ".ob-preview-label",
			);
			const r = el.getBoundingClientRect();
			const lr = label && shown(label) ? label.getBoundingClientRect() : null;
			return {
				id: tree
					? (el.dataset.foldOf ?? "")
					: (el.closest<HTMLElement>(".ob-block")?.dataset.id ?? ""),
				lines: Math.round(r.height / lineOf(el)),
				cut: !!text && text.scrollWidth > text.clientWidth + 1,
				// The label is inside the line's box (never pushed out by a long text).
				labelSeen: !lr || (lr.right <= r.right + 1 && lr.width > 0),
			};
		}),
		hoverRules,
	};
}

/** Locks, pending changes and unanswered questions as the page's summary would mark them. */
export function setMarks(
	marks: Record<string, { lockedBy?: string; pending?: string[]; openQuestion?: boolean }>,
): void {
	surface().setMarks(new Map(Object.entries(marks)), true);
}

/** The report lines the editor draws (the readable line of each container on screen). */
export function reportLines(): Array<{ id: string; label: string }> {
	if (foldSurface() === "tree")
		return [...document.querySelectorAll<HTMLElement>("[data-testid=outline-report-line]")].map(
			(el) => ({
				id: el.closest<HTMLElement>("[data-block-id]")?.dataset.blockId ?? "",
				label: el.textContent ?? "",
			}),
		);
	return [...view().pm.dom.querySelectorAll<HTMLElement>(".ob-report-line")]
		.filter(shown)
		.map((el) => ({
			id: el.closest<HTMLElement>(".ob-block")?.dataset.id ?? "",
			label: el.dataset.reportLabel ?? "",
		}));
}

/** The map's nodes on screen with their count badges ("" for none). */
export function mapBadges(): Record<string, string> {
	const out: Record<string, string> = {};
	const m = surface().map;
	for (const [id, ne] of m.els) out[id] = ne.badge.textContent ?? "";
	return out;
}

/** The centre of a map node's folding arrow, in the viewport. */
export function mapArrowPoint(id: string): { x: number; y: number } | null {
	const arrow = surface().map.els.get(id)?.el.querySelector<HTMLElement>(".ob-arrow");
	if (!shown(arrow)) return null;
	const r = arrow.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Set a block's checkbox through the editor (another person ticking a task). */
export function setTask(blockId: string, task: " " | "/" | "x" | "-" | null): boolean {
	const v = view();
	const pos = findBlockPos(v.pm.state.doc, blockId);
	if (pos == null) return false;
	v.pm.dispatch(v.pm.state.tr.setNodeAttribute(pos, "task", task));
	return true;
}

/** Jump to a block as the quick switcher does (focus it and put the cursor on it). */
export function reveal(id: string): boolean {
	return surface().reveal(id);
}
