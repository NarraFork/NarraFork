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
import { bodySize, clearMeasureCache, measureStats, NODE, nodeSize } from "./mindmap/measure";
import { prewarmStats, setMeasureWorkerFactoryForTests } from "./mindmap/prewarm";
import { OutlineSurface } from "./OutlineSurface";
import { quickSwitcherIndexOf } from "./QuickSwitcher";
import { OutlineViewStates } from "./view-state";

const instance = i18next.createInstance();
await instance
	.use(initReactI18next)
	.init({ lng: "en", resources: { en: { outline: outlineEn } }, react: { useSuspense: false } });

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

function providers(children: React.ReactNode, queryClient: QueryClient) {
	return (
		<I18nextProvider i18n={instance}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider>{children}</MantineProvider>
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
}

let lens: "facts" | "all" = "all";

/** Mount a host of the outline surface on a page. */
export function open(options: OpenOptions): void {
	host = options.host;
	lens = options.lens ?? "all";
	window.addEventListener("error", (e) => errors.push(String(e.message)));
	transport = new SocketTransport(options.wsUrl);
	overrideLiveTransportForTests(transport);
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(["settings"], { outline: { enabled: true } });
	if (options.host === "page") {
		window.history.replaceState(
			null,
			"",
			`/outline/${options.spaceId}/${options.blockId}${lens === "all" ? "?view=all" : ""}`,
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

/** Breadcrumbs: every crumb's text. */
export function crumbs(): string[] {
	const bar = document.querySelector("[data-testid=outline-surface] .mantine-Breadcrumbs-root");
	return [...(bar?.children ?? [])]
		.map((el) => (el as HTMLElement).textContent?.trim() ?? "")
		.filter((t) => t && t !== "/");
}

export function clickCrumb(text: string): boolean {
	const a = [
		...document.querySelectorAll("[data-testid=outline-surface] .mantine-Breadcrumbs-root a"),
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
		measure: { ...measureStats },
		prewarm: { ...prewarmStats },
	};
}

/** How far measured node heights are from the DOM's (pretext vs. layout). */
export function nodeAccuracy(): { checked: number; maxDiffH: number; overH: number } {
	const m = surface().map;
	let checked = 0;
	let maxDiffH = 0;
	let overH = 0;
	for (const [id, ne] of m.els) {
		if (m.editing?.id === id || id.startsWith("\u0000")) continue;
		const inf = m.info.get(id);
		if (!inf) continue;
		const predicted = nodeSize(bodySize(inf.content), !!inf.task).h;
		const actual = ne.el.getBoundingClientRect().height / m.scale;
		const d = Math.abs(predicted - actual);
		checked++;
		if (d > maxDiffH) maxDiffH = d;
		if (d > 1) overH++;
	}
	return { checked, maxDiffH: +maxDiffH.toFixed(2), overH };
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

export { findBlockPos };

// ─────────────────────────────────────────────────────────────────────────────
// Measuring (performance runs: numbers are logged, never asserted)
// ─────────────────────────────────────────────────────────────────────────────

/** No Worker: node sizes are measured where needed (the cold first switch). */
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
