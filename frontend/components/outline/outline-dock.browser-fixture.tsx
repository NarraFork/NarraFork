/**
 * Browser fixture of the outline dock panel beside a session's composer: the session dock's real
 * provider (`NarratorDockProvider`, whose outline opener decides which panel a place opens in),
 * a dockview surface with a composer panel (the real composer editor) and the real outline dock
 * panel (`OutlineDockPanel`), in a memory router. The outline API and the live sessions are the
 * test server's (`outline-dock.browser.test.ts`); live frames go over a plain WebSocket.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import type { ComposerDocument } from "@shared/composer-document";
import { decodeLiveFrame, LIVE_FRAME, type LiveFrame } from "@shared/outline-live-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	type AnyRouter,
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import i18next from "i18next";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { type OutlineOpener, useOutlineOpener } from "../../lib/outline-opener";
import type { OutlinePanelState } from "../../lib/outline-panel";
import outlineEn from "../../locales/en/outline.json";
import { DockviewSurface } from "../dockview";
import { InlineComposerEditor } from "../narrator/composer/InlineComposerEditor";
import { dockPanelId } from "../narrator/dock/dock-panel-types";
import { NarratorDockProvider, useNarratorDockContext } from "../narrator/dock/NarratorDockContext";
import { OutlineDockPanel } from "../narrator/dock/OutlineDockPanel";
import type { LiveTransport } from "./editor/live-client";
import { liveSessionsOn, setLiveSessionGraceForTests } from "./editor/live-sessions";
import { overrideLiveTransportForTests } from "./editor/transport";

const instance = i18next.createInstance();
await instance
	.use(initReactI18next)
	.init({ lng: "en", resources: { en: { outline: outlineEn } }, react: { useSuspense: false } });

/** Sessions the server ended for this tab (a refused join among them), by close code. */
const closedFrames: string[] = [];
let transport: SocketTransport | null = null;

class SocketTransport implements LiveTransport {
	connected = false;
	private ws: WebSocket;
	private readonly frameListeners = new Set<(frame: LiveFrame) => void>();
	private readonly connListeners = new Set<(connected: boolean) => void>();
	private readonly handles = new Set<number>();

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
			const frame = decodeLiveFrame(new Uint8Array(event.data as ArrayBuffer));
			if (frame?.kind === LIVE_FRAME.closed) {
				closedFrames.push(String((frame.head as { code?: string } | null)?.code ?? "ended"));
			}
			if (frame) for (const l of this.frameListeners) l(frame);
		};
	}
	send(frame: Uint8Array): boolean {
		if (!this.connected) return false;
		this.ws.send(frame as Uint8Array<ArrayBuffer>);
		return true;
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

let dockApi: DockviewApi | null = null;
let opener: OutlineOpener | null = null;
let composerText = "";
let router: AnyRouter | null = null;

/** The composer panel: the session composer's real editor. */
function ComposerPanel() {
	const [value, setValue] = useState<ComposerDocument>({
		version: 1,
		paragraphs: [{ children: [] }],
		assets: [],
	});
	const element = useRef<HTMLDivElement>(null);
	return (
		<div id="composer-panel" style={{ padding: 8, height: "100%" }}>
			<InlineComposerEditor
				elementRef={element}
				value={value}
				onChange={(document) => {
					composerText = document.paragraphs
						.map((p) => p.children.map((c) => ("text" in c ? c.text : "")).join(""))
						.join("\n");
					setValue(document);
				}}
				resources={new Map()}
				placeholder="Message"
				onRemoveAsset={() => {}}
				onOpenQuote={() => {}}
				onOpenImage={() => {}}
				onOpenFile={() => {}}
				onOpenAttachment={() => {}}
				onPasteFiles={() => {}}
			/>
		</div>
	);
}

function Surface() {
	const dock = useNarratorDockContext();
	opener = useOutlineOpener();
	return (
		<div style={{ height: 760, width: 1200 }}>
			<DockviewSurface
				apiRef={dock?.apiRef}
				components={{
					chat: ComposerPanel as React.FunctionComponent<IDockviewPanelProps>,
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

export function ready(): boolean {
	return true;
}

/** Mount the dock (composer only) with the outline API and live frames of the test server. */
export function open(options: { wsUrl: string }): void {
	transport = new SocketTransport(options.wsUrl);
	overrideLiveTransportForTests(transport);
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// The session dock opens outline panels only while the app shell knows the outline is on.
	queryClient.setQueryData(["settings"], { outline: { enabled: true } });
	const rootRoute = createRootRoute({
		component: () => (
			<NarratorDockProvider narratorId="n-fixture">
				<Surface />
			</NarratorDockProvider>
		),
	});
	const created = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/narrators/n-fixture"] }),
	});
	router = created;
	createRoot(document.getElementById("root") as HTMLElement).render(
		<I18nextProvider i18n={instance}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider>
					<RouterProvider router={created} />
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
}

/** Open a place the way a tool card or a chat link does (Ctrl/Cmd: `newPanel`). */
export function openOutline(state: OutlinePanelState, newPanel = false): boolean {
	if (!opener) throw new Error("no outline opener in the dock");
	return opener.open(state, { newPanel });
}

/** Every panel's id, component and params. */
export function panels(): Array<{ id: string; params: Record<string, unknown>; title: string }> {
	return (dockApi?.panels ?? []).map((panel) => ({
		id: panel.id,
		params: { ...(panel.params as Record<string, unknown>) },
		title: panel.api.title ?? "",
	}));
}

export function outlinePanels() {
	return panels().filter((panel) => panel.params.panelType === "outline");
}

/** Where the app thinks it is: the router's location and the window's. */
export function locations(): { router: string; window: string } {
	return { router: router?.state.location.href ?? "", window: window.location.href };
}

export function composer(): string {
	return composerText;
}

/** Live editors mounted in outline panels, by panel. */
export function liveEditors(): number {
	return document.querySelectorAll(
		"[data-testid=outline-surface] [data-testid=outline-editor] .ProseMirror[contenteditable=true]",
	).length;
}

/** Bring a panel to the front of its group. */
export function activate(id: string): void {
	dockApi?.getPanel(id)?.api.setActive();
}

/** Open a place in a new panel behind the others in its group (as a restored layout has it). */
export function openInBackground(state: OutlinePanelState, id: string): void {
	const chat = dockApi?.getPanel(dockPanelId("chat"));
	const beside = dockApi?.panels.find((panel) => panel !== chat);
	dockApi?.addPanel({
		id,
		component: "outline",
		params: { panelType: "outline", ...state },
		inactive: true,
		...(beside ? { position: { referenceGroup: beside.group } } : {}),
	});
}

/** Move a panel into a group of its own, right of its current one (both now on screen). */
export function splitRight(id: string): void {
	const panel = dockApi?.getPanel(id);
	if (panel) panel.api.moveTo({ group: panel.group, position: "right" });
}

/** Panels on screen (the front panel of each group). */
export function visiblePanels(): string[] {
	return (dockApi?.panels ?? []).filter((panel) => panel.api.isVisible).map((panel) => panel.id);
}

/** The live sessions this tab holds, and the sessions the server ended or refused. */
export function liveState(): {
	sessions: Array<{ pageId: string; refs: number; status: string }>;
	closed: string[];
	tabLimitNotices: number;
} {
	return {
		sessions: transport
			? liveSessionsOn(transport).map(({ pageId, refs, status }) => ({ pageId, refs, status }))
			: [],
		closed: [...closedFrames],
		tabLimitNotices: document.querySelectorAll("[data-testid=outline-tab-limit]").length,
	};
}

/** How long a page's session outlives its last editor (null: the app's). */
export function setGrace(ms: number | null): void {
	setLiveSessionGraceForTests(ms);
}
