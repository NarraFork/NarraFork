/**
 * Browser fixture of the live outline editor: the real `OutlineEditor` over a WebSocket to the
 * test server (`outline-live-harness.browser-fixture.ts`), which runs the real live sessions. The
 * transport can be held (frames queue both ways), to make two people edit before either sees
 * the other.
 */
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { decodeLiveFrame, type LiveFrame } from "@shared/outline-live-protocol";
import i18next from "i18next";
import type { Node as PMNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../locales/en/outline.json";
import { OutlineViewStates } from "../view-state";
import {
	deleteBlock,
	indent,
	joinBackward,
	moveBlock,
	outdent,
	splitBlock,
	toggleTask,
} from "./commands";
import { serializePM } from "./convert";
import type { LiveClient, LiveTransport } from "./live-client";
import { OutlineEditor } from "./OutlineEditor";
import { keyBetweenLoose } from "./store";
import { findBlockPos, type OutlineView } from "./view";

const instance = i18next.createInstance();
await instance
	.use(initReactI18next)
	.init({ lng: "en", resources: { en: { outline: en } }, react: { useSuspense: false } });

class SocketTransport implements LiveTransport {
	connected = false;
	held = false;
	private ws: WebSocket | null = null;
	private readonly frameListeners = new Set<(frame: LiveFrame) => void>();
	private readonly connListeners = new Set<(connected: boolean) => void>();
	private readonly handles = new Set<number>();
	private outQueue: Uint8Array[] = [];
	private inQueue: LiveFrame[] = [];
	bytesUp = 0;
	bytesDown = 0;
	framesUp = 0;
	framesDown = 0;

	constructor(private readonly url: string) {
		this.connect();
	}

	connect(): void {
		const ws = new WebSocket(this.url);
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.onopen = () => {
			this.connected = true;
			for (const l of this.connListeners) l(true);
		};
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.connected = false;
			for (const l of this.connListeners) l(false);
		};
		ws.onmessage = (event) => {
			if (typeof event.data === "string") return;
			const bytes = new Uint8Array(event.data as ArrayBuffer);
			this.bytesDown += bytes.length;
			this.framesDown++;
			const frame = decodeLiveFrame(bytes);
			if (!frame) return;
			if (this.held) this.inQueue.push(frame);
			else for (const l of this.frameListeners) l(frame);
		};
	}

	disconnect(): void {
		const ws = this.ws;
		this.ws = null;
		ws?.close();
		this.connected = false;
		for (const l of this.connListeners) l(false);
	}

	send(frame: Uint8Array): boolean {
		if (!this.connected || !this.ws) return false;
		if (this.held) {
			this.outQueue.push(frame.slice());
			return true;
		}
		this.bytesUp += frame.length;
		this.framesUp++;
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

let root: Root | null = null;
let second: Root | null = null;
let transport: SocketTransport | null = null;
let current: { client: LiveClient; view: () => OutlineView | null } | null = null;
let other: { client: LiveClient; view: () => OutlineView | null } | null = null;
const focused: string[] = [];
const unavailable: string[] = [];

export function ready(): boolean {
	return true;
}

export interface OpenOptions {
	wsUrl: string;
	pageId: string;
	focusId?: string;
	spaceKey: string;
	canWrite: boolean;
	lens?: "facts" | "all";
	width?: number;
}

function editor(
	options: OpenOptions,
	onClient: (client: LiveClient, view: () => OutlineView | null) => void,
) {
	return (
		<I18nextProvider i18n={instance}>
			<MantineProvider>
				<OutlineEditor
					pageId={options.pageId}
					focusId={options.focusId ?? options.pageId}
					spaceKey={options.spaceKey}
					canWrite={options.canWrite}
					lens={options.lens ?? "all"}
					viewState={new OutlineViewStates().of(options.pageId)}
					transport={transport as LiveTransport}
					onFocus={(id) => focused.push(id)}
					onUnavailable={(reason) => unavailable.push(reason)}
					onClient={onClient}
				/>
			</MantineProvider>
		</I18nextProvider>
	);
}

/** Mount the editor for one person (one per browser page). */
export async function open(options: OpenOptions): Promise<void> {
	transport = new SocketTransport(options.wsUrl);
	const host = document.getElementById("root") as HTMLElement;
	if (options.width) host.style.width = `${options.width}px`;
	root = createRoot(host);
	flushSync(() => {
		root?.render(
			editor(options, (client, view) => {
				current = { client, view };
			}),
		);
	});
}

/**
 * Mount a second editor of the same person in this tab (as a dock panel beside the outline
 * page), on the same socket, with a composer (a textarea) before it.
 */
export function openSecond(options: Omit<OpenOptions, "wsUrl">): void {
	const composer = document.createElement("textarea");
	composer.id = "composer";
	document.body.appendChild(composer);
	const host = document.createElement("div");
	host.id = "second";
	host.style.width = "360px";
	document.body.appendChild(host);
	second = createRoot(host);
	flushSync(() => {
		second?.render(
			editor({ ...options, wsUrl: "" }, (client, view) => {
				other = { client, view };
			}),
		);
	});
}

/** The second editor's client and view. */
export function secondClient(): LiveClient {
	if (!other) throw new Error("second editor not open");
	return other.client;
}

export function secondView(): OutlineView {
	const v = other?.view();
	if (!v) throw new Error("second editor view not mounted");
	return v;
}

export function client(): LiveClient {
	if (!current) throw new Error("editor not open");
	return current.client;
}

export function view(): OutlineView {
	const v = current?.view();
	if (!v) throw new Error("editor view not mounted");
	return v;
}

export function net(): SocketTransport {
	if (!transport) throw new Error("editor not open");
	return transport;
}

export function events() {
	return { focused: [...focused], unavailable: [...unavailable] };
}

/** The page's blocks as the editor shows them: indentation, checkbox, text. */
export function outline(): string {
	return client().outline(client().pageId);
}

/** Put the cursor in a block (offset in its editor content; -1 = end) and focus the editor. */
export function caret(blockId: string, offset = -1): boolean {
	return view().focusBlock(blockId, offset);
}

/** Where the cursor is: block id and offset in its editor content. */
export function where(): { blockId: string; offset: number } | null {
	const sel = view().captureSel();
	return sel ? { blockId: sel.head.blockId, offset: sel.head.offset } : null;
}

/** Ids of the children of a block, as the editor's client sees them. */
export function kids(id: string): string[] {
	return client().visible.children(id);
}

export function text(id: string): string {
	return client().textOf(id);
}

/** Wait until nothing local is waiting to be sent or acknowledged. */
export async function idle(timeoutMs = 5000): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const c = client();
		if (c.status === "live" && c.pending.length === 0 && c.quiet) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return false;
}

export function dom(blockId: string): HTMLElement | null {
	return view().blockEls.get(blockId) ?? null;
}

export function unmount(): void {
	root?.unmount();
	root = null;
	second?.unmount();
	second = null;
}

/** The block as the editor document holds it, serialized (may differ from Yjs mid-composition). */
export function viewText(blockId: string): string | null {
	const v = view();
	const pos = findBlockPos(v.pm.state.doc, blockId);
	if (pos == null) return null;
	const node = v.pm.state.doc.nodeAt(pos);
	return node ? serializePM(node.child(0)) : null;
}

/** Insert text at an offset of a block through the editor (another person typing elsewhere). */
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
	join: (v: OutlineView) => joinBackward(v),
	task: () => toggleTask(),
	delete: () => deleteBlock(),
} as const;

/** Run an outline command with the cursor at a block offset (another person's keystroke). */
export function cmd(name: keyof typeof COMMANDS, blockId: string, offset = 0): boolean {
	const v = view();
	const pos = v.pointToPos(v.pm.state.doc, { blockId, offset });
	if (pos == null) return false;
	const state = v.pm.state.apply(
		v.pm.state.tr.setSelection(TextSelection.create(v.pm.state.doc, pos)).setMeta("remote", true),
	);
	v.pm.updateState(state);
	return COMMANDS[name](v)(v.pm.state, (tr) => v.pm.dispatch(tr));
}

/** The editor document as an outline (same format as the client's and the server's). */
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
	const root = view().pm.state.doc.child(0);
	if (root.childCount > 1) walk(root.child(1), 0);
	return lines.join("\n");
}

/** Select from one block offset to another and focus the editor. */
export function select(
	anchorBlock: string,
	anchorOffset: number,
	headBlock: string,
	headOffset: number,
): void {
	const v = view();
	v.applySelection({
		anchor: { blockId: anchorBlock, offset: anchorOffset },
		head: { blockId: headBlock, offset: headOffset },
		view: v,
	});
	v.pm.focus();
}

export function selection() {
	const sel = view().captureSel();
	return sel ? { anchor: sel.anchor, head: sel.head } : null;
}

export function composing(): boolean {
	return view().pm.composing;
}

export function stats() {
	return { ...view().stats };
}

/** Mark a block's DOM node, to tell later whether it was replaced. */
export function markDom(blockId: string): boolean {
	const el = dom(blockId);
	if (!el) return false;
	(el as unknown as { __mark?: number }).__mark = 1;
	return true;
}

export function sameDom(blockId: string): boolean {
	return (dom(blockId) as unknown as { __mark?: number } | null)?.__mark === 1;
}

export function peerCaretIn(blockId: string): boolean {
	return !!dom(blockId)?.querySelector(":scope > .ob-content > :first-child .ob-peer-caret");
}

export function peerMarked(blockId: string): boolean {
	return !!dom(blockId)?.classList.contains("ob-peer");
}

export function blockCount(): number {
	const c = client();
	return [...c.visible.blocks.values()].filter((b) => c.visible.inPage(b.id)).length;
}

/** Move a block to the end of another block's children, as one transaction (a drag). */
export function moveInto(id: string, parentId: string): void {
	const c = client();
	const kids = c.visible.children(parentId);
	const last = kids.length
		? (c.visible.get(kids[kids.length - 1] as string)?.orderKey ?? null)
		: null;
	c.commit({
		ops: [{ t: "m", id, p: parentId, k: keyBetweenLoose(last, null) }],
		bodies: [],
		kind: "struct",
		blockId: null,
		selBefore: null,
		selAfter: null,
		view: null,
	});
}

/** Delete a block (and what is under it) as one transaction. */
export function deleteVia(id: string): void {
	view().deleteBlocks([id]);
}

export function undo(): boolean {
	return client().undo();
}

export function redo(): boolean {
	return client().redo();
}

/** Paste HTML (and its plain text) into the editor, as a browser would from another app. */
export function pasteHtml(html: string, plain: string): boolean {
	const data = new DataTransfer();
	data.setData("text/html", html);
	data.setData("text/plain", plain);
	const event = new ClipboardEvent("paste", {
		clipboardData: data,
		bubbles: true,
		cancelable: true,
	});
	view().pm.dom.dispatchEvent(event);
	return event.defaultPrevented;
}

/** Who else is here, as the bar shows them. */
export function peers(): Array<{ name: string; editing: boolean }> {
	return [...client().presence.values()].map((p) => ({ name: p.name, editing: p.editing }));
}

export function deletedNotice(): string | null {
	return document.querySelector("[data-testid=outline-deleted-notice]")?.textContent ?? null;
}

/** Click a button of the editor's bar or notices by its text. */
export function clickButton(text: string): boolean {
	for (const b of document.querySelectorAll("button")) {
		if (b.textContent?.trim() === text) {
			b.click();
			return true;
		}
	}
	return false;
}

/** Whether the page scrolls sideways (it must not, at any width). */
export function overflowsX(): boolean {
	return document.documentElement.scrollWidth > document.documentElement.clientWidth;
}

export function editable(): boolean {
	return view().pm.editable;
}

export function blockSelection(): string[] {
	return view().selectedBlocks();
}
