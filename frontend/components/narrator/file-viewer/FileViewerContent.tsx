/**
 * FileViewerContent.tsx — read-only file viewer body for the `file` dock panel.
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
 * Images and PDFs are NOT rendered here — this panel is the text/code surface,
 * and the existing modal / image viewer own binary previews.
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
import { IconCheck, IconCopy, IconDownload, IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFileSystemCapability } from "../../../hooks/usePlatform";
import { ApiError, api, authorizedFetch, readFetchError } from "../../../lib/api";
import { saveBlobAsFile } from "../../../lib/file-download";
import { formatLocaleNumber } from "../../../lib/intl-format";
import { getShikiLang } from "../../../lib/shiki-lang";
import { TruncatedText } from "../../common/TruncatedText";
import { ContentViewer } from "../ContentViewer";
import { getFilePreviewType, readTextPreview } from "../FilePreviewModal";
import { MarkdownContent } from "../MarkdownContent";
import { StructuredNodeTree } from "./StructuredNodeTree";
import {
	detectStructuredFormat,
	isStructuredParseError,
	parseStructured,
	type StructuredNode,
} from "./structured-parse";

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

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
 * HighlightedCode drops to an unhighlighted code block past 20k chars, and
 * MarkdownContent falls back to plain text past 80k. Both still show the whole
 * document, so raising this cap cannot produce silently-clipped content.
 *
 * Kept at the backend's byte ceiling EXACTLY (1024 * 1024, not a round 1e6):
 * 1,000,000 would clip the last 48,576 characters of an ASCII file the API had
 * served in full. `file-viewer-limits.test.ts` pins this alignment.
 */
export const MAX_FILE_VIEWER_TEXT_CHARS = 1024 * 1024;

export type FileViewerMode = "preview" | "node" | "raw";

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

/** True when the path should render as markdown in `preview` mode. */
export function isMarkdownPath(filePath: string): boolean {
	const base = filePath.split(/[/\\]/).pop() ?? filePath;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return false;
	return MARKDOWN_EXTS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * The modes a path supports, in display order. Always ends with `raw`; a single
 * entry means the caller should hide the switch.
 */
export function availableModes(filePath: string): FileViewerMode[] {
	if (isMarkdownPath(filePath)) return ["preview", "raw"];
	if (detectStructuredFormat(filePath)) return ["node", "raw"];
	return ["raw"];
}

/** Basename of a path, tolerating both separators. */
export function fileBaseName(filePath: string): string {
	return filePath.split(/[/\\]/).pop() || filePath;
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
}

const INITIAL_LOAD: LoadState = { text: null, truncated: false, error: null, loading: false };

export interface FileViewerContentProps {
	filePath: string;
}

export function FileViewerContent({ filePath }: FileViewerContentProps) {
	const { t } = useTranslation("narrator");
	// The fetch effect needs `t` only for its fallback error string. Held in a ref so
	// switching the UI language does not re-run the effect and re-download the file.
	const tRef = useRef(t);
	tRef.current = t;
	const fsCapability = useFileSystemCapability();
	const previewCapability = fsCapability.preview;
	const clipboard = useClipboard({ timeout: 1500 });

	const modes = useMemo(() => availableModes(filePath), [filePath]);
	const defaultMode = modes[0] ?? "raw";
	const [mode, setMode] = useState<FileViewerMode>(defaultMode);
	const [reloadToken, setReloadToken] = useState(0);
	const [load, setLoad] = useState<LoadState>(INITIAL_LOAD);

	const previewType = getFilePreviewType(filePath);
	const isText = previewType === "text";
	const lang = useMemo(() => getShikiLang(filePath), [filePath]);
	const fileName = fileBaseName(filePath);
	const structuredFormat = useMemo(() => detectStructuredFormat(filePath), [filePath]);

	// A different file resets the mode to that file's default. `defaultMode` is
	// derived from the path, so it alone is the right trigger.
	useEffect(() => {
		setMode(defaultMode);
	}, [defaultMode]);

	// Fetch (and re-fetch on reload). Text only: binary types never hit the wire
	// here, they get the "use the image/PDF viewer" hint instead.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is the intentional re-fetch trigger
	useEffect(() => {
		if (!isText || !previewCapability.supported) {
			setLoad(INITIAL_LOAD);
			return;
		}
		let cancelled = false;
		const controller = new AbortController();
		setLoad({ text: null, truncated: false, error: null, loading: true });
		authorizedFetch(`/api/fs/preview?path=${encodeURIComponent(filePath)}`, {
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) {
					const failure = await readFetchError(response, "Request failed");
					throw new ApiError(failure.message, response.status, failure.data);
				}
				return readTextPreview(response, MAX_FILE_VIEWER_TEXT_CHARS);
			})
			.then((preview) => {
				if (cancelled) return;
				setLoad({
					text: preview.text,
					truncated: preview.truncated,
					error: null,
					loading: false,
				});
			})
			.catch((err) => {
				if (cancelled) return;
				setLoad({
					text: null,
					truncated: false,
					error: err instanceof Error ? err.message : tRef.current("filePreview_loadError"),
					loading: false,
				});
			});
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [filePath, isText, previewCapability.supported, reloadToken]);

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
	}, [filePath]);

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
	const effectiveMode: FileViewerMode = mode === "node" && nodeUnavailable ? "raw" : mode;

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
		<Box style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
			{header}
			<Box style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
				{!previewCapability.supported ? (
					<Box p="md">
						<Text size="sm" c="dimmed">
							{previewCapability.reason ?? t("filePreview_unsupported")}
						</Text>
					</Box>
				) : !isText ? (
					<Box p="md">
						<Text size="sm" c="dimmed">
							{t("fileViewer.binaryHint")}
						</Text>
					</Box>
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
				) : load.text == null ? null : (
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
				<ContentViewer content={text} title={fileName} language={lang} style={{ fontSize: 12 }} />
			</Box>
			{truncationNotice}
		</>
	);
}
