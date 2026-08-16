/**
 * ChatRoomList.tsx — The DM conversation list.
 *
 * Renders only what the server's room-list endpoint returns (peer, preview,
 * unread) — never message bodies. That is why the list stays cheap regardless of
 * how much history a conversation holds.
 */

import { ActionIcon, Badge, Box, Group, ScrollArea, Stack, Text, Tooltip } from "@mantine/core";
import { IconMessagePlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { ChatRoomSummary } from "../../lib/api/chat";
import { UserAvatar } from "../UserAvatar";

/** Above this the badge reads "99+" rather than an exact number. */
const UNREAD_DISPLAY_MAX = 99;

export function formatUnread(unread: number, capped: boolean): string {
	if (capped || unread > UNREAD_DISPLAY_MAX) return `${UNREAD_DISPLAY_MAX}+`;
	return String(unread);
}

export interface ChatRoomListProps {
	rooms: ChatRoomSummary[];
	activeRoomId?: string | null;
	onSelect: (room: ChatRoomSummary) => void;
	onNewConversation?: () => void;
	isLoading?: boolean;
}

export function ChatRoomList({
	rooms,
	activeRoomId,
	onSelect,
	onNewConversation,
	isLoading,
}: ChatRoomListProps) {
	const { t } = useTranslation("chat");

	return (
		<Box style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
			<Group
				gap="xs"
				px="md"
				py="xs"
				wrap="nowrap"
				style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-default-border)" }}
			>
				<Text size="sm" fw={600} style={{ flex: 1 }}>
					{t("conversations")}
				</Text>
				{onNewConversation ? (
					<Tooltip label={t("newConversation")}>
						<ActionIcon size="sm" variant="subtle" onClick={onNewConversation}>
							<IconMessagePlus size={16} />
						</ActionIcon>
					</Tooltip>
				) : null}
			</Group>
			<ScrollArea style={{ flex: 1, minHeight: 0 }}>
				<Stack gap={0} p={4}>
					{rooms.length === 0 && !isLoading ? (
						<Text size="xs" c="dimmed" p="sm">
							{t("noConversations")}
						</Text>
					) : null}
					{rooms.map((room) => {
						const active = room.id === activeRoomId;
						return (
							<Box
								key={room.id}
								// A styled row rather than a <button>: the row nests its own
								// controls, which a button would swallow. role + key handler keep
								// it keyboard reachable.
								role="button"
								tabIndex={0}
								onClick={() => onSelect(room)}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										onSelect(room);
									}
								}}
								style={{
									cursor: "pointer",
									borderRadius: 6,
									padding: "8px 10px",
									background: active ? "var(--mantine-primary-color-light)" : undefined,
								}}
							>
								<Group gap="sm" wrap="nowrap">
									<UserAvatar
										userId={room.peer?.id ?? ""}
										username={room.peer?.username ?? "?"}
										avatarColor={room.peer?.avatarColor ?? null}
										avatarImageId={room.peer?.avatarImageId ?? null}
										size={32}
										showTooltip={false}
									/>
									<Box style={{ flex: 1, minWidth: 0 }}>
										<Text size="sm" fw={500} truncate>
											{room.peer?.username ?? t("unknownSender")}
										</Text>
										<Text size="xs" c="dimmed" truncate>
											{room.lastMessagePreview ?? t("noMessagesYet")}
										</Text>
									</Box>
									{room.unread > 0 ? (
										<Badge size="sm" circle variant="filled" color="indigo">
											{formatUnread(room.unread, room.unreadCapped)}
										</Badge>
									) : null}
								</Group>
							</Box>
						);
					})}
				</Stack>
			</ScrollArea>
		</Box>
	);
}
