import {
	ActionIcon,
	Box,
	Group,
	Image,
	Loader,
	Paper,
	Skeleton,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconArrowsMinimize } from "@tabler/icons-react";
import { getToken } from "../../lib/api";
import { ContentViewer } from "./ContentViewer";
import { ToolCallCard } from "./ToolCallCard";

interface MessageBubbleProps {
	narratorId?: string;
	message: {
		role: string;
		contentJson: any[];
		contentText?: string;
		toolCalls?: any[];
		sdkMessageUuid?: string;
	};
	onForkFromMessage?: (sdkMessageUuid: string) => void;
}

function ImageBlock({ block, narratorId }: { block: any; narratorId?: string }) {
	const [blobUrl, setBlobUrl] = useState<string | null>(null);

	useEffect(() => {
		if (block.previewUrl || !narratorId || !block.imageId) return;

		const token = getToken();
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;

		let cancelled = false;
		let objectUrl: string | null = null;
		fetch(`/api/uploads/${narratorId}/${block.imageId}`, { headers })
			.then((res) => (res.ok ? res.blob() : null))
			.then((blob) => {
				if (blob && !cancelled) {
					objectUrl = URL.createObjectURL(blob);
					setBlobUrl(objectUrl);
				}
			})
			.catch(() => {});

		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [narratorId, block.imageId, block.previewUrl]);

	const src = block.previewUrl ?? blobUrl;
	if (!src) {
		return <Skeleton h={200} w={300} radius="sm" />;
	}
	return (
		<Box
			style={{
				maxWidth: "100%",
				width: "fit-content",
				height: 200,
				borderRadius: "var(--mantine-radius-sm)",
				overflow: "hidden",
				margin: "0 auto",
			}}
		>
			<Image
				src={src}
				alt={block.filename ?? "image"}
				radius="sm"
				h={200}
				w="auto"
				fit="contain"
				loading="lazy"
				style={{ cursor: "pointer", maxWidth: "100%" }}
				onClick={() => window.open(src, "_blank")}
			/>
		</Box>
	);
}

export const MessageBubble = memo(function MessageBubble({
	narratorId,
	message,
	onForkFromMessage,
}: MessageBubbleProps) {
	const isUser = message.role === "user";
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	const canFork = !isUser && message.sdkMessageUuid && onForkFromMessage;
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("chapters");

	// System messages (compact indicators)
	if (message.role === "system") {
		const compactBlock = blocks.find((b: any) => b.type === "compact");
		if (compactBlock) {
			const isCompacting = compactBlock.status === "compacting";
			return (
				<Group gap={6} justify="center" py={4}>
					{isCompacting ? (
						<Loader size={14} color="orange" />
					) : (
						<IconArrowsMinimize size={14} style={{ color: "var(--mantine-color-orange-6)" }} />
					)}
					<Text size="xs" c="orange">
						{isCompacting ? t("compacting") : t("compacted")}
					</Text>
				</Group>
			);
		}
		return null;
	}

	// User messages: full-width bubble
	if (isUser) {
		return (
			<Paper p="sm" radius="md" style={{ backgroundColor: "var(--mantine-color-indigo-light)" }}>
				<Stack gap={4}>
					<Text size="xs" fw={600} c="indigo">
						{t("you")}
					</Text>
					{blocks.map((block: any, i: number) => {
						const key = block.id ?? `${block.type}-${i}`;
						if (block.type === "text") {
							return (
								<Text key={key} size="sm" style={{ whiteSpace: "pre-wrap" }}>
									{block.text}
								</Text>
							);
						}
						if (block.type === "image") {
							return <ImageBlock key={key} block={block} narratorId={narratorId} />;
						}
						return null;
					})}
				</Stack>
			</Paper>
		);
	}

	// Assistant messages: render content blocks directly
	return (
		<Stack gap={4}>
			{canFork && (
				<Group justify="flex-end">
					<Tooltip label={tc("forkFromMessage")}>
						<ActionIcon
							size="xs"
							variant="subtle"
							color="gray"
							onClick={() => onForkFromMessage(message.sdkMessageUuid!)}
						>
							&#x2442;
						</ActionIcon>
					</Tooltip>
				</Group>
			)}
			{blocks.map((block: any, i: number) => {
				const key = block.id ?? `${block.type}-${i}`;
				if (block.type === "text") {
					if (!block.text?.trim()) return null;
					return <ContentViewer key={key} content={block.text} markdown contentType="markdown" />;
				}
				if (block.type === "image") {
					return <ImageBlock key={key} block={block} narratorId={narratorId} />;
				}
				if (block.type === "thinking") {
					return (
						<Paper
							key={key}
							p="xs"
							radius="sm"
							style={{ backgroundColor: "var(--mantine-color-yellow-light)" }}
						>
							<Text size="xs" c="dimmed" fw={500} mb={2}>
								{t("thinking")}
							</Text>
							<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
								{block.thinking}
							</Text>
						</Paper>
					);
				}
				if (block.type === "tool_use") {
					const tc = message.toolCalls?.find((t: any) => t.toolUseId === block.id);
					return (
						<ToolCallCard
							key={key}
							toolCall={{
								toolName: block.name,
								toolUseId: block.id,
								inputJson: tc?.inputJson ?? block.input,
								outputJson: tc?.outputJson,
								status: tc?.status ?? "running",
								durationMs: tc?.durationMs,
								errorMessage: tc?.errorMessage,
							}}
						/>
					);
				}
				return null;
			})}
		</Stack>
	);
});
