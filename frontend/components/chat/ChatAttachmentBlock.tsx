/**
 * ChatAttachmentBlock.tsx — Draws a message's attachments into the boxes the
 * measure layer reserved.
 *
 * ## Geometry comes from the measure layer, never from the content
 *
 * Every box's `top`/`width`/`height` is supplied by `measureChatMessage`, computed
 * from the dimensions the SERVER parsed at upload time. Nothing here waits for an
 * image to load before it knows how tall the row is — which is the whole point: the
 * chat list has no unknown-height correction pass, so a height that depended on a
 * network fetch would arrive after the row was already laid out and either clip the
 * image or leave a hole.
 *
 * The thumbnail is therefore drawn INTO a fixed box with `object-fit: contain`. A
 * slow or failed fetch changes what is inside the box, never the box.
 *
 * ## Why blob fetch instead of a plain `<img src>`
 *
 * `/api/chat/attachments/:id` is behind `requireSessionAuth` and a room ACL, so the
 * request needs an `Authorization` header — which an `<img>` tag cannot send. The
 * bounded, token-aware fetch here mirrors `EditAttachmentChips`'
 * `useUploadedImageBlobUrl`, including absorbing a renewed token and capping the
 * blob size.
 */

import { ActionIcon, Box, Group, Image, Loader, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { formatFileSize } from "@shared/text-file-types";
import { IconAlertTriangle, IconDownload, IconFile } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { absorbRenewedToken, clearTokenOnSessionFailure, getToken } from "../../lib/api";
import type { ChatAttachment } from "../../lib/api/chat";
import { apiUrl } from "../../lib/base-path";
import { useImageViewer } from "../common/ImageViewerProvider";
import type { MeasuredChatAttachment } from "./measure-chat-message";

/**
 * Ceiling on a thumbnail blob held in memory.
 *
 * The upload path caps a file well above this, so a legitimately large image simply
 * does not get an inline preview — the box shows the failed state and the file is
 * still downloadable. Holding tens of MiB of object URLs for a scrolled room is the
 * failure this prevents.
 */
const MAX_THUMBNAIL_BLOB_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling on a DOWNLOAD buffered in the JS heap.
 *
 * The endpoint needs an `Authorization` header, so the bytes must come through
 * `fetch` and land in a blob rather than being handed to the browser's own
 * downloader via a plain link. That makes a download's peak memory the file's full
 * size: at the upload cap a handful of concurrent clicks can take a low-memory tab
 * down. Refusing loudly beats an OOM the user cannot attribute to anything.
 *
 * Set at the upload cap rather than below it so no attachment the product accepts
 * becomes undownloadable; it only stops the pathological case of several very large
 * files at once from being silently unbounded.
 */
const MAX_DOWNLOAD_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * Object URL for one chat attachment, or null while loading / on failure.
 *
 * `enabled` gates the fetch on the row being mounted, so scrolling past a hundred
 * images does not queue a hundred requests for rows that were never painted — the
 * virtual list unmounts them and the cleanup revokes the URL.
 */
function useChatAttachmentBlobUrl(
	attachmentId: string,
	enabled: boolean,
): { url: string | null; failed: boolean } {
	const [url, setUrl] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (!enabled) return;
		const token = getToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		let cancelled = false;
		let objectUrl: string | null = null;
		setFailed(false);
		fetch(apiUrl(`/chat/attachments/${attachmentId}`), { headers })
			.then(async (res) => {
				// The token actually sent is passed through, so a tab that switched
				// accounts mid-flight cannot have the old account's renewal written back.
				absorbRenewedToken(res, token ?? undefined);
				if (!res.ok) {
					await clearTokenOnSessionFailure(res);
					throw new Error(`Request failed (${res.status})`);
				}
				return res.blob();
			})
			.then((blob) => {
				if (cancelled) return;
				if (blob.size > MAX_THUMBNAIL_BLOB_BYTES) throw new Error("Preview too large");
				objectUrl = URL.createObjectURL(blob);
				setUrl(objectUrl);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [attachmentId, enabled]);

	return { url, failed };
}

/**
 * Download an attachment through the authorized endpoint.
 *
 * Returns false when the download did not start, so the caller can say so instead
 * of leaving the reader looking at a button that did nothing.
 */
async function downloadChatAttachment(attachment: ChatAttachment): Promise<boolean> {
	const token = getToken();
	const headers: Record<string, string> = {};
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(apiUrl(`/chat/attachments/${attachment.id}`), { headers });
	absorbRenewedToken(res, token ?? undefined);
	if (!res.ok) {
		await clearTokenOnSessionFailure(res);
		return false;
	}
	const blob = await res.blob();
	if (blob.size > MAX_DOWNLOAD_BLOB_BYTES) return false;
	const objectUrl = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = objectUrl;
	anchor.download = attachment.filename;
	anchor.click();
	// Revoked well after the click rather than on the next tick: a next-tick revoke
	// can beat a slower browser's own read of the URL the click just started, which
	// shows up as a download that silently produces nothing.
	setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
	return true;
}

export interface ChatAttachmentBlockProps {
	attachments: readonly ChatAttachment[];
	/** Reserved boxes, index-aligned with `attachments`. */
	measured: readonly MeasuredChatAttachment[];
	/** Total block height including the gap to the body below. */
	height: number;
}

export function ChatAttachmentBlock({ attachments, measured, height }: ChatAttachmentBlockProps) {
	return (
		<Box style={{ position: "relative", height, overflow: "hidden" }}>
			{measured.map((box, index) => {
				const attachment = attachments[index];
				// A measured box with no attachment means a stale cached measurement is
				// being drawn against fresher data. Reserving the space and drawing
				// nothing is correct; throwing inside a render pass is not.
				if (!attachment) return null;
				return (
					<Box
						key={attachment.id}
						style={{
							position: "absolute",
							top: box.top,
							left: 0,
							width: box.width,
							height: box.height,
						}}
					>
						{attachment.kind === "image" ? (
							<ChatImageAttachment attachment={attachment} width={box.width} height={box.height} />
						) : (
							<ChatFileAttachment attachment={attachment} height={box.height} />
						)}
					</Box>
				);
			})}
		</Box>
	);
}

function ChatImageAttachment({
	attachment,
	width,
	height,
}: {
	attachment: ChatAttachment;
	width: number;
	height: number;
}) {
	const { t } = useTranslation("chat");
	const openImageViewer = useImageViewer();
	const { url, failed } = useChatAttachmentBlobUrl(attachment.id, true);

	return (
		<Box
			style={{
				width,
				height,
				borderRadius: 6,
				overflow: "hidden",
				background: "var(--mantine-color-default)",
				display: "grid",
				placeItems: "center",
				cursor: url ? "zoom-in" : "default",
			}}
			onClick={(event) => {
				event.stopPropagation();
				if (url) {
					openImageViewer({ src: url, filename: attachment.filename, alt: attachment.filename });
				}
			}}
		>
			{url ? (
				<Image
					src={url}
					alt={attachment.filename}
					// `contain` inside the reserved box: the box already has the right
					// aspect ratio, and contain guarantees a mismatch (a stale row, an
					// image whose stored dimensions are wrong) letterboxes instead of
					// overflowing a height the list has already committed to.
					fit="contain"
					w={width}
					h={height}
					style={{ display: "block" }}
				/>
			) : failed ? (
				<Tooltip label={t("attachmentPreviewFailed")}>
					<IconAlertTriangle size={18} color="var(--mantine-color-dimmed)" />
				</Tooltip>
			) : (
				<Loader size="xs" />
			)}
		</Box>
	);
}

function ChatFileAttachment({
	attachment,
	height,
}: {
	attachment: ChatAttachment;
	height: number;
}) {
	const { t } = useTranslation("chat");
	return (
		<Group
			gap={6}
			wrap="nowrap"
			px={8}
			style={{
				height,
				borderRadius: 6,
				background: "var(--mantine-color-default)",
				border: "1px solid var(--mantine-color-default-border)",
				boxSizing: "border-box",
			}}
		>
			<IconFile size={14} style={{ flexShrink: 0 }} />
			<Text size="xs" truncate style={{ flex: 1, minWidth: 0 }}>
				{attachment.filename}
			</Text>
			<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
				{formatFileSize(attachment.sizeBytes)}
			</Text>
			<Tooltip label={t("downloadAttachment")}>
				<ActionIcon
					size="xs"
					variant="subtle"
					color="gray"
					onClick={(event) => {
						event.stopPropagation();
						void downloadChatAttachment(attachment).then((started) => {
							// A refused download must say so: the button is otherwise
							// indistinguishable from one that worked.
							if (!started) {
								notifications.show({ message: t("attachmentDownloadFailed"), color: "red" });
							}
						});
					}}
				>
					<IconDownload size={12} />
				</ActionIcon>
			</Tooltip>
		</Group>
	);
}
