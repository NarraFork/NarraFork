import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import {
	type ComposerAsset,
	type ComposerDocument,
	type ComposerInlineNode,
	composerDocumentText,
	MAX_COMPOSER_DOCUMENT_NODES,
	MAX_COMPOSER_DOCUMENT_TEXT,
	parseComposerDocument,
} from "@shared/composer-document";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import i18next from "i18next";
import { createRef, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { composerOptimizeTarget } from "./composer-optimize-target";
import {
	InlineComposerEditor,
	type InlineComposerEditorHandle,
	type InlineComposerSelectionBookmark,
} from "./InlineComposerEditor";
import composerClasses from "./NarratorComposer.module.css";
import { QuoteSelectionButton } from "./QuoteSelectionButton";
import type { QuoteCandidate } from "./use-quote-candidate";

const instance = i18next.createInstance();
await instance
	.use(initReactI18next)
	.init({ lng: "en", resources: {}, react: { useSuspense: false } });
const root = createRoot(document.getElementById("root") as HTMLElement);
const editor = createRef<InlineComposerEditorHandle>();
const element = createRef<HTMLDivElement>();
const initial: ComposerDocument = { version: 1, paragraphs: [{ children: [] }], assets: [] };
let restoredBeforeInstance = false;
function attachEditor(handle: InlineComposerEditorHandle | null) {
	editor.current = handle;
	if (
		!handle ||
		handle.getElement() ||
		restoredBeforeInstance ||
		!location.search.includes("early-restore")
	)
		return;
	restoredBeforeInstance = true;
	handle.setDocument({
		...initial,
		paragraphs: [{ children: [{ type: "text", text: "restored" }] }],
	});
	const restored = handle.getDocument();
	handle.setDocument({
		...restored,
		paragraphs: [
			{ children: [...restored.paragraphs[0].children, { type: "text", text: " appended" }] },
		],
	});
}
let externalDocument: (document: ComposerDocument) => void;
let updateResources: (resources: ReadonlyMap<string, File | string>) => void;
let toggleDisabled: (disabled: boolean) => void;
let toggleHydrating: (hydrating: boolean) => void;
let changes = 0;
let sends = 0;
let accepted = 0;
let dismissed = 0;
let opened = 0;
let pasted: string[] = [];
let pasteCalls = 0;
let panelDrops = 0;
let captureNextDrop = false;
// While set, onChange emissions queue here instead of rendering: a parent lagging behind.
let heldEchoes: ComposerDocument[] | null = null;
const removed: string[] = [];
const candidate: Extract<QuoteCandidate, { kind: "text" }> = {
	kind: "text",
	key: "test",
	quote: { label: "Selection", text: "Source text" },
};
function Fixture() {
	const [value, setValue] = useState(initial);
	const [disabled, setDisabled] = useState(false);
	const [hydrating, setHydrating] = useState(false);
	toggleHydrating = setHydrating;
	const [resources, setResources] = useState<ReadonlyMap<string, File | string>>(new Map());
	externalDocument = setValue;
	updateResources = setResources;
	toggleDisabled = setDisabled;
	useEffect(() => {
		const panel = document.getElementById("layout");
		const countDrop = () => {
			panelDrops++;
		};
		panel?.addEventListener("drop", countDrop);
		return () => panel?.removeEventListener("drop", countDrop);
	}, []);
	return (
		<I18nextProvider i18n={instance}>
			<MantineProvider>
				<div id="layout" style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
					<div id="messages" style={{ flex: 1, minHeight: 0 }}>
						Source text to quote
					</div>
					<div id="shell">
						<InlineComposerEditor
							ref={attachEditor}
							elementRef={element}
							value={value}
							onChange={(document) => {
								changes++;
								if (heldEchoes) heldEchoes.push(document);
								else setValue(document);
							}}
							resources={resources}
							attachmentsHydrating={hydrating}
							disabled={disabled}
							placeholder="Message"
							onRemoveAsset={(id) => removed.push(id)}
							onOpenQuote={() => opened++}
							onOpenImage={() => opened++}
							onOpenFile={() => opened++}
							onOpenAttachment={() => opened++}
							onPasteFiles={(files) => {
								pasteCalls++;
								pasted = files.map((file) => file.name);
								if (captureNextDrop && files.length) {
									captureNextDrop = false;
									captureBookmark("drop");
								}
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									sends++;
								}
							}}
							controls={
								<button type="button" id="outside">
									Controls
								</button>
							}
						/>
					</div>
				</div>
			</MantineProvider>
		</I18nextProvider>
	);
}
root.render(<Fixture />);
export function ready() {
	return !!editor.current?.getElement();
}
export function load(document: ComposerDocument) {
	externalDocument(document);
}
export function holdEchoes() {
	heldEchoes = [];
}
/** Commit the oldest held emission as its own parent render; false once none are left. */
export function releaseEcho() {
	const next = heldEchoes?.shift();
	if (!next) {
		heldEchoes = null;
		return false;
	}
	flushSync(() => externalDocument(next));
	return true;
}
export function restoreSilently(document: ComposerDocument) {
	editor.current?.setDocument(document);
}
export function replaceUndoable(document: ComposerDocument) {
	editor.current?.setDocument(document, true);
	editor.current?.focus();
}
export function insert(nodes: ComposerInlineNode[], assets?: ComposerAsset[]) {
	editor.current?.insertNodes(nodes, assets);
}
export function selection(start: number, end = start) {
	editor.current?.setSelection(start, end);
	editor.current?.focus();
}
export function disable(disabled: boolean) {
	toggleDisabled(disabled);
}
export function hydrating(value: boolean) {
	toggleHydrating(value);
}
export function resources(entries: [string, string][]) {
	updateResources(new Map(entries));
}
const trackedURLs = new Set<string>();
const revokedURLs = new Set<string>();
export async function fileImageResource() {
	const create = URL.createObjectURL.bind(URL);
	const revoke = URL.revokeObjectURL.bind(URL);
	URL.createObjectURL = (blob) => {
		const url = create(blob);
		trackedURLs.add(url);
		return url;
	};
	URL.revokeObjectURL = (url) => {
		if (trackedURLs.has(url)) revokedURLs.add(url);
		revoke(url);
	};
	const response = await fetch("/api/test-image");
	if (!response.ok) throw new Error("Image fixture unavailable");
	const blob = await response.blob();
	updateResources(new Map([["image-1", new File([blob], "pixel.png", { type: "image/png" })]]));
}
export function pasteFiles() {
	editor.current?.insertFiles([new File(["text"], "note.txt", { type: "text/plain" })]);
}
export function expand(expanded: boolean) {
	const shell = document.getElementById("shell");
	if (!shell) return;
	shell.className = expanded ? composerClasses.fullscreen : "";
}
const bookmarks = new Map<string, InlineComposerSelectionBookmark>();
export function captureBookmark(id: string) {
	bookmarks.get(id)?.cancel();
	const bookmark = editor.current?.captureSelectionBookmark();
	if (bookmark) bookmarks.set(id, bookmark);
}
export function restoreBookmark(id: string) {
	return bookmarks.get(id)?.restore() ?? false;
}
export function cancelBookmark(id: string) {
	bookmarks.get(id)?.cancel();
}
export function prepareAsyncDrop() {
	captureNextDrop = true;
}
export function unmount() {
	root.unmount();
}
/** Use the real mounted Tiptap view, not a DOM range that PM may normalize to NodeSelection. */
export function selectAtomAsText() {
	const dom = editor.current?.getElement() as (HTMLDivElement & { editor?: Editor }) | null;
	const instance = dom?.editor;
	if (!instance) throw new Error("Mounted Tiptap editor unavailable");
	let atom: { from: number; to: number } | null = null;
	instance.state.doc.descendants((node, position) => {
		if (atom) return false;
		if (node.isAtom && !node.isText && node.type.name !== "hardBreak") {
			atom = { from: position, to: position + node.nodeSize };
			return false;
		}
	});
	if (!atom) throw new Error("Missing atom");
	const { from, to } = atom as { from: number; to: number };
	instance.view.dispatch(
		instance.state.tr.setSelection(TextSelection.create(instance.state.doc, from, to)),
	);
}
export function optimize() {
	const target = composerOptimizeTarget(editor.current);
	return target?.text ?? null;
}
export function applyOptimization(result: string) {
	return composerOptimizeTarget(editor.current)?.apply(result) ?? false;
}
export function snapshot() {
	const dom = editor.current?.getElement();
	const shell = document.getElementById("shell")?.getBoundingClientRect();
	const viewport = document.getElementById("messages")?.getBoundingClientRect();
	return {
		document: editor.current?.getDocument(),
		selection: editor.current?.getSelection(),
		nativeSelection: {
			empty: editor.current?.getSelection().empty,
			type: editor.current?.getSelection().type,
		},
		textContext: editor.current?.getTextContext(),
		changes,
		restoredBeforeInstance,
		sends,
		accepted,
		dismissed,
		opened,
		pasted,
		pasteCalls,
		panelDrops,
		objectURLs: { created: trackedURLs.size, revoked: revokedURLs.size },
		removed,
		elementMatches: dom === element.current,
		shellHeight: shell?.height,
		viewportHeight: viewport?.height,
		selected: !!document.querySelector(".ProseMirror-selectednode"),
		atoms: [...document.querySelectorAll<HTMLElement>("[data-composer-atom]")].map((node) => ({
			type: node.dataset.composerAtom,
			width: node.getBoundingClientRect().width,
			height: node.getBoundingClientRect().height,
			missing: node.dataset.missing === "true",
		})),
		contentHeight: dom?.parentElement?.clientHeight,
		scrollHeight: dom?.parentElement?.scrollHeight,
	};
}
export async function benchmarkBoundary(kind: "text" | "nodes", samples = 20) {
	const handle = editor.current;
	if (!handle?.getElement()) throw new Error("Editor not ready");
	const breaks = kind === "nodes" ? MAX_COMPOSER_DOCUMENT_NODES - 2 : 0;
	const document = parseComposerDocument({
		version: 1,
		paragraphs: [
			{
				children: [
					{ type: "text", text: "x".repeat(MAX_COMPOSER_DOCUMENT_TEXT - breaks) },
					...Array.from({ length: breaks }, () => ({ type: "break" })),
				],
			},
		],
		assets: [],
	});
	handle.setDocument(document);
	const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	await settle();
	const transactionMs: number[] = [];
	const projectionMs: number[] = [];
	for (let index = 0; index < samples; index++) {
		const start = performance.now();
		handle.setSelection(0, 1);
		handle.insertNodes([{ type: "text", text: index % 2 ? "y" : "z" }]);
		transactionMs.push(performance.now() - start);
		const projectionStart = performance.now();
		const projection = composerDocumentText(handle.getDocument());
		projectionMs.push(performance.now() - projectionStart);
		if (projection.text.length !== MAX_COMPOSER_DOCUMENT_TEXT)
			throw new Error("Boundary projection lost data");
		await settle();
	}
	const percentile = (values: number[]) =>
		[...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
	return {
		kind,
		samples,
		characters: MAX_COMPOSER_DOCUMENT_TEXT,
		nodes: breaks + 2,
		transactionP95Ms: percentile(transactionMs),
		transactionMaxMs: Math.max(...transactionMs),
		projectionP95Ms: percentile(projectionMs),
		projectionMaxMs: Math.max(...projectionMs),
	};
}

export function frameCandidate() {
	const frame = document.createElement("iframe");
	frame.id = "candidate-frame";
	document.body.append(frame);
	const frameDocument = frame.contentDocument;
	if (!frameDocument) throw new Error("Frame not ready");
	const mount = frameDocument.createElement("div");
	const source = frameDocument.createElement("div");
	source.textContent = "Selected source";
	const composer = frameDocument.createElement("div");
	composer.style.cssText = "margin-top: 80px; height: 40px";
	frameDocument.body.append(source, composer, mount);
	const range = frameDocument.createRange();
	range.selectNodeContents(source);
	frameDocument.getSelection()?.addRange(range);
	createRoot(mount).render(
		<I18nextProvider i18n={instance}>
			<QuoteSelectionButton
				candidate={{ ...candidate, range }}
				anchor={composer}
				placement="selection"
				onAccept={() => accepted++}
				onDismiss={() => dismissed++}
			/>
		</I18nextProvider>,
	);
}
