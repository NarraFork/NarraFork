import { Box, CloseButton, Group } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	MAX_MEDIA_ATTACHMENTS,
	MAX_MEDIA_FILE_SIZE,
	MEDIA_MIME_TO_EXT,
	type MediaRef,
	mediaRefToContentBlock,
	normalizeMediaFile,
} from "@shared/media-attachments";
import { useTranslation } from "react-i18next";
import { MediaAttachment, PendingMediaAttachment, pendingMediaKey } from "./MediaAttachment";

export function appendMediaFiles(
	files: File[],
	keptCount: number,
	previous: File[],
	t: (key: string) => string,
): File[] {
	const valid = files.map(normalizeMediaFile).filter((file) => {
		const error = !Object.hasOwn(MEDIA_MIME_TO_EXT, file.type)
			? "unsupportedFileType"
			: !file.size || file.size > MAX_MEDIA_FILE_SIZE
				? "mediaFileTooLarge"
				: null;
		if (error) notifications.show({ color: "yellow", title: t(error), message: file.name });
		return !error;
	});
	const room = Math.max(0, MAX_MEDIA_ATTACHMENTS - keptCount - previous.length);
	if (valid.length > room) notifications.show({ color: "yellow", message: t("mediaTooMany") });
	return [...previous, ...valid.slice(0, room)];
}

export function MediaAttachmentEditor({
	narratorId,
	kept,
	newFiles,
	onRemoveKept,
	onRemoveNew,
	disabled,
}: {
	narratorId: string;
	kept: MediaRef[];
	newFiles: File[];
	onRemoveKept: (id: string) => void;
	onRemoveNew: (index: number) => void;
	disabled?: boolean;
}) {
	const { t } = useTranslation("narrator");

	if (!kept.length && !newFiles.length) return null;
	return (
		<Group gap="xs" align="flex-start" wrap="wrap">
			{kept.map((media) => (
				<Box key={media.mediaId} pos="relative" style={{ maxWidth: "100%" }}>
					<MediaAttachment narratorId={narratorId} block={mediaRefToContentBlock(media)} />
					<CloseButton
						size="xs"
						disabled={disabled}
						title={t("removeMedia")}
						aria-label={`${t("removeMedia")}: ${media.filename}`}
						style={{ position: "absolute", right: 0, top: 0 }}
						onClick={() => onRemoveKept(media.mediaId)}
					/>
				</Box>
			))}
			{newFiles.map((file, index) => (
				<Box key={pendingMediaKey(file)} pos="relative" style={{ maxWidth: "100%" }}>
					<PendingMediaAttachment file={file} />
					<CloseButton
						size="xs"
						disabled={disabled}
						title={t("removeMedia")}
						aria-label={`${t("removeMedia")}: ${file.name}`}
						style={{ position: "absolute", right: 0, top: 0 }}
						onClick={() => onRemoveNew(index)}
					/>
				</Box>
			))}
		</Group>
	);
}
