import { ActionIcon, Button, Group, Stack, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { PendingAgentMessagesPage } from "@shared/agent-inbox";
import { IconChevronDown, IconChevronUp, IconPlayerPlay, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";

export const pendingAgentMessagesQueryKey = (narratorId: string) =>
	["narrator-agent-inbox", narratorId] as const;

/**
 * Messages other agents queued for this session that no turn has read yet. A session
 * whose last turn failed (or was stopped) is not restarted by agent messages, so this
 * is where the user sees them and decides: resume, or discard.
 */
export function PendingAgentMessagesPanel({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("narrator");
	const queryClient = useQueryClient();
	const queryKey = pendingAgentMessagesQueryKey(narratorId);
	const [expanded, setExpanded] = useState(false);
	const { data } = useQuery<PendingAgentMessagesPage>({
		queryKey,
		queryFn: ({ signal }) => api.getPendingAgentMessages(narratorId, signal),
		staleTime: 5_000,
	});

	useEffect(() => {
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["agent_inbox_changed", "status_change"] },
			() => {
				void queryClient.invalidateQueries({ queryKey: pendingAgentMessagesQueryKey(narratorId) });
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [narratorId, queryClient]);

	const refresh = () => queryClient.invalidateQueries({ queryKey });
	const fail = (error: unknown) =>
		notifications.show({
			color: "red",
			title: t("agentInboxActionFailed"),
			message: error instanceof Error ? error.message : String(error),
		});
	const resume = useMutation({
		mutationFn: () => api.resumeAgentInbox(narratorId),
		onSuccess: (result) => {
			if (!result.resumed)
				notifications.show({ color: "yellow", message: t("agentInboxResumeNotStarted") });
		},
		onError: fail,
		onSettled: refresh,
	});
	const discard = useMutation({
		mutationFn: (messageId: string) => api.discardPendingAgentMessage(narratorId, messageId),
		onError: fail,
		onSettled: refresh,
	});

	if (!data || data.running || data.messages.length === 0) return null;
	const count = data.messages.length;
	const reasonText =
		data.blockedReason === "error"
			? t("agentInboxBlockedError")
			: data.blockedReason === "user_interrupt"
				? t("agentInboxBlockedInterrupted")
				: t("agentInboxWaiting");

	return (
		<Stack
			gap={0}
			data-pending-agent-messages
			style={{ borderTop: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
		>
			<Group px="md" py={4} gap="xs" wrap="nowrap">
				<Button
					size="compact-xs"
					variant="subtle"
					color={data.blockedReason ? "orange" : "gray"}
					onClick={() => setExpanded(!expanded)}
					aria-expanded={expanded}
					leftSection={expanded ? <IconChevronDown size={12} /> : <IconChevronUp size={12} />}
				>
					{data.hasMore ? t("agentInboxCountMore", { count }) : t("agentInboxCount", { count })}
				</Button>
				<Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0 }} lineClamp={2}>
					{reasonText}
				</Text>
				<Button
					size="compact-xs"
					variant="light"
					leftSection={<IconPlayerPlay size={12} />}
					loading={resume.isPending}
					onClick={() => resume.mutate()}
				>
					{t("agentInboxResume")}
				</Button>
			</Group>
			{expanded && (
				<Stack gap={0} style={{ maxHeight: "min(32vh, 280px)", overflowY: "auto" }}>
					{data.messages.map((message) => (
						<Group key={message.id} px="md" py={4} gap="xs" wrap="nowrap" align="flex-start">
							<Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
								<Text size="xs" fw={600}>
									{message.sender?.label ||
										message.sender?.title ||
										message.sender?.id ||
										t("agentInboxUnknownSender")}
								</Text>
								<Text size="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
									{message.truncated ? `${message.preview}…` : message.preview}
								</Text>
							</Stack>
							<Tooltip label={t("agentInboxDiscard")} withinPortal>
								<ActionIcon
									size="sm"
									variant="subtle"
									color="gray"
									aria-label={t("agentInboxDiscard")}
									loading={discard.isPending && discard.variables === message.id}
									onClick={() => discard.mutate(message.id)}
								>
									<IconX size={14} />
								</ActionIcon>
							</Tooltip>
						</Group>
					))}
				</Stack>
			)}
		</Stack>
	);
}
