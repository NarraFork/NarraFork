/**
 * ChatComposerAttachments.tsx — Pending attachment chips above the composer.
 *
 * Each chip is one file in one of three states, and all three are visible on purpose:
 *
 *   - `uploading` — the upload is in flight. Sending is blocked while any chip is
 *     here, because a send would claim only the ids that had already landed and
 *     silently drop the rest.
 *   - `ready`     — persisted as a draft on the server; its id goes to the send.
 *   - `error`     — the upload failed. The chip STAYS so the failure is visible and
 *     the file can be re-picked. Removing it on failure would look like a success.
 *
 * A chip has no server id until the upload lands, so the list is keyed by a
 * client-generated `localId`: the row has to be visible and removable before the
 * server knows about it.
 */

import { ActionIcon, Box, Group, Loader, Text, Tooltip } from "@mantine/core";
import { formatFileSize } from "@shared/text-file-types";
import { IconAlertTriangle, IconFile, IconPhoto, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { ChatAttachment } from "../../lib/api/chat";

export interface PendingChatAttachment {
	/** Client-side key; the server id only exists once `attachment` is set. */
	localId: string;
	filename: string;
	sizeBytes: number;
	status: "uploading" | "ready" | "error";
	/** Present once the upload succeeded. */
	attachment?: ChatAttachment;
	/** Failure reason, shown on the chip's tooltip. */
	error?: string;
}

export interface ChatComposerAttachmentsProps {
	items: readonly PendingChatAttachment[];
	onRemove: (localId: string) => void;
}

export function ChatComposerAttachments({ items, onRemove }: ChatComposerAttachmentsProps) {
	const { t } = useTranslation("chat");
	if (items.length === 0) return null;

	return (
		<Group
			gap={6}
			px="sm"
			py={6}
			wrap="wrap"
			style={{
				flexShrink: 0,
				borderTop: "1px solid var(--mantine-color-default-border)",
			}}
		>
			{items.map((item) => {
				const isImage = item.attachment?.kind === "image";
				const failed = item.status === "error";
				return (
					<Group
						key={item.localId}
						gap={4}
						wrap="nowrap"
						px={6}
						py={2}
						style={{
							borderRadius: 4,
							maxWidth: 240,
							background: failed
								? "var(--mantine-color-red-light)"
								: "var(--mantine-color-default-hover)",
							border: "1px solid var(--mantine-color-default-border)",
						}}
					>
						{item.status === "uploading" ? (
							<Loader size={12} style={{ flexShrink: 0 }} />
						) : failed ? (
							<Tooltip label={item.error ?? t("attachmentUploadFailed")}>
								<Box style={{ display: "flex", flexShrink: 0 }}>
									<IconAlertTriangle size={12} color="var(--mantine-color-red-6)" />
								</Box>
							</Tooltip>
						) : isImage ? (
							<IconPhoto size={12} style={{ flexShrink: 0 }} />
						) : (
							<IconFile size={12} style={{ flexShrink: 0 }} />
						)}
						<Text size="xs" truncate style={{ minWidth: 0 }}>
							{item.filename}
						</Text>
						<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
							{formatFileSize(item.sizeBytes)}
						</Text>
						<Tooltip label={t("removeAttachment")}>
							<ActionIcon
								size="xs"
								variant="subtle"
								color="gray"
								onClick={() => onRemove(item.localId)}
							>
								<IconX size={11} />
							</ActionIcon>
						</Tooltip>
					</Group>
				);
			})}
		</Group>
	);
}
