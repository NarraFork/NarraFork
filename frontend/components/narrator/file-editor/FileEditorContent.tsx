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
import { useClipboard } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
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
} from "react";
import { useTranslation } from "react-i18next";
import { useMobileViewport } from "../../../hooks/useMobileViewport";
import { api } from "../../../lib/api";
import { request } from "../../../lib/api/client";
import { fileReferenceApi } from "../../../lib/api/file-references";
import { saveBlobAsFile } from "../../../lib/file-download";
import { getShikiLang } from "../../../lib/shiki-lang";
import { useFileReferenceScope } from "../composer/FileReferenceScope";
import type { DiffLine } from "../diff/DiffView";
import { availableModes } from "../file-viewer/file-viewer-modes";
import { filePanelBaseName } from "../panels/panel-kind";
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
	// Selection is high-frequency during drag-select. Keep it in a ref so intermediate
	// cursor moves never re-render this panel (or the dock context built from it).
	const editorSelectionRef = useRef<FileSelection | null>(null);
	const [lineWrapping, setLineWrapping] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const readOnly = deviceId !== "local" || !narratorId;
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
	const splitContainerRef = useRef<HTMLDivElement | null>(null);
	const [splitHorizontal, setSplitHorizontal] = useState(true);
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
					// Document identity changed: drop selection ownership without a React
					// render storm. Non-explicit Monaco callbacks only clear the ref.
					editorSelectionRef.current = null;
					publishSelectionRef.current?.(null);
					if (modeRef.current === "raw") {
						setPreviewText(null);
						setPreviewError(null);
					} else {
						// Preview/node mode: remember the reading position and KEEP the current
						// rendering on screen — the regenerated preview replaces it atomically,
						// so a reload never flashes a loader over what the user was reading.
						const el = previewScrollRef.current;
						if (el) {
							const range = el.scrollHeight - el.clientHeight;
							previewScrollFraction.current = range > 0 ? el.scrollTop / range : 0;
						}
					}
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
					// model.setValue resets Monaco's view position; restore it afterwards so a
					// reload does not teleport the raw editor back to the top of the file.
					const editor = editorRef.current?.getEditor();
					const scrollTop = editor?.getScrollTop?.() ?? null;
					model.setValue(text);
					if (scrollTop != null && scrollTop > 0) editor?.setScrollTop?.(scrollTop);
					// Reloading from disk must not kick the user out of the rendered view:
					// keep preview/node mode and regenerate it from the new content instead.
					if (modeRef.current !== "raw") regeneratePreviewRef.current();
					return {
						revision: model.getVersionId(),
						alternativeVersionId: model.getAlternativeVersionId(),
						length: model.getValueLength(),
					};
				},
				onChange: (next) => {
					// Publish before React commits: a close/navigation in the same turn as
					// typing or starting a save must already see the exit guard.
					const blocked = sessionExitBlocked(next);
					if (publishedExitBlocked.current !== blocked) {
						publishedExitBlocked.current = blocked;
						onDirtyChangeRef.current?.(blocked);
					}
					setState(next);
				},
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
	// Metadata refresh for the panel's CURRENT selection when dirty/hash identity
	// changes. Selection itself is not a dependency — drag-select must not re-enter
	// this path. Identity publish remains explicit (handleSelection).
	useEffect(() => {
		if (!baseHash) return;
		const next = editorSelectionRef.current;
		publishSelection?.(
			next
				? {
						target: { deviceId, path: filePath, selection: next },
						label: filePanelBaseName(filePath),
						expectedHash: baseHash,
						dirty,
					}
				: null,
		);
	}, [baseHash, deviceId, dirty, filePath, publishSelection]);
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
	useEffect(() => {
		if (navigationRef.current === navigationKey) return;
		navigationRef.current = navigationKey;
		setMode("raw");
	}, [navigationKey]);
	useEffect(() => {
		if (mode === "raw") {
			previewController.current?.abort();
			setPreviewText(null);
		}
	}, [mode]);
	// keepCurrent: a disk reload regenerates the preview behind the existing one;
	// only an explicit mode switch or error replaces what is on screen.
	const generatePreview = useCallback(async (keepCurrent = false) => {
		previewController.current?.abort();
		if (!keepCurrent) {
			setPreviewText(null);
			setPreviewError(null);
		}
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
	}, []);
	regeneratePreviewRef.current = () => void generatePreview(true);
	// A remembered non-raw default means the panel OPENS in preview/split: generate
	// the first rendering once the model is ready, without waiting for a mode click.
	const previewKickRef = useRef(false);
	useEffect(() => {
		if (previewKickRef.current || !editor || mode === "raw") return;
		previewKickRef.current = true;
		void generatePreview(true);
	}, [editor, mode, generatePreview]);
	// Split mode is a LIVE view: edits regenerate the preview behind the current one
	// (keepCurrent) after a short debounce, so typing never flashes a loader.
	useEffect(() => {
		if (mode !== "split" || revision == null) return;
		const timer = setTimeout(() => void generatePreview(true), 300);
		return () => clearTimeout(timer);
	}, [mode, revision, generatePreview]);
	// Split direction follows the panel's own aspect ratio: wide panels split left/
	// right, tall (or narrow dock) panels stack the preview below the editor.
	useEffect(() => {
		if (mode !== "split") return;
		const el = splitContainerRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const update = () => setSplitHorizontal(el.clientWidth >= el.clientHeight);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
	}, [mode]);
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
		if (mode !== "split" || !editor) return;
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
		const subscription = editor.onDidScrollChange(() => {
			if (Math.abs(editor.getScrollTop() - lastWritten.editor) < 1) return;
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
			syncPreviewToEditor();
		});
		scheduleAnchorRefreshRef.current = anchorObserver.schedule;
		return () => {
			subscription.dispose();
			previewEl.removeEventListener("scroll", previewListener);
			scheduleAnchorRefreshRef.current = null;
			anchorObserver.dispose();
			previewFollower.dispose();
			editorFollower.dispose();
		};
	}, [mode, editor]);
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
		if (previewText == null || !el || fraction == null) return;
		previewScrollFraction.current = null;
		el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
	}, [previewText]);
	const switchMode = (next: EditorMode) => {
		previewController.current?.abort();
		setMode(next);
		setPreviewText(null);
		setPreviewError(null);
		previewScrollFraction.current = null;
		if (next === "raw") return;
		setSearchOpen(false);
		void generatePreview();
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
	// Split keeps the editor fully interactive beside the preview; preview/node
	// modes keep it mounted but inert behind the rendered overlay.
	const split = mode === "split";
	const editorActive = mode === "raw" || split;
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
				</Box>
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
			{searchOpen && editorActive && editor && (
				<MonacoSearchPanel
					editor={editor}
					readOnly={readOnly || state.loading}
					onSave={handleSave}
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
						visible={editorActive}
					/>
				</Box>
				{mode !== "raw" && (
					<Box
						ref={previewScrollRef}
						data-file-editor-preview={mode}
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
								<FileEditorPreview
									text={previewText}
									mode={split ? splitRenderMode(modes) : mode}
									filePath={filePath}
									deviceId={deviceId}
									narratorId={narratorId}
									withSourceLines={split}
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
