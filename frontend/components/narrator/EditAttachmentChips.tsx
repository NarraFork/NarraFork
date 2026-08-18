/**
 * EditAttachmentChips.tsx — attachment previews used by the message editor.
 *
 * Extracted from MessageBubble together with MessageEditorPanel: these three
 * pieces are only ever rendered while editing a user message (kept image thumb,
 * newly-selected image thumb, removable text-file chip).
 */

import { Box, CloseButton, Group, Image, Skeleton, Text } from "@mantine/core";
import { formatFileSize } from "@shared/text-file-types";
import { IconFile } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUploadCapability } from "../../hooks/usePlatform";
import { absorbRenewedToken, clearTokenOnSessionFailure, getToken } from "../../lib/api";
import { useImageViewer } from "../common/ImageViewerProvider";
import { MAX_IMAGE_CLIPBOARD_BLOB_BYTES } from "./image-clipboard";

const MAX_MESSAGE_IMAGE_PREVIEW_BLOB_BYTES = MAX_IMAGE_CLIPBOARD_BLOB_BYTES;

/**
 * Object URL for an image already persisted under `/api/uploads/:narratorId/:imageId`.
 *
 * Shared by the message editor's thumbnails and the queued-message row so both
 * fetch through the same bounded, token-aware path. Returns null while loading,
 * or when the platform does not serve narrator images at all.
 */
function useUploadedImageBlobUrl(
	uploadNarratorId: string | undefined,
	imageId: string | undefined,
	enabled: boolean,
): string | null {
	const uploadCapability = useUploadCapability();
	const supported = uploadCapability.serveNarratorImages.supported;
	const [blobUrl, setBlobUrl] = useState<string | null>(null);

	useEffect(() => {
		if (!enabled || !supported || !uploadNarratorId || !imageId) return;
		const token = getToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		let cancelled = false;
		let objectUrl: string | null = null;
		fetch(`/api/uploads/${uploadNarratorId}/${imageId}`, { headers })
			.then(async (res) => {
				absorbRenewedToken(res, token);
				if (!res.ok) {
					await clearTokenOnSessionFailure(res);
					return null;
				}
				return res.blob();
			})
			.then((blob) => {
				if (blob && !cancelled && blob.size <= MAX_MESSAGE_IMAGE_PREVIEW_BLOB_BYTES) {
					objectUrl = URL.createObjectURL(blob);
					setBlobUrl(objectUrl);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [uploadNarratorId, imageId, enabled, supported]);

	return blobUrl;
}

/**
 * Read-only thumbnail of a queued message's image attachment.
 *
 * The queue row shows what is actually attached instead of a bare count, so the
 * user can tell two pending messages apart before either one runs. Click opens
 * the shared full-size viewer.
 */
export function QueuedImageThumb({
	imageId,
	filename,
	uploadNarratorId,
	size = 20,
}: {
	imageId: string;
	filename?: string | null;
	uploadNarratorId?: string;
	size?: number;
}) {
	const openImageViewer = useImageViewer();
	const src = useUploadedImageBlobUrl(uploadNarratorId, imageId, true);
	const alt = filename ?? "image";

	if (!src) return <Skeleton h={size} w={size} radius="sm" />;
	return (
		<Image
			src={src}
			alt={alt}
			radius="sm"
			h={size}
			w={size}
			fit="cover"
			style={{ cursor: "pointer", flexShrink: 0 }}
			onClick={(event) => {
				// The row itself is a drag handle / expand target.
				event.stopPropagation();
				openImageViewer({ src, filename: alt, alt });
			}}
		/>
	);
}

/**
 * Compact 60×60 thumbnail of an already-persisted image, used inside the user
 * message edit mode so the editor can see (and remove) existing attachments.
 * Reuses the same `/api/uploads/:narratorId/:imageId` blob fetch as ImageBlock.
 */
export function EditExistingImageThumb({
	block,
	imageNarratorId,
	onRemove,
	disabled = false,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON block
	block: any;
	imageNarratorId?: string;
	onRemove: () => void;
	disabled?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const openImageViewer = useImageViewer();
	const uploadNarratorId =
		typeof block.uploadNarratorId === "string" ? block.uploadNarratorId : imageNarratorId;
	const blobUrl = useUploadedImageBlobUrl(uploadNarratorId, block.imageId, !block.previewUrl);

	const src = block.previewUrl ?? blobUrl;

	return (
		<Box pos="relative" style={{ display: "inline-block" }}>
			{src ? (
				<Image
					src={src}
					alt={block.filename ?? "image"}
					radius="sm"
					h={60}
					w={60}
					fit="cover"
					style={{ cursor: "pointer" }}
					onClick={() => openImageViewer({ src, filename: block.filename, alt: block.filename })}
				/>
			) : (
				<Skeleton h={60} w={60} radius="sm" />
			)}
			<CloseButton
				size="xs"
				radius="xl"
				variant="filled"
				color="dark"
				style={{ position: "absolute", top: -6, right: -6 }}
				onClick={onRemove}
				disabled={disabled}
				title={t("removeImage")}
			/>
		</Box>
	);
}

/** Preview of a freshly-selected image file during message editing. */
export function EditNewImageThumb({
	file,
	onRemove,
	disabled = false,
}: {
	file: File;
	onRemove: () => void;
	disabled?: boolean;
}) {
	const { t } = useTranslation("narrator");
	const openImageViewer = useImageViewer();
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		const objectUrl = URL.createObjectURL(file);
		setUrl(objectUrl);
		return () => URL.revokeObjectURL(objectUrl);
	}, [file]);
	return (
		<Box pos="relative" style={{ display: "inline-block" }}>
			{url ? (
				<Image
					src={url}
					alt={file.name}
					radius="sm"
					h={60}
					w={60}
					fit="cover"
					style={{ cursor: "pointer" }}
					onClick={() => openImageViewer({ src: url, filename: file.name, alt: file.name })}
				/>
			) : (
				<Skeleton h={60} w={60} radius="sm" />
			)}
			<CloseButton
				size="xs"
				radius="xl"
				variant="filled"
				color="dark"
				style={{ position: "absolute", top: -6, right: -6 }}
				onClick={onRemove}
				disabled={disabled}
				title={t("removeImage")}
			/>
		</Box>
	);
}

/**
 * Removable file chip shown during message editing for both kept (existing) and
 * newly-added text-file attachments. Mirrors the main composer's text-file chip.
 */
export function EditTextFileChip({
	filename,
	size,
	onRemove,
	disabled = false,
}: {
	filename: string;
	size: number;
	onRemove: () => void;
	disabled?: boolean;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Group
			gap={6}
			px="xs"
			py={4}
			wrap="nowrap"
			style={{
				borderRadius: "var(--mantine-radius-sm)",
				backgroundColor: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
			}}
		>
			<IconFile size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
			<Text size="xs" truncate style={{ maxWidth: 160, minWidth: 0 }}>
				{filename}
			</Text>
			{/* Fixed: the size is never the part that gives way — the filename truncates. */}
			<Text size="xs" c="dimmed" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
				{formatFileSize(size)}
			</Text>
			<CloseButton
				size={16}
				iconSize={12}
				variant="transparent"
				c="dimmed"
				onClick={onRemove}
				disabled={disabled}
				title={t("removeFile")}
			/>
		</Group>
	);
}
