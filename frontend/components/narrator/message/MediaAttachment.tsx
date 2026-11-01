import { Box, Text } from "@mantine/core";
import { mediaModality } from "@shared/media-attachments";
import {
	AUDIO_ATTACHMENT_CONTROL_HEIGHT,
	MEDIA_ATTACHMENT_FILENAME_HEIGHT,
	MEDIA_ATTACHMENT_WIDTH,
	mediaAttachmentHeight,
	VIDEO_ATTACHMENT_CONTROL_HEIGHT,
} from "@shared/pretext-layout/media-attachment-layout";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiBase, authorizedFetch } from "../../../lib/api/client";
import type { ContentBlock } from "../narrator-panel-types";

type MediaAttachmentBlock = Pick<
	ContentBlock,
	"type" | "mediaId" | "filename" | "mediaType" | "size" | "uploadNarratorId" | "previewUrl"
>;

const pendingKeys = new WeakMap<File, string>();
let pendingKeySequence = 0;
export function pendingMediaKey(file: File): string {
	let key = pendingKeys.get(file);
	if (!key) {
		key = `pending-media-${++pendingKeySequence}`;
		pendingKeys.set(file, key);
	}
	return key;
}

/** Each binary File owns its preview URL; removing another attachment never restarts this player. */
export function PendingMediaAttachment({ file }: { file: File }) {
	const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
	useEffect(() => {
		const url = URL.createObjectURL(file);
		setPreview({ file, url });
		return () => URL.revokeObjectURL(url);
	}, [file]);
	return (
		<MediaAttachment
			narratorId=""
			block={{
				type: mediaModality(file.type) ?? "audio",
				filename: file.name,
				mediaType: file.type,
				size: file.size,
				previewUrl: preview?.file === file ? preview.url : undefined,
			}}
		/>
	);
}

/** Protected uploads are fetched with session auth; native controls only receive a local blob URL. */
export function MediaAttachment({
	narratorId,
	block,
}: {
	narratorId: string;
	block: MediaAttachmentBlock;
}) {
	const { t } = useTranslation("narrator");
	const [loaded, setLoaded] = useState<{ key: string; url?: string; failed?: boolean } | null>(
		null,
	);
	const [playbackErrorKey, setPlaybackErrorKey] = useState<string | null>(null);
	const owner = block.uploadNarratorId || narratorId;
	const previewUrl = block.previewUrl?.startsWith("blob:") ? block.previewUrl : undefined;
	const referencingContext =
		narratorId && narratorId !== owner
			? `?referencingNarratorId=${encodeURIComponent(narratorId)}`
			: "";
	const key = `${narratorId}:${owner}:${block.mediaId ?? ""}:${previewUrl ?? ""}`;
	const isVideo = block.type === "video";
	useEffect(() => {
		if (previewUrl) return;
		if (!block.mediaId) return;
		const controller = new AbortController();
		let objectUrl: string | undefined;
		let disposed = false;
		void authorizedFetch(
			`${apiBase()}/uploads/${encodeURIComponent(owner)}/media/${encodeURIComponent(block.mediaId)}${referencingContext}`,
			{ signal: controller.signal },
		)
			.then(async (response) => {
				if (!response.ok) throw new Error(`Media ${response.status}`);
				const blob = await response.blob();
				if (disposed) return;
				objectUrl = URL.createObjectURL(blob);
				setLoaded({ key, url: objectUrl });
			})
			.catch(() => {
				if (!disposed) setLoaded({ key, failed: true });
			});
		return () => {
			disposed = true;
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [owner, block.mediaId, previewUrl, referencingContext, key]);
	const url = previewUrl || (loaded?.key === key ? loaded.url : undefined);
	const failed = (loaded?.key === key && loaded.failed) || playbackErrorKey === key;
	const controlHeight = isVideo ? VIDEO_ATTACHMENT_CONTROL_HEIGHT : AUDIO_ATTACHMENT_CONTROL_HEIGHT;
	return (
		<Box
			style={{
				width: MEDIA_ATTACHMENT_WIDTH,
				maxWidth: "100%",
				height: mediaAttachmentHeight(isVideo ? "video" : "audio"),
				overflow: "hidden",
			}}
		>
			<Text
				size="xs"
				truncate
				title={block.filename}
				style={{
					height: MEDIA_ATTACHMENT_FILENAME_HEIGHT,
					lineHeight: `${MEDIA_ATTACHMENT_FILENAME_HEIGHT}px`,
				}}
			>
				{block.filename || t(isVideo ? "videoAttachment" : "audioAttachment")}
			</Text>
			{url && !failed ? (
				isVideo ? (
					// biome-ignore lint/a11y/useMediaCaption: User-supplied media has no caption track; do not fabricate captions.
					<video
						src={url}
						controls
						preload="metadata"
						onError={() => setPlaybackErrorKey(key)}
						playsInline
						aria-label={block.filename || t("videoAttachment")}
						style={{
							display: "block",
							width: "100%",
							height: controlHeight,
							objectFit: "contain",
							background: "#111",
							borderRadius: "var(--mantine-radius-sm)",
						}}
					/>
				) : (
					// biome-ignore lint/a11y/useMediaCaption: User-supplied media has no caption track; do not fabricate captions.
					<audio
						src={url}
						controls
						preload="metadata"
						onError={() => setPlaybackErrorKey(key)}
						aria-label={block.filename || t("audioAttachment")}
						style={{ display: "block", width: "100%", height: controlHeight }}
					/>
				)
			) : (
				<Box
					style={{
						height: controlHeight,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						borderRadius: "var(--mantine-radius-sm)",
						background: "var(--mantine-color-default-hover)",
					}}
				>
					<Text size="xs" c="dimmed" role={failed ? "alert" : "status"}>
						{t(failed ? "mediaPreviewFailed" : "mediaPreviewLoading")}
					</Text>
				</Box>
			)}
		</Box>
	);
}
