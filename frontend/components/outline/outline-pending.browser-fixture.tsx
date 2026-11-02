/**
 * Browser fixture of an outline page with a locked plan (P2 PR 6): the real `OutlineSurface`
 * (live editor, side panel, timeline) in a memory router, against the test server's outline API
 * and live sessions (`outline-pending.browser.test.ts`); live frames go over a plain WebSocket.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { decodeLiveFrame, type LiveFrame } from "@shared/outline-live-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import i18next from "i18next";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import outlineEn from "../../locales/en/outline.json";
import type { LiveTransport } from "./editor/live-client";
import { overrideLiveTransportForTests } from "./editor/transport";
import { OutlineSurface } from "./OutlineSurface";
import type { OutlineTarget } from "./outline-nav";

const instance = i18next.createInstance();
await instance
	.use(initReactI18next)
	.init({ lng: "en", resources: { en: { outline: outlineEn } }, react: { useSuspense: false } });

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

let queryClient: QueryClient | null = null;
let go: ((target: { spaceId: string; blockId: string; view?: "facts" | "all" }) => void) | null =
	null;
const visited: string[] = [];

function Page(props: { spaceId: string; blockId: string; view?: "facts" | "all" }) {
	const [target, setTarget] = useState(props);
	go = (next) => setTarget(next);
	return (
		<div style={{ height: 760, width: 1200 }}>
			<OutlineSurface
				spaceId={target.spaceId}
				blockId={target.blockId}
				view={target.view}
				layout="panel"
				compact={false}
				onNavigate={(to: OutlineTarget) => {
					if (to.kind !== "block") return;
					visited.push(to.blockId);
					setTarget({ spaceId: to.spaceId, blockId: to.blockId, view: to.view });
				}}
			/>
		</div>
	);
}

export function ready(): boolean {
	return true;
}

/** Mount the page focused on `blockId`, with the test server's API and live frames. */
export function open(options: {
	wsUrl: string;
	spaceId: string;
	blockId: string;
	view?: "facts" | "all";
}): void {
	overrideLiveTransportForTests(new SocketTransport(options.wsUrl));
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(["settings"], { outline: { enabled: true } });
	const client = queryClient;
	const rootRoute = createRootRoute({
		component: () => (
			<Page spaceId={options.spaceId} blockId={options.blockId} view={options.view} />
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	createRoot(document.getElementById("root") as HTMLElement).render(
		<I18nextProvider i18n={instance}>
			<QueryClientProvider client={client}>
				<MantineProvider>
					<RouterProvider router={router} />
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
}

/** Focus another block (the host's navigation). */
export function focus(spaceId: string, blockId: string, view?: "facts" | "all"): void {
	go?.({ spaceId, blockId, view });
}

/** Re-read everything (what the page subscription's frames do in the app). */
export function refresh(): void {
	void queryClient?.invalidateQueries({ queryKey: ["outline"] });
}

/** Blocks the surface was asked to focus, in order. */
export function navigations(): string[] {
	return [...visited];
}

/** Text of the element a test id names (the first), or null. */
export function textOf(testId: string): string | null {
	return document.querySelector(`[data-testid=${testId}]`)?.textContent ?? null;
}

export function count(selector: string): number {
	return document.querySelectorAll(selector).length;
}

/** Click the first element matching a selector (mousedown for the editor's own controls). */
export function click(selector: string, how: "click" | "mousedown" = "click"): boolean {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) return false;
	if (how === "mousedown")
		element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	else element.click();
	return true;
}

/** Text of the live editor's block, by id. */
export function blockText(id: string): string | null {
	return (
		document.querySelector(`[data-testid=outline-editor] .ob-block[data-id="${id}"] > .ob-content`)
			?.firstElementChild?.textContent ?? null
	);
}
