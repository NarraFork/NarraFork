import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { readEditorRawPage } from "../frontend/components/narrator/file-editor/EditorPagedView";
import { editorDiskStateRegistry } from "../frontend/components/narrator/file-editor/editor-disk-state";
import {
	type EditorDocumentLease,
	editorDocumentRegistry,
} from "../frontend/components/narrator/file-editor/editor-document-registry";
import {
	editorDraftStore,
	editorDraftWriterId,
} from "../frontend/components/narrator/file-editor/editor-draft-store";
import {
	EditorFormatHistory,
	serializeEditorFormat,
} from "../frontend/components/narrator/file-editor/editor-format";
import {
	type EditorRawSnapshot,
	editorSaveDiagnostics,
	encodeEditorRawSnapshot,
} from "../frontend/components/narrator/file-editor/editor-save-client";
import { sessionDirty } from "../frontend/components/narrator/file-editor/editor-session-state";
import { editorCodecDiagnostics } from "../frontend/components/narrator/file-editor/editor-stream-decoder";
import {
	captureEditorSnapshot,
	getEditorWorkerDiagnostics,
	hashEditorSnapshot,
} from "../frontend/components/narrator/file-editor/editor-worker-client";
import { FileEditorContent } from "../frontend/components/narrator/file-editor/FileEditorContent";
import { getEditorViewDiagnostics } from "../frontend/components/narrator/file-editor/MonacoEditor";
import { loadMonaco } from "../frontend/components/narrator/file-editor/monaco-loader";
import { FilePanelContent } from "../frontend/components/narrator/file-panel/FilePanelContent";
import { NarratorPanelVisibilityProvider } from "../frontend/components/narrator/narrator-panel-visibility";
import { setToken } from "../frontend/lib/api/client";
import { narratorWSManager } from "../frontend/lib/narrator-ws-manager";
import en from "../frontend/locales/en/narrator.json";
import type { EditorRawEncoding } from "../shared/editor-document";
import { createSmokeEditorQueryClient } from "./smoke-editor-query-client";

const queryClient = createSmokeEditorQueryClient();

const config = (await (await fetch("/fixture-config")).json()) as {
	narratorId: string;
	deviceId?: string;
	token?: string;
};
if (config.token) {
	setToken(config.token);
	narratorWSManager.connect();
}
const api = await loadMonaco();
const i18n = i18next.createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { narrator: en } },
	interpolation: { escapeValue: false },
});
const host = document.getElementById("root");
if (!host) throw new Error("Missing fixture host");
const root = createRoot(host);
let lease: EditorDocumentLease | undefined;
let extraLease: EditorDocumentLease | undefined;
let path = "";
let encodingHint: EditorRawEncoding | undefined;
let controller: AbortController | undefined;
const disposal: boolean[] = [];
const languages: string[] = [];
const longTasks: number[] = [];
const invalidations: { reason: string; stack: string }[] = [];
const observer = new PerformanceObserver((list) => {
	for (const entry of list.getEntries())
		if (longTasks.length < 1000) longTasks.push(entry.duration);
});
observer.observe({ type: "longtask", buffered: true });
api.editor.onDidCreateModel((model) => {
	languages.push(model.getLanguageId());
	model.onWillDispose(() =>
		disposal.push(api.editor.getEditors().every((view) => view.getModel() !== model)),
	);
});
export function state() {
	return {
		session: lease?.copy.session.state,
		docId: lease?.copy.session.documentId,
		stableResource: lease?.copy.session.currentDocument?.stableResourceKey,
		invalidations: [...invalidations],
		pageDocId: lease?.copy.pagedDocument?.docId,
		eol: lease?.copy.model?.getEOL(),
		modelLoad: lease?.copy.rawLoadStats,
		length: lease?.copy.model?.getValueLength() ?? 0,
		language: lease?.copy.model?.getLanguageId(),
		models: api.editor.getModels().length,
		registry: editorDocumentRegistry.diagnostics(),
		disk: editorDiskStateRegistry.resources(),
		observing: editorDiskStateRegistry.inspect(lease?.copy.model)?.watchActive ?? false,
		connected: narratorWSManager.connected,
		codecs: editorCodecDiagnostics(),
		save: editorSaveDiagnostics(),
		dirty: lease ? sessionDirty(lease.copy.session.state) : false,
		lifetime: lease?.copy.lifetimeId,
		format:
			lease?.copy.format && lease.copy.format.count <= 64
				? [...serializeEditorFormat(lease.copy.format)]
				: undefined,
		searchMirrors: getEditorWorkerDiagnostics().pool.slots.filter((slot) => slot.docId).length,
		views: getEditorViewDiagnostics(),
		viewReadOnly: api.editor.getEditors().map((view) => view.getRawOptions().readOnly),
		viewSamples: api.editor
			.getEditors()
			.slice(0, 4)
			.map((view) => ({
				length: view.getModel()?.getValueLength(),
				prefix: view.getModel()?.getValueInRange({
					startLineNumber: 1,
					startColumn: 1,
					endLineNumber: 1,
					endColumn: 65,
				}),
			})),
		disposal: [...disposal],
		languages: [...languages],
		maxLongTaskMs: Math.max(0, ...longTasks),
		heap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
			?.usedJSHeapSize,
	};
}
export async function open(filePath: string, hint?: EditorRawEncoding) {
	await close();
	path = filePath;
	encodingHint = hint;
	return adoptVisible();
}
/** Restore all lightweight tabs cold, before the fixture itself owns a model/doc. */
export async function restoreCold(filePath: string) {
	await close();
	path = filePath;
	encodingHint = undefined;
	restoredTabs();
}
/** Independently reauthorize the visible copy only after the host has loaded it. */
export async function openDefault(filePath: string) {
	await close();
	path = filePath;
	flushSync(() =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<MantineProvider>
					<I18nextProvider i18n={i18n}>
						<FilePanelContent
							filePath={path}
							narratorId={config.narratorId}
							deviceId={config.deviceId ?? "local"}
							confirmed
						/>
					</I18nextProvider>
				</MantineProvider>
			</QueryClientProvider>,
		),
	);
}
export async function adoptVisible() {
	controller = new AbortController();
	lease = await editorDocumentRegistry.acquire(
		{
			narratorId: config.narratorId,
			path,
			deviceId: config.deviceId ?? "local",
			origin: () => "legacy",
			protocol: "raw-v2",
			encodingHint,
		},
		controller.signal,
	);
	const session = lease.copy.session,
		invalidate = session.invalidate.bind(session);
	session.invalidate = (reason) => {
		if (invalidations.length < 8)
			invalidations.push({ reason, stack: (new Error().stack ?? "").slice(0, 1500) });
		invalidate(reason);
	};
	await lease.copy.ensureLoaded();
	return state();
}
export function reconnectHost() {
	narratorWSManager.disconnect();
	narratorWSManager.connect();
}
const restoredTabDescriptors = Array.from({ length: 1000 }, (_, index) => ({
	id: `tab-${index}`,
	index,
}));
export function restoredTabs(visible = true) {
	lease?.setVisible(visible);
	flushSync(() =>
		root.render(
			<StrictMode>
				<QueryClientProvider client={queryClient}>
					<MantineProvider>
						<I18nextProvider i18n={i18n}>
							<div style={{ display: "flex", height: "100vh" }}>
								{restoredTabDescriptors.map(({ id, index }) => (
									<div key={id} style={{ width: "50%", display: index < 2 ? "block" : "none" }}>
										<FilePanelContent
											filePath={index < 2 ? path : `${path}.hidden-${index}`}
											narratorId={config.narratorId}
											deviceId={config.deviceId ?? "local"}
											confirmed
											visible={visible && index < 2}
										/>
									</div>
								))}
							</div>
						</I18nextProvider>
					</MantineProvider>
				</QueryClientProvider>
			</StrictMode>,
		),
	);
}
export function dualViews(visible = true) {
	lease?.setVisible(visible);
	flushSync(() =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<MantineProvider>
					<I18nextProvider i18n={i18n}>
						<NarratorPanelVisibilityProvider value={visible}>
							<div style={{ display: "flex", height: "100vh" }}>
								<div style={{ width: "50%" }}>
									<FileEditorContent
										filePath={path}
										narratorId={config.narratorId}
										deviceId={config.deviceId ?? "local"}
										rawProtocol
										rawEncoding={encodingHint}
									/>
								</div>
								<div style={{ width: "50%" }}>
									<FileEditorContent
										filePath={path}
										narratorId={config.narratorId}
										deviceId={config.deviceId ?? "local"}
										rawProtocol
										rawEncoding={encodingHint}
									/>
								</div>
							</div>
						</NarratorPanelVisibilityProvider>
					</I18nextProvider>
				</MantineProvider>
			</QueryClientProvider>,
		),
	);
}
export async function fingerprint() {
	const model = lease?.copy.model;
	return model
		? hashEditorSnapshot(captureEditorSnapshot(model), new AbortController().signal)
		: null;
}
export async function reload() {
	await lease?.copy.session.load(true);
	return state();
}
export function edit(text: string) {
	const model = lease?.copy.model;
	if (!model) throw new Error("No model");
	model.pushEditOperations(
		[],
		[{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text }],
		() => null,
	);
}
export function undo() {
	lease?.copy.model?.undo();
}
export async function page() {
	const document = lease?.copy.pagedDocument;
	if (!document) throw new Error("No paged descriptor");
	return readEditorRawPage(config.narratorId, document, 0, new AbortController().signal);
}
export function windowsControl() {
	const model = api.editor.createModel("", "plaintext");
	const eol = model.getEOL();
	model.applyEdits(
		[
			{
				range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
				text: "a\nb",
			},
		],
		false,
	);
	const length = model.getValueLength();
	model.dispose();
	return { eol, length };
}
export async function refresh() {
	await lease?.copy.session.refreshDocument();
	return state();
}
function panelViews(rawOnly: boolean, a = true, b = true, secondary = true) {
	flushSync(() =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<MantineProvider>
					<I18nextProvider i18n={i18n}>
						<div style={{ display: "flex", height: "100vh" }}>
							<div style={{ width: "50%" }}>
								<FilePanelContent
									key={rawOnly ? "raw-a" : "v1"}
									rawProtocol={rawOnly}
									filePath={path}
									narratorId={config.narratorId}
									deviceId={config.deviceId ?? "local"}
									confirmed
									visible={a}
								/>
							</div>
							{secondary && (
								<div style={{ width: "50%" }}>
									<FilePanelContent
										key={rawOnly ? "raw-b" : "raw"}
										rawProtocol
										filePath={path}
										narratorId={config.narratorId}
										deviceId={config.deviceId ?? "local"}
										confirmed
										visible={b}
									/>
								</div>
							)}
						</div>
					</I18nextProvider>
				</MantineProvider>
			</QueryClientProvider>,
		),
	);
}
export async function mixedStart(filePath: string) {
	await close();
	path = filePath;
	controller = new AbortController();
	lease = await editorDocumentRegistry.acquire(
		{
			narratorId: config.narratorId,
			path,
			deviceId: config.deviceId ?? "local",
			origin: () => "legacy",
		},
		controller.signal,
	);
	await lease.copy.ensureLoaded();
	panelViews(false, true, true, false);
}
export function mixedAddRaw() {
	panelViews(false);
}
export async function mixedInspect() {
	if (!extraLease)
		extraLease = await editorDocumentRegistry.acquire(
			{
				narratorId: config.narratorId,
				path,
				deviceId: config.deviceId ?? "local",
				origin: () => "legacy",
				protocol: "raw-v2",
			},
			new AbortController().signal,
		);
	return {
		v1: lease?.copy.session.state,
		raw: extraLease.copy.session.state,
		sharedModel: lease?.copy.model === extraLease.copy.model,
		v1Text: lease?.copy.model?.getValue(),
		rawText: extraLease.copy.model?.getValue(),
	};
}
export function focusV1() {
	api.editor
		.getEditors()
		.find((view) => view.getModel() === lease?.copy.model)
		?.focus();
}
export async function saveV1() {
	await lease?.copy.session.save();
	return lease?.copy.session.state;
}
export async function beginHiddenLoad(filePath: string) {
	await close();
	path = filePath;
	panelViews(true);
}
export function loadingViews(a: boolean, b: boolean) {
	panelViews(true, a, b);
}
export async function close() {
	flushSync(() => root.render(null));
	controller?.abort();
	lease?.release();
	extraLease?.release();
	lease = undefined;
	extraLease = undefined;
	editorDocumentRegistry.shutdown();
	await new Promise((resolve) => setTimeout(resolve, 0));
}
export async function encodeRaw(tinyChunks = false) {
	if (!lease) throw new Error("No copy");
	const captured = lease.copy.captureSnapshot() as EditorRawSnapshot;
	let pending = "",
		offset = 0;
	// Deliberately split a REAL immutable Monaco snapshot at every UTF-16 unit.
	const snapshot: EditorRawSnapshot = tinyChunks
		? {
				...captured,
				read() {
					if (offset >= pending.length) {
						pending = captured.read() ?? "";
						offset = 0;
					}
					return pending ? pending[offset++] : null;
				},
			}
		: captured;
	const spool = await encodeEditorRawSnapshot(snapshot, new AbortController().signal);
	try {
		const bytes: number[] = [];
		if ((spool.seal?.bytes ?? Infinity) <= 1024)
			for await (const chunk of spool.chunks()) bytes.push(...chunk.data);
		return {
			...spool.seal,
			storage: spool.storage,
			chunks: spool.chunkCount,
			data: bytes,
			state: state(),
		};
	} finally {
		await spool.dispose();
	}
}
export async function saveRaw() {
	await lease?.copy.session.save();
	return state();
}
export async function verifyRaw() {
	await lease?.copy.session.verifyEquivalent(new AbortController().signal);
	return state();
}
export async function confirmRaw() {
	await lease?.copy.session.confirm();
	return state();
}
export async function reconcileRaw() {
	await lease?.copy.session.reconcile();
	return state();
}
export async function undoAndEncode() {
	lease?.copy.model?.undo();
	return encodeRaw();
}
export function redo() {
	lease?.copy.model?.redo();
	return state();
}
export function rawBatch(
	edits: {
		range: {
			startLineNumber: number;
			startColumn: number;
			endLineNumber: number;
			endColumn: number;
		};
		text: string;
	}[],
) {
	const model = lease?.copy.model;
	if (!model) throw new Error("No model");
	model.pushStackElement();
	model.pushEditOperations([], edits, () => null);
	model.pushStackElement();
	return state();
}
export function fragmentedEdits() {
	const model = lease?.copy.model;
	if (!model) throw new Error("No model");
	model.pushStackElement();
	model.pushEditOperations(
		[],
		Array.from({ length: 10_000 }, (_, i) => ({
			range: { startLineNumber: 1, startColumn: i * 2 + 1, endLineNumber: 1, endColumn: i * 2 + 2 },
			text: "y",
		})),
		() => null,
	);
	model.pushStackElement();
	const snapshot = model.createSnapshot(false);
	let pieces = 0;
	while (snapshot.read() !== null) pieces++;
	return { appliedEdits: 10_000, publicSnapshotReads: pieces, state: state() };
}
export function budgetNextEdit() {
	if (!lease?.copy.format || !lease.copy.model) throw new Error("No format");
	const copy = lease.copy;
	(copy as unknown as { formatHistory: EditorFormatHistory }).formatHistory =
		new EditorFormatHistory(
			copy.format as NonNullable<typeof copy.format>,
			copy.model?.getAlternativeVersionId() ?? 1,
			1,
			{ bytes: 8 * 1024 * 1024, roots: 1 },
		);
}
export async function checkpointRaw() {
	const copy = lease?.copy;
	if (!copy?.draftCheckpoint || !copy.draftScope) throw new Error("No checkpoint");
	await copy.draftCheckpoint.run(new AbortController().signal);
	const rows = await editorDraftStore.list(copy.draftScope.recoveryKey);
	return rows
		.filter(
			(row) =>
				row.writerId === editorDraftWriterId &&
				row.scope.resourceKey === copy.key &&
				row.modelLifetime === copy.lifetimeId,
		)
		.map((row) => ({
			revision: row.revision,
			modelLifetime: row.modelLifetime,
			format: row.format,
			encoding: row.encoding,
			bytes: row.bytes,
			protocol: row.protocol,
			anchor: row.anchor,
			operation: row.operation,
		}));
}
/**
 * Chrome's inspector holds the promise returned to `Runtime.callFunctionOn` (puppeteer's
 * `page.evaluate`) only weakly. When an async fixture call settles, nothing in the page still
 * references its promise, and the inspector's own reaction is merely queued; a major GC in between
 * (likely after a large synchronous render such as `restoreCold`) collects the settled promise and
 * the test sees "Promise was collected" for a call that actually succeeded. Keep every returned
 * promise reachable until a task after it settles, by which time that reaction has run.
 */
const inspectorResults = new Set<Promise<unknown>>();
function retainResultsForInspector<T extends Record<string, (...args: never[]) => unknown>>(
	api: T,
): T {
	const wrapped: Record<string, unknown> = {};
	for (const [name, call] of Object.entries(api))
		wrapped[name] = (...args: never[]) => {
			const result = call(...args);
			if (result instanceof Promise) {
				inspectorResults.add(result);
				const release = () => setTimeout(() => inspectorResults.delete(result), 0);
				result.then(release, release);
			}
			return result;
		};
	return wrapped as T;
}

Object.assign(window, {
	rawFixture: retainResultsForInspector({
		encodeRaw,
		saveRaw,
		verifyRaw,
		confirmRaw,
		reconcileRaw,
		undoAndEncode,
		redo,
		rawBatch,
		fragmentedEdits,
		budgetNextEdit,
		checkpointRaw,
		open,
		state,
		dualViews,
		restoredTabs,
		restoreCold,
		adoptVisible,
		openDefault,
		reconnectHost,
		fingerprint,
		reload,
		edit,
		undo,
		page,
		close,
		windowsControl,
		refresh,
		mixedStart,
		mixedAddRaw,
		mixedInspect,
		focusV1,
		saveV1,
		beginHiddenLoad,
		loadingViews,
	}),
});
