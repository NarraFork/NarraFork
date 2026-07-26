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
import { clearToken, getToken } from "../../lib/api";
import { useImageViewer } from "../common/ImageViewerProvider";
import { MAX_IMAGE_CLIPBOARD_BLOB_BYTES } from "./image-clipboard";

const MAX_MESSAGE_IMAGE_PREVIEW_BLOB_BYTES = MAX_IMAGE_CLIPBOARD_BLOB_BYTES;

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
	const uploadCapability = useUploadCapability();
	const narratorImageServing = uploadCapability.serveNarratorImages;
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const uploadNarratorId =
		typeof block.uploadNarratorId === "string" ? block.uploadNarratorId : imageNarratorId;

	useEffect(() => {
		if (block.previewUrl || !narratorImageServing.supported || !uploadNarratorId || !block.imageId)
			return;
		const token = getToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		let cancelled = false;
		let objectUrl: string | null = null;
		fetch(`/api/uploads/${uploadNarratorId}/${block.imageId}`, { headers })
			.then((res) => {
				if (!res.ok) {
					if (res.status === 401) clearToken();
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
	}, [uploadNarratorId, block.imageId, block.previewUrl, narratorImageServing.supported]);

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
			<Text size="xs" truncate style={{ maxWidth: 160 }}>
				{filename}
			</Text>
			<Text size="xs" c="dimmed">
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
