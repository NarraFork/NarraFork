import { Box, CloseButton, Group, Image, Text } from "@mantine/core";
import { IconFile } from "@tabler/icons-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useImageViewer } from "../../common/image-viewer-context";
import { formatFileSize } from "../narrator-panel-types";

export interface AttachmentPreviewsProps {
	attachedImages: File[];
	attachedTextFiles: File[];
	updateAttachedImages: React.Dispatch<React.SetStateAction<File[]>>;
	updateAttachedTextFiles: React.Dispatch<React.SetStateAction<File[]>>;
}

/**
 * Staged image + text-file preview strips shown above the composer. Owns its own
 * object-URL previews (derived from `attachedImages`) and the image viewer, so the
 * panel does not thread those in.
 */
export function AttachmentPreviews(props: AttachmentPreviewsProps) {
	const { t } = useTranslation("narrator");
	const openImageViewer = useImageViewer();
	const [imagePreviewUrls, setImagePreviewUrls] = useState<string[]>([]);
	useEffect(() => {
		const urls = props.attachedImages.map((file) => URL.createObjectURL(file));
		setImagePreviewUrls(urls);
		return () => {
			for (const url of urls) URL.revokeObjectURL(url);
		};
	}, [props.attachedImages]);

	const hasImages = props.attachedImages.length > 0;

	return (
		<>
			{/* Image previews */}
			{hasImages && (
				<Group
					pt="xs"
					px="md"
					pb={6}
					gap="xs"
					style={{ borderTop: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
				>
					{props.attachedImages.map((file, i) => (
						<Box
							key={`${file.name}-${file.size}-${file.lastModified}-${file.type}`}
							pos="relative"
							style={{ display: "inline-block" }}
						>
							<Image
								src={imagePreviewUrls[i]}
								alt={file.name}
								radius="sm"
								h={60}
								w={60}
								fit="cover"
								style={{ cursor: "pointer" }}
								onClick={() =>
									openImageViewer({
										src: imagePreviewUrls[i],
										filename: file.name,
										alt: file.name,
									})
								}
							/>
							<CloseButton
								size="xs"
								radius="xl"
								variant="filled"
								color="dark"
								style={{ position: "absolute", top: -6, right: -6 }}
								onClick={() => props.updateAttachedImages((prev) => prev.filter((_, j) => j !== i))}
								title={t("removeImage")}
							/>
						</Box>
					))}
				</Group>
			)}

			{/* Text file previews */}
			{props.attachedTextFiles.length > 0 && (
				<Group
					pt="xs"
					px="md"
					pb={6}
					gap={6}
					wrap="wrap"
					style={{
						borderTop: hasImages ? undefined : "1px solid var(--mantine-color-default-border)",
						flexShrink: 0,
					}}
				>
					{props.attachedTextFiles.map((file, i) => (
						<Group
							key={`${file.name}-${file.size}-${file.lastModified}-${file.type}`}
							gap={6}
							px="xs"
							py={4}
							wrap="nowrap"
							style={{
								borderRadius: "var(--mantine-radius-sm)",
								backgroundColor:
									"light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
								fontSize: "var(--mantine-font-size-xs)",
							}}
						>
							<IconFile size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
							<Text size="xs" truncate style={{ maxWidth: 160, minWidth: 0 }}>
								{file.name}
							</Text>
							<Text size="xs" c="dimmed" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
								{formatFileSize(file.size)}
							</Text>
							<CloseButton
								size={16}
								iconSize={12}
								variant="transparent"
								c="dimmed"
								onClick={() =>
									props.updateAttachedTextFiles((prev) => prev.filter((_, j) => j !== i))
								}
							/>
						</Group>
					))}
				</Group>
			)}
		</>
	);
}
