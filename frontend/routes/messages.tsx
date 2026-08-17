/**
 * /messages — standalone direct-message page.
 *
 * Conversation list on the left, the selected room on the right. The active room
 * lives in a `?room=` search param so a conversation is linkable and survives a
 * reload.
 *
 * The narrator-side discussion rooms are NOT listed here: they belong to a
 * narrator and are opened from its toolbar. This page is only for person-to-person
 * conversations, which is also why there is no "send to narrator" action — there is
 * no narrator on this surface to send to.
 */

import { Box, Loader, Text } from "@mantine/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatRoomList } from "../components/chat/ChatRoomList";
import { ChatRoomView } from "../components/chat/ChatRoomView";
import { NewDmModal } from "../components/chat/NewDmModal";
import { useChatRooms, useOpenChatDm } from "../hooks/useChat";
import { APP_SHELL_FULL_BLEED_HEIGHT } from "../lib/safe-area";

interface MessagesSearch {
	room?: string;
}

export const Route = createFileRoute("/messages")({
	component: MessagesPage,
	validateSearch: (search: Record<string, unknown>): MessagesSearch => ({
		room: typeof search.room === "string" ? search.room : undefined,
	}),
});

function MessagesPage() {
	const { t } = useTranslation("chat");
	const { room: activeRoomId } = Route.useSearch();
	const navigate = useNavigate();
	const { data: rooms, isLoading } = useChatRooms();
	const openDm = useOpenChatDm();
	const [pickerOpen, setPickerOpen] = useState(false);

	const selectRoom = useCallback(
		(roomId: string) => {
			navigate({ to: "/messages", search: { room: roomId } });
		},
		[navigate],
	);

	const activeRoom = rooms?.find((room) => room.id === activeRoomId);

	return (
		// Full bleed: Main's symmetric `md` gutter is cancelled with negative margins so
		// the column divider and the header borders reach the edges of the content area
		// instead of stopping short of them.
		<Box
			h={APP_SHELL_FULL_BLEED_HEIGHT}
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
			style={{ minHeight: 0, overflow: "hidden" }}
		>
			<Box style={{ height: "100%", minHeight: 0, display: "flex" }}>
				<Box
					style={{
						width: 300,
						flexShrink: 0,
						height: "100%",
						minHeight: 0,
						borderRight: "1px solid var(--mantine-color-default-border)",
					}}
				>
					{isLoading ? (
						<Box style={{ height: "100%", display: "grid", placeItems: "center" }}>
							<Loader size="sm" />
						</Box>
					) : (
						<ChatRoomList
							rooms={rooms ?? []}
							activeRoomId={activeRoomId ?? null}
							onSelect={(room) => selectRoom(room.id)}
							onNewConversation={() => setPickerOpen(true)}
							isLoading={isLoading}
						/>
					)}
				</Box>
				<Box style={{ flex: 1, minWidth: 0, height: "100%", minHeight: 0 }}>
					{activeRoomId ? (
						// Keyed by room so switching conversations REMOUNTS the view instead of
						// reusing it. Its subtree keeps per-room refs (the read watermark's
						// last-sent seq, the list's scroll/boot state) plus draft, reply target
						// and selection — all of which are meaningless in another room, and a
						// carried-over watermark seq higher than the new room's would suppress
						// its read reports entirely.
						<ChatRoomView
							key={activeRoomId}
							roomId={activeRoomId}
							title={activeRoom?.peer?.username ?? t("conversations")}
						/>
					) : (
						<Box style={{ height: "100%", display: "grid", placeItems: "center" }}>
							<Text size="sm" c="dimmed">
								{t("noRoomSelected")}
							</Text>
						</Box>
					)}
				</Box>
			</Box>
			<NewDmModal
				opened={pickerOpen}
				onClose={() => setPickerOpen(false)}
				isPending={openDm.isPending}
				onPick={(user) => {
					openDm.mutate(user.id, {
						onSuccess: (room) => {
							setPickerOpen(false);
							selectRoom(room.id);
						},
					});
				}}
			/>
		</Box>
	);
}
