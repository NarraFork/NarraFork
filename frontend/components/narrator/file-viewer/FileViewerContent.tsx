/**
 * FileViewerContent.tsx — binary dock previews and the legacy off-dock reader.
 * Text dock panels use FileEditorContent directly; NarratorPanel's mobile drawer
 * still uses the text modes here, so they remain backward-compatible.
 *
 * Reads the file's CURRENT on-disk content through `/api/fs/preview` (the same
 * endpoint and the same bounded streaming read the "view this file" modal uses),
 * then offers up to three ways to look at it:
 *
 *   - preview : markdown rendered via MarkdownContent (markdown files only)
 *   - node    : json / toml / ini as a collapsible key/value tree
 *   - raw     : the source with Shiki highlighting (ContentViewer)
 *
 * Files with no structure and no markdown (code, txt, yaml) only get `raw`, so
 * the mode switch is hidden rather than shown with one option.
 *
 * Bounded on purpose, mirroring FilePreviewModal: the text is capped while
 * streaming (`readTextPreview` cancels the reader at the cap, so a huge file
 * never fully lands in memory) and the node tree has its own depth/count caps.
 * Images and PDFs use bounded blob previews; images also open the fullscreen viewer.
 */

import {
	ActionIcon,
	Box,
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
	type FileTarget,
} from "@shared/file-reference";
import { localFileDirectory } from "@shared/markdown-file-path";
import { IconCheck, IconCopy, IconDownload, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFileSystemCapability } from "../../../hooks/usePlatform";
import { ApiError, api, authorizedFetch, readFetchError } from "../../../lib/api";
import { fileReferenceApi } from "../../../lib/api/file-references";
import { saveBlobAsFile } from "../../../lib/file-download";
import { formatLocaleNumber } from "../../../lib/intl-format";
import { getShikiLang } from "../../../lib/shiki-lang";
import { useImageViewer } from "../../common/image-viewer-context";
import { TruncatedText } from "../../common/TruncatedText";
import { ContentViewer } from "../ContentViewer";
import {
	getFilePreviewType,
	MAX_FILE_PREVIEW_BLOB_BYTES,
	readTextPreview,
} from "../FilePreviewModal";
import { FileReferenceScopeProvider, useFileReferenceScope } from "../FileReferenceScope";
import { MonacoEditor } from "../file-editor/MonacoEditor";
import { MAX_FILE_HIGHLIGHT_CODE_CHARS } from "../highlight-cache";
import { MarkdownContent } from "../MarkdownContent";
import { filePanelBaseName } from "../panels/panel-kind";
import { availableModes, type FileViewerMode } from "./file-viewer-modes";
import { StructuredNodeTree } from "./StructuredNodeTree";
import {
	detectStructuredFormat,
	isStructuredParseError,
	parseStructured,
	type StructuredNode,
} from "./structured-parse";

export { availableModes, type FileViewerMode, isMarkdownPath } from "./file-viewer-modes";

/**
 * Character cap for the viewer's streaming read, aligned with the backend's own
 * text limit (`MAX_TEXT_PREVIEW_BYTES` = 1 MB in server/routes/fs.ts) rather
 * than the tighter cap the hover preview modal uses.
 *
 * The modal is a transient peek where a tight cap is the right trade; a docked
 * viewer is where you go to actually READ a file, and truncating a 300k-char
 * source file at 120k made the panel quietly useless for exactly the files it
 * exists to open. A UTF-8 character never encodes in less than one byte, so a
 * response the backend accepted (≤ 1 MB) can never carry more characters than
 * this cap: it is only ever reached for payloads the backend would already have
 * refused with 413. In practice the panel now shows every file the API serves.
 *
 * Rendering stays bounded independently, and by DEGRADING rather than cutting:
 * Raw source has its own bounded file highlighting budget (rather than the
 * chat preview's 20k cap); MarkdownContent falls back to plain text past 80k.
 * Both still show the whole document, so raising this cap cannot silently clip it.
 *
 * Kept at the backend's byte ceiling EXACTLY (1024 * 1024, not a round 1e6):
 * 1,000,000 would clip the last 48,576 characters of an ASCII file the API had
 * served in full. `file-viewer-limits.test.ts` pins this alignment.
 */
export const MAX_FILE_VIEWER_TEXT_CHARS = 1024 * 1024;

/** Why node mode cannot render, when it cannot. */
export type NodeUnavailableReason = "truncated" | "parse-error";

/**
 * Decide whether node mode can render, and if not, WHY.
 *
 * Extracted as a pure function because conflating its two outcomes is a silent
 * UX bug rather than a crash: a truncated file whose parse was skipped used to
 * surface "could not parse as json", blaming the file's syntax for what was
 * really our own fetch cap — and it appeared alongside the truncation notice, so
 * the panel said the same thing twice in two incompatible ways.
 *
 * `parsed` is the parse result, or null when no parse was attempted (non-
 * structured file, nothing loaded yet, or a truncated read — whose tail is cut
 * mid-token, so parsing it could produce a partial document presented as whole).
 */
export function resolveNodeUnavailable(args: {
	structuredFormat: string | null;
	truncated: boolean;
	parseFailed: boolean;
}): NodeUnavailableReason | null {
	if (args.structuredFormat == null) return null;
	// Truncation wins: the parse was never attempted, so a syntax verdict would be
	// fabricated.
	if (args.truncated) return "truncated";
	return args.parseFailed ? "parse-error" : null;
}

/** Same target-path grammar as markdown resolution and the dock/editor labels. */
export function fileBaseName(filePath: string): string {
	return filePanelBaseName(filePath);
}

/**
 * Header flex roles, named so the one rule that matters is stated once.
 *
 * The bug these fix: the filename was `flexShrink: 0` beside a separate flex
 * spacer, so a long name (an `api-request-<timestamp>-<id>.json` dump is ~55
 * chars) grew the row past the panel and pushed the mode switch and every action
 * button out of sight. In a `nowrap` row exactly one item may absorb the leftover
 * space and give it back — that is the filename, and the controls must hold their
 * size.
 *
 * `minWidth: 0` is the non-obvious half: a flex item's automatic minimum size is
 * its content width, so without it the name refuses to shrink below the full
 * string and `text-overflow: ellipsis` never engages, no matter what `flex` says.
 */
export const HEADER_FLEXIBLE_STYLE = { flex: 1, minWidth: 0 } as const;
export const HEADER_FIXED_STYLE = { flexShrink: 0 } as const;

interface LoadState {
	text: string | null;
	truncated: boolean;
	error: string | null;
	loading: boolean;
	hash?: string;
	target?: FileTarget;
}

const INITIAL_LOAD: LoadState = { text: null, truncated: false, error: null, loading: false };

export interface FileViewerContentProps {
	filePath: string;
	/** Scoped references never fall back to the unrestricted/local preview route. */
	narratorId?: string;
	deviceId?: string;
	/** References are text-only and cannot enter the legacy binary/download reader. */
	referenceOrigin?: boolean;
	selection?: FileSelection;
	highlightRequestId?: string;
	onOpenFileTarget?: (target: FileTarget) => void;
	onFileReferenceSelectionChange?: (selection: FileReferenceEditorSelection | null) => void;
}

/** Directory semantics come from the file's own device, not the browser URL. */
export function fileReferenceDirectory(filePath: string): string {
	const directory = localFileDirectory(filePath);
	return directory === "." ? "" : directory;
}

/** Inheriting a narrator scope must not silently change a legacy local reader's policy. */
export function fileViewerReadMode(
	narratorId: string | undefined,
	deviceId = "local",
	referenceOrigin = false,
): "legacy" | "scoped" | "missing-context" {
	if (!referenceOrigin && deviceId === "local") return "legacy";
	return narratorId ? "scoped" : "missing-context";
}

export function FileViewerContent({
	filePath,
	narratorId: narratorIdProp,
	deviceId = "local",
	referenceOrigin = false,
	selection,
	highlightRequestId,
	onOpenFileTarget,
	onFileReferenceSelectionChange,
}: FileViewerContentProps) {
	const { t } = useTranslation("narrator");
	const parentScope = useFileReferenceScope();
	const narratorId = narratorIdProp ?? parentScope.narratorId;
	const readerMode = fileViewerReadMode(narratorId, deviceId, referenceOrigin);
	const scopedNarratorId = readerMode === "scoped" ? narratorId : undefined;
	const publishSelection = onFileReferenceSelectionChange ?? parentScope.setSelection;
	const [sourceSelection, setSourceSelection] = useState<FileSelection | null>(null);
	// The fetch effect needs `t` only for its fallback error string. Held in a ref so
	// switching the UI language does not re-run the effect and re-download the file.
	const tRef = useRef(t);
	tRef.current = t;
	const fsCapability = useFileSystemCapability();
	const previewCapability = fsCapability.preview;
	const clipboard = useClipboard({ timeout: 1500 });

	const modes = useMemo(() => availableModes(filePath, selection), [filePath, selection]);
	const defaultMode = modes[0] ?? "raw";
	const [mode, setMode] = useState<FileViewerMode>(defaultMode);
	const [reloadToken, setReloadToken] = useState(0);
	const [load, setLoad] = useState<LoadState>(INITIAL_LOAD);

	const previewType = getFilePreviewType(filePath);
	const isText = previewType === "text" || !!selection || referenceOrigin || deviceId !== "local";
	const previewSupported = readerMode !== "legacy" || previewCapability.supported;
	const sourceOnly = !!selection;
	const lang = useMemo(() => getShikiLang(filePath), [filePath]);
	const fileName = fileBaseName(filePath);
	const structuredFormat = useMemo(() => detectStructuredFormat(filePath), [filePath]);

	// A different file resets the mode to that file's default. `defaultMode` is
	// derived from the path, so it alone is the right trigger.
	useEffect(() => {
		setMode(defaultMode);
	}, [defaultMode]);

	// Fetch text here; binary previews own their request and object URL lifecycle.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is the intentional re-fetch trigger
	useEffect(() => {
		if (!isText || !previewSupported) {
			setLoad(INITIAL_LOAD);
			return;
		}
		let cancelled = false;
		const controller = new AbortController();
		setLoad({ text: null, truncated: false, error: null, loading: true });
		setSourceSelection(null);
		const timeout = setTimeout(() => controller.abort(), FILE_REFERENCE_READ_TIMEOUT_MS);
		const read = async (): Promise<LoadState> => {
			if (referenceOrigin && previewType !== "text")
				throw new Error(
					tRef.current("fileReferences.binaryNotSupported", {
						defaultValue:
							"Binary files cannot be opened as text references. Use a file attachment instead.",
					}),
				);
			if (scopedNarratorId) {
				const preview = await fileReferenceApi.preview(
					scopedNarratorId,
					{ deviceId, path: filePath },
					controller.signal,
				);
				return {
					text: preview.content,
					hash: preview.hash,
					target: preview.target,
					truncated: false,
					error: null,
					loading: false,
				};
			}
			if (readerMode === "missing-context")
				throw new Error(
					tRef.current("fileReferences.missingContext", {
						defaultValue: "This file requires a narrator context to preview.",
					}),
				);
			const response = await authorizedFetch(
				`/api/fs/preview?path=${encodeURIComponent(filePath)}`,
				{
					signal: controller.signal,
				},
			);
			if (!response.ok) {
				const failure = await readFetchError(response, "Request failed");
				throw new ApiError(failure.message, response.status, failure.data);
			}
			const preview = await readTextPreview(response, MAX_FILE_VIEWER_TEXT_CHARS);
			return { text: preview.text, truncated: preview.truncated, error: null, loading: false };
		};
		read()
			.then((preview) => {
				if (!cancelled) setLoad(preview);
			})
			.catch((err) => {
				if (cancelled) return;
				setLoad({
					text: null,
					truncated: false,
					error: err instanceof Error ? err.message : tRef.current("filePreview_loadError"),
					loading: false,
				});
			})
			.finally(() => clearTimeout(timeout));
		return () => {
			cancelled = true;
			clearTimeout(timeout);
			controller.abort();
		};
	}, [
		deviceId,
		readerMode,
		scopedNarratorId,
		filePath,
		isText,
		previewSupported,
		previewType,
		referenceOrigin,
		reloadToken,
	]);

	const reload = useCallback(() => setReloadToken((token) => token + 1), []);

	const [downloading, setDownloading] = useState(false);

	/**
	 * Save the file to disk.
	 *
	 * Goes to `/api/fs/download` rather than reusing `load.text`: what is in state
	 * may be truncated at the fetch cap, and for a non-text file there is no state
	 * at all. So the download is always the real, complete bytes from disk — which
	 * is also why this button is available for binary files the panel cannot render.
	 */
	const download = useCallback(async () => {
		// Scoped/remote references must not bypass their reader via local fsDownload.
		if (referenceOrigin || deviceId !== "local") return;
		setDownloading(true);
		try {
			const { blob, fileName: served } = await api.fsDownload(filePath);
			saveBlobAsFile(blob, served ?? fileBaseName(filePath));
		} catch (err) {
			notifications.show({
				color: "red",
				title: tRef.current("fileViewer.downloadFailed"),
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setDownloading(false);
		}
	}, [deviceId, referenceOrigin, filePath]);

	// Parse for node mode. A truncated read is NOT attempted at all: its tail is
	// cut mid-token, so any parser would either fail or (worse) succeed on a
	// partial document and present it as complete.
	const parsed = useMemo(():
		| { nodes: StructuredNode[]; truncated: boolean }
		| { error: string }
		| null => {
		if (!structuredFormat || load.text == null || load.truncated) return null;
		return parseStructured(load.text, structuredFormat);
	}, [structuredFormat, load.text, load.truncated]);
	const nodeUnavailable = resolveNodeUnavailable({
		structuredFormat,
		truncated: load.truncated,
		parseFailed: parsed != null && isStructuredParseError(parsed),
	});
	// The effective mode: nodes can only render from a complete, parsed document.
	const effectiveMode: FileViewerMode =
		sourceOnly || (mode === "node" && nodeUnavailable) ? "raw" : mode;
	const sourcePath = load.target?.path ?? filePath;
	const sourceDeviceId = load.target?.deviceId ?? deviceId;
	const viewerScope = useMemo(
		() => ({
			narratorId,
			context: fileReferenceDirectory(sourcePath)
				? { deviceId: sourceDeviceId, cwd: fileReferenceDirectory(sourcePath) }
				: null,
			openFile: onOpenFileTarget ?? parentScope.openFile,
		}),
		[narratorId, sourcePath, sourceDeviceId, onOpenFileTarget, parentScope.openFile],
	);
	useEffect(() => {
		publishSelection?.(
			load.hash && sourceSelection && !load.truncated
				? {
						target: { deviceId: sourceDeviceId, path: sourcePath, selection: sourceSelection },
						label: fileName,
						expectedHash: load.hash,
						dirty: false,
					}
				: null,
		);
	}, [
		fileName,
		load.hash,
		load.truncated,
		sourceSelection,
		sourceDeviceId,
		sourcePath,
		publishSelection,
	]);
	useEffect(() => () => publishSelection?.(null), [publishSelection]);

	const header = (
		<Group gap={6} px="xs" py={4} wrap="nowrap" style={{ flexShrink: 0 }}>
			{/* The name is the ONLY flexible item here (see HEADER_FLEXIBLE_STYLE); the
			    full path is on hover, since the basename alone is what gets clipped. */}
			<TruncatedText
				text={fileName}
				tooltipLabel={filePath}
				size="xs"
				fw={600}
				style={HEADER_FLEXIBLE_STYLE}
			/>
			{modes.length > 1 && (
				<SegmentedControl
					size="xs"
					value={mode}
					style={HEADER_FIXED_STYLE}
					onChange={(value) => setMode(value as FileViewerMode)}
					data={modes.map((value) => ({
						value,
						label:
							value === "preview"
								? t("fileViewer.mode_preview")
								: value === "node"
									? t("fileViewer.mode_node")
									: t("fileViewer.mode_raw"),
					}))}
				/>
			)}
			{/* Grouped so the buttons hold their size as one unit: as individual flex
			    children they each carried the default `flex-shrink: 1` and would be
			    squeezed into unclickable slivers before the filename gave up any width. */}
			<Group gap={2} wrap="nowrap" style={HEADER_FIXED_STYLE}>
				<Tooltip label={t("contextMenu_copyFilePath")} withinPortal>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						aria-label={t("contextMenu_copyFilePath")}
						onClick={() => clipboard.copy(filePath)}
					>
						{clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
					</ActionIcon>
				</Tooltip>
				{/* Offered even when the panel cannot render the file (binary, or a read
				    that failed): saving the bytes does not depend on previewing them. */}
				{!referenceOrigin && deviceId === "local" && (
					<Tooltip label={t("fileViewer.download")} withinPortal>
						<ActionIcon
							size="sm"
							variant="subtle"
							color="gray"
							aria-label={t("fileViewer.download")}
							loading={downloading}
							onClick={download}
						>
							<IconDownload size={14} />
						</ActionIcon>
					</Tooltip>
				)}
				<Tooltip label={t("fileViewer.reload")} withinPortal>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						aria-label={t("fileViewer.reload")}
						onClick={reload}
					>
						<IconRefresh size={14} />
					</ActionIcon>
				</Tooltip>
			</Group>
		</Group>
	);

	return (
		<FileReferenceScopeProvider value={viewerScope}>
			<Box style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
				{header}
				<Box style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
					{!previewSupported ? (
						<Box p="md">
							<Text size="sm" c="dimmed">
								{previewCapability.reason ?? t("filePreview_unsupported")}
							</Text>
						</Box>
					) : !isText ? (
						<BinaryFilePreview
							key={`${filePath}:${reloadToken}`}
							filePath={filePath}
							previewType={previewType}
						/>
					) : load.loading ? (
						<Center h="100%">
							<Loader size="sm" />
						</Center>
					) : load.error ? (
						<Box p="md">
							<Text size="sm" c="red">
								{load.error}
							</Text>
						</Box>
					) : load.text == null ? null : effectiveMode === "raw" && (sourceOnly || !!load.hash) ? (
						<Box h="100%" style={{ display: "flex", flexDirection: "column" }}>
							<Box style={{ flex: 1, minHeight: 0 }}>
								<MonacoEditor
									initialValue={load.text}
									documentKey={JSON.stringify([narratorId, sourceDeviceId, sourcePath])}
									filePath={sourcePath}
									readOnly
									selection={selection}
									navigationRequestId={highlightRequestId}
									onSelectionChange={setSourceSelection}
								/>
							</Box>
							{load.truncated && (
								<Text size="xs" c="yellow" p="xs">
									{t("fileViewer.truncated", {
										chars: formatLocaleNumber(MAX_FILE_VIEWER_TEXT_CHARS),
									})}
								</Text>
							)}
						</Box>
					) : (
						<FileBody
							filePath={filePath}
							fileName={fileName}
							lang={lang}
							text={load.text}
							truncated={load.truncated}
							mode={effectiveMode}
							parsed={parsed}
							nodeUnavailable={nodeUnavailable}
							structuredFormat={structuredFormat}
							reloadToken={reloadToken}
						/>
					)}
				</Box>
			</Box>
		</FileReferenceScopeProvider>
	);
}

/** Enforce the byte budget while reading, not after allocating the entire response. */
export async function readBinaryPreview(response: Response): Promise<Blob> {
	const limit = MAX_FILE_PREVIEW_BLOB_BYTES;
	if (Number(response.headers.get("content-length")) > limit) {
		await response.body?.cancel();
		throw new Error("Preview too large");
	}
	const reader = response.body?.getReader();
	if (!reader) return new Blob([]);
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > limit) {
				await reader.cancel();
				throw new Error("Preview too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new Blob(chunks, { type: response.headers.get("content-type") ?? "" });
}

function BinaryFilePreview({
	filePath,
	previewType,
}: {
	filePath: string;
	previewType: "image" | "pdf";
}) {
	const { t } = useTranslation("narrator");
	const openImageViewer = useImageViewer();
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const fileName = fileBaseName(filePath);

	useEffect(() => {
		const controller = new AbortController();
		let disposed = false;
		let objectUrl: string | null = null;
		const timeout = setTimeout(() => controller.abort(), 30_000);
		authorizedFetch(`/api/fs/preview?path=${encodeURIComponent(filePath)}`, {
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) {
					const failure = await readFetchError(response, "Request failed");
					throw new ApiError(failure.message, response.status, failure.data);
				}
				return readBinaryPreview(response);
			})
			.then((blob) => {
				if (disposed) return;
				objectUrl = URL.createObjectURL(blob);
				setUrl(objectUrl);
			})
			.catch((err) => {
				if (!disposed) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => clearTimeout(timeout));
		return () => {
			disposed = true;
			clearTimeout(timeout);
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [filePath]);

	if (error) {
		return (
			<Text p="md" size="sm" c="red">
				{error}
			</Text>
		);
	}
	if (!url)
		return (
			<Center h="100%">
				<Loader size="sm" />
			</Center>
		);
	if (previewType === "pdf") {
		return (
			<iframe
				src={url}
				title={fileName}
				sandbox="allow-same-origin allow-scripts"
				onError={() => setError(t("filePreview_loadError"))}
				style={{ width: "100%", height: "100%", border: 0, display: "block" }}
			/>
		);
	}
	return (
		<Center h="100%" p="xs">
			<button
				type="button"
				aria-label={fileName}
				onClick={() =>
					openImageViewer({ src: url, savedPath: filePath, filename: fileName, alt: fileName })
				}
				style={{ display: "contents", cursor: "zoom-in" }}
			>
				<img
					src={url}
					alt={fileName}
					onError={() => setError(t("filePreview_loadError"))}
					style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
				/>
			</button>
		</Center>
	);
}

function FileBody({
	fileName,
	lang,
	text,
	truncated,
	mode,
	parsed,
	nodeUnavailable,
	structuredFormat,
	reloadToken,
	filePath,
}: {
	filePath: string;
	fileName: string;
	lang: string;
	text: string;
	truncated: boolean;
	mode: FileViewerMode;
	parsed: { nodes: StructuredNode[]; truncated: boolean } | { error: string } | null;
	/** Why node mode fell back to raw, when it did — drives which notice shows. */
	nodeUnavailable: NodeUnavailableReason | null;
	structuredFormat: string | null;
	reloadToken: number;
}) {
	const { t } = useTranslation("narrator");

	// A caveat about how to read what follows belongs ABOVE the document.
	//
	// Only the syntax-error case is announced here: when node mode is unavailable
	// because the file was TRUNCATED, the notice at the bottom already says so, and
	// showing both made a perfectly valid file look malformed ("could not parse as
	// json" when the real story was "we only fetched the first megabyte").
	const topNotices =
		nodeUnavailable === "parse-error" && mode === "raw" && structuredFormat ? (
			<Text size="xs" c="yellow" px="xs" pt={4}>
				{t("fileViewer.parseFailed", { format: structuredFormat })}
			</Text>
		) : null;

	// Truncation is reported at the END, where the content actually stops. Shown at
	// the top it read as a caveat about the whole file and — worse — was invisible
	// exactly when it matters: after scrolling down to what looks like the last line.
	const truncationNotice = truncated ? (
		<Text size="xs" c="yellow" px="xs" pb="xs">
			{t("fileViewer.truncated", { chars: formatLocaleNumber(MAX_FILE_VIEWER_TEXT_CHARS) })}
		</Text>
	) : null;

	// Node mode only renders from a COMPLETE document (a truncated read yields a
	// null `parsed`), so `truncationNotice` cannot apply here — the only cap that
	// can bite is the node-count ceiling inside the parser.
	if (mode === "node" && parsed && !isStructuredParseError(parsed)) {
		return (
			<>
				{topNotices}
				<StructuredNodeTree nodes={parsed.nodes} resetKey={`${filePath}:${reloadToken}`} />
				{parsed.truncated && (
					<Text size="xs" c="yellow" px="xs" pb="xs">
						{t("fileViewer.nodesTruncated")}
					</Text>
				)}
			</>
		);
	}

	if (mode === "preview") {
		return (
			<>
				{topNotices}
				<Box p="xs">
					<MarkdownContent text={text} />
				</Box>
				{truncationNotice}
			</>
		);
	}

	return (
		<>
			{topNotices}
			<Box p="xs">
				<ContentViewer
					content={text}
					title={fileName}
					language={lang}
					maxHighlightChars={MAX_FILE_HIGHLIGHT_CODE_CHARS}
					style={{ fontSize: 12 }}
				/>
			</Box>
			{truncationNotice}
		</>
	);
}
