import { useClipboard } from "@frontend/hooks/useClipboard";
import {
	ActionIcon,
	Alert,
	Anchor,
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
import { notifications } from "@mantine/notifications";
import type { EditorRawEncoding } from "@shared/editor-document";
import {
	FILE_REFERENCE_READ_TIMEOUT_MS,
	type FileReferenceEditorSelection,
	type FileSelection,
} from "@shared/file-reference";
import {
	IconAlertTriangle,
	IconArrowBackUp,
	IconArrowForwardUp,
	IconCheck,
	IconCopy,
	IconDeviceFloppy,
	IconDownload,
	IconRefresh,
	IconSearch,
	IconTextWrap,
} from "@tabler/icons-react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { useMobileViewport } from "../../../hooks/useMobileViewport";
import { api } from "../../../lib/api";
import { request } from "../../../lib/api/client";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { fileReferenceApi } from "../../../lib/api/file-references";
import { saveBlobAsFile } from "../../../lib/file-download";
import { getShikiLang } from "../../../lib/shiki-lang";
import { useFileReferenceScope } from "../composer/FileReferenceScope";
import type { DiffLine } from "../diff/DiffView";
import { availableModes } from "../file-viewer/file-viewer-modes";
import { useEditorPanelVisible, useRetainedEditorView } from "../narrator-panel-visibility";
import { filePanelBaseName } from "../panels/panel-kind";
import { EditorPagedView } from "./EditorPagedView";
import {
	EditorReceiptNotice,
	EditorRecoveryBoundary,
	editorRecoveryScopeIdentity,
	readEditorProtocol,
	useEditorRecoveryHost,
} from "./EditorRecoveryBoundary";
import { editorDiskStateRegistry } from "./editor-disk-state";
import { type EditorDocumentLease, editorDocumentRegistry } from "./editor-document-registry";
import {
	type EditorMode,
	fractionToScroll,
	readEditorModePref,
	resolveInitialMode,
	scrollFraction,
	splitRenderMode,
	writeEditorModePref,
} from "./editor-mode-prefs";
import {
	collectPreviewAnchors,
	type LineAnchor,
	lineForScrollTop,
	observePreviewAnchorChanges,
	scrollTopForLine,
} from "./editor-scroll-sync";
import { sessionCanSave, sessionDirty, sessionExitBlocked } from "./editor-session-state";
import {
	captureEditorSnapshot,
	computeEditorConflictDiff,
	encodeEditorSnapshot,
} from "./editor-worker-client";
import type { EditorWorkingCopy, WorkingCopyOptions } from "./editor-working-copy";
import { type MonacoDocumentStatus, MonacoEditor, type MonacoEditorHandle } from "./MonacoEditor";
import { MonacoSearchPanel } from "./MonacoSearchPanel";
import { monacoHostVisible } from "./monaco-scroll";
import { type EditorState, isDirty, reloaded } from "./save-state";
import { createScrollFollower } from "./scroll-follower";

const DiffView = lazy(() => import("../diff/DiffView").then((m) => ({ default: m.DiffView })));
const FileEditorPreview = lazy(() =>
	import("./FileEditorPreview").then((m) => ({ default: m.FileEditorPreview })),
);
const PREVIEW_BYTES = 1024 * 1024;
// Both conflict inputs are bounded prefixes; even the small diff is computed in a Worker.
const CONFLICT_DIFF_CHARS = 32 * 1024;

export interface FileEditorContentProps {
	filePath: string;
	/** Protocol override (default raw-v2); writing requires negotiated durable capabilities. */
	rawProtocol?: boolean;
	rawEncoding?: EditorRawEncoding;
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

/** Every consumer is authorized before attaching a realm-local working copy. */
export function FileEditorContent(props: FileEditorContentProps) {
	const recovery = useEditorRecoveryHost(props);
	const binding = <FileEditorBinding key={editorRecoveryScopeIdentity(props)} {...props} />;
	return recovery ? binding : <EditorRecoveryBoundary {...props}>{binding}</EditorRecoveryBoundary>;
}

function FileEditorBinding(props: FileEditorContentProps) {
	const { t } = useTranslation("narrator");
	const [copy, setCopy] = useState<EditorWorkingCopy | null>(null);
	const recovery = useEditorRecoveryHost(props);
	const [rawV2] = useState(
		() =>
			(props.rawProtocol !== undefined
				? readEditorProtocol(props.rawProtocol)
				: (recovery?.protocol ?? readEditorProtocol())) === "raw-v2",
	);
	const [error, setError] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);
	const latest = useRef(t);
	latest.current = t;
	const { narratorId, filePath, deviceId = "local", referenceOrigin = false } = props;
	const visible = useEditorPanelVisible();
	const retainedView = useRetainedEditorView(visible);
	const leaseRef = useRef<EditorDocumentLease | null>(null);
	const controllerRef = useRef<AbortController | null>(null);
	const unregisterRef = useRef<(() => void) | undefined>(undefined);
	const viewState = useRef<import("monaco-editor").editor.ICodeEditorViewState | null>(null);
	useEffect(
		() => () => {
			controllerRef.current?.abort();
			controllerRef.current = null;
			unregisterRef.current?.();
			leaseRef.current?.release();
			leaseRef.current = null;
		},
		[],
	);
	useLayoutEffect(() => {
		if (copy === leaseRef.current?.copy) leaseRef.current?.setVisible(retainedView);
	}, [retainedView, copy]);
	// One shared disk-state entry per working copy; only a foreground view probes.
	const diskView = useRef<ReturnType<typeof editorDiskStateRegistry.attach> | null>(null);
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	useEffect(() => {
		if (!copy) return;
		const view = editorDiskStateRegistry.attach(copy, visibleRef.current);
		diskView.current = view;
		return () => {
			view.detach();
			if (diskView.current === view) diskView.current = null;
		};
	}, [copy]);
	useEffect(() => {
		diskView.current?.setVisible(visible);
	}, [visible]);
	useEffect(() => {
		if (!visible && !copy && !leaseRef.current) {
			controllerRef.current?.abort();
			controllerRef.current = null;
		}
	}, [visible, copy]);
	useEffect(() => {
		void retry;
		if (copy || !visible || leaseRef.current || controllerRef.current) return;
		setError(null);
		const controller = new AbortController();
		controllerRef.current = controller;
		const viewing = (async () => {
			const readMode =
				rawV2 && narratorId
					? (recovery?.readMode ??
						(await editorDocumentApi.readMode(
							narratorId,
							{ path: filePath, deviceId, origin: referenceOrigin ? "reference" : "legacy" },
							controller.signal,
						)))
					: deviceId !== "local"
						? "bounded-preview"
						: "text-v1";
			controller.signal.throwIfAborted();
			if (rawV2) recovery?.setReadMode(readMode);
			const readOnly = !narratorId || (deviceId !== "local" && readMode !== "raw-v2");
			const options: WorkingCopyOptions = {
				narratorId: narratorId ?? "",
				path: filePath,
				deviceId,
				...(readMode === "raw-v2" && narratorId
					? { protocol: "raw-v2" as const, encodingHint: props.rawEncoding }
					: {}),
				origin: () => (referenceOrigin ? "reference" : "legacy"),
				translate: (key, defaultValue) => latest.current(`fileEditor.${key}`, { defaultValue }),
				...(readOnly
					? {
							readOnlySource: async (signal: AbortSignal) => {
								const boundedSignal = AbortSignal.any([
									signal,
									AbortSignal.timeout(FILE_REFERENCE_READ_TIMEOUT_MS),
								]);
								if ((referenceOrigin || deviceId !== "local") && !narratorId)
									throw new Error(latest.current("fileEditor.missingContext"));
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
			};
			return editorDocumentRegistry.acquire(options, controller.signal, () => {
				controllerRef.current?.abort();
				leaseRef.current?.release();
				leaseRef.current = null;
				controllerRef.current = null;
				setCopy(null);
			});
		})()
			.then((lease) => {
				if (controller.signal.aborted) {
					lease.release();
					return null;
				}
				leaseRef.current = lease;
				setCopy(lease.copy);
				void lease.copy.ensureLoaded().catch((cause) => {
					if (!controller.signal.aborted)
						setError(cause instanceof Error ? cause.message : String(cause));
				});
				return lease.copy;
			})
			.catch((cause) => {
				if (controllerRef.current === controller) controllerRef.current = null;
				if (!controller.signal.aborted)
					setError(cause instanceof Error ? cause.message : String(cause));
				return null;
			});
		unregisterRef.current?.();
		unregisterRef.current = recovery?.registerViewing(viewing);
	}, [
		narratorId,
		filePath,
		deviceId,
		referenceOrigin,
		retry,
		recovery,
		visible,
		copy,
		rawV2,
		props.rawEncoding,
	]);
	if (error)
		return (
			<Center h="100%">
				<Group gap="xs">
					<Text c="red" size="sm">
						{error}
					</Text>
					<Button
						size="xs"
						onClick={() => {
							controllerRef.current?.abort();
							controllerRef.current = null;
							leaseRef.current?.release();
							leaseRef.current = null;
							setCopy(null);
							setRetry((value) => value + 1);
						}}
					>
						{t("fileTree.retry")}
					</Button>
				</Group>
			</Center>
		);
	if (!copy)
		return (
			<Center h="100%">
				<Loader size="sm" />
			</Center>
		);
	return <FileEditorDocument {...props} workingCopy={copy} viewState={viewState} />;
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
	workingCopy,
	viewState,
}: FileEditorContentProps & {
	workingCopy: EditorWorkingCopy;
	viewState: { current: import("monaco-editor").editor.ICodeEditorViewState | null };
}) {
	const { t } = useTranslation("narrator");
	const visible = useEditorPanelVisible();
	const isMobileViewport = useMobileViewport();
	const onDirtyChangeRef = useRef(onDirtyChange);
	onDirtyChangeRef.current = onDirtyChange;
	const publishedExitBlocked = useRef(false);
	const tRef = useRef(t);
	tRef.current = t;
	const scope = useFileReferenceScope();
	const publishSelection = onFileReferenceSelectionChange ?? scope.setSelection;
	// Session callbacks outlive renders; always invoke the latest publisher.
	const publishSelectionRef = useRef(publishSelection);
	publishSelectionRef.current = publishSelection;
	const editorRef = useRef<MonacoEditorHandle | null>(null);
	const [editor, setEditor] = useState<ReturnType<MonacoEditorHandle["getEditor"]>>(null);
	const documentKey = workingCopy.key;
	const state = useSyncExternalStore(
		workingCopy.subscribe,
		workingCopy.getSnapshot,
		workingCopy.getSnapshot,
	);
	const [history, setHistory] = useState<MonacoDocumentStatus | null>(null);
	const [editorError, setEditorError] = useState<string | null>(null);
	// Selection is high-frequency during drag-select. Keep it in a ref so intermediate
	// cursor moves never re-render this panel (or the dock context built from it).
	const editorSelectionRef = useRef<FileSelection | null>(null);
	const [lineWrapping, setLineWrapping] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	// Server-declared capabilities of the current authorization decide editability.
	// Only an older server that declares none keeps the original device heuristic.
	const canWrite =
		!!narratorId &&
		!state.invalidated &&
		(state.protocol === "raw-v2"
			? !!(
					state.codecSafe &&
					state.formatReady &&
					state.capabilities?.stage &&
					state.capabilities.durableApply &&
					state.capabilities.durableQuery
				)
			: state.capabilities
				? state.capabilities.v1Save
				: deviceId === "local");
	const readOnly = !canWrite || !!state.formatProtected;
	const clipboard = useClipboard({ timeout: 1500 });
	const [downloading, setDownloading] = useState(false);
	const download = async () => {
		// Match the viewer: scoped/remote files must never use the broad local reader.
		if (referenceOrigin || deviceId !== "local" || downloading) return;
		setDownloading(true);
		try {
			const { blob, fileName } = await api.fsDownload(filePath);
			saveBlobAsFile(blob, fileName ?? filePanelBaseName(filePath));
		} catch (error) {
			notifications.show({
				color: "red",
				title: tRef.current("fileViewer.downloadFailed"),
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setDownloading(false);
		}
	};
	const modes = useMemo(() => availableModes(filePath), [filePath]);
	// The remembered default mode applies only where it makes sense for this file
	// (resolveInitialMode); "设为默认" writes the current mode back to the same key.
	const [savedModePref, setSavedModePref] = useState<EditorMode>(() => readEditorModePref());
	const [mode, setMode] = useState<EditorMode>(() =>
		resolveInitialMode(readEditorModePref(), availableModes(filePath)),
	);
	// applyContent runs inside the session (created before callbacks below exist), so
	// both the current mode and the preview regenerator reach it through refs.
	const modeRef = useRef(mode);
	modeRef.current = mode;
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
	const regeneratePreviewRef = useRef<() => void>(() => {});
	// Reading position kept across a disk reload: the preview keeps its fractional
	// scroll, the raw editor keeps its absolute scroll line.
	const previewScrollRef = useRef<HTMLDivElement | null>(null);
	const previewScrollFraction = useRef<number | null>(null);
	const previewLastScrollFraction = useRef<number | null>(null);
	const previewResumeAuthoritative = useRef(false);
	const previewVisible = useRef(visible);
	previewVisible.current = visible;
	const endPreviewResume = useCallback(() => {
		previewResumeAuthoritative.current = false;
		previewScrollFraction.current = null;
	}, []);
	const rememberPreviewScroll = useCallback(() => {
		const el = previewScrollRef.current;
		// Hiding removes rendered preview children in the same commit. Never let its
		// resulting zero-size/zero-scroll events replace the last visible position.
		if (
			!previewVisible.current ||
			!el ||
			previewScrollFraction.current !== null ||
			el.scrollHeight <= el.clientHeight
		)
			return;
		previewLastScrollFraction.current = scrollFraction(
			el.scrollTop,
			el.scrollHeight,
			el.clientHeight,
		);
	}, []);
	useLayoutEffect(() => {
		if (!visible && previewLastScrollFraction.current !== null) {
			previewScrollFraction.current = previewLastScrollFraction.current;
			previewResumeAuthoritative.current = true;
		}
	}, [visible]);
	const splitContainerRef = useRef<HTMLDivElement | null>(null);
	const [splitHorizontal, setSplitHorizontal] = useState(true);
	const session = workingCopy.session;
	useLayoutEffect(
		() =>
			workingCopy.subscribe(() => {
				const blocked = sessionExitBlocked(session.state);
				if (publishedExitBlocked.current !== blocked) {
					publishedExitBlocked.current = blocked;
					onDirtyChangeRef.current?.(blocked);
				}
			}),
		[workingCopy, session],
	);
	useEffect(
		() => () => {
			previewController.current?.abort();
		},
		[],
	);
	// Reload is document-owned, but each view preserves its own reading position.
	useEffect(
		() =>
			workingCopy.onWillApply((nextModel) => {
				const view = editorRef.current?.getEditor();
				const scrollTop = view?.getScrollTop?.();
				// setValue resets cursor/selection; reinstall this view's own state afterwards.
				const saved = view?.saveViewState?.() ?? null;
				editorSelectionRef.current = null;
				publishSelectionRef.current?.(null);
				const el = previewScrollRef.current;
				if (previewVisible.current && el && el.scrollHeight > el.clientHeight)
					previewLastScrollFraction.current = scrollFraction(
						el.scrollTop,
						el.scrollHeight,
						el.clientHeight,
					);
				previewScrollFraction.current = previewLastScrollFraction.current;
				return () => {
					if (nextModel !== undefined) view?.setModel(nextModel);
					if (saved) view?.restoreViewState?.(saved);
					if (scrollTop != null) view?.setScrollTop?.(scrollTop);
					if (modeRef.current !== "raw") regeneratePreviewRef.current();
					else {
						setPreviewText(null);
						setPreviewError(null);
					}
				};
			}),
		[workingCopy],
	);
	const load = () => {
		if (session.state.phase !== "idle") return;
		if (sessionDirty(session.state) && !window.confirm(tRef.current("fileEditor.confirmReload")))
			return;
		previewController.current?.abort();
		void session.load();
	};
	const attachedViewPin = useRef<(() => void) | undefined>(undefined);
	const handleReady = useCallback(
		(handle: MonacoEditorHandle | null) => {
			attachedViewPin.current?.();
			attachedViewPin.current = handle ? workingCopy.pin("view") : undefined;
			editorRef.current = handle;
			setEditor(handle?.getEditor() ?? null);
		},
		[workingCopy],
	);
	const handleChange = useCallback((status: MonacoDocumentStatus) => {
		setHistory(status);
	}, []);
	const handleSave = useCallback(() => {
		if (canWrite) void session.save();
	}, [session, canWrite]);
	const openSearch = useCallback(() => {
		if (modeRef.current !== "split") setMode("raw");
		setSearchOpen(true);
	}, []);
	const handleSelection = useCallback(
		(next: FileSelection | null, explicit: boolean) => {
			const previous = editorSelectionRef.current;
			editorSelectionRef.current = next;
			// MonacoEditor already coalesces pointer-drag cursor events; this callback
			// only runs for ownership-relevant moments (mouseup / keyboard / focus).
			if (explicit) {
				publishSelection?.(
					session.state.baseHash && next && session.state.protocol !== "raw-v2"
						? {
								target: { deviceId, path: filePath, selection: next },
								label: filePanelBaseName(filePath),
								expectedHash: session.state.baseHash,
								dirty: sessionDirty(session.state),
							}
						: null,
					true,
				);
				return;
			}
			// Document flush / navigation reset clears the live selection without claiming
			// ownership. Drop this panel's published selection if it owned one.
			if (next === null && previous !== null) publishSelection?.(null, false);
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
		if (!visible || (mode !== "raw" && mode !== "split") || !dirty || phase !== "idle" || readOnly)
			return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			const host = editorRef.current?.getEditor()?.getDomNode?.();
			if (host && monacoHostVisible(host)) void session.verifyEquivalent(controller.signal);
		}, 750);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [visible, mode, dirty, phase, readOnly, session, revision, baseHash]);
	// Metadata refresh for the panel's CURRENT selection when dirty/hash identity
	// changes. Selection itself is not a dependency — drag-select must not re-enter
	// this path. Identity publish remains explicit (handleSelection).
	useEffect(() => {
		if (!visible || !baseHash) return;
		const next = editorSelectionRef.current;
		publishSelection?.(
			next && session.state.protocol !== "raw-v2"
				? {
						target: { deviceId, path: filePath, selection: next },
						label: filePanelBaseName(filePath),
						expectedHash: baseHash,
						dirty,
					}
				: null,
		);
	}, [visible, baseHash, deviceId, dirty, filePath, publishSelection, session.state.protocol]);
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
	// Only a CHANGE of explicit navigation returns to source — running on mount would
	// clobber a remembered non-raw default before the user ever sees it.
	const navigationRef = useRef(navigationKey);
	useLayoutEffect(() => {
		if (navigationRef.current === navigationKey) return;
		navigationRef.current = navigationKey;
		// Explicit host navigation wins before the child's passive Monaco reveal;
		// ordinary reattachment with the same navigation identity is not an intent.
		endPreviewResume();
		setMode("raw");
	}, [navigationKey, endPreviewResume]);
	useEffect(() => {
		if (mode === "raw") {
			previewController.current?.abort();
			setPreviewText(null);
		}
	}, [mode]);
	// keepCurrent: a disk reload regenerates the preview behind the existing one;
	// only an explicit mode switch or error replaces what is on screen.
	const generatePreview = useCallback(
		async (keepCurrent = false) => {
			previewController.current?.abort();
			if (!keepCurrent) {
				setPreviewText(null);
				setPreviewError(null);
			}
			const model = workingCopy.model;
			if (!visible || !model) return;
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
		},
		[workingCopy, visible],
	);
	regeneratePreviewRef.current = () => void generatePreview(true);
	// A remembered non-raw default means the panel OPENS in preview/split: generate
	// the first rendering once the model is ready, without waiting for a mode click.
	useEffect(() => {
		if (!visible || state.paged) {
			previewController.current?.abort();
			setPreviewText(null);
			setSearchOpen(false);
			publishSelectionRef.current?.(null);
			return;
		}
		if (state.loaded && mode !== "raw") void generatePreview(true);
	}, [visible, state.loaded, state.paged, mode, generatePreview]);
	// Split mode is a LIVE view: edits regenerate the preview behind the current one
	// (keepCurrent) after a short debounce, so typing never flashes a loader.
	useEffect(() => {
		if (!visible || mode !== "split" || revision == null) return;
		const timer = setTimeout(() => void generatePreview(true), 300);
		return () => clearTimeout(timer);
	}, [visible, mode, revision, generatePreview]);
	// Split direction follows the panel's own aspect ratio: wide panels split left/
	// right, tall (or narrow dock) panels stack the preview below the editor.
	useEffect(() => {
		if (!visible || state.paged || mode !== "split") return;
		const el = splitContainerRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const update = () => setSplitHorizontal(el.clientWidth >= el.clientHeight);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
	}, [visible, state.paged, mode]);
	// Bidirectional scroll sync. Both preview kinds carry `data-line` anchors:
	// markdown blocks get them from MarkdownContent, node-tree rows from the
	// parser (structured-parse stamps each entry's source line). Both directions
	// interpolate SOURCE LINES between neighbouring anchors — proportional
	// height sync drifts by whole screens because rendered block height is not
	// linear in line count. The proportional fallback remains for anchorless
	// content (parse error, oversized doc). Targets are approached through rAF
	// followers (exponential ease) instead of throttled instant writes, so the
	// following pane glides at display refresh rate.
	const lineAnchorsRef = useRef<LineAnchor[]>([]);
	const scheduleAnchorRefreshRef = useRef<(() => void) | null>(null);
	useEffect(() => {
		if (!visible || mode !== "split" || !editor) return;
		const previewEl = previewScrollRef.current;
		if (!previewEl || !editor.onDidScrollChange) return;
		// Programmatic writes are recognized by matching the value the follower
		// last wrote; any other scroll event is the user taking over that side.
		// (A write counter desyncs when the follower emits dozens of writes per
		// second and when native momentum scrolling interleaves.)
		const lastWritten = { preview: Number.NaN, editor: Number.NaN };
		const previewFollower = createScrollFollower(
			() => previewEl.scrollTop,
			(value) => {
				lastWritten.preview = value;
				previewEl.scrollTop = value;
			},
		);
		const editorFollower = createScrollFollower(
			() => editor.getScrollTop(),
			(value) => {
				lastWritten.editor = value;
				editor.setScrollTop(value);
			},
		);
		// Fractional top line of the editor viewport — VS Code's getVisibleLine:
		// the integer line plus the column's progress through it.
		const editorTopLine = (): number | null => {
			const model = editor.getModel?.();
			const start = editor.getVisibleRanges?.()[0];
			if (!model || !start) return null;
			return (
				start.startLineNumber -
				1 +
				(start.startColumn - 1) / (model.getLineLength(start.startLineNumber) + 2)
			);
		};
		/** Document-space editor offset for a fractional source line. */
		const editorScrollTopForLine = (line: number): number | null => {
			const base = Math.floor(line);
			const top = editor.getTopForLineNumber?.(base + 1);
			if (top == null) return null;
			const next = editor.getTopForLineNumber(base + 2);
			const lineHeight = next > top ? next - top : 0;
			return top + (line - base) * lineHeight;
		};
		// Anchors are layout-derived and scroll-independent, so they are collected
		// once and invalidated by DOM/layout observers — collecting on every
		// scroll event (querySelectorAll + getBoundingClientRect per anchor)
		// forced a synchronous layout read in the middle of scrolling.
		const refreshAnchors = () => {
			const model = editor.getModel?.();
			lineAnchorsRef.current = model ? collectPreviewAnchors(previewEl, model.getLineCount()) : [];
		};
		const syncPreviewToEditor = () => {
			const anchors = lineAnchorsRef.current;
			const line = anchors.length ? editorTopLine() : null;
			const target = line != null ? scrollTopForLine(anchors, line) : null;
			const nextScrollTop =
				target ??
				fractionToScroll(
					scrollFraction(
						editor.getScrollTop(),
						editor.getScrollHeight(),
						editor.getLayoutInfo().height,
					),
					previewEl.scrollHeight,
					previewEl.clientHeight,
				);
			if (Math.abs(previewEl.scrollTop - nextScrollTop) < 1 && !previewFollower.active) return;
			previewFollower.setTarget(nextScrollTop);
		};
		const syncEditorToPreview = () => {
			const anchors = lineAnchorsRef.current;
			const model = editor.getModel?.();
			const anchored =
				anchors.length && model
					? editorScrollTopForLine(
							lineForScrollTop(anchors, previewEl.scrollTop, model.getLineCount()),
						)
					: null;
			const nextScrollTop =
				anchored ??
				fractionToScroll(
					scrollFraction(previewEl.scrollTop, previewEl.scrollHeight, previewEl.clientHeight),
					editor.getScrollHeight(),
					editor.getLayoutInfo().height,
				);
			if (Math.abs(editor.getScrollTop() - nextScrollTop) < 1 && !editorFollower.active) return;
			editorFollower.setTarget(nextScrollTop);
		};
		const sourceHost = editor.getDomNode?.();
		const userIntent = (event: Event) => {
			if (event.type === "keydown") {
				const key = event as KeyboardEvent;
				if (
					["Control", "Meta", "Alt", "Shift"].includes(key.key) ||
					((key.ctrlKey || key.metaKey) && key.key.toLowerCase() === "f")
				)
					return;
			}
			endPreviewResume();
		};
		// A recreated source view emits layout/recovery scrolls before its first paint.
		// Until user intent arrives, resume from the preview's saved reading position,
		// not a lossy source-line round trip that creeps upward on every tab switch.
		for (const type of ["wheel", "pointerdown", "keydown"]) {
			sourceHost?.addEventListener(type, userIntent, true);
			previewEl.addEventListener(type, userIntent, true);
		}
		const subscription = editor.onDidScrollChange(() => {
			if (
				previewResumeAuthoritative.current ||
				Math.abs(editor.getScrollTop() - lastWritten.editor) < 1
			)
				return;
			editorFollower.cancel();
			syncPreviewToEditor();
		});
		const previewListener = () => {
			if (Math.abs(previewEl.scrollTop - lastWritten.preview) < 1) return;
			previewFollower.cancel();
			syncEditorToPreview();
		};
		previewEl.addEventListener("scroll", previewListener, { passive: true });
		refreshAnchors();
		// FileEditorPreview is lazy and syntax highlighting/diagrams may add DOM
		// after this effect. Recollect anchors when the rendered subtree changes
		// (debounced — highlighting arrives in bursts), then realign: the two
		// maps are exact inverses, so realigning after a live-preview refresh is
		// a drift correction, never a fight with the side the user is scrolling.
		const anchorObserver = observePreviewAnchorChanges(previewEl, () => {
			refreshAnchors();
			if (previewResumeAuthoritative.current) syncEditorToPreview();
			else syncPreviewToEditor();
		});
		scheduleAnchorRefreshRef.current = anchorObserver.schedule;
		return () => {
			subscription.dispose();
			for (const type of ["wheel", "pointerdown", "keydown"]) {
				sourceHost?.removeEventListener(type, userIntent, true);
				previewEl.removeEventListener(type, userIntent, true);
			}
			previewEl.removeEventListener("scroll", previewListener);
			scheduleAnchorRefreshRef.current = null;
			anchorObserver.dispose();
			previewFollower.dispose();
			editorFollower.dispose();
		};
	}, [visible, mode, editor, endPreviewResume]);
	// React may reuse every preview row and only update data-line; an unchanged
	// preview can also have a new model line count (the document-end sentinel).
	// Schedule after the commit, retaining the observers' debounce and teardown.
	useLayoutEffect(() => {
		if (previewText !== null) scheduleAnchorRefreshRef.current?.();
	}, [previewText]);
	// Restore the fractional reading position once the regenerated preview renders.
	// Fraction (not absolute pixels) because the new content may be longer or shorter.
	useLayoutEffect(() => {
		const el = previewScrollRef.current;
		const fraction = previewScrollFraction.current;
		if (!visible || previewText == null || !el || fraction == null) return;
		previewScrollFraction.current = null;
		previewLastScrollFraction.current = fraction;
		el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
	}, [visible, previewText]);
	const switchMode = (next: EditorMode) => {
		previewController.current?.abort();
		setMode(next);
		setPreviewText(null);
		setPreviewError(null);
		previewScrollFraction.current = null;
		previewLastScrollFraction.current = null;
		previewResumeAuthoritative.current = false;
		if (next === "raw") return;
		setSearchOpen(false);
		void generatePreview();
	};
	const conflict = state?.conflict;
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry is an explicit bounded conflict-read request
	useEffect(() => {
		setConflictDiff(null);
		setConflictError(null);
		const model = workingCopy.model;
		if (!visible || !conflict || !model) return;
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
	}, [visible, conflict, session, conflictRetry]);
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
	if (state.paged && workingCopy.pagedDocument)
		return (
			<EditorPagedView
				narratorId={narratorId ?? ""}
				document={workingCopy.pagedDocument}
				expectedHash={state.baseHash}
				onReload={() => {
					void session.load();
				}}
				visible={visible}
			/>
		);
	const saving = state.phase !== "idle" && state.phase !== "unknown";
	// Split keeps the editor fully interactive beside the preview; preview/node
	// modes keep it mounted but inert behind the rendered overlay.
	const split = mode === "split";
	const editorActive = visible && (mode === "raw" || split);
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
			<Group
				justify="space-between"
				gap="xs"
				px="xs"
				py={6}
				wrap={isMobileViewport ? "wrap" : "nowrap"}
				style={{ flexShrink: 0 }}
			>
				<Group
					gap={6}
					wrap="nowrap"
					style={{ minWidth: 0, flex: 1, flexBasis: isMobileViewport ? "100%" : undefined }}
				>
					<Text
						size="xs"
						c="dimmed"
						truncate="end"
						title={filePath}
						style={{ minWidth: 0, flex: 1 }}
					>
						{filePath}
					</Text>
					{readOnly && (
						<Badge
							size="xs"
							color="gray"
							title={
								state.capabilities?.writeUnavailableReason
									? t(`fileEditor.${state.capabilities.writeUnavailableReason}`)
									: undefined
							}
						>
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
				<Box style={{ maxWidth: "100%", overflowX: "auto", flexShrink: 0 }}>
					<Group gap={4} wrap="nowrap" style={{ width: "max-content" }}>
						<Tooltip label={t("contextMenu_copyFilePath")} openDelay={200}>
							<ActionIcon
								variant="subtle"
								color="gray"
								size="sm"
								aria-label={t("contextMenu_copyFilePath")}
								onClick={() => clipboard.copy(filePath)}
							>
								{clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
							</ActionIcon>
						</Tooltip>
						{!referenceOrigin && deviceId === "local" && (
							<Tooltip label={t("fileViewer.download")} openDelay={200}>
								<ActionIcon
									variant="subtle"
									color="gray"
									size="sm"
									aria-label={t("fileViewer.download")}
									loading={downloading}
									onClick={() => void download()}
								>
									<IconDownload size={14} />
								</ActionIcon>
							</Tooltip>
						)}
						<Tooltip label={`${t("fileEditor.undo")} (Ctrl/Cmd+Z)`} openDelay={200}>
							<ActionIcon
								variant="subtle"
								size="sm"
								aria-label={t("fileEditor.undo")}
								disabled={readOnly || state.loading || !editorActive || !history?.canUndo}
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
								disabled={readOnly || state.loading || !editorActive || !history?.canRedo}
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
								disabled={!editorActive || history?.longLine}
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
						{canWrite && (
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
				</Box>
			</Group>
			{deviceId !== "local" && workingCopy.options.readOnlySource && (
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
				<Group gap={8} px="xs" pb={6} wrap="nowrap" style={{ flexShrink: 0, overflowX: "auto" }}>
					<SegmentedControl
						size="xs"
						value={mode}
						onChange={(value) => void switchMode(value as EditorMode)}
						data={[
							"raw" as const,
							"split" as const,
							...modes.filter((value) => value !== "raw"),
						].map((value) => ({
							value,
							label:
								value === "raw"
									? t(readOnly ? "fileViewer.mode_raw" : "fileEditor.edit")
									: value === "split"
										? t("fileEditor.modeSplit")
										: t(value === "preview" ? "fileViewer.mode_preview" : "fileViewer.mode_node"),
						}))}
					/>
					{mode !== savedModePref && (
						<Anchor
							component="button"
							type="button"
							size="xs"
							style={{ flexShrink: 0, whiteSpace: "nowrap" }}
							onClick={() => {
								writeEditorModePref(mode);
								setSavedModePref(mode);
							}}
						>
							{t("fileEditor.setAsDefaultMode")}
						</Anchor>
					)}
				</Group>
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
			{state.externalDisk && !conflict && (
				<Alert color="yellow" radius={0} data-editor-external-disk={state.externalDisk}>
					<Text size="xs">
						{state.externalDisk === "deleted"
							? t("fileEditor.externalDiskDeleted")
							: t("fileEditor.externalDiskModified")}
					</Text>
				</Alert>
			)}
			{state.phase === "unknown" && (
				<Alert color="yellow" radius={0}>
					<Text size="xs">
						{t("fileEditor.unknownSave", {
							defaultValue:
								"The save result needs verification. Your draft is retained; another save is blocked.",
						})}
					</Text>
					{state.receiptError && (
						<Text size="xs" c="red">
							{state.receiptError}
						</Text>
					)}
					<Button
						size="xs"
						loading={!!state.checkingReceipt}
						onClick={() => void session.reconcile()}
					>
						{t("fileEditor.checkSave", { defaultValue: "Check save result" })}
					</Button>
				</Alert>
			)}
			{state.invalidated && state.phase !== "unknown" && state.receipt && (
				<Alert color="yellow" radius={0}>
					<EditorReceiptNotice state={state} />
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
							{t(
								state.protocol === "raw-v2" ? "fileEditor.reload" : "fileEditor.conflictTakeTheirs",
							)}
						</Button>
					</Group>
				</Alert>
			)}
			{searchOpen && editorActive && editor && (
				<MonacoSearchPanel
					editor={editor}
					readOnly={readOnly || state.loading || !!state.invalidated}
					onSave={handleSave}
					onNavigationIntent={endPreviewResume}
					onClose={() => setSearchOpen(false)}
				/>
			)}
			<Box
				ref={splitContainerRef}
				style={{
					flex: 1,
					minHeight: 0,
					position: "relative",
					display: "flex",
					flexDirection: split ? (splitHorizontal ? "row" : "column") : "column",
				}}
			>
				<Box
					data-file-editor-source
					inert={!editorActive}
					aria-hidden={!editorActive}
					style={
						split
							? { position: "relative", flex: 1, minWidth: 0, minHeight: 0 }
							: {
									position: "absolute",
									inset: 0,
									visibility: mode === "raw" ? "inherit" : "hidden",
								}
					}
				>
					{(workingCopy.protocol !== "raw-v2" || workingCopy.model) && (
						<MonacoEditor
							initialValue=""
							model={workingCopy.model ?? undefined}
							forcePlaintext={
								state.protocol === "raw-v2" && workingCopy.model?.getLanguageId() === "plaintext"
							}
							documentKey={documentKey}
							filePath={filePath}
							onReady={handleReady}
							onDocumentChange={handleChange}
							onSelectionChange={handleSelection}
							onSearchRequested={openSearch}
							onSave={handleSave}
							onError={(error) => setEditorError(error.message)}
							selection={selection}
							navigationRequestId={navigationRequestId}
							isFormatProtected={() => !!workingCopy.session.state.formatProtected}
							readOnly={readOnly || state.loading || !!state.invalidated}
							lineWrapping={lineWrapping}
							visible={editorActive}
							viewState={viewState}
						/>
					)}
				</Box>
				{mode !== "raw" && (
					<Box
						ref={previewScrollRef}
						data-file-editor-preview={mode}
						onScroll={rememberPreviewScroll}
						style={
							split
								? {
										position: "relative",
										flex: 1,
										minWidth: 0,
										minHeight: 0,
										overflow: "auto",
										borderLeft: splitHorizontal
											? "1px solid var(--mantine-color-dark-4)"
											: undefined,
										borderTop: splitHorizontal
											? undefined
											: "1px solid var(--mantine-color-dark-4)",
									}
								: { position: "absolute", inset: 0, overflow: "auto" }
						}
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
								{visible && (
									<FileEditorPreview
										text={previewText}
										mode={split ? splitRenderMode(modes) : mode}
										filePath={filePath}
										deviceId={deviceId}
										narratorId={narratorId}
										withSourceLines={split}
									/>
								)}
							</Suspense>
						)}
					</Box>
				)}
			</Box>
		</Box>
	);
}

export { reloaded };
