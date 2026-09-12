import { Box, Center, Loader, Text } from "@mantine/core";
import { localFileDirectory } from "@shared/markdown-file-path";
import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FileReferenceScopeProvider } from "../FileReferenceScope";
import type { FileViewerMode } from "../file-viewer/file-viewer-modes";
import {
	detectStructuredFormat,
	isStructuredParseError,
	parseStructured,
} from "../file-viewer/structured-parse";

const MarkdownContent = lazy(() =>
	import("../MarkdownContent").then((m) => ({ default: m.MarkdownContent })),
);
const StructuredNodeTree = lazy(() =>
	import("../file-viewer/StructuredNodeTree").then((m) => ({ default: m.StructuredNodeTree })),
);

/** Preview work must remain bounded even when an unsaved buffer grows beyond the read cap. */
export const MAX_EDITOR_PREVIEW_CHARS = 1024 * 1024;

/** Only mounted when requested: no parsing/rendering cost on the typing path. */
export function FileEditorPreview({
	text,
	mode,
	filePath,
	deviceId,
	narratorId,
	withSourceLines,
}: {
	text: string;
	mode: Exclude<FileViewerMode, "raw">;
	filePath: string;
	deviceId: string;
	narratorId?: string;
	/** Stamp `data-line` anchors so the split view can scroll-sync by source line. */
	withSourceLines?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const tooLarge = text.length > MAX_EDITOR_PREVIEW_CHARS;
	const format = mode === "node" ? detectStructuredFormat(filePath) : null;
	const parsed = useMemo(
		() => (format && !tooLarge ? parseStructured(text, format) : null),
		[format, text, tooLarge],
	);
	const scope = useMemo(() => {
		const directory = localFileDirectory(filePath);
		return { narratorId, context: directory === "." ? null : { deviceId, cwd: directory } };
	}, [deviceId, filePath, narratorId]);
	if (tooLarge)
		return (
			<Text size="sm" c="dimmed" p="xs">
				{t("fileEditor.previewTooLarge")}
			</Text>
		);
	if (mode === "node" && (!parsed || isStructuredParseError(parsed))) {
		return (
			<Text size="sm" c="orange" p="xs" role="status">
				{t("fileEditor.previewParseFailed", { format })}
			</Text>
		);
	}
	return (
		<FileReferenceScopeProvider value={scope}>
			<Suspense
				fallback={
					<Center p="md">
						<Loader size="sm" />
					</Center>
				}
			>
				{mode === "preview" ? (
					<Box p="xs">
						<MarkdownContent text={text} sourceLines={withSourceLines} />
					</Box>
				) : parsed && !isStructuredParseError(parsed) ? (
					<>
						<StructuredNodeTree nodes={parsed.nodes} />
						{parsed.truncated && (
							<Text size="xs" c="yellow" p="xs">
								{t("fileViewer.nodesTruncated")}
							</Text>
						)}
					</>
				) : null}
			</Suspense>
		</FileReferenceScopeProvider>
	);
}
