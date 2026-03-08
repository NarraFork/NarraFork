import {
	Box,
	Button,
	Group,
	Image,
	Loader,
	Modal,
	Paper,
	ScrollArea,
	Skeleton,
	Spoiler,
	Stack,
	Text,
	Textarea,
	ThemeIcon,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
	IconAlertTriangle,
	IconArrowsMinimize,
	IconBrain,
	IconChevronDown,
	IconChevronRight,
	IconGitCommit,
	IconGitMerge,
	IconListCheck,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, getToken } from "../../lib/api";
import { UserAvatar } from "../UserAvatar";
import { ContentViewer } from "./ContentViewer";
import { LazyCollapse } from "./LazyCollapse";
import { MarkdownContent } from "./MarkdownContent";
import { type MessageContextMenuActions, MessageContextMenuCtx } from "./MessageContextMenuCtx";
import { getCategoryColor, type PendingPermission, ToolCallCard } from "./ToolCallCard";

interface MessageBubbleProps {
	narratorId?: string;
	message: {
		id?: string;
		role: string;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		contentJson: any[];
		contentText?: string | null;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		toolCalls?: any[];
		messageUuid?: string | null;
		commandText?: string | null;
		creator?: {
			id: string;
			username: string;
			avatarColor?: string | null;
			avatarImageId?: string | null;
		} | null;
		/** Maps each index in the (possibly filtered/reordered) contentJson back to its index in the original contentJson. */
		_blockOriginalIndices?: number[];
	};
	onForkFromMessage?: (messageUuid: string) => void;
	/** Resolve a PendingPermission for a given tool call record */
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	resolvePerm?: (tc: any) => PendingPermission | null;
	onPermissionDecision?: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
		compactAfter?: boolean,
		updatedPlan?: string,
	) => void;
	onQuestionSubmit?: (requestId: string, answers: Record<string, string>) => void;
	onQuestionDeny?: (requestId: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
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
		queryFn: () => api.getCompactSummary(narratorId ?? "", messageId ?? ""),
		enabled: opened && !!narratorId && !!messageId,
	});

	const handleDelete = async () => {
		if (!narratorId || !messageId) return;
		setDeleting(true);
		try {
			await api.deleteCompactMessage(narratorId, messageId);
			close();
			onDelete?.();
		} catch {
			notifications.show({
				title: t("deleteMessageFailed"),
				message: t("deleteMessageFailedDesc"),
				color: "red",
				autoClose: 5000,
			});
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

function MergeSummaryCard({
	block,
	creator,
	onDelete,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	block: any;
	creator?: {
		id: string;
		username: string;
		avatarColor?: string | null;
		avatarImageId?: string | null;
	} | null;
	onDelete?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [opened, { open, close }] = useDisclosure(false);
	const [confirmOpen, { open: openConfirm, close: closeConfirm }] = useDisclosure(false);
	const qc = useQueryClient();

	const unmergeMutation = useMutation({
		mutationFn: () => api.unmergeChapter(block.sourceChapterId),
		onSuccess: () => {
			closeConfirm();
			close();
			// The backend deletes the merge_summary message during unmerge,
			// so invalidating messages will remove this card from the list.
			onDelete?.();
			qc.invalidateQueries({ queryKey: ["storyGraph"] });
			qc.invalidateQueries({ queryKey: ["chapters"] });
			notifications.show({
				title: t("unmergeSuccess"),
				message: t("unmergeSuccessDesc"),
				color: "green",
			});
		},
		onError: (err) => {
			notifications.show({
				title: t("unmergeFailed"),
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		},
	});

	const header = block.mergedBy
		? `${block.sourceBranch} → ${block.targetBranch} (${block.mergedBy})`
		: `${block.sourceBranch} → ${block.targetBranch}`;

	return (
		<>
			<Paper
				p="xs"
				radius="sm"
				style={{
					backgroundColor: "var(--mantine-color-indigo-light)",
					cursor: "pointer",
				}}
				onClick={open}
				onContextMenu={(e) => {
					if (!block.sourceChapterId) return;
					e.preventDefault();
					open();
				}}
			>
				<Group gap={6} wrap="nowrap">
					{creator && (
						<UserAvatar
							username={creator.username}
							avatarColor={creator.avatarColor}
							avatarImageId={creator.avatarImageId}
							userId={creator.id}
							size={16}
							showTooltip={false}
						/>
					)}
					<IconGitMerge
						size={16}
						style={{ flexShrink: 0, color: "var(--mantine-color-indigo-6)" }}
					/>
					<Text size="xs" c="indigo" lineClamp={1}>
						{t("mergeSummaryLabel")}
						{block.mergeRound > 1 && ` #${block.mergeRound}`} — {header}
					</Text>
				</Group>
			</Paper>

			<Modal
				opened={opened}
				onClose={close}
				title={
					<Group gap="xs">
						<IconGitMerge size={18} style={{ color: "var(--mantine-color-indigo-6)" }} />
						<Text fw={600}>
							{t("mergeSummaryTitle")}
							{block.mergeRound > 1 && ` #${block.mergeRound}`}
						</Text>
					</Group>
				}
				size="lg"
			>
				<Stack gap="xs" mb="md">
					<Group gap="xs">
						<Text size="sm" c="dimmed">
							{t("mergeSummaryBranch")}:
						</Text>
						{creator && (
							<UserAvatar
								username={creator.username}
								avatarColor={creator.avatarColor}
								avatarImageId={creator.avatarImageId}
								userId={creator.id}
								size={20}
								showTooltip
							/>
						)}
						<Text size="sm" fw={500}>
							{header}
						</Text>
					</Group>
					{block.strategy && (
						<Group gap="xs">
							<Text size="sm" c="dimmed">
								{t("mergeSummaryStrategy")}:
							</Text>
							<Text size="sm">{block.strategy}</Text>
						</Group>
					)}
					{block.commitSha && (
						<Group gap="xs">
							<Text size="sm" c="dimmed">
								Commit:
							</Text>
							<Text size="sm" ff="monospace">
								{block.commitSha.slice(0, 8)}
							</Text>
						</Group>
					)}
				</Stack>

				{block.summary && (
					<ScrollArea.Autosize mah="60vh">
						<MarkdownContent text={block.summary} />
					</ScrollArea.Autosize>
				)}

				{block.sourceChapterId && (
					<Group justify="flex-end" mt="md">
						<Button color="orange" variant="light" size="xs" onClick={openConfirm}>
							{t("unmerge")}
						</Button>
					</Group>
				)}
			</Modal>

			{/* Confirmation dialog for unmerge */}
			<Modal opened={confirmOpen} onClose={closeConfirm} title={t("unmergeConfirmTitle")} size="sm">
				<Text size="sm" mb="md">
					{t("unmergeConfirmDesc", { branch: block.sourceBranch })}
				</Text>
				<Group justify="flex-end">
					<Button variant="default" size="xs" onClick={closeConfirm}>
						{t("cancel")}
					</Button>
					<Button
						color="orange"
						size="xs"
						loading={unmergeMutation.isPending}
						onClick={() => unmergeMutation.mutate()}
					>
						{t("unmerge")}
					</Button>
				</Group>
			</Modal>
		</>
	);
}

export function ReasoningSummary({ text }: { text: string }) {
	const [expanded, setExpanded] = useState(false);
	const [isOverflow, setIsOverflow] = useState(false);
	const lineRef = useRef<HTMLDivElement | null>(null);
	const singleLineText = text.trim().replace(/\s+/g, " ");
	const boldMatch = singleLineText.match(/^\*\*(.+?)\*\*/);
	const headerText = boldMatch ? boldMatch[1] : singleLineText.replace(/\*\*/g, "");
	const trailingText = boldMatch ? singleLineText.slice(boldMatch[0].length).trim() : "";
	const hasTrailingContent = trailingText.length > 0;

	const autoExpandedRef = useRef(false);
	useLayoutEffect(() => {
		if (hasTrailingContent && !autoExpandedRef.current) {
			autoExpandedRef.current = true;
			setExpanded(true);
		}
	}, [hasTrailingContent]);

	useLayoutEffect(() => {
		if (!headerText) {
			setIsOverflow(false);
			return;
		}

		const measure = () => {
			const el = lineRef.current;
			if (!el) {
				setIsOverflow(false);
				return;
			}
			setIsOverflow(el.scrollWidth - el.clientWidth > 1);
		};

		measure();
		const rafId = requestAnimationFrame(measure);
		const timeoutId1 = setTimeout(measure, 120);
		const timeoutId2 = setTimeout(measure, 400);

		const handleResize = () => measure();
		window.addEventListener("resize", handleResize);

		let ro: ResizeObserver | undefined;
		if (typeof ResizeObserver !== "undefined" && lineRef.current) {
			ro = new ResizeObserver(measure);
			ro.observe(lineRef.current);
		}

		let cancelled = false;
		if (document.fonts?.ready) {
			document.fonts.ready
				.then(() => {
					if (!cancelled) measure();
				})
				.catch(() => {});
		}

		return () => {
			cancelled = true;
			cancelAnimationFrame(rafId);
			clearTimeout(timeoutId1);
			clearTimeout(timeoutId2);
			window.removeEventListener("resize", handleResize);
			ro?.disconnect();
		};
	}, [headerText]);

	const canExpand = isOverflow || hasTrailingContent;

	useLayoutEffect(() => {
		if (!canExpand && expanded) {
			setExpanded(false);
		}
	}, [canExpand, expanded]);

	return (
		<Box style={{ flex: 1, minWidth: 0 }}>
			{canExpand ? (
				<UnstyledButton
					onClick={() => setExpanded((o) => !o)}
					w="100%"
					style={{ display: "block" }}
				>
					<Group gap={4} wrap="nowrap" align="center">
						<Box
							style={{
								flex: 1,
								minWidth: 0,
								display: "flex",
								alignItems: "center",
								height: 18,
							}}
						>
							<div
								ref={lineRef}
								style={{
									width: "100%",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									fontSize: "var(--mantine-font-size-xs)",
									fontFamily: "var(--mantine-font-family-monospace)",
									lineHeight: "18px",
								}}
								title={headerText}
							>
								{headerText}
							</div>
						</Box>
						<Box
							style={{
								display: "inline-flex",
								alignItems: "center",
								justifyContent: "center",
								flexShrink: 0,
								width: 16,
								height: 16,
							}}
						>
							{expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
						</Box>
					</Group>
				</UnstyledButton>
			) : (
				<Box
					style={{
						flex: 1,
						minWidth: 0,
						display: "flex",
						alignItems: "center",
						height: 18,
					}}
				>
					<div
						ref={lineRef}
						style={{
							width: "100%",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							fontSize: "var(--mantine-font-size-xs)",
							fontFamily: "var(--mantine-font-family-monospace)",
							lineHeight: "18px",
						}}
						title={headerText}
					>
						{headerText}
					</div>
				</Box>
			)}
			{canExpand && (
				<LazyCollapse in={expanded}>
					<Box
						mt={4}
						style={{
							lineHeight: 1.35,
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							overflowWrap: "anywhere",
						}}
					>
						<MarkdownContent text={hasTrailingContent ? trailingText : text.trim()} />
					</Box>
				</LazyCollapse>
			)}
		</Box>
	);
}

function PlanCard({
	summary,
	narratorId,
	messageId,
	onDelete,
}: {
	summary: string;
	narratorId?: string;
	messageId?: string;
	onDelete?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const [displaySummary, setDisplaySummary] = useState(summary);
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);

	// Sync if parent re-renders with a new summary (e.g. after query refetch)
	useEffect(() => {
		setDisplaySummary(summary);
	}, [summary]);

	const handleEdit = () => {
		setEditText(displaySummary);
		setEditing(true);
	};

	const handleSave = async () => {
		if (!narratorId || !messageId) return;
		setSaving(true);
		try {
			await api.updateCompactSummary(narratorId, messageId, editText);
			setDisplaySummary(editText);
			setEditing(false);
		} finally {
			setSaving(false);
		}
	};

	const handleDelete = async () => {
		if (!narratorId || !messageId) return;
		setDeleting(true);
		try {
			await api.deleteCompactMessage(narratorId, messageId);
			onDelete?.();
		} catch {
			notifications.show({
				title: t("deleteMessageFailed"),
				message: t("deleteMessageFailedDesc"),
				color: "red",
				autoClose: 5000,
			});
		} finally {
			setDeleting(false);
		}
	};

	return (
		<Paper
			p="sm"
			radius="md"
			withBorder
			style={{
				borderColor: "var(--mantine-color-teal-light-color)",
				backgroundColor: "var(--mantine-color-teal-light)",
			}}
		>
			<Group gap={6} mb={6}>
				<IconListCheck size={16} style={{ color: "var(--mantine-color-teal-6)" }} />
				<Text size="xs" fw={600} c="teal">
					{t("plan")}
				</Text>
				{narratorId && messageId && (
					<Group gap={4} ml="auto">
						{editing ? (
							<>
								<Button variant="subtle" size="compact-xs" onClick={() => setEditing(false)}>
									{t("cancelEdit")}
								</Button>
								<Button size="compact-xs" loading={saving} onClick={handleSave}>
									{t("saveEdit")}
								</Button>
							</>
						) : (
							<>
								<Button variant="subtle" size="compact-xs" c="dimmed" onClick={handleEdit}>
									{t("editCompact")}
								</Button>
								<Button
									variant="subtle"
									size="compact-xs"
									c="red"
									loading={deleting}
									onClick={handleDelete}
								>
									{t("deleteCompact")}
								</Button>
							</>
						)}
					</Group>
				)}
			</Group>
			{editing ? (
				<Textarea
					value={editText}
					onChange={(e) => setEditText(e.currentTarget.value)}
					autosize
					minRows={4}
					maxRows={20}
				/>
			) : (
				<MarkdownContent text={displaySummary} />
			)}
		</Paper>
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
	onCompactBeforeMessage,
	onDeleteBlock,
}: MessageBubbleProps) {
	const isUser = message.role === "user";
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const _msgId = message.id;

	// Lightweight cache refresh for CompactIndicator/PlanCard — they already
	// call their own delete API, so we only need to invalidate the messages
	// query instead of firing another delete request via onDeleteBlock.
	const invalidateMessages = useCallback(
		() => qc.invalidateQueries({ queryKey: ["narrators", narratorId, "messages"] }),
		[qc, narratorId],
	);

	// Build message-level context menu actions for ContentViewer to consume
	const ctxActions = useMemo<MessageContextMenuActions>(() => {
		const actions: MessageContextMenuActions = {};
		const msgId = message.id;
		const msgUuid = message.messageUuid;
		if (msgUuid && onForkFromMessage && !isUser) {
			actions.onForkFromMessage = () => onForkFromMessage(msgUuid);
		}
		if (msgId && onCompactBeforeMessage) {
			actions.onCompactBeforeMessage = () => onCompactBeforeMessage(msgId);
		}
		if (msgId && onDeleteBlock) {
			actions.onDeleteBlock = (blockIndex: number) => onDeleteBlock(msgId, blockIndex);
		}
		return actions;
	}, [
		isUser,
		message.id,
		message.messageUuid,
		onForkFromMessage,
		onCompactBeforeMessage,
		onDeleteBlock,
	]);

	// Merge summary cards — rendered for both role="system" (legacy) and role="user"
	// (new: persistSystemMessage uses role="user" so the SDK includes it in context).
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const mergeSummaryBlock = blocks.find((b: any) => b.type === "merge_summary");
	if (mergeSummaryBlock) {
		return (
			<MergeSummaryCard
				block={mergeSummaryBlock}
				creator={message.creator}
				onDelete={invalidateMessages}
			/>
		);
	}

	// System messages (compact indicators / plan cards)
	if (message.role === "system") {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const compactBlock = blocks.find((b: any) => b.type === "compact");
		if (compactBlock) {
			if (compactBlock.subtype === "plan") {
				return (
					<PlanCard
						summary={compactBlock.summary ?? ""}
						narratorId={narratorId}
						messageId={message.id}
						onDelete={invalidateMessages}
					/>
				);
			}
			const isCompacting = compactBlock.status === "compacting";
			const isFailed = compactBlock.status === "failed";
			if (isFailed) {
				return (
					<Paper p="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-red-light)" }}>
						<Group gap={6} wrap="nowrap" align="flex-start">
							<IconAlertTriangle
								size={16}
								style={{ flexShrink: 0, color: "var(--mantine-color-red-7)" }}
							/>
							<Stack gap={2}>
								<Text size="xs" fw={600} c="red.8">
									{t("compactFailed")}
								</Text>
								<Text size="xs" c="red.9" style={{ whiteSpace: "pre-wrap" }}>
									{compactBlock.error ?? compactBlock.summary ?? t("compactFailedDesc")}
								</Text>
							</Stack>
						</Group>
					</Paper>
				);
			}
			const canNavigate = !isCompacting && narratorId && message.id;
			return (
				<CompactIndicator
					isCompacting={isCompacting}
					narratorId={canNavigate ? narratorId : undefined}
					messageId={canNavigate ? message.id : undefined}
					onDelete={canNavigate ? invalidateMessages : undefined}
				/>
			);
		}
		return null;
	}

	// Auto-commit system notices (stored as role="user" so the SDK sees them)
	if (isUser) {
		const acBlock = blocks.find(
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(b: any) => b.type === "auto_commit_reminder" || b.type === "auto_commit_notice",
		);
		if (acBlock) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			const textBlock = blocks.find((b: any) => b.type === "text");
			const isReminder = acBlock.type === "auto_commit_reminder";
			return (
				<Paper
					p="xs"
					radius="sm"
					style={{
						backgroundColor: isReminder
							? "var(--mantine-color-yellow-light)"
							: "var(--mantine-color-teal-light)",
					}}
				>
					<Group gap={6} align="center">
						<IconGitCommit size={16} style={{ flexShrink: 0 }} />
						<Text size="xs" style={{ whiteSpace: "pre-wrap" }}>
							{(textBlock?.text ?? message.contentText ?? "")
								.replace(/<\/?system-reminder>/g, "")
								.trim()}
						</Text>
					</Group>
				</Paper>
			);
		}
	}

	// User messages — wrap entire bubble in ContentViewer for context menu / swipe
	if (isUser) {
		const fullText = blocks
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.filter((b: any) => b.type === "text" && b.text)
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.map((b: any) => b.text)
			.join("\n\n");
		const hasCommand = !!message.commandText;
		return (
			<MessageContextMenuCtx.Provider value={ctxActions}>
				<ContentViewer content={fullText} markdown contentType="markdown" blockIndex={0}>
					<Paper
						p="sm"
						radius="md"
						style={{ backgroundColor: "var(--mantine-color-indigo-light)" }}
					>
						<Stack gap={4}>
							<Group gap={6}>
								{message.creator && (
									<UserAvatar
										username={message.creator.username}
										avatarColor={message.creator.avatarColor}
										avatarImageId={message.creator.avatarImageId}
										userId={message.creator.id}
										size={20}
										showTooltip={false}
									/>
								)}
								<Text size="xs" fw={600} c="indigo">
									{message.creator?.username ?? t("you")}
								</Text>
							</Group>
							{hasCommand ? (
								<>
									<Text size="sm" fw={500} c="indigo.4" style={{ fontFamily: "monospace" }}>
										{message.commandText}
									</Text>
									<Spoiler
										maxHeight={0}
										showLabel={t("showExpandedPrompt")}
										hideLabel={t("hideExpandedPrompt")}
										styles={{
											control: { fontSize: "var(--mantine-font-size-xs)" },
										}}
									>
										<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
											{fullText}
										</Text>
									</Spoiler>
									{blocks
										.filter(
											// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
											(b: any) => b.type === "image",
										)
										.map(
											// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
											(block: any, i: number) => (
												<ImageBlock
													// biome-ignore lint/suspicious/noArrayIndexKey: filtered image blocks have no stable id
													key={`cmd-img-${i}`}
													block={block}
													narratorId={narratorId}
												/>
											),
										)}
								</>
							) : (
								<>
									{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
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
								</>
							)}
						</Stack>
					</Paper>
				</ContentViewer>
			</MessageContextMenuCtx.Provider>
		);
	}

	// Assistant messages — wrap in context provider so all ContentViewers
	// (including those inside ToolCallCard) can access message-level actions
	return (
		<MessageContextMenuCtx.Provider value={ctxActions}>
			<Stack gap={4}>
				{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
				{blocks.map((block: any, i: number) => {
					const key = block.id ?? `${block.type}-${i}`;
					const realIndex = message._blockOriginalIndices?.[i] ?? i;
					if (block.type === "text") {
						if (!block.text?.trim()) return null;
						return (
							<ContentViewer
								key={key}
								content={block.text}
								markdown
								contentType="markdown"
								blockIndex={realIndex}
							/>
						);
					}
					if (block.type === "image") {
						return <ImageBlock key={key} block={block} narratorId={narratorId} />;
					}
					if (block.type === "reasoning") {
						const iconColor = getCategoryColor("plan");
						return (
							<Paper key={key} withBorder radius="sm" p="xs">
								<Group gap={6} wrap="nowrap" align="flex-start">
									<ThemeIcon size={18} variant="light" color={iconColor} radius="sm" mt={1}>
										<IconBrain size={12} />
									</ThemeIcon>
									<ReasoningSummary text={typeof block.text === "string" ? block.text : ""} />
								</Group>
							</Paper>
						);
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
						// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
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
								blockIndex={realIndex}
							/>
						);
					}
					return null;
				})}
			</Stack>
		</MessageContextMenuCtx.Provider>
	);
});
