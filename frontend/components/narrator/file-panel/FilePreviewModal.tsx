/**
 * FilePreviewModal.tsx — "View this file" modal for file-oriented tool calls.
 *
 * Extracted verbatim from ToolCallCard.tsx so BOTH renderer paths can mount it:
 *   - chunked path : ToolCallCard's own context menu
 *   - vlist path   : VListRowInteraction's row menu
 *
 * Fetches `/api/fs/preview` and renders one of three shapes by extension:
 * image (blob → <img>, click opens the fullscreen viewer), pdf (blob → sandboxed
 * <iframe>), or text (streamed + char-capped → ContentViewer with Shiki lang).
 *
 * Both payload paths are bounded on purpose: text is capped at
 * MAX_FILE_PREVIEW_TEXT_CHARS while streaming (the reader is cancelled once the
 * cap is hit, so a huge file never fully lands in memory), and blobs are
 * rejected past MAX_FILE_PREVIEW_BLOB_BYTES.
 */

import { Box, Group, Loader, Modal, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFileSystemCapability } from "../../../hooks/usePlatform";
import { ApiError, authorizedFetch, readFetchError } from "../../../lib/api";
import { apiUrl } from "../../../lib/base-path";
import { getShikiLang } from "../../../lib/shiki-lang";
import { useImageViewer } from "../../common/image-viewer-context";
import { ContentViewer } from "../content/ContentViewer";

const IMAGE_EXTS = new Set([
	".jpg",
	".jpeg",
	".png",
	".gif",
	".webp",
	".svg",
	".avif",
	".bmp",
	".ico",
]);
const PDF_EXTS = new Set([".pdf"]);
export const MAX_FILE_PREVIEW_TEXT_CHARS = 120_000;
export const MAX_FILE_PREVIEW_BLOB_BYTES = 25 * 1024 * 1024;

/**
 * Read a text response up to `maxChars`, cancelling the stream once the cap is
 * reached so an oversized file never fully lands in memory.
 */
export async function readTextPreview(
	response: Response,
	maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) {
		const text = await response.text();
		return text.length > maxChars
			? { text: text.slice(0, maxChars), truncated: true }
			: { text, truncated: false };
	}

	const decoder = new TextDecoder();
	let text = "";
	let truncated = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		if (text.length + chunk.length > maxChars) {
			text += chunk.slice(0, maxChars - text.length);
			truncated = true;
			await reader.cancel().catch(() => {});
			break;
		}
		text += chunk;
	}
	if (!truncated) text += decoder.decode();
	return { text, truncated };
}

export function getFilePreviewType(filePath: string): "image" | "pdf" | "text" {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return "text";
	const ext = filePath.slice(dot).toLowerCase();
	if (IMAGE_EXTS.has(ext)) return "image";
	if (PDF_EXTS.has(ext)) return "pdf";
	return "text";
}

export function FilePreviewModal({
	filePath,
	opened,
	onClose,
}: {
	filePath: string;
	opened: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("narrator");
	const openImageViewer = useImageViewer();
	const fsCapability = useFileSystemCapability();
	const previewCapability = fsCapability.preview;
	const previewType = getFilePreviewType(filePath);
	const [error, setError] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [textContent, setTextContent] = useState<string | null>(null);
	const [textPreviewTruncated, setTextPreviewTruncated] = useState(false);
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const lang = getShikiLang(filePath);
	const fileName = filePath.split("/").pop() || filePath;

	// Reset state when modal opens, closes, or switches files.
	// biome-ignore lint/correctness/useExhaustiveDependencies: filePath changes must clear stale preview state before the next fetch completes
	useEffect(() => {
		setError(false);
		setErrorMessage(null);
		setTextContent(null);
		setTextPreviewTruncated(false);
		setBlobUrl(null);
		if (!opened) setLoading(false);
	}, [opened, filePath]);

	// Cleanup blob URL on unmount
	useEffect(() => {
		return () => {
			if (blobUrl) URL.revokeObjectURL(blobUrl);
		};
	}, [blobUrl]);

	// Fetch file content when modal opens
	useEffect(() => {
		if (!opened || !previewCapability.supported) return;
		let cancelled = false;
		const controller = new AbortController();
		setLoading(true);
		const url = `${apiUrl("/fs/preview")}?path=${encodeURIComponent(filePath)}`;

		if (previewType === "text") {
			authorizedFetch(url, { signal: controller.signal })
				.then(async (r) => {
					if (!r.ok) {
						const error = await readFetchError(r, "Request failed");
						throw new ApiError(error.message, r.status, error.data);
					}
					return readTextPreview(r, MAX_FILE_PREVIEW_TEXT_CHARS);
				})
				.then((preview) => {
					if (cancelled) return;
					setTextContent(preview.text);
					setTextPreviewTruncated(preview.truncated);
				})
				.catch((err) => {
					if (!cancelled) {
						setError(true);
						setErrorMessage(err instanceof Error ? err.message : null);
					}
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		} else {
			// Image or PDF: fetch as blob and create object URL
			authorizedFetch(url, { signal: controller.signal })
				.then(async (r) => {
					if (!r.ok) {
						const error = await readFetchError(r, "Request failed");
						throw new ApiError(error.message, r.status, error.data);
					}
					return r.blob();
				})
				.then((blob) => {
					if (blob.size > MAX_FILE_PREVIEW_BLOB_BYTES) throw new Error("Preview too large");
					const nextUrl = URL.createObjectURL(blob);
					if (cancelled) {
						URL.revokeObjectURL(nextUrl);
						return;
					}
					setBlobUrl(nextUrl);
				})
				.catch((err) => {
					if (!cancelled) {
						setError(true);
						setErrorMessage(err instanceof Error ? err.message : null);
					}
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		}
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [opened, previewCapability.supported, previewType, filePath]);

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={fileName}
			size="xl"
			styles={{
				body: { padding: 0 },
				header: { paddingBottom: 4 },
			}}
		>
			{loading && (
				<Group gap={4} p="md">
					{/* Mantine's Loader, not a hand-spun IconLoader2: the `spin` keyframe this
					    used to reference was injected at runtime by ToolCallCard, so deleting
					    that component left the icon frozen. A Loader carries its own animation. */}
					<Loader size={14} />
					<Text size="sm" c="dimmed">
						{t("filePreview_loading")}
					</Text>
				</Group>
			)}
			{!previewCapability.supported && (
				<Box p="md">
					<Text c="dimmed" size="sm">
						{previewCapability.reason ?? t("filePreview_unsupported")}
					</Text>
				</Box>
			)}
			{error && (
				<Box p="md">
					<Text c="red" size="sm">
						{errorMessage ?? t("filePreview_loadError")}
					</Text>
				</Box>
			)}
			{!error && !loading && previewType === "image" && blobUrl && (
				<Box p="xs" style={{ textAlign: "center" }}>
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: opens fullscreen viewer; Escape/keys handled there */}
					<img
						src={blobUrl}
						alt={fileName}
						onError={() => setError(true)}
						onClick={() =>
							openImageViewer({
								src: blobUrl,
								savedPath: filePath,
								filename: fileName,
								alt: fileName,
							})
						}
						style={{
							maxWidth: "100%",
							maxHeight: "80vh",
							objectFit: "contain",
							borderRadius: "var(--mantine-radius-sm)",
							cursor: "pointer",
						}}
					/>
				</Box>
			)}
			{!error && !loading && previewType === "pdf" && blobUrl && (
				<iframe
					src={blobUrl}
					title={fileName}
					onError={() => setError(true)}
					sandbox="allow-same-origin allow-scripts"
					style={{
						width: "100%",
						height: "80vh",
						border: "none",
					}}
				/>
			)}
			{!error && !loading && previewType === "text" && textContent != null && (
				<Box p="xs">
					<ContentViewer
						content={
							textPreviewTruncated ? `${textContent}\n\n${t("filePreview_truncated")}` : textContent
						}
						style={{ fontSize: 12, maxHeight: "75vh", overflow: "auto" }}
						title={fileName}
						language={lang}
					/>
				</Box>
			)}
		</Modal>
	);
}
