import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	Paper,
	ScrollArea,
	Select,
	Stack,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowLeft, IconBolt, IconSend, IconUsers } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useAddChatGroupMember,
	useApplyIncomingGroupMessage,
	useChatGroup,
	useChatGroupMessages,
	useNamedNarrators,
	usePostChatGroupMessage,
} from "../../hooks/useChatGroup";
import { useChatGroupWS } from "../../hooks/useChatGroupWS";
import { addRecentTab } from "../../hooks/useRecentTabs";
import type { ChatGroupMember, ChatGroupMessage } from "../../lib/api";
import { APP_SHELL_SAFE_VIEWPORT_HEIGHT } from "../../lib/safe-area";

export const Route = createFileRoute("/groups/$groupId")({
	component: GroupChatPage,
});

/** Stable color per sender label so each speaker is visually distinct. */
function senderColor(label: string): string {
	const palette = ["grape", "indigo", "teal", "orange", "cyan", "pink", "lime"];
	let hash = 0;
	for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
	return palette[hash % palette.length];
}

function memberLabel(member: ChatGroupMember): string {
	return member.handle
		? `@${member.handle}`
		: (member.title ?? member.narratorId?.slice(0, 6) ?? "?");
}

function memberRoleColor(role: ChatGroupMember["role"]): string {
	if (role === "named") return "grape";
	if (role === "origin") return "indigo";
	return "gray";
}

function memberStatusColor(status?: string | null): string {
	switch (status) {
		case "working":
			return "blue";
		case "waiting":
			return "yellow";
		case "error":
			return "red";
		case "archived":
			return "gray";
		default:
			return "green";
	}
}

function memberStatusLabel(
	t: (key: string, options?: Record<string, string>) => string,
	status?: string | null,
): string {
	switch (status) {
		case "working":
			return t("groupMemberStatusWorking");
		case "waiting":
			return t("groupMemberStatusWaiting");
		case "archived":
			return t("groupMemberStatusArchived");
		case "error":
			return t("groupMemberStatusError");
		case "idle":
			return t("groupMemberStatusIdle");
		default:
			return status ? t("groupMemberStatusOther", { status }) : t("groupMemberStatusUnknown");
	}
}

function GroupChatPage() {
	const { groupId } = Route.useParams();
	const navigate = useNavigate();
	const { t } = useTranslation("narrators");

	const { data: groupData, isLoading } = useChatGroup(groupId);
	const messagesQuery = useChatGroupMessages(groupId);
	const postMessage = usePostChatGroupMessage(groupId);
	const addMember = useAddChatGroupMember(groupId);
	const { data: namedNarrators } = useNamedNarrators();
	const applyIncoming = useApplyIncomingGroupMessage();

	// Register a recent tab on visit (fallback discovery path).
	const groupTitle = groupData?.group.title;
	useEffect(() => {
		if (!groupData) return;
		addRecentTab({
			type: "group",
			id: groupId,
			title: groupTitle || t("groupUntitled"),
		});
	}, [groupId, groupData, groupTitle, t]);

	const narratorMembers = useMemo(
		() => (groupData?.members ?? []).filter((m) => m.memberType === "narrator"),
		[groupData?.members],
	);
	const memberNarratorIds = useMemo(
		() => narratorMembers.filter((m) => m.narratorId).map((m) => m.narratorId as string),
		[narratorMembers],
	);
	const memberNarratorIdSet = useMemo(() => new Set(memberNarratorIds), [memberNarratorIds]);
	const addMemberOptions = useMemo(
		() =>
			(namedNarrators ?? [])
				.filter((n: { id: string; handle?: string | null }) => {
					return !!n.handle && !memberNarratorIdSet.has(n.id);
				})
				.map((n: { handle?: string | null; title?: string | null }) => {
					const handle = n.handle as string;
					return {
						value: handle,
						label: n.title ? `@${handle} · ${n.title}` : `@${handle}`,
					};
				}),
		[memberNarratorIdSet, namedNarrators],
	);

	const handleIncoming = useCallback(
		(message: ChatGroupMessage) => applyIncoming(groupId, message),
		[applyIncoming, groupId],
	);
	useChatGroupWS(groupId, memberNarratorIds, handleIncoming);

	// Flatten paginated pages (newest-first) into chronological order (oldest-first).
	const messages = useMemo(() => {
		const all = (messagesQuery.data?.pages ?? []).flatMap((p) => p.messages);
		return [...all].reverse();
	}, [messagesQuery.data]);

	const [input, setInput] = useState("");
	const [urgent, setUrgent] = useState(false);
	const viewportRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to bottom only when a new message arrives at the bottom (newest
	// id changes), not when older history is prepended via fetchNextPage — which
	// would otherwise yank the user away from the history they're reading.
	const latestMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on newest-message change
	useEffect(() => {
		const vp = viewportRef.current;
		if (vp) vp.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
	}, [latestMessageId]);

	const handleSend = useCallback(() => {
		const content = input.trim();
		if (!content) return;
		postMessage.mutate(
			{ content, urgent },
			{
				onSuccess: () => {
					setInput("");
					setUrgent(false);
				},
				onError: (err) => {
					notifications.show({
						color: "red",
						title: t("groupSendFailed"),
						message: err instanceof Error ? err.message : String(err),
					});
				},
			},
		);
	}, [input, urgent, postMessage, t]);

	const handleAddMember = useCallback(
		(handle: string | null) => {
			if (!handle) return;
			addMember.mutate(handle, {
				onSuccess: () => {
					notifications.show({
						color: "grape",
						title: t("groupAddMemberSuccessTitle"),
						message: t("groupAddMemberSuccessMessage", { handle: `@${handle}` }),
					});
				},
				onError: (err) => {
					notifications.show({
						color: "red",
						title: t("groupAddMemberFailed"),
						message: err instanceof Error ? err.message : String(err),
					});
				},
			});
		},
		[addMember, t],
	);

	if (isLoading) {
		return (
			<Center h={APP_SHELL_SAFE_VIEWPORT_HEIGHT}>
				<Loader size="sm" />
			</Center>
		);
	}

	if (!groupData) {
		return (
			<Center h={APP_SHELL_SAFE_VIEWPORT_HEIGHT}>
				<Text c="dimmed">{t("groupNotFound")}</Text>
			</Center>
		);
	}

	const { group } = groupData;

	return (
		<Box
			h={APP_SHELL_SAFE_VIEWPORT_HEIGHT}
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
			style={{ display: "flex", flexDirection: "column" }}
		>
			{/* Header */}
			<Group justify="space-between" px="md" py="sm" style={{ flexShrink: 0 }} wrap="nowrap">
				<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
					<ActionIcon variant="subtle" color="gray" onClick={() => navigate({ to: ".." })}>
						<IconArrowLeft size={18} />
					</ActionIcon>
					<IconUsers size={18} />
					<Text fw={600} truncate="end">
						{group.title || t("groupUntitled")}
					</Text>
				</Group>
				<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
					<Select
						size="xs"
						w={220}
						placeholder={
							addMemberOptions.length > 0 ? t("groupAddMember") : t("groupNoMoreNamedMembers")
						}
						data={addMemberOptions}
						value={null}
						onChange={handleAddMember}
						searchable
						disabled={addMemberOptions.length === 0 || addMember.isPending}
						comboboxProps={{ withinPortal: true }}
					/>
					<Group gap={4} wrap="nowrap" style={{ minWidth: 0, overflow: "hidden" }}>
						{narratorMembers.map((m) => {
							const label = memberLabel(m);
							const statusLabel = memberStatusLabel(t, m.status);
							return (
								<Tooltip key={m.id} label={t("groupOpenNarrator")}>
									<Badge
										size="sm"
										variant="light"
										color={memberRoleColor(m.role)}
										rightSection={
											<Box
												w={6}
												h={6}
												style={{
													borderRadius: 999,
													background: `var(--mantine-color-${memberStatusColor(m.status)}-5)`,
												}}
											/>
										}
										style={{ cursor: m.narratorId ? "pointer" : undefined, flexShrink: 0 }}
										onClick={() => {
											if (!m.narratorId) return;
											navigate({
												to: "/narrators/$narratorId",
												params: { narratorId: m.narratorId },
											});
										}}
									>
										{label} · {statusLabel}
									</Badge>
								</Tooltip>
							);
						})}
					</Group>
				</Group>
			</Group>

			{/* Messages */}
			<ScrollArea style={{ flex: 1 }} viewportRef={viewportRef} px="md">
				<Stack gap="sm" py="md">
					{messagesQuery.hasNextPage && (
						<Center>
							<Button
								size="xs"
								variant="subtle"
								loading={messagesQuery.isFetchingNextPage}
								onClick={() => messagesQuery.fetchNextPage()}
							>
								{t("groupLoadEarlier")}
							</Button>
						</Center>
					)}
					{messages.length === 0 && (
						<Center py="xl">
							<Text c="dimmed" size="sm">
								{t("groupEmpty")}
							</Text>
						</Center>
					)}
					{messages.map((m) => {
						const isSystem = m.senderType === "system";
						if (isSystem) {
							return (
								<Center key={m.id}>
									<Text size="xs" c="dimmed" fs="italic" ta="center">
										{m.content}
									</Text>
								</Center>
							);
						}
						return (
							<Box key={m.id}>
								<Group gap={6} mb={2}>
									<Text size="xs" fw={600} c={`${senderColor(m.senderLabel)}.4`}>
										{m.senderType === "narrator" ? "@" : ""}
										{m.senderLabel}
									</Text>
									{m.urgent && (
										<Badge size="xs" color="red" variant="light">
											<Group gap={2}>
												<IconBolt size={10} />
												{t("groupUrgent")}
											</Group>
										</Badge>
									)}
								</Group>
								<Paper
									p="xs"
									radius="md"
									withBorder
									style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
								>
									<Text size="sm">{m.content}</Text>
								</Paper>
							</Box>
						);
					})}
				</Stack>
			</ScrollArea>

			{/* Composer */}
			<Box px="md" pb="md" pt="xs" style={{ flexShrink: 0 }}>
				<Group gap="xs" align="end" wrap="nowrap">
					<Textarea
						style={{ flex: 1 }}
						placeholder={t("groupSendPlaceholder")}
						value={input}
						onChange={(e) => setInput(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								handleSend();
							}
						}}
						autosize
						minRows={1}
						maxRows={6}
					/>
					<Tooltip label={t("groupUrgentHint")}>
						<ActionIcon
							variant={urgent ? "filled" : "subtle"}
							color={urgent ? "red" : "gray"}
							onClick={() => setUrgent((u) => !u)}
							mb={4}
						>
							<IconBolt size={18} />
						</ActionIcon>
					</Tooltip>
					<Button
						onClick={handleSend}
						loading={postMessage.isPending}
						disabled={!input.trim()}
						rightSection={<IconSend size={16} />}
						mb={2}
					>
						{t("groupSend")}
					</Button>
				</Group>
			</Box>
		</Box>
	);
}
