import {
	ActionIcon,
	Box,
	Button,
	Group,
	Image,
	Loader,
	Modal,
	Paper,
	ScrollArea,
	Skeleton,
	Stack,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconArrowsMinimize } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, getToken } from "../../lib/api";
import { ContentViewer } from "./ContentViewer";
import { MarkdownContent } from "./MarkdownContent";
import { type PendingPermission, ToolCallCard } from "./ToolCallCard";

interface MessageBubbleProps {
	narratorId?: string;
	message: {
		id?: string;
		role: string;
		contentJson: any[];
		contentText?: string;
		toolCalls?: any[];
		sdkMessageUuid?: string;
	};
	onForkFromMessage?: (sdkMessageUuid: string) => void;
	/** Resolve a PendingPermission for a given tool call record */
	resolvePerm?: (tc: any) => PendingPermission | null;
	onPermissionDecision?: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
	) => void;
	onQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
	onQuestionDeny?: (requestId: string) => void;
	onDeleteMessage?: (messageId: string) => void;
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

function CompactIndicator({
	isCompacting,
	narratorId,
	messageId,
	onDelete,
}: {
	isCompacting: boolean;
	narratorId?: string;
	messageId?: string;
	onDelete?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [opened, { open, close }] = useDisclosure(false);
	const [deleting, setDeleting] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [saving, setSaving] = useState(false);

	const canClick = !isCompacting && narratorId && messageId;

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ["compact-summary", narratorId, messageId],
		queryFn: () => api.getCompactSummary(narratorId!, messageId!),
		enabled: opened && !!narratorId && !!messageId,
	});

	const handleDelete = async () => {
		if (!narratorId || !messageId) return;
		setDeleting(true);
		try {
			await api.deleteCompactMessage(narratorId, messageId);
			close();
			onDelete?.();
		} finally {
			setDeleting(false);
		}
	};

	const handleEdit = () => {
		setEditText(data?.summary ?? "");
		setEditing(true);
	};

	const handleSave = async () => {
		if (!narratorId || !messageId) return;
		setSaving(true);
		try {
			await api.updateCompactSummary(narratorId, messageId, editText);
			setEditing(false);
			refetch();
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<Group
				gap={6}
				justify="center"
				py={4}
				style={canClick ? { cursor: "pointer" } : undefined}
				onClick={canClick ? open : undefined}
			>
				{isCompacting ? (
					<Loader size={14} color="orange" />
				) : (
					<IconArrowsMinimize size={14} style={{ color: "var(--mantine-color-orange-6)" }} />
				)}
				<Text size="xs" c="orange" td={canClick ? "underline" : undefined}>
					{isCompacting ? t("compacting") : t("compacted")}
				</Text>
			</Group>

			<Modal
				opened={opened}
				onClose={() => {
					close();
					setEditing(false);
				}}
				title={
					<Group gap="xs">
						<IconArrowsMinimize size={18} style={{ color: "var(--mantine-color-orange-6)" }} />
						<Text fw={600}>{t("compactSummaryTitle")}</Text>
					</Group>
				}
				size="lg"
			>
				{isLoading && (
					<Group justify="center" py="xl">
						<Loader size="sm" />
					</Group>
				)}
				{error && (
					<Text c="red" size="sm">
						{error instanceof Error ? error.message : String(error)}
					</Text>
				)}
				{editing ? (
					<Textarea
						value={editText}
						onChange={(e) => setEditText(e.currentTarget.value)}
						autosize
						minRows={8}
						maxRows={20}
					/>
				) : (
					data?.summary && (
						<ScrollArea.Autosize mah="70vh">
							<MarkdownContent text={data.summary} />
						</ScrollArea.Autosize>
					)
				)}
				{canClick && (
					<Group justify="flex-end" mt="md">
						{editing ? (
							<>
								<Button variant="subtle" size="xs" onClick={() => setEditing(false)}>
									{t("cancelEdit")}
								</Button>
								<Button size="xs" loading={saving} onClick={handleSave}>
									{t("saveEdit")}
								</Button>
							</>
						) : (
							<>
								<Button
									color="red"
									variant="light"
									size="xs"
									loading={deleting}
									onClick={handleDelete}
								>
									{t("deleteCompact")}
								</Button>
								<Button variant="light" size="xs" onClick={handleEdit}>
									{t("editCompact")}
								</Button>
							</>
						)}
					</Group>
				)}
			</Modal>
		</>
	);
}

export const MessageBubble = memo(function MessageBubble({
	narratorId,
	message,
	onForkFromMessage,
	resolvePerm,
	onPermissionDecision,
	onQuestionSubmit,
	onQuestionDeny,
	onDeleteMessage,
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
			const canNavigate = !isCompacting && narratorId && message.id;
			return (
				<CompactIndicator
					isCompacting={isCompacting}
					narratorId={canNavigate ? narratorId : undefined}
					messageId={canNavigate ? message.id : undefined}
					onDelete={canNavigate && onDeleteMessage ? () => onDeleteMessage(message.id!) : undefined}
				/>
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
				<Group justify="flex-end" gap={4}>
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
					const toolCallData = {
						id: tc?.id,
						toolName: block.name,
						toolUseId: block.id,
						inputJson: tc?.inputJson ?? block.input,
						outputJson: tc?.outputJson,
						status: tc?.status ?? "running",
						durationMs: tc?.durationMs,
						errorMessage: tc?.errorMessage,
						permissionDecisionReason: tc?.permissionDecisionReason,
						permissionSuggestions: tc?.permissionSuggestions,
					};
					const perm = resolvePerm?.(toolCallData) ?? null;
					return (
						<ToolCallCard
							key={key}
							toolCall={toolCallData}
							narratorId={narratorId}
							pendingPermission={perm}
							onPermissionDecision={onPermissionDecision}
							onQuestionSubmit={onQuestionSubmit}
							onQuestionDeny={onQuestionDeny}
						/>
					);
				}
				return null;
			})}
		</Stack>
	);
});
