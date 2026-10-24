/**
 * BotChatPage.tsx — A bot narrator's page: the reader's conversation with it.
 *
 * All a person sees of a bot is this room — their own posts and what the bot sent
 * them with `Send({ user })`. Its transcript (replies, reasoning, tool calls) is the
 * monitor, one click away and never the default. Switching views changes nothing
 * about the bot: it is the same narrator either way, so the monitor is a route
 * state of its page rather than anything stored on it.
 *
 * The header is the one place the bot's work shows through (see `bot-activity.ts`):
 * while it thinks the reader would otherwise stare at a silent room, and a decision
 * it waits on can only be made in the monitor.
 */

import { ActionIcon, Badge, Box, Button, Center, Group, Loader, Text } from "@mantine/core";
import { useDocumentVisibility } from "@mantine/hooks";
import { IconArrowLeft, IconEye } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBotChatRoom } from "../../hooks/useChat";
import { useMobileViewport } from "../../hooks/useMobileViewport";
import { type NarratorListWSEvent, useNarratorsListWS } from "../../hooks/useNarratorWS";
import { api } from "../../lib/api";
import {
	APP_SHELL_FULL_BLEED_HEIGHT,
	SAFE_AREA_INSET_LEFT,
	SAFE_AREA_INSET_RIGHT,
} from "../../lib/safe-area";
import { NarratorAvatar } from "../narrator/header/NarratorAvatar";
import { BotChatComposer } from "./BotChatComposer";
import { botActivity } from "./bot-activity";
import { ChatRoomView } from "./ChatRoomView";
import { CHAT_HEADER_HEIGHT } from "./chat-header";

export interface BotChatPageProps {
	narratorId: string;
	title: string | null | undefined;
	handle?: string | null;
	avatarImageId?: string | null;
	/** Status and substatus when the page loaded; changes arrive over the narrator list stream. */
	status?: string;
	substatus?: readonly string[];
	/** Open the transcript (monitor) view of this bot. */
	onMonitor: () => void;
	/** Where the page was opened from (a workspace), when it has somewhere to go back to. */
	onBack?: () => void;
}

export function BotChatPage({
	narratorId,
	title: loadedTitle,
	handle,
	avatarImageId,
	status: loadedStatus,
	substatus: loadedSubstatus,
	onMonitor,
	onBack,
}: BotChatPageProps) {
	const { t } = useTranslation("chat");
	const { t: tc } = useTranslation("common");
	const isMobile = useMobileViewport();
	const visibility = useDocumentVisibility();
	const { data: room, error } = useBotChatRoom(narratorId);

	const [title, setTitle] = useState(loadedTitle);
	const [status, setStatus] = useState(loadedStatus);
	const [substatus, setSubstatus] = useState<readonly string[]>(loadedSubstatus ?? []);
	useEffect(() => setTitle(loadedTitle), [loadedTitle]);
	useEffect(() => setStatus(loadedStatus), [loadedStatus]);
	useEffect(() => setSubstatus(loadedSubstatus ?? []), [loadedSubstatus]);
	const watched = useMemo(() => [narratorId], [narratorId]);
	const onUpdate = useCallback(
		(id: string, event: NarratorListWSEvent) => {
			if (id !== narratorId) return;
			if (event.type === "title" && event.title) setTitle(event.title);
			if (event.type !== "status") return;
			if (event.status) setStatus(event.status);
			if (event.substatus) setSubstatus(event.substatus);
		},
		[narratorId],
	);
	useNarratorsListWS(watched, onUpdate);

	// A finished turn's reply is in this room, so reading the room reads the turn — the
	// same acknowledgement the monitor sends. Without it the bot stays "unread" in the
	// sidebar after every answer until someone opens the transcript.
	const unread = status === "idle" && substatus.includes("unread");
	useEffect(() => {
		if (!unread || visibility !== "visible") return;
		setSubstatus((tags) => tags.filter((tag) => tag !== "unread"));
		api.markNarratorRead(narratorId).catch(() => {});
	}, [narratorId, unread, visibility]);

	// Matches the server's `botDisplayName`, so the header and the messages agree.
	const name = title?.trim() || (handle ? `@${handle}` : "") || t("botFallbackName");
	const canPost = room?.canPost !== false;
	const activity = botActivity(status, substatus);
	// Only someone who may drive the bot can settle what it waits on.
	const actionable = activity === "error" || (activity === "decision" && canPost);
	const statusLine =
		activity === "thinking"
			? t("botThinking")
			: activity === "model"
				? t("botWaitingModel")
				: activity === "error"
					? t("botFailed")
					: activity === "decision"
						? canPost
							? t("botWaiting")
							: t("botWaitingReadOnly")
						: null;
	const statusColor = activity === "error" ? "red" : actionable ? "orange" : "dimmed";

	return (
		// Full bleed like the messages page: Main's gutter is cancelled so the header
		// border and the composer reach the edges of the content area. On a phone this
		// page is the whole screen, so it also keeps clear of a landscape notch.
		<Box
			h={APP_SHELL_FULL_BLEED_HEIGHT}
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
			style={{
				display: "flex",
				flexDirection: "column",
				minHeight: 0,
				overflow: "hidden",
				...(isMobile
					? { paddingInlineStart: SAFE_AREA_INSET_LEFT, paddingInlineEnd: SAFE_AREA_INSET_RIGHT }
					: {}),
			}}
		>
			<Group
				gap="sm"
				px="md"
				h={CHAT_HEADER_HEIGHT}
				wrap="nowrap"
				style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-default-border)" }}
			>
				{onBack ? (
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						onClick={onBack}
						aria-label={tc("back")}
					>
						<IconArrowLeft size={16} />
					</ActionIcon>
				) : null}
				<NarratorAvatar
					narratorId={narratorId}
					avatarImageId={avatarImageId}
					title={name}
					size={28}
					showTooltip={false}
				/>
				<Box style={{ flex: 1, minWidth: 0 }}>
					<Group gap={6} wrap="nowrap">
						<Text size="sm" fw={600} lh={1.2} truncate>
							{name}
						</Text>
						<Badge size="xs" variant="light" color="grape" style={{ flexShrink: 0 }}>
							{t("botBadge")}
						</Badge>
					</Group>
					{/* A live region, so the change is announced, not just painted. */}
					<Box role="status">
						{statusLine ? (
							<Text size="xs" lh={1.2} c={statusColor} truncate>
								{statusLine}
							</Text>
						) : null}
					</Box>
				</Box>
				<Button
					size="compact-sm"
					// What the bot waits on, or why it failed, is in the monitor: point at it.
					variant={actionable ? "light" : "subtle"}
					color={activity === "error" ? "red" : actionable ? "orange" : "gray"}
					leftSection={<IconEye size={14} />}
					onClick={onMonitor}
				>
					{t("botMonitor")}
				</Button>
			</Group>
			<Box style={{ flex: 1, minHeight: 0 }}>
				{room ? (
					// Keyed by room for the per-room state reasons given in NarratorUserChatPanel.
					// A failed background refetch keeps the last good room rather than
					// replacing a working conversation with an error.
					<ChatRoomView
						key={room.id}
						roomId={room.id}
						readOnlyReason={canPost ? undefined : t("botReadOnly")}
						renderComposer={({ replyTo, onSent }) => (
							<BotChatComposer
								narratorId={narratorId}
								roomId={room.id}
								replyTo={replyTo}
								onSent={onSent}
							/>
						)}
					/>
				) : error ? (
					<Text size="sm" c="red" p="md">
						{error instanceof Error ? error.message : t("roomLoadFailed")}
					</Text>
				) : (
					<Center h="100%">
						<Loader size="sm" />
					</Center>
				)}
			</Box>
		</Box>
	);
}
