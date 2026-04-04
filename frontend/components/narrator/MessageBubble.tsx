import {
	ActionIcon,
	Badge,
	Box,
	Button,
	CloseButton,
	Code,
	Collapse,
	Group,
	Image,
	Loader,
	Modal,
	NumberInput,
	Paper,
	ScrollArea,
	Skeleton,
	Spoiler,
	Stack,
	Text,
	Textarea,
	TextInput,
	ThemeIcon,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { formatFileSize } from "@shared/text-file-types";
import {
	IconAlertTriangle,
	IconArrowsMinimize,
	IconBrain,
	IconChevronDown,
	IconChevronRight,
	IconEye,
	IconFile,
	IconGitMerge,
	IconLanguage,
	IconListCheck,
	IconRepeat,
	IconWorldSearch,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocalPref } from "../../hooks/useLocalPref";
import { api, getToken } from "../../lib/api";
import { UserAvatar } from "../UserAvatar";
import { ContentViewer } from "./ContentViewer";
import { LazyCollapse } from "./LazyCollapse";
import { MarkdownContent } from "./MarkdownContent";
import { type MessageContextMenuActions, MessageContextMenuCtx } from "./MessageContextMenuCtx";
import { generateBlockKeys } from "./message-segments";
import {
	getCategory,
	getCategoryColor,
	getCategoryIcon,
	type PendingPermission,
	ToolCallCard,
} from "./ToolCallCard";

// Module-level map that persists reasoning expand/collapse state across
// component remounts (e.g. when streaming __streaming__ → real message).
// Key: `${narratorId}:${blockIndex}`, Value: expanded (true) or collapsed (false).
// Only written when the user explicitly toggles — blocks without an entry
// always follow the global preference (narrafork_expand_reasoning).
const reasoningExpandState = new Map<string, boolean>();

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
		createdAt?: string | null;
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
	onRegenerateFromMessage?: (messageId: string) => void;
	onEditAndRegenerate?: (messageId: string, newContent: string, rollback: boolean) => void;
	/** Whether this is the last user message in the conversation */
	isLastUserMessage?: boolean;
	/** Whether the narrator is bound to a chapter (has git support) */
	hasChapter?: boolean;
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

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON block
function TextFileBlock({ block }: { block: any }) {
	return (
		<Group gap={6} py={2}>
			<ThemeIcon size="sm" variant="light" color="gray">
				<IconFile size={14} />
			</ThemeIcon>
			<Text size="sm" fw={500}>
				{block.filename}
			</Text>
			<Text size="xs" c="dimmed">
				({formatFileSize(block.size)})
			</Text>
		</Group>
	);
}

function ReasoningBlock({
	block,
	streaming,
	narratorId,
	blockIndex,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON block
	block: any;
	streaming?: boolean;
	narratorId?: string;
	blockIndex?: number;
}) {
	const { t } = useTranslation("narrator");
	const [expandReasoning] = useLocalPref("narrafork_expand_reasoning");

	// Build a stable persistence key from narratorId + blockIndex.
	// This key survives component remounts (streaming → real message transition).
	const persistKey =
		narratorId != null && blockIndex != null ? `${narratorId}:${blockIndex}` : undefined;

	// Initialize from persisted state (if user toggled before remount) or global pref.
	const persistedState = persistKey != null ? reasoningExpandState.get(persistKey) : undefined;
	const [opened, setOpened] = useState(
		persistedState !== undefined ? persistedState : expandReasoning,
	);

	// Track whether this instance has ever been toggled by the user.
	// On the very first render with opened=true, we bypass LazyCollapse
	// and render Mantine's Collapse directly — this avoids the LazyCollapse
	// effect cascade (setMounted → rAF → setReveal) that causes "Maximum
	// update depth exceeded" when many ReasoningBlock instances mount
	// simultaneously (e.g. loading a long conversation with expand=true).
	const hasToggled = useRef(persistedState !== undefined);

	const text: string = block.text || block.thinking || "";
	const translatedText: string | undefined = block.translatedText;
	const [showTranslation, setShowTranslation] = useState(!!translatedText);
	const prevTranslatedRef = useRef(translatedText);
	// Auto-switch to translation when it arrives via WS update
	useEffect(() => {
		if (translatedText && !prevTranslatedRef.current) {
			setShowTranslation(true);
		}
		prevTranslatedRef.current = translatedText;
	}, [translatedText]);
	const displayText = showTranslation && translatedText ? translatedText : text;

	// During streaming with no content yet, show a minimal "thinking" indicator
	if (streaming && !displayText) {
		return (
			<Group gap={0} py={2} wrap="nowrap" align="center">
				<Box style={{ display: "flex", alignItems: "center", width: 11, justifyContent: "center" }}>
					<IconChevronRight
						size={12}
						style={{ color: "var(--mantine-color-dimmed)", opacity: 0.5 }}
					/>
				</Box>
				<ThemeIcon size={16} variant="light" color="grape" radius="sm">
					<IconBrain size={10} />
				</ThemeIcon>
				<Text size="xs" c="dimmed" fs="italic" ml={4}>
					{t("thinking")}…
				</Text>
			</Group>
		);
	}

	if (!displayText) return null;

	const handleToggle = () => {
		hasToggled.current = true;
		setOpened((v) => {
			const next = !v;
			// Persist to module-level map so the state survives component remounts
			// (e.g. when streaming __streaming__ message is replaced by real message).
			if (persistKey) reasoningExpandState.set(persistKey, next);
			return next;
		});
	};

	const content = (
		<Box
			pl="md"
			py={4}
			style={{
				borderLeft: "2px solid var(--mantine-color-grape-9)",
				opacity: 0.75,
				fontSize: "var(--mantine-font-size-xs)",
			}}
		>
			<MarkdownContent text={displayText} streaming={streaming} />
			{translatedText && text && (
				<Group
					gap={4}
					mt={4}
					style={{ cursor: "pointer", display: "inline-flex" }}
					onClick={(e) => {
						e.stopPropagation();
						setShowTranslation((v) => !v);
					}}
				>
					<IconLanguage size={12} style={{ opacity: 0.5 }} />
					<Text size="xs" c="dimmed">
						{showTranslation ? t("showOriginal") : t("showTranslated")}
					</Text>
				</Group>
			)}
		</Box>
	);

	return (
		<Box>
			<Group
				gap={0}
				py={2}
				wrap="nowrap"
				align="center"
				style={{ cursor: "pointer", userSelect: "none" }}
				onClick={handleToggle}
			>
				<Box style={{ display: "flex", alignItems: "center", width: 11, justifyContent: "center" }}>
					{opened ? (
						<IconChevronDown size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
					) : (
						<IconChevronRight size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
					)}
				</Box>
				<ThemeIcon size={16} variant="light" color="grape" radius="sm">
					<IconBrain size={10} />
				</ThemeIcon>
				<Text size="xs" c="dimmed" ml={4} style={{ flexShrink: 0 }}>
					{t("reasoning")}
				</Text>
				<Text size="xs" c="dimmed" ml={6} style={{ flexShrink: 0, opacity: 0.5 }}>
					{t("reasoningChars", { formatted: displayText.length.toLocaleString() })}
				</Text>
				{!opened && (
					<Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0, opacity: 0.6 }}>
						— {displayText.slice(0, 80)}
						{displayText.length > 80 ? "…" : ""}
					</Text>
				)}
			</Group>
			{/*
				Initial mount with opened=true: render Collapse directly to avoid
				LazyCollapse's effect cascade (setMounted → rAF → setReveal) that
				triggers "Maximum update depth exceeded" in Mantine's Transition
				when many instances mount at once.
				After first user toggle: switch to LazyCollapse for proper
				expand/collapse animation with content unmount.
			*/}
			{!hasToggled.current && opened ? (
				<Collapse in={opened}>{content}</Collapse>
			) : (
				<LazyCollapse in={opened}>{content}</LazyCollapse>
			)}
		</Box>
	);
}

function ErrorNotice({
	message,
	narratorId,
	messageId,
	onDismiss,
}: {
	message: string;
	narratorId: string;
	messageId: string;
	onDismiss?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: ts } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const [dismissing, setDismissing] = useState(false);
	const [ruleModalOpened, { open: openRuleModal, close: closeRuleModal }] = useDisclosure(false);
	const [ruleDomain, setRuleDomain] = useState("");
	const [ruleStatusCode, setRuleStatusCode] = useState<number | string>("");
	const [ruleKeyword, setRuleKeyword] = useState(message);
	const [ruleNote, setRuleNote] = useState("");
	const [ruleSubmitting, setRuleSubmitting] = useState(false);
	const qc = useQueryClient();

	const handleDismiss = async () => {
		setDismissing(true);
		try {
			await api.dismissErrorMessage(narratorId, messageId);
			onDismiss?.();
		} catch {
			notifications.show({
				title: t("deleteMessageFailed"),
				message: t("deleteMessageFailedDesc"),
				color: "red",
				autoClose: 5000,
			});
		} finally {
			setDismissing(false);
		}
	};

	const handleAddRule = async () => {
		const code = typeof ruleStatusCode === "number" ? ruleStatusCode : undefined;
		const domain = ruleDomain.trim() || undefined;
		const keyword = ruleKeyword.trim() || undefined;
		if (!domain && !code && !keyword) {
			notifications.show({
				message: ts("retryRuleAtLeastOne"),
				color: "yellow",
			});
			return;
		}
		setRuleSubmitting(true);
		try {
			await api.addRetryRule({
				domain,
				statusCode: code,
				keyword,
				note: ruleNote.trim() || undefined,
			});
			qc.invalidateQueries({ queryKey: ["settings"] });
			notifications.show({
				message: t("markRetryableSuccess"),
				color: "green",
				autoClose: 5000,
			});
			closeRuleModal();
		} catch (err) {
			notifications.show({
				title: t("narratorError"),
				message: err instanceof Error ? err.message : tc("unknownError"),
				color: "red",
			});
		} finally {
			setRuleSubmitting(false);
		}
	};

	return (
		<>
			<Paper p="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-red-light)" }}>
				<Group gap={6} wrap="nowrap" align="flex-start">
					<IconAlertTriangle
						size={16}
						style={{ flexShrink: 0, marginTop: 1, color: "var(--mantine-color-red-7)" }}
					/>
					<Text
						size="xs"
						c="red.9"
						style={{ whiteSpace: "pre-wrap", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}
					>
						{message}
					</Text>
					<Tooltip label={t("markRetryable")} withArrow>
						<ActionIcon
							size="xs"
							variant="subtle"
							color="red.7"
							style={{ flexShrink: 0 }}
							onClick={openRuleModal}
						>
							<IconRepeat size={14} />
						</ActionIcon>
					</Tooltip>
					<CloseButton
						size="xs"
						variant="subtle"
						c="red.7"
						style={{ flexShrink: 0 }}
						disabled={dismissing}
						onClick={handleDismiss}
					/>
				</Group>
			</Paper>

			<Modal
				opened={ruleModalOpened}
				onClose={closeRuleModal}
				title={t("markRetryableTitle")}
				size="sm"
			>
				<Stack gap="sm">
					<TextInput
						label={ts("retryRuleDomain")}
						placeholder={ts("retryRuleDomainPlaceholder")}
						value={ruleDomain}
						onChange={(e) => setRuleDomain(e.currentTarget.value)}
					/>
					<NumberInput
						label={ts("retryRuleStatusCode")}
						placeholder={ts("retryRuleStatusCodePlaceholder")}
						value={ruleStatusCode}
						onChange={setRuleStatusCode}
						min={100}
						max={599}
						allowDecimal={false}
					/>
					<TextInput
						label={ts("retryRuleKeyword")}
						placeholder={ts("retryRuleKeywordPlaceholder")}
						value={ruleKeyword}
						onChange={(e) => setRuleKeyword(e.currentTarget.value)}
					/>
					<TextInput
						label={ts("retryRuleNote")}
						placeholder={ts("retryRuleNotePlaceholder")}
						value={ruleNote}
						onChange={(e) => setRuleNote(e.currentTarget.value)}
					/>
					<Button onClick={handleAddRule} loading={ruleSubmitting} fullWidth>
						{ts("retryRuleAdd")}
					</Button>
				</Stack>
			</Modal>
		</>
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
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
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

				{block.sourceChapterId && block.isLatest !== false && (
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

// --- Overseer permission request block (rendered inside user messages) ---

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON block
function OverseerPermissionRequestBlock({ block }: { block: any }) {
	const { t } = useTranslation("narrator");
	const toolName = block.toolName as string;
	const cat = getCategory(toolName);
	const ToolIcon = getCategoryIcon(cat);
	const color = getCategoryColor(cat);
	const inputJson = block.inputJson as Record<string, unknown> | undefined;
	const inputPreview = inputJson ? JSON.stringify(inputJson, null, 2).slice(0, 1500) : "";

	return (
		<Paper
			p="sm"
			radius="sm"
			withBorder
			style={{ borderColor: "var(--mantine-color-indigo-light)" }}
		>
			<Group gap="xs" mb="xs">
				<ThemeIcon size="sm" variant="light" color="indigo" radius="xl">
					<IconEye size={12} />
				</ThemeIcon>
				<Text size="xs" fw={600} c="indigo">
					{t("overseer_permissionRequest")}
				</Text>
			</Group>
			<Stack gap={6}>
				<Group gap="xs">
					<Text size="xs" c="dimmed" style={{ width: 60 }}>
						{t("overseer_narrator")}
					</Text>
					<Text size="xs">{block.narratorTitle ?? block.narratorId}</Text>
				</Group>
				<Group gap="xs">
					<Text size="xs" c="dimmed" style={{ width: 60 }}>
						{t("overseer_tool")}
					</Text>
					<Badge size="xs" variant="light" color={color} leftSection={<ToolIcon size={10} />}>
						{toolName}
					</Badge>
				</Group>
				<Group gap="xs">
					<Text size="xs" c="dimmed" style={{ width: 60 }}>
						{t("overseer_request")}
					</Text>
					<Code style={{ fontSize: 10 }}>{block.requestId}</Code>
				</Group>
				{inputPreview && (
					<Code block style={{ fontSize: 10, maxHeight: 200, overflow: "auto" }}>
						{inputPreview}
					</Code>
				)}
			</Stack>
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
	onRegenerateFromMessage,
	onEditAndRegenerate,
	isLastUserMessage,
	hasChapter,
}: MessageBubbleProps) {
	const isUser = message.role === "user";
	const blocks = Array.isArray(message.contentJson) ? message.contentJson : [];
	const blockKeys = useMemo(() => generateBlockKeys(blocks), [blocks]);
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const _msgId = message.id;

	// Edit mode state for user messages
	const [isEditing, setIsEditing] = useState(false);
	const [editContent, setEditContent] = useState("");
	const [showConfirmModal, setShowConfirmModal] = useState(false);

	// Initialize edit content when entering edit mode
	const startEditing = useCallback(() => {
		const textBlocks = blocks.filter((b: { type: string }) => b.type === "text");
		const fullText = textBlocks
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.map((b: any) => b.text)
			.join("\n\n");
		setEditContent(fullText);
		setIsEditing(true);
	}, [blocks]);

	const cancelEditing = useCallback(() => {
		setIsEditing(false);
		setEditContent("");
		setShowConfirmModal(false);
	}, []);

	const handleConfirmClick = useCallback(() => {
		if (!editContent.trim()) return;
		// If this is the last user message, no confirmation needed
		if (isLastUserMessage) {
			if (!message.id || !onEditAndRegenerate) return;
			onEditAndRegenerate(message.id, editContent.trim(), false);
			setIsEditing(false);
			setEditContent("");
			return;
		}
		setShowConfirmModal(true);
	}, [editContent, isLastUserMessage, message.id, onEditAndRegenerate]);

	const submitEdit = useCallback(
		(rollback: boolean) => {
			if (!message.id || !onEditAndRegenerate || !editContent.trim()) return;
			onEditAndRegenerate(message.id, editContent.trim(), rollback);
			setIsEditing(false);
			setEditContent("");
			setShowConfirmModal(false);
		},
		[message.id, onEditAndRegenerate, editContent],
	);

	// Lightweight cache refresh for CompactIndicator/PlanCard — they already
	// call their own delete API, so we only need to invalidate the messages
	// query instead of firing another delete request via onDeleteBlock.
	const invalidateMessages = useCallback(
		() => qc.invalidateQueries({ queryKey: ["narrators", narratorId, "messages"] }),
		[qc, narratorId],
	);

	// Build message-level context menu actions for ContentViewer to consume
	const navigate = useNavigate();

	// Detect overseer permission request blocks
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const overseerBlock = blocks.find((b: any) => b.type === "overseer_permission_request");
	const isOverseerMessage = !!overseerBlock;

	const ctxActions = useMemo<MessageContextMenuActions>(() => {
		// Overseer messages: only show "jump to source narrator"
		if (isOverseerMessage && overseerBlock?.narratorId) {
			return {
				onJumpToSource: () => {
					navigate({
						to: "/narrators/$narratorId",
						params: { narratorId: overseerBlock.narratorId },
					});
				},
			};
		}

		const actions: MessageContextMenuActions = { messageId: message.id };
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
		if (msgId && onRegenerateFromMessage) {
			actions.onRegenerateFromMessage = () => onRegenerateFromMessage(msgId);
		}
		if (isUser && msgId && onEditAndRegenerate) {
			actions.onEditMessage = startEditing;
		}
		return actions;
	}, [
		isUser,
		isOverseerMessage,
		overseerBlock,
		navigate,
		message.id,
		message.messageUuid,
		onForkFromMessage,
		onCompactBeforeMessage,
		onDeleteBlock,
		onRegenerateFromMessage,
		onEditAndRegenerate,
		startEditing,
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

	// System messages (compact indicators / plan cards / error notices)
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
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const errorBlock = blocks.find((b: any) => b.type === "error");
		if (errorBlock && narratorId && message.id) {
			return (
				<ErrorNotice
					message={errorBlock.message ?? t("unknownError")}
					narratorId={narratorId}
					messageId={message.id}
					onDismiss={invalidateMessages}
				/>
			);
		}
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const infoBlock = blocks.find((b: any) => b.type === "info");
		if (infoBlock) {
			return (
				<Paper p="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-dark-6)" }}>
					<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
						{infoBlock.message}
					</Text>
				</Paper>
			);
		}
		return null;
	}

	// User messages — wrap entire bubble in ContentViewer for context menu / swipe
	if (isUser) {
		// Tool-loaded notification — render like an info message, not a user bubble
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const toolLoadedBlock = blocks.find((b: any) => b.type === "tool_loaded");
		if (toolLoadedBlock) {
			return (
				<Paper p="xs" radius="sm" style={{ backgroundColor: "var(--mantine-color-dark-6)" }}>
					<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
						{toolLoadedBlock.text}
					</Text>
				</Paper>
			);
		}

		const fullText = blocks
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.filter((b: any) => b.type === "text" && b.text)
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			.map((b: any) => b.text)
			.join("\n\n");
		const hasCommand = !!message.commandText;

		// Edit mode UI
		if (isEditing) {
			return (
				<>
					<Paper
						p="sm"
						radius="md"
						style={{ backgroundColor: "var(--mantine-color-indigo-light)" }}
					>
						<Stack gap="xs">
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
							<Textarea
								value={editContent}
								onChange={(e) => setEditContent(e.currentTarget.value)}
								autosize
								minRows={2}
								maxRows={10}
							/>
							<Group gap="xs" justify="flex-end">
								<Button size="xs" variant="subtle" onClick={cancelEditing}>
									{t("editCancel")}
								</Button>
								<Button size="xs" onClick={handleConfirmClick} disabled={!editContent.trim()}>
									{t("editSubmit")}
								</Button>
							</Group>
						</Stack>
					</Paper>
					<Modal
						opened={showConfirmModal}
						onClose={() => setShowConfirmModal(false)}
						title={t("editConfirmTitle")}
						centered
						size="sm"
					>
						<Stack gap="md">
							{hasChapter ? (
								<>
									<Text size="sm">{t("editConfirmDesc")}</Text>
									<Stack gap="xs">
										<Button fullWidth onClick={() => submitEdit(false)}>
											{t("editConfirmKeep")}
										</Button>
										<Button
											fullWidth
											variant="light"
											color="orange"
											onClick={() => submitEdit(true)}
										>
											{t("editConfirmRollback")}
										</Button>
										<Button fullWidth variant="subtle" onClick={() => setShowConfirmModal(false)}>
											{t("editCancel")}
										</Button>
									</Stack>
								</>
							) : (
								<>
									<Text size="sm">{t("editConfirmStandaloneDesc")}</Text>
									<Stack gap="xs">
										<Button fullWidth onClick={() => submitEdit(false)}>
											{t("editConfirmProceed")}
										</Button>
										<Button fullWidth variant="subtle" onClick={() => setShowConfirmModal(false)}>
											{t("editCancel")}
										</Button>
									</Stack>
								</>
							)}
						</Stack>
					</Modal>
				</>
			);
		}

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
								{message.createdAt && (
									<Text size="xs" c="dimmed" ml="auto">
										{(() => {
											const d = new Date(message.createdAt);
											const now = new Date();
											const isToday =
												d.getFullYear() === now.getFullYear() &&
												d.getMonth() === now.getMonth() &&
												d.getDate() === now.getDate();
											return isToday
												? d.toLocaleTimeString([], {
														hour: "2-digit",
														minute: "2-digit",
													})
												: d.toLocaleString([], {
														month: "2-digit",
														day: "2-digit",
														hour: "2-digit",
														minute: "2-digit",
													});
										})()}
									</Text>
								)}
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
										if (block.type === "text_file") {
											return <TextFileBlock key={key} block={block} />;
										}
										if (block.type === "overseer_permission_request") {
											return <OverseerPermissionRequestBlock key={key} block={block} />;
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
	const isStreaming = message.id === "__streaming__";
	return (
		<MessageContextMenuCtx.Provider value={ctxActions}>
			<Stack gap={4} style={{ minWidth: 0 }}>
				{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
				{blocks.map((block: any, i: number) => {
					const key = blockKeys[i];
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
								streaming={isStreaming}
							/>
						);
					}
					if (block.type === "image") {
						return <ImageBlock key={key} block={block} narratorId={narratorId} />;
					}
					if (block.type === "text_file") {
						return <TextFileBlock key={key} block={block} />;
					}
					if (block.type === "reasoning" || block.type === "thinking") {
						return (
							<ReasoningBlock
								key={key}
								block={block}
								streaming={isStreaming}
								narratorId={narratorId}
								blockIndex={realIndex}
							/>
						);
					}
					if (block.type === "web_search") {
						const query = block.query ?? (block.queries as string[] | undefined)?.join(", ");
						const isSearching = block.status && block.status !== "completed";
						return (
							<Paper key={key} withBorder radius="sm" p="xs">
								<Group gap={6} wrap="nowrap" align="center">
									<ThemeIcon size={18} variant="light" color="teal" radius="sm">
										<IconWorldSearch size={12} />
									</ThemeIcon>
									{isSearching && <Loader size={12} color="teal" type="dots" />}
									<Text size="xs" c="dimmed">
										{isSearching
											? block.status === "searching"
												? t("webSearching")
												: t("webSearchPreparing")
											: t("webSearched")}
										{query && (
											<Text span fw={500} c="teal" ml={4}>
												{query}
											</Text>
										)}
									</Text>
								</Group>
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
							// startedAt: 工具开始执行的时间戳（由 mergeFieldsByIndex 写入），
							// 用于 BashTerminateButton 本地计时器计算已运行时长
							startedAt: tc?.startedAt,
							// _longRunning: 由 WS tool_long_running 事件通过 mergeFieldsByIndex 设置
							_longRunning: tc?._longRunning,
							_streamingOutput: tc?._streamingOutput,
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
