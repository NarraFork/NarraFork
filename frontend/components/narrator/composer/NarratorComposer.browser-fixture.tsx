import "@mantine/core/styles.css";
import { ImageViewerContext } from "@frontend/components/common/image-viewer-context";
import { api } from "@frontend/lib/api";
import common from "@frontend/locales/en/common.json";
import narrator from "@frontend/locales/en/narrator.json";
import { MantineProvider } from "@mantine/core";
import { type ComposerDocument, composerDocumentText } from "@shared/composer-document";
import type { FileReferenceEditorSelection } from "@shared/file-reference";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import i18next from "i18next";
import { createRef, useCallback, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { useComposerAttachments } from "../interaction/use-composer-attachments";
import { useComposerFileIngest } from "../interaction/use-composer-file-ingest";
import {
	clearDraftImageAttachments,
	getComposerAssetId,
	loadDraftImageAttachments,
} from "./draft-image-attachments";
import { FileReferenceScopeProvider } from "./FileReferenceScope";
import type { NarratorComposerHandle } from "./NarratorComposer";
import { NarratorComposerRow, type NarratorComposerRowProps } from "./NarratorComposerRow";
import { persistNarratorInputDraft, readNarratorInputDraft } from "./narrator-draft-storage";

const i18n = i18next.createInstance();
await i18n
	.use(initReactI18next)
	.init({ lng: "en", resources: { en: { narrator, common } }, react: { useSuspense: false } });
const query = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
});
query.setQueryData(["auth", "me"], { id: "fixture-user" });
query.setQueryData(["named-narrators"], []);
const composer = createRef<NarratorComposerHandle>();
const fileInput = createRef<HTMLInputElement>();
const sending = { current: false };
const persistentAttachments = new URLSearchParams(window.location.search).has("persist");
const attachmentT = (key: string, options?: Record<string, unknown>) =>
	String(i18n.t(key, { ...options, ns: "narrator" }));
if (persistentAttachments) localStorage.setItem("narrafork_token", "fixture-user");
const noop = () => {};
let switchNarrator: (id: string) => void;
let switchAccount: (id: string) => void;
let currentUser = "fixture-user";
let attachmentsHydrating = false;
let hidePersistedAttachments: () => void;
let clearPersistedAttachments: () => void;
let hiddenFiles: File[] = [];
const heldReads: {
	userId: string;
	narratorId: string;
	release(): void;
	reject(reason: Error): void;
}[] = [];
let parentRenders = 0;
let sends = 0;
let updateFiles: (images: File[], textFiles: File[]) => void;
let updateSending: (value: boolean) => void;
let updateTakeover: (value: boolean) => void;
let ingestFiles: ReturnType<typeof useComposerFileIngest>["ingestFiles"];
let pendingFiles: Promise<File[]> | undefined;
let currentFiles: File[] = [];
let updateSourceSelection: (selection: FileReferenceEditorSelection | null) => void;
const defaults = {
	fileInputRef: fileInput,
	composerRef: composer,
	sendingRef: sending,
	appendInputRef: undefined,
	narratorId: "fixture-narrator",
	isActive: false,
	effectiveFocusIndex: null,
	enterQueueMode: "turn",
	ctrlEnterQueueMode: "interrupt",
	onFileInputChange: noop,
	onComposerPasteImages: noop,
	onSendWithMode: () => {
		sends++;
	},
	onSend: () => {
		sends++;
	},
	onRetry: noop,
	onContinue: noop,
	onTakeover: noop,
	onStopTakeover: noop,
	queuedMessagesCount: 0,
	showCompactQueueChoice: false,
	canCutInLine: false,
	hasCutInMessage: false,
	canTakeover: false,
	isTakenOver: false,
	canRetryLastUserMessage: false,
	canContinueNarrator: false,
	retryRecoveryAllowsInterrupt: false,
	takeoverMutationPending: false,
	stopTakeoverMutationPending: false,
	interruptMutationPending: false,
	interruptProgress: 0,
	queueHoldProgress: 0,
	startInterruptPress: noop,
	handleInterruptMouseUp: noop,
	clearInterruptTimer: noop,
	startQueueHold: noop,
	handleQueuePointerUp: noop,
	cancelQueueHold: noop,
	handleQueueClick: noop,
	onUpdateEnterQueueMode: noop,
	onUpdateCtrlEnterQueueMode: noop,
} satisfies Omit<
	NarratorComposerRowProps,
	"composerHasText" | "composerHasAttachments" | "setComposerHasText" | "isSending"
>;
function PanelBoundary({
	narratorId,
	userId,
	showFileSource = false,
}: {
	narratorId: string;
	userId: string;
	showFileSource?: boolean;
}) {
	parentRenders++;
	const [hasText, setHasText] = useState(false);
	const [localImages, setLocalImages] = useState<File[]>([]);
	const [localTextFiles, setLocalTextFiles] = useState<File[]>([]);
	const persisted = useComposerAttachments({
		narratorId,
		currentUserId: persistentAttachments ? userId : null,
		sendingRef: sending,
		t: attachmentT,
	});
	const images = persistentAttachments ? persisted.attachedImages : localImages;
	const textFiles = persistentAttachments ? persisted.attachedTextFiles : localTextFiles;
	const setImages = persistentAttachments ? persisted.updateAttachedImages : setLocalImages;
	const setTextFiles = persistentAttachments
		? persisted.updateAttachedTextFiles
		: setLocalTextFiles;
	attachmentsHydrating = persistentAttachments && persisted.attachmentsHydrating;
	hidePersistedAttachments = persisted.hideAttachedFilesForSend;
	clearPersistedAttachments = persisted.clearAttachedFilesAndDraft;
	const [isSending, setIsSending] = useState(false);
	const [takenOver, setTakenOver] = useState(false);
	updateTakeover = setTakenOver;
	const changeFiles = useCallback(
		(nextImages: File[], nextTextFiles: File[]) => {
			setImages(nextImages);
			setTextFiles(nextTextFiles);
		},
		[setImages, setTextFiles],
	);
	updateFiles = changeFiles;
	updateSending = setIsSending;
	currentFiles = [...images, ...textFiles];
	const dragCounterRef = useRef(0);
	const ingest = useComposerFileIngest({
		narratorId,
		sendingRef: sending,
		updateAttachedImages: setImages,
		updateAttachedTextFiles: setTextFiles,
		setIsDragging: noop,
		dragCounterRef,
		t: (key) => key,
		captureInsertion: (origin) => composer.current?.captureAttachmentInsertion(origin),
		onAcceptedFiles: (files, bookmark) =>
			composer.current?.insertAcceptedFiles(files, bookmark) ?? false,
	});
	ingestFiles = ingest.ingestFiles;
	return (
		<div
			data-narrator-panel
			data-fixture-owner={narratorId}
			data-fixture-user={userId}
			id="panel"
			style={{
				height: "100dvh",
				maxWidth: 880,
				margin: "auto",
				padding: 16,
				display: "flex",
				flexDirection: "column",
				boxSizing: "border-box",
			}}
		>
			<div id="messages" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
				<div data-content-block data-message-id="message-source" data-quote-role="assistant">
					<p id="quote-source">
						Select this source text to quote without changing the message layout.
					</p>
				</div>
				{showFileSource && (
					<div className="monaco-editor">
						<textarea
							id="file-selection-source"
							aria-label="Selected file source"
							defaultValue="source text"
						/>
					</div>
				)}
				<div style={{ height: 600 }}>Scrollable message history</div>
			</div>
			<div id="row">
				<NarratorComposerRow
					{...defaults}
					narratorId={narratorId}
					attachmentsHydrating={attachmentsHydrating}
					attachmentsRestoreFailed={persistentAttachments && persisted.attachmentsRestoreFailed}
					onRetryAttachments={persistentAttachments ? persisted.retryAttachmentRestore : undefined}
					restoredAttachmentResources={
						persistentAttachments ? persisted.restoredAttachmentResources : undefined
					}
					onDocumentAssetsChange={
						persistentAttachments ? persisted.reconcileDocumentAssets : undefined
					}
					canTakeover={takenOver}
					isTakenOver={takenOver}
					onFileInputChange={ingest.handleFileInputChange}
					onComposerPasteImages={ingest.handleComposerPasteImages}
					composerHasText={hasText}
					composerHasAttachments={images.length + textFiles.length > 0}
					setComposerHasText={setHasText}
					attachedImages={images}
					attachedTextFiles={textFiles}
					onAttachmentsChange={changeFiles}
					isSending={isSending}
				/>
			</div>
		</div>
	);
}
function ScopedFixture() {
	const [narratorId, setNarratorId] = useState(
		persistentAttachments ? "persist-a" : "fixture-narrator",
	);
	const [userId, setUserId] = useState("fixture-user");
	currentUser = userId;
	switchNarrator = setNarratorId;
	switchAccount = setUserId;
	const [selection, setSelection] = useState<FileReferenceEditorSelection | null>(null);
	updateSourceSelection = setSelection;
	return (
		<FileReferenceScopeProvider
			value={{
				narratorId,
				context: { deviceId: "local", cwd: "/work" },
				selection,
			}}
		>
			<PanelBoundary
				key={
					new URLSearchParams(window.location.search).has("reuse")
						? "reused"
						: `${userId}:${narratorId}`
				}
				narratorId={narratorId}
				userId={userId}
				showFileSource={!!selection}
			/>
		</FileReferenceScopeProvider>
	);
}
createRoot(document.getElementById("root") as HTMLElement).render(
	<QueryClientProvider client={query}>
		<MantineProvider defaultColorScheme="dark">
			<I18nextProvider i18n={i18n}>
				<ImageViewerContext.Provider value={{ open: noop }}>
					<ScopedFixture />
				</ImageViewerContext.Provider>
			</I18nextProvider>
		</MantineProvider>
	</QueryClientProvider>,
);
export function ready() {
	return !!composer.current && !!document.querySelector('[role="textbox"]');
}
export function snapshot() {
	return {
		text: composer.current?.getText(),
		document: composer.current?.getDocument(),
		missing: composer.current?.hasMissingAssets(),
		parentRenders,
		sends,
		files: currentFiles.map((file) => file.name),
		hydrating: attachmentsHydrating,
	};
}
export function selectSource() {
	const source = document.getElementById("quote-source");
	if (!source?.firstChild) throw new Error("Missing quote source");
	const range = document.createRange();
	range.selectNodeContents(source);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
	document.dispatchEvent(new Event("selectionchange"));
}
export function clearSelection() {
	window.getSelection()?.removeAllRanges();
	document.dispatchEvent(new Event("selectionchange"));
}
export function stageMixed() {
	const pixel = Uint8Array.from(
		atob(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
		),
		(char) => char.charCodeAt(0),
	);
	const image = new File([pixel], "screenshot.png", { type: "image/png" });
	const textFile = new File(["console output"], "console.log", { type: "text/plain" });
	flushSync(() => updateFiles([image], [textFile]));
	const imageId = getComposerAssetId(image);
	const textId = getComposerAssetId(textFile);
	const doc: ComposerDocument = {
		version: 1,
		assets: [
			{ id: imageId, kind: "image", name: image.name, size: image.size, mimeType: image.type },
			{
				id: textId,
				kind: "textFile",
				name: textFile.name,
				size: textFile.size,
				mimeType: textFile.type,
			},
		],
		paragraphs: [
			{
				children: [
					{ type: "text", text: "Analyze " },
					{
						type: "quote",
						id: "quote",
						label: "Selected explanation",
						text: "This is the quoted context.",
					},
					{ type: "text", text: " with " },
					{ type: "attachment", id: "image", assetId: imageId },
					{ type: "text", text: " and " },
					{
						type: "fileReference",
						id: "file",
						reference: { id: "ref", deviceId: "local", path: "/work/App.tsx", label: "App.tsx" },
					},
					{ type: "attachment", id: "log", assetId: textId },
					{ type: "text", text: " for the answer." },
				],
			},
		],
	};
	load(doc);
	return doc;
}
export function load(doc: ComposerDocument) {
	const projection = composerDocumentText(doc);
	composer.current?.restoreInput(projection.text, projection.fileReferences, doc);
}
export function hide() {
	hiddenFiles = [...currentFiles];
	sending.current = true;
	composer.current?.hideTextForSend();
	flushSync(() => {
		if (persistentAttachments) hidePersistedAttachments();
		else updateFiles([], []);
		updateSending(true);
	});
}
export function restore(doc: ComposerDocument) {
	sending.current = false;
	flushSync(() => {
		if (persistentAttachments) {
			const images = new Set(
				doc.assets.filter((asset) => asset.kind === "image").map((asset) => asset.id),
			);
			const texts = new Set(
				doc.assets.filter((asset) => asset.kind === "textFile").map((asset) => asset.id),
			);
			updateFiles(
				hiddenFiles.filter((file) => images.has(getComposerAssetId(file))),
				hiddenFiles.filter((file) => texts.has(getComposerAssetId(file))),
			);
		}
		updateSending(false);
	});
	load(doc);
}
export function commit() {
	composer.current?.commitDraftAfterSend();
	if (persistentAttachments) clearPersistedAttachments();
}

export function ingestImage() {
	const pixel = Uint8Array.from(
		atob(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
		),
		(char) => char.charCodeAt(0),
	);
	pendingFiles = ingestFiles([new File([pixel], "async.png", { type: "image/png" })], "paste");
}
export function ingestText(name: string) {
	pendingFiles = ingestFiles([new File(["text"], name, { type: "text/plain" })], "direct");
}
export function awaitFiles() {
	return pendingFiles;
}
export function remote(doc: ComposerDocument, revision = 100) {
	const projection = composerDocumentText(doc);
	composer.current?.handleDraftChanged({
		hasDraft: true,
		...projection,
		composerDocument: doc,
		revision,
		updatedAt: new Date().toISOString(),
		updatedBy: "another-user",
		sourceId: "another-tab",
	});
}
export function remember(doc: ComposerDocument) {
	const projection = composerDocumentText(doc);
	composer.current?.noteSent(projection.text, projection.fileReferences, doc);
}
export function clear() {
	composer.current?.clearTextAndDraft();
}
export function namedCandidates(candidates: { id: string; handle: string; title?: string }[]) {
	query.setQueryData(["named-narrators"], candidates);
}

function textboxEditor(): Editor {
	const element = document.querySelector<HTMLElement & { editor?: Editor }>("[role=textbox]");
	if (!element?.editor) throw new Error("Missing composer editor");
	return element.editor;
}

export function caretProbe() {
	const editor = textboxEditor();
	const head = editor.state.selection.head;
	return { head, top: editor.view.coordsAtPos(head).top, text: composer.current?.getText() ?? "" };
}

export function scrollProbe() {
	const editor = textboxEditor();
	const scroller = editor.view.dom.closest<HTMLElement>("[data-composer-scroll]");
	if (!scroller) throw new Error("Missing composer scroller");
	const caret = editor.view.coordsAtPos(editor.state.selection.head);
	const box = scroller.getBoundingClientRect();
	return {
		head: editor.state.selection.head,
		text: composer.current?.getText() ?? "",
		scrollTop: scroller.scrollTop,
		scrollHeight: scroller.scrollHeight,
		clientHeight: scroller.clientHeight,
		caretTop: caret.top,
		caretBottom: caret.bottom,
		boxTop: box.top,
		boxBottom: box.bottom,
	};
}

export function placeCaretAt(text: string, offset: number) {
	const editor = textboxEditor();
	let pos: number | null = null;
	editor.state.doc.descendants((node, position) => {
		if (pos != null || !node.isText || !node.text) return;
		const index = node.text.indexOf(text);
		if (index >= 0) pos = position + index + offset;
	});
	if (pos == null) throw new Error(`Missing text ${text}`);
	editor.commands.setTextSelection(pos);
	editor.commands.focus();
	return caretProbe();
}

/** `line` is the visual row, so soft-wrapped text counts even without hard breaks. */
export function placeCaretOnVisualLine(line: number) {
	const editor = textboxEditor();
	const samples: { pos: number; top: number }[] = [];
	editor.state.doc.descendants((node, position) => {
		if (!node.isText || !node.text) return;
		for (let index = 0; index <= node.text.length; index++) {
			try {
				samples.push({ pos: position + index, top: editor.view.coordsAtPos(position + index).top });
			} catch {
				// Replaced atoms have no caret rectangle.
			}
		}
	});
	const lines: { top: number; positions: number[] }[] = [];
	for (const sample of samples) {
		const group = lines.find((entry) => Math.abs(entry.top - sample.top) <= 2);
		if (group) group.positions.push(sample.pos);
		else lines.push({ top: sample.top, positions: [sample.pos] });
	}
	lines.sort((a, b) => a.top - b.top);
	const chosen = lines[Math.max(0, Math.min(line, lines.length - 1))];
	if (!chosen) throw new Error("Composer has no visual caret line");
	const pos = chosen.positions[Math.floor(chosen.positions.length / 2)] ?? chosen.positions[0];
	editor.commands.setTextSelection(pos);
	editor.commands.focus();
	return { ...caretProbe(), lineCount: lines.length };
}

export function nativeSelection(from: number, to = from) {
	const editor = textboxEditor();
	editor.commands.setTextSelection({ from, to });
	editor.commands.focus();
}

export function publishFileSelection(dirty = false) {
	flushSync(() =>
		updateSourceSelection({
			target: {
				deviceId: "local",
				path: "/work/src.ts",
				selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7 },
			},
			label: "src.ts",
			expectedHash: "a".repeat(64),
			dirty,
		}),
	);
	const source = document.getElementById("file-selection-source") as HTMLTextAreaElement;
	source.focus();
	source.setSelectionRange(0, 6);
}

export function takeover(value: boolean) {
	updateTakeover(value);
}

type AttachmentReadGlobal = typeof globalThis & {
	__draftAttachmentReadGate?: (userId: string, narratorId: string) => Promise<void>;
};
export function switchToNarrator(narratorId: string) {
	flushSync(() => switchNarrator(narratorId));
}
export function switchToUser(userId: string) {
	flushSync(() => {
		localStorage.setItem("narrafork_token", userId);
		query.setQueryData(["auth", "me"], { id: userId });
		switchAccount(userId);
	});
}
export function owner() {
	return document.querySelector<HTMLElement>("[data-fixture-owner]")?.dataset.fixtureOwner;
}
export function holdAttachmentReads() {
	(globalThis as AttachmentReadGlobal).__draftAttachmentReadGate = (userId, narratorId) =>
		new Promise<void>((release, reject) => heldReads.push({ userId, narratorId, release, reject }));
}
export function heldAttachmentReads() {
	return heldReads.map(({ userId, narratorId }) => ({ userId, narratorId }));
}
export function releaseAttachmentReads(narratorId?: string, userId?: string, keepHolding = false) {
	if (!keepHolding) delete (globalThis as AttachmentReadGlobal).__draftAttachmentReadGate;
	for (let index = heldReads.length - 1; index >= 0; index--) {
		const item = heldReads[index];
		if ((narratorId && item.narratorId !== narratorId) || (userId && item.userId !== userId))
			continue;
		heldReads.splice(index, 1);
		item.release();
	}
}
export async function storedAttachments(narratorId = owner() ?? "persist-a", userId = currentUser) {
	const loaded = await loadDraftImageAttachments(userId, narratorId);
	return Promise.all(
		[...loaded.images, ...loaded.textFiles].map(async (file) => ({
			id: getComposerAssetId(file),
			name: file.name,
			type: file.type,
			bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
		})),
	);
}

export function ownerUser() {
	return document.querySelector<HTMLElement>("[data-fixture-owner]")?.dataset.fixtureUser;
}
export async function dropStoredAttachments() {
	await clearDraftImageAttachments(currentUser, owner() ?? "persist-a");
}

export function ingestDifferentImage() {
	pendingFiles = (async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = 1;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas unavailable");
		context.fillStyle = "#ff0000";
		context.fillRect(0, 0, 1, 1);
		const blob = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(blob) => (blob ? resolve(blob) : reject(new Error("PNG encode failed"))),
				"image/png",
			),
		);
		return ingestFiles([new File([blob], "async.png", { type: "image/png" })], "paste");
	})();
}
export async function activeAttachmentBytes() {
	return Promise.all(
		currentFiles.map(async (file) => ({
			id: getComposerAssetId(file),
			name: file.name,
			type: file.type,
			bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
		})),
	);
}

export function rejectAttachmentReads() {
	delete (globalThis as AttachmentReadGlobal).__draftAttachmentReadGate;
	for (const item of heldReads.splice(0)) item.reject(new Error("Test attachment read failure"));
}
export async function seedLegacyTextDraft(text: string) {
	const id = owner() ?? "persist-a";
	const previous = readNarratorInputDraft(currentUser, id);
	const stored = await api.updateNarratorDraft(
		id,
		text,
		previous.serverRevision ?? 1,
		"legacy-fixture",
		[],
	);
	persistNarratorInputDraft(currentUser, id, text, stored.revision, stored.updatedAt, [], {
		text,
		fileReferences: [],
	});
}
export function cachedDraft() {
	return readNarratorInputDraft(currentUser, owner() ?? "persist-a");
}
export function append(text: string) {
	composer.current?.appendText(text);
}
