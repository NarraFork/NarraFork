import { Box, Button, Text } from "@mantine/core";
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

/** Protected uploads download only on request; native controls only receive a local blob URL. */
export function MediaAttachment({
	narratorId,
	block,
}: {
	narratorId: string;
	block: MediaAttachmentBlock;
}) {
	const owner = block.uploadNarratorId || narratorId;
	const previewUrl = block.previewUrl?.startsWith("blob:") ? block.previewUrl : undefined;
	const referencingContext =
		narratorId && narratorId !== owner
			? `?referencingNarratorId=${encodeURIComponent(narratorId)}`
			: "";
	const sourceUrl = block.mediaId
		? `${apiBase()}/uploads/${encodeURIComponent(owner)}/media/${encodeURIComponent(block.mediaId)}${referencingContext}`
		: undefined;
	return (
		<MediaAttachmentPreview
			key={JSON.stringify([sourceUrl, previewUrl])}
			block={block}
			sourceUrl={sourceUrl}
			previewUrl={previewUrl}
		/>
	);
}

/** A new source starts idle, even when a virtual-list row reuses the component. */
function MediaAttachmentPreview({
	block,
	sourceUrl,
	previewUrl,
}: {
	block: MediaAttachmentBlock;
	sourceUrl?: string;
	previewUrl?: string;
}) {
	const { t } = useTranslation("narrator");
	const [request, setRequest] = useState(0);
	const [loaded, setLoaded] = useState<{ url?: string; failed?: boolean } | null>(null);
	const [playbackError, setPlaybackError] = useState(false);
	const isVideo = block.type === "video";
	useEffect(() => {
		if (!request || previewUrl || !sourceUrl) return;
		const controller = new AbortController();
		let objectUrl: string | undefined;
		let disposed = false;
		void authorizedFetch(sourceUrl, { signal: controller.signal })
			.then(async (response) => {
				if (disposed) return;
				if (!response.ok) throw new Error(`Media ${response.status}`);
				const blob = await response.blob();
				if (disposed) return;
				objectUrl = URL.createObjectURL(blob);
				setLoaded({ url: objectUrl });
			})
			.catch(() => {
				if (!disposed) setLoaded({ failed: true });
			});
		return () => {
			disposed = true;
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [request, previewUrl, sourceUrl]);
	const url = previewUrl || loaded?.url;
	const failed = loaded?.failed || playbackError;
	const loading = !previewUrl && request > 0 && !loaded;
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
						onError={() => setPlaybackError(true)}
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
						onError={() => setPlaybackError(true)}
						aria-label={block.filename || t("audioAttachment")}
						style={{ display: "block", width: "100%", height: controlHeight }}
					/>
				)
			) : (
				<Box
					style={{
						height: controlHeight,
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						borderRadius: "var(--mantine-radius-sm)",
						background: "var(--mantine-color-default-hover)",
					}}
				>
					{(failed || loading || (!sourceUrl && !previewUrl)) && (
						<Text size="xs" c="dimmed" role={failed ? "alert" : "status"}>
							{t(failed ? "mediaPreviewFailed" : "mediaPreviewLoading")}
						</Text>
					)}
					{!loading && (sourceUrl || previewUrl) && (
						<Button
							size="compact-xs"
							variant="subtle"
							onClick={() => {
								setLoaded(null);
								setPlaybackError(false);
								setRequest((attempt) => attempt + 1);
							}}
						>
							{t(failed ? "mediaPreviewRetry" : "mediaPreviewLoad")}
						</Button>
					)}
				</Box>
			)}
		</Box>
	);
}
