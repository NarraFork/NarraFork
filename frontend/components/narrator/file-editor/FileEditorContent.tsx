import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	SegmentedControl,
	Text,
	Tooltip,
} from "@mantine/core";
import {
	FILE_REFERENCE_READ_TIMEOUT_MS,
	type FileReferenceEditorSelection,
	type FileSelection,
} from "@shared/file-reference";
import {
	IconAlertTriangle,
	IconArrowBackUp,
	IconArrowForwardUp,
	IconDeviceFloppy,
	IconRefresh,
	IconSearch,
	IconTextWrap,
} from "@tabler/icons-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { request } from "../../../lib/api/client";
import { fileReferenceApi } from "../../../lib/api/file-references";
import { saveBlobAsFile } from "../../../lib/file-download";
import { getShikiLang } from "../../../lib/shiki-lang";
import type { DiffLine } from "../diff/DiffView";
import { useFileReferenceScope } from "../FileReferenceScope";
import { availableModes, type FileViewerMode } from "../file-viewer/file-viewer-modes";
import { filePanelBaseName } from "../panels/panel-kind";
import {
	EditorDocumentSession,
	type EditorSessionState,
	sessionCanSave,
	sessionDirty,
	sessionExitBlocked,
} from "./editor-session-state";
import {
	captureEditorSnapshot,
	computeEditorConflictDiff,
	encodeEditorSnapshot,
} from "./editor-worker-client";
import { type MonacoDocumentStatus, MonacoEditor, type MonacoEditorHandle } from "./MonacoEditor";
import { MonacoSearchPanel } from "./MonacoSearchPanel";
import { monacoHostVisible } from "./monaco-scroll";
import { type EditorState, isDirty, reloaded } from "./save-state";

const DiffView = lazy(() => import("../diff/DiffView").then((m) => ({ default: m.DiffView })));
const FileEditorPreview = lazy(() =>
	import("./FileEditorPreview").then((m) => ({ default: m.FileEditorPreview })),
);
const PREVIEW_BYTES = 1024 * 1024;
// Both conflict inputs are bounded prefixes; even the small diff is computed in a Worker.
const CONFLICT_DIFF_CHARS = 32 * 1024;

export interface FileEditorContentProps {
	filePath: string;
	/** Actual source narrator; the dock host is not a filesystem authority. */
	narratorId?: string;
	deviceId?: string;
	referenceOrigin?: boolean;
	selection?: FileSelection;
	navigationRequestId?: string;
	onFileReferenceSelectionChange?: (
		selection: FileReferenceEditorSelection | null,
		takeOwnership?: boolean,
	) => void;
	onDirtyChange?: (dirty: boolean) => void;
}

/** Compatibility for reference consumers; mutable text is no longer part of this component's state. */
export function fileEditorReferenceSelection(
	state: EditorState | null,
	deviceId: string,
	filePath: string,
	selection: FileSelection | null,
): FileReferenceEditorSelection | null {
	if (!state?.baseHash || !selection) return null;
	return {
		target: { deviceId, path: filePath, selection },
		label: filePanelBaseName(filePath),
		expectedHash: state.baseHash,
		dirty: isDirty(state),
	};
}

/** Identity changes dispose the old session; navigation/visibility never replace its model. */
export function FileEditorContent(props: FileEditorContentProps) {
	return (
		<FileEditorDocument
			key={JSON.stringify([props.narratorId, props.deviceId ?? "local", props.filePath])}
			{...props}
		/>
	);
}

function FileEditorDocument({
	filePath,
	narratorId,
	deviceId = "local",
	referenceOrigin = false,
	selection,
	navigationRequestId,
	onFileReferenceSelectionChange,
	onDirtyChange,
}: FileEditorContentProps) {
	const { t } = useTranslation("narrator");
	const tRef = useRef(t);
	tRef.current = t;
	const scope = useFileReferenceScope();
	const publishSelection = onFileReferenceSelectionChange ?? scope.setSelection;
	const origin = useRef(referenceOrigin);
	origin.current = referenceOrigin;
	const editorRef = useRef<MonacoEditorHandle | null>(null);
	const [editor, setEditor] = useState<ReturnType<MonacoEditorHandle["getEditor"]>>(null);
	// This seed changes ONLY before the first model is ready. Reload uses setValue once.
	const initialValue = useRef("");
	const documentKey = useRef(JSON.stringify([narratorId, deviceId, filePath]));
	const [state, setState] = useState<EditorSessionState | null>(null);
	const [history, setHistory] = useState<MonacoDocumentStatus | null>(null);
	const [editorError, setEditorError] = useState<string | null>(null);
	const [editorSelection, setEditorSelection] = useState<FileSelection | null>(null);
	const [lineWrapping, setLineWrapping] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const [mode, setMode] = useState<FileViewerMode>("raw");
	const [previewText, setPreviewText] = useState<string | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const previewController = useRef<AbortController | null>(null);
	const [conflictDiff, setConflictDiff] = useState<{
		lines: readonly DiffLine[];
		truncated: boolean;
	} | null>(null);
	const [conflictError, setConflictError] = useState<string | null>(null);
	const [conflictRetry, setConflictRetry] = useState(0);
	const [downloadingConflict, setDownloadingConflict] = useState(false);
	const downloadController = useRef<AbortController | null>(null);
	const readOnly = deviceId !== "local" || !narratorId;
	const modes = useMemo(() => availableModes(filePath), [filePath]);
	const session = useMemo(
		() =>
			new EditorDocumentSession({
				narratorId: narratorId ?? "",
				path: filePath,
				deviceId,
				origin: () => (origin.current ? "reference" : "legacy"),
				snapshot: () => {
					const model = editorRef.current?.getModel();
					if (!model) throw new Error("Editor is not ready");
					return captureEditorSnapshot(model);
				},
				encode: encodeEditorSnapshot,
				translate: (key, defaultValue) => tRef.current(`fileEditor.${key}`, { defaultValue }),
				applyContent: (text, document) => {
					const model = editorRef.current?.getModel();
					setEditorSelection(null);
					setPreviewText(null);
					setMode("raw");
					if (!model) {
						if (document)
							documentKey.current = JSON.stringify([
								narratorId,
								document.target.deviceId,
								document.target.path,
							]);
						initialValue.current = text;
						return null;
					}
					model.setValue(text);
					return {
						revision: model.getVersionId(),
						alternativeVersionId: model.getAlternativeVersionId(),
						length: model.getValueLength(),
					};
				},
				onChange: setState,
				...(readOnly
					? {
							readOnlySource: async (signal: AbortSignal) => {
								const boundedSignal = AbortSignal.any([
									signal,
									AbortSignal.timeout(FILE_REFERENCE_READ_TIMEOUT_MS),
								]);
								if ((origin.current || deviceId !== "local") && !narratorId)
									throw new Error(tRef.current("fileEditor.missingContext"));
								if (deviceId !== "local")
									return fileReferenceApi.preview(
										narratorId as string,
										{ deviceId, path: filePath },
										boundedSignal,
									);
								return request<{ content: string; encoding: string; hash: string }>(
									`/fs/edit-source?path=${encodeURIComponent(filePath)}`,
									{ signal: boundedSignal },
								);
							},
						}
					: {}),
			}),
		[deviceId, filePath, narratorId, readOnly],
	);

	useEffect(() => {
		session.activate();
		void session.load();
		return () => {
			previewController.current?.abort();
			session.dispose();
		};
	}, [session]);
	const load = () => {
		if (session.state.phase !== "idle") return;
		if (sessionDirty(session.state) && !window.confirm(tRef.current("fileEditor.confirmReload")))
			return;
		previewController.current?.abort();
		void session.load();
	};
	const handleReady = useCallback(
		(handle: MonacoEditorHandle | null) => {
			editorRef.current = handle;
			setEditor(handle?.getEditor() ?? null);
			const model = handle?.getModel();
			if (model)
				session.change({
					revision: model.getVersionId(),
					alternativeVersionId: model.getAlternativeVersionId(),
					length: model.getValueLength(),
				});
		},
		[session],
	);
	const handleChange = useCallback(
		(status: MonacoDocumentStatus) => {
			session.change(status);
			setHistory(status);
		},
		[session],
	);
	const handleSave = useCallback(() => {
		if (!readOnly) void session.save();
	}, [session, readOnly]);
	const openSearch = useCallback(() => {
		setMode("raw");
		setSearchOpen(true);
	}, []);
	const handleSelection = useCallback(
		(next: FileSelection | null, explicit: boolean) => {
			if (explicit)
				publishSelection?.(
					session.state.baseHash && next
						? {
								target: { deviceId, path: filePath, selection: next },
								label: filePanelBaseName(filePath),
								expectedHash: session.state.baseHash,
								dirty: sessionDirty(session.state),
							}
						: null,
					true,
				);
			setEditorSelection((old) =>
				old?.startLineNumber === next?.startLineNumber &&
				old?.startColumn === next?.startColumn &&
				old?.endLineNumber === next?.endLineNumber &&
				old?.endColumn === next?.endColumn
					? old
					: next,
			);
		},
		[deviceId, filePath, publishSelection, session],
	);
	const dirty = state ? sessionDirty(state) : false;
	const exitBlocked = state ? sessionExitBlocked(state) : false;
	const baseHash = state?.baseHash;
	const revision = state?.version?.revision;
	const phase = state?.phase;
	// A quiet-window equivalence check is not part of the keystroke path. Undo to the
	// known alternativeVersionId is immediate; equal text with different history is verified.
	// biome-ignore lint/correctness/useExhaustiveDependencies: any new revision or baseline cancels and restarts the quiet window
	useEffect(() => {
		if (!dirty || phase !== "idle" || readOnly) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			const host = editorRef.current?.getEditor()?.getDomNode?.();
			if (host && monacoHostVisible(host)) void session.verifyEquivalent(controller.signal);
		}, 750);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [dirty, phase, readOnly, session, revision, baseHash]);
	useEffect(() => {
		publishSelection?.(
			baseHash && editorSelection
				? {
						target: { deviceId, path: filePath, selection: editorSelection },
						label: filePanelBaseName(filePath),
						expectedHash: baseHash,
						dirty,
					}
				: null,
		);
	}, [baseHash, deviceId, dirty, editorSelection, filePath, publishSelection]);
	useEffect(() => () => publishSelection?.(null), [publishSelection]);
	useEffect(() => {
		onDirtyChange?.(exitBlocked);
	}, [exitBlocked, onDirtyChange]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
	useEffect(() => {
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (!sessionExitBlocked(session.state)) return;
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", beforeUnload);
		return () => window.removeEventListener("beforeunload", beforeUnload);
	}, [session]);
	const navigationKey = JSON.stringify([deviceId, filePath, navigationRequestId, selection]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only explicit navigation returns to source
	useEffect(() => {
		setMode("raw");
	}, [navigationKey]);
	useEffect(() => {
		if (mode === "raw") {
			previewController.current?.abort();
			setPreviewText(null);
		}
	}, [mode]);
	const switchMode = async (next: FileViewerMode) => {
		previewController.current?.abort();
		setMode(next);
		setPreviewText(null);
		setPreviewError(null);
		if (next === "raw") return;
		setSearchOpen(false);
		const model = editorRef.current?.getModel();
		if (!model) return;
		// No snapshot/full-text work until the user explicitly requests a preview.
		if (model.getValueLength() > PREVIEW_BYTES) {
			setPreviewError(tRef.current("fileEditor.previewTooLarge"));
			return;
		}
		const controller = new AbortController();
		previewController.current = controller;
		try {
			const blob = await encodeEditorSnapshot(captureEditorSnapshot(model), controller.signal);
			if (blob.size > PREVIEW_BYTES) throw new Error(tRef.current("fileEditor.previewTooLarge"));
			const text = await blob.text();
			controller.signal.throwIfAborted();
			setPreviewText(text);
		} catch (error) {
			if (!controller.signal.aborted)
				setPreviewError(error instanceof Error ? error.message : String(error));
		}
	};
	const conflict = state?.conflict;
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry is an explicit bounded conflict-read request
	useEffect(() => {
		setConflictDiff(null);
		setConflictError(null);
		const model = editorRef.current?.getModel();
		if (!conflict || !model) return;
		const controller = new AbortController();
		// This is a bounded display prefix, NEVER an editable or saveable document.
		const snapshot = captureEditorSnapshot(model);
		let mine = "";
		while (mine.length < CONFLICT_DIFF_CHARS) {
			const chunk = snapshot.read();
			if (chunk === null) break;
			mine += chunk.slice(0, CONFLICT_DIFF_CHARS - mine.length);
		}
		void session
			.conflictPreview(controller.signal)
			.then(async (theirs) => {
				const diff = await computeEditorConflictDiff(theirs.content, mine, controller.signal);
				if (!controller.signal.aborted)
					setConflictDiff({
						lines: diff.lines,
						truncated: diff.truncated || theirs.truncated || snapshot.length > CONFLICT_DIFF_CHARS,
					});
			})
			.catch((error) => {
				if (!controller.signal.aborted)
					setConflictError(error instanceof Error ? error.message : String(error));
			});
		return () => controller.abort();
	}, [conflict, session, conflictRetry]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: changing conflict identity cancels its old download
	useEffect(() => {
		setDownloadingConflict(false);
		return () => downloadController.current?.abort();
	}, [conflict]);
	const downloadConflict = async () => {
		downloadController.current?.abort();
		const controller = new AbortController();
		downloadController.current = controller;
		setDownloadingConflict(true);
		try {
			const blob = await session.conflictDownload(controller.signal);
			controller.signal.throwIfAborted();
			saveBlobAsFile(blob, `${filePanelBaseName(filePath)}.conflict.utf8.txt`);
		} catch (error) {
			if (!controller.signal.aborted)
				setConflictError(error instanceof Error ? error.message : String(error));
		} finally {
			if (!controller.signal.aborted) setDownloadingConflict(false);
		}
	};

	if (!state?.loaded)
		return (
			<Center h="100%" p="md">
				{state?.error ? (
					<Group gap="xs">
						<Text size="sm" c="red">
							{state.error}
						</Text>
						<Button size="xs" onClick={load}>
							{t("fileTree.retry")}
						</Button>
					</Group>
				) : (
					<Loader size="sm" />
				)}
			</Center>
		);
	const saving = state.phase !== "idle" && state.phase !== "unknown";
	return (
		<Box
			style={{ height: "100%", display: "flex", flexDirection: "column" }}
			onKeyDownCapture={(event) => {
				if (
					mode !== "raw" &&
					!event.nativeEvent.isComposing &&
					(event.ctrlKey || event.metaKey) &&
					event.key.toLowerCase() === "s"
				) {
					event.preventDefault();
					event.stopPropagation();
					handleSave();
				}
			}}
		>
			<Group justify="space-between" gap="xs" px="xs" py={6} wrap="nowrap">
				<Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
					<Text size="xs" c="dimmed" truncate title={filePath}>
						{filePanelBaseName(filePath)}
					</Text>
					{readOnly && (
						<Badge size="xs" color="gray">
							{t("fileEditor.readOnly")}
						</Badge>
					)}
					{dirty && (
						<Badge size="xs" color="yellow" variant="light">
							{t("fileEditor.unsaved")}
						</Badge>
					)}
					{(state.error || editorError) && (
						<Text size="xs" c="red" truncate title={state.error ?? editorError ?? undefined}>
							{state.error || editorError}
						</Text>
					)}
				</Group>
				<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
					<Tooltip label={`${t("fileEditor.undo")} (Ctrl/Cmd+Z)`} openDelay={200}>
						<ActionIcon
							variant="subtle"
							size="sm"
							aria-label={t("fileEditor.undo")}
							disabled={readOnly || state.loading || mode !== "raw" || !history?.canUndo}
							onClick={() => editorRef.current?.undo()}
						>
							<IconArrowBackUp size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={`${t("fileEditor.redo")} (Ctrl/Cmd+Shift+Z)`} openDelay={200}>
						<ActionIcon
							variant="subtle"
							size="sm"
							aria-label={t("fileEditor.redo")}
							disabled={readOnly || state.loading || mode !== "raw" || !history?.canRedo}
							onClick={() => editorRef.current?.redo()}
						>
							<IconArrowForwardUp size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={`${t("fileEditor.search")} (Ctrl/Cmd+F)`} openDelay={200}>
						<ActionIcon
							variant="subtle"
							size="sm"
							aria-label={t("fileEditor.search")}
							onClick={openSearch}
						>
							<IconSearch size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("fileEditor.wrap")} openDelay={200}>
						<ActionIcon
							variant={lineWrapping ? "light" : "subtle"}
							size="sm"
							aria-label={t("fileEditor.wrap")}
							aria-pressed={lineWrapping}
							disabled={mode !== "raw" || history?.longLine}
							onClick={() => setLineWrapping((old) => !old)}
						>
							<IconTextWrap size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("fileEditor.reload")} openDelay={200}>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="sm"
							aria-label={t("fileEditor.reload")}
							onClick={load}
							loading={state.loading}
							disabled={state.phase !== "idle" || state.loading}
						>
							<IconRefresh size={14} />
						</ActionIcon>
					</Tooltip>
					{!readOnly && (
						<Tooltip label={`${t("fileEditor.save")} (Ctrl/Cmd+S)`} openDelay={200}>
							<ActionIcon
								variant={dirty ? "filled" : "subtle"}
								color={dirty ? "green" : "gray"}
								size="sm"
								aria-label={t("fileEditor.save")}
								onClick={handleSave}
								loading={saving}
								disabled={!editor || !sessionCanSave(state)}
							>
								<IconDeviceFloppy size={14} />
							</ActionIcon>
						</Tooltip>
					)}
				</Group>
			</Group>
			{deviceId !== "local" && (
				<Text size="xs" c="dimmed" px="xs">
					{t("fileEditor.remoteBudget", {
						defaultValue: "Remote files are read-only and use the existing 1 MiB preview limit.",
					})}
				</Text>
			)}
			{history?.longLine && (
				<Text size="xs" c="yellow" px="xs">
					{t("fileEditor.longLine", {
						defaultValue:
							"Long-line highlighting and wrapping are limited; the full text remains editable and saveable.",
					})}
				</Text>
			)}
			{history?.languageSupported === false && (
				<Text size="xs" c="yellow" px="xs">
					{t("fileEditor.languageUnavailable", {
						defaultValue: "Syntax highlighting is unavailable for this language.",
					})}
				</Text>
			)}
			{modes.length > 1 && (
				<Box px="xs" pb={6} style={{ flexShrink: 0 }}>
					<SegmentedControl
						size="xs"
						value={mode}
						onChange={(value) => void switchMode(value as FileViewerMode)}
						data={["raw" as const, ...modes.filter((value) => value !== "raw")].map((value) => ({
							value,
							label:
								value === "raw"
									? t(readOnly ? "fileViewer.mode_raw" : "fileEditor.edit")
									: t(value === "preview" ? "fileViewer.mode_preview" : "fileViewer.mode_node"),
						}))}
					/>
				</Box>
			)}
			{saving && (
				<Group px="xs" pb="xs">
					<Text size="xs">
						{t("fileEditor.saveTask", {
							defaultValue: "Saving an immutable snapshot; you may continue editing.",
						})}
					</Text>
					<Button size="xs" variant="default" onClick={() => session.cancel()}>
						{t("fileEditor.cancelTask", { defaultValue: "Cancel task" })}
					</Button>
				</Group>
			)}
			{state.phase === "unknown" && (
				<Alert color="yellow" radius={0}>
					<Text size="xs">
						{t("fileEditor.unknownSave", {
							defaultValue:
								"The save result needs verification. Your draft is retained; another save is blocked.",
						})}
					</Text>
					<Button size="xs" onClick={() => void session.reconcile()}>
						{t("fileEditor.checkSave", { defaultValue: "Check save result" })}
					</Button>
				</Alert>
			)}
			{state.confirmation && (
				<Alert
					color="yellow"
					icon={<IconAlertTriangle size={16} />}
					title={t("fileEditor.outsideWorkspaceTitle")}
					radius={0}
				>
					<Text size="xs" mb="xs">
						{t("fileEditor.outsideWorkspaceBody")}
					</Text>
					<Text size="xs" ff="monospace" mb="xs" style={{ wordBreak: "break-all" }}>
						{state.confirmation.physicalPath}
					</Text>
					<Group gap="xs">
						<Button
							size="xs"
							color="yellow"
							disabled={state.loading}
							onClick={() => void session.confirm()}
						>
							{t("fileEditor.outsideWorkspaceConfirm")}
						</Button>
						<Button size="xs" variant="default" onClick={() => session.cancel()}>
							{t("fileEditor.outsideWorkspaceCancel")}
						</Button>
					</Group>
				</Alert>
			)}
			{conflict && (
				<Alert
					color="orange"
					icon={<IconAlertTriangle size={16} />}
					title={t("fileEditor.conflictTitle")}
					radius={0}
				>
					<Text size="xs" mb="xs">
						{t("fileEditor.conflictBody")}
					</Text>
					{conflictDiff ? (
						<Box mb="xs" style={{ maxHeight: 240, overflow: "auto" }}>
							<Suspense fallback={<Loader size="xs" />}>
								<DiffView
									lines={conflictDiff.lines}
									language={getShikiLang(filePath)}
									maxHeight={240}
								/>
							</Suspense>
						</Box>
					) : conflictError ? (
						<Text size="xs" c="red">
							{conflictError}
						</Text>
					) : (
						<Loader size="xs" />
					)}
					{conflictDiff?.truncated && (
						<Text size="xs" mb="xs">
							{t("fileEditor.conflictDiffLimited", {
								defaultValue:
									"This is a partial conflict preview (up to 32 Ki characters per side). Download the full immutable disk version to inspect the remainder; saving never uses this truncated preview.",
							})}
						</Text>
					)}
					<Text size="xs" mb="xs">
						{t("fileEditor.conflictSnapshot", {
							defaultValue:
								"This comparison is a fixed snapshot. Keeping mine retains your current draft and permits replacing this disk version.",
						})}
					</Text>
					<Group gap="xs">
						<Button
							size="xs"
							variant="default"
							onClick={() => setConflictRetry((value) => value + 1)}
						>
							{t("fileTree.retry")}
						</Button>
						<Button
							size="xs"
							variant="default"
							loading={downloadingConflict}
							onClick={() => void downloadConflict()}
						>
							{t("fileEditor.downloadConflict", {
								defaultValue: "Download full conflict version (UTF-8)",
							})}
						</Button>
						<Button
							size="xs"
							color="orange"
							disabled={state.loading || !conflictDiff}
							onClick={() => session.keepMine()}
						>
							{t("fileEditor.conflictKeepMine")}
						</Button>
						<Button
							size="xs"
							variant="default"
							loading={state.loading}
							onClick={() => {
								if (window.confirm(t("fileEditor.confirmReload"))) void session.takeTheirs();
							}}
						>
							{t("fileEditor.conflictTakeTheirs")}
						</Button>
					</Group>
				</Alert>
			)}
			{searchOpen && mode === "raw" && editor && (
				<MonacoSearchPanel
					editor={editor}
					readOnly={readOnly || state.loading}
					onSave={handleSave}
					onClose={() => setSearchOpen(false)}
				/>
			)}
			<Box style={{ flex: 1, minHeight: 0, position: "relative" }}>
				<Box
					data-file-editor-source
					inert={mode !== "raw"}
					aria-hidden={mode !== "raw"}
					style={{
						position: "absolute",
						inset: 0,
						visibility: mode === "raw" ? "inherit" : "hidden",
					}}
				>
					<MonacoEditor
						initialValue={initialValue.current}
						documentKey={documentKey.current}
						filePath={filePath}
						onReady={handleReady}
						onDocumentChange={handleChange}
						onSelectionChange={handleSelection}
						onSearchRequested={openSearch}
						onSave={handleSave}
						onError={(error) => setEditorError(error.message)}
						selection={selection}
						navigationRequestId={navigationRequestId}
						readOnly={readOnly || state.loading}
						lineWrapping={lineWrapping}
						visible={mode === "raw"}
					/>
				</Box>
				{mode !== "raw" && (
					<Box
						data-file-editor-preview={mode}
						style={{ position: "absolute", inset: 0, overflow: "auto" }}
					>
						{previewError ? (
							<Text size="sm" c="yellow" p="md">
								{previewError}
							</Text>
						) : previewText === null ? (
							<Center p="md">
								<Loader size="sm" />
							</Center>
						) : (
							<Suspense
								fallback={
									<Center p="md">
										<Loader size="sm" />
									</Center>
								}
							>
								<FileEditorPreview
									text={previewText}
									mode={mode}
									filePath={filePath}
									deviceId={deviceId}
									narratorId={narratorId}
								/>
							</Suspense>
						)}
					</Box>
				)}
			</Box>
		</Box>
	);
}

export { reloaded };
