import { Box, Modal, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export const MAX_COMPOSER_TEXT_PREVIEW_BYTES = 256 * 1024;
const PREVIEW_READ_TIMEOUT_MS = 10_000;

interface TextPreview {
	text: string;
	truncated: boolean;
}

/** Read only a bounded prefix, regardless of the attachment's declared MIME type. */
export async function readComposerTextAttachment(file: File): Promise<TextPreview> {
	const prefix = await file.slice(0, MAX_COMPOSER_TEXT_PREVIEW_BYTES).arrayBuffer();
	let truncated = file.size > MAX_COMPOSER_TEXT_PREVIEW_BYTES;
	// Do not show a replacement character for a UTF-8 sequence cut by the byte limit.
	let text = new TextDecoder().decode(prefix, { stream: truncated });
	const encoded = new TextEncoder().encode(text);
	// Malformed UTF-8 can expand into three-byte replacement characters after decoding.
	if (encoded.byteLength > MAX_COMPOSER_TEXT_PREVIEW_BYTES) {
		text = new TextDecoder().decode(encoded.subarray(0, MAX_COMPOSER_TEXT_PREVIEW_BYTES), {
			stream: true,
		});
		truncated = true;
	}
	return { text, truncated };
}

export function ComposerTextAttachmentPreview({
	file,
	name,
	mediaKind,
	onClose,
}: {
	file: File | undefined;
	name: string;
	mediaKind?: "audio" | "video";
	onClose: () => void;
}) {
	const { t } = useTranslation("narrator");
	useEffect(() => {
		const close = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
			// Consume before closing: the fullscreen editor may reattach its document listener
			// synchronously, while this same key event is still travelling from window to document.
			event.preventDefault();
			event.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", close, true);
		return () => window.removeEventListener("keydown", close, true);
	}, [onClose]);
	const [result, setResult] = useState<{
		file: File;
		preview?: TextPreview;
		failed?: boolean;
	} | null>(null);

	const [mediaUrl, setMediaUrl] = useState<{ file: File; url: string } | null>(null);
	useEffect(() => {
		setMediaUrl(null);
		if (!file || !mediaKind) return;
		const url = URL.createObjectURL(file);
		setMediaUrl({ file, url });
		return () => URL.revokeObjectURL(url);
	}, [file, mediaKind]);
	useEffect(() => {
		setResult(null);
		if (!file || mediaKind) return;
		let active = true;
		const timeout = setTimeout(() => {
			active = false;
			setResult({ file, failed: true });
		}, PREVIEW_READ_TIMEOUT_MS);
		void readComposerTextAttachment(file).then(
			(preview) => {
				if (!active) return;
				clearTimeout(timeout);
				setResult({ file, preview });
			},
			() => {
				if (!active) return;
				clearTimeout(timeout);
				setResult({ file, failed: true });
			},
		);
		return () => {
			// Blob reads cannot be aborted, but are bounded and must never update a new preview.
			active = false;
			clearTimeout(timeout);
		};
	}, [file, mediaKind]);

	const current = result?.file === file ? result : null;
	return (
		// The fullscreen composer is at z-index 400; its attachment viewer must stay above it.
		<Modal
			opened
			onClose={onClose}
			title={t("attachments.previewTitle", { name })}
			size="xl"
			zIndex={500}
			closeOnEscape={false}
		>
			<Stack gap="xs">
				{file && mediaKind ? (
					mediaUrl?.file === file ? (
						mediaKind === "video" ? (
							<video
								controls
								preload="metadata"
								src={mediaUrl.url}
								aria-label={name}
								style={{ width: "100%", maxHeight: "60vh" }}
							>
								<track kind="captions" />
							</video>
						) : (
							<audio
								controls
								preload="metadata"
								src={mediaUrl.url}
								aria-label={name}
								style={{ width: "100%" }}
							>
								<track kind="captions" />
							</audio>
						)
					) : (
						<Text role="status">{t("attachments.previewLoading")}</Text>
					)
				) : !file || current?.failed ? (
					<Text c="red" size="sm" role="alert">
						{t("attachments.previewFailed")}
					</Text>
				) : !current?.preview ? (
					<Text c="dimmed" size="sm" role="status">
						{t("attachments.previewLoading")}
					</Text>
				) : (
					<>
						{current.preview.truncated && (
							<Text c="orange" size="sm" role="status">
								{t("attachments.previewTruncated", {
									limit: MAX_COMPOSER_TEXT_PREVIEW_BYTES / 1024,
								})}
							</Text>
						)}
						{current.preview.text ? (
							<Box
								component="pre"
								role="region"
								aria-label={t("attachments.previewContent")}
								style={{
									margin: 0,
									maxHeight: "60vh",
									overflow: "auto",
									whiteSpace: "pre-wrap",
									overflowWrap: "anywhere",
									fontFamily: "var(--mantine-font-family-monospace)",
									fontSize: "var(--mantine-font-size-sm)",
								}}
							>
								{current.preview.text}
							</Box>
						) : (
							<Text c="dimmed" size="sm">
								{t("attachments.previewEmpty")}
							</Text>
						)}
					</>
				)}
			</Stack>
		</Modal>
	);
}
