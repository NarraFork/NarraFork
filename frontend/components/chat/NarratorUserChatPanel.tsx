/**
 * NarratorUserChatPanel.tsx — The discussion room beside one narrator.
 *
 * People talk to each other here; the narrator does not read any of it. The only
 * path into its context is the explicit "send to narrator" action, which goes
 * through the dock's `submitToNarrator` bridge — i.e. the narrator's OWN composer
 * submit path, not a direct REST call.
 *
 * That indirection is load-bearing: the composer is where busy-narrator buffering,
 * slash-command resolution and attachment/draft state live. Posting straight to
 * `/api/narrators/:id/messages` from here would bypass all of it, so a message
 * sent while the narrator was mid-turn would start a new turn instead of queueing.
 */

import { Box, Text } from "@mantine/core";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorChatRoom } from "../../hooks/useChat";
import { useNarratorDockContext } from "../narrator/dock/NarratorDockContext";
import { ChatRoomView } from "./ChatRoomView";

export interface NarratorUserChatPanelProps {
	narratorId: string;
}

export function NarratorUserChatPanel({ narratorId }: NarratorUserChatPanelProps) {
	const { t } = useTranslation("chat");
	const dock = useNarratorDockContext();
	const { data: room, isLoading, error } = useNarratorChatRoom(narratorId);

	const submitToNarrator = dock?.submitToNarrator;
	const forward = useCallback(
		(text: string) => {
			submitToNarrator?.(text);
		},
		[submitToNarrator],
	);

	if (error) {
		return (
			<Box p="md">
				<Text size="sm" c="red">
					{error instanceof Error ? error.message : t("roomLoadFailed")}
				</Text>
			</Box>
		);
	}

	const roomId = isLoading ? undefined : room?.id;

	return (
		// Keyed by room so a different narrator's room REMOUNTS the view rather than
		// reusing it. The subtree holds per-room state that is wrong anywhere else:
		// the read watermark's last-sent seq (a carried-over higher seq silently
		// suppresses every read report in the new room), the list's scroll/boot
		// refs, and the draft / reply target / selection. The `pending` fallback
		// covers the pre-resolution render, so the real room still gets a fresh
		// mount once its id arrives.
		<ChatRoomView
			key={roomId ?? "pending"}
			roomId={roomId}
			// Only offer forwarding when a narrator composer is actually mounted to
			// receive it; otherwise the button would be a no-op control.
			onForwardToNarrator={submitToNarrator ? forward : undefined}
			// Forwarding ATTACHMENTS needs the narrator itself, not just the composer
			// bridge: the files are copied into its worktree before the forwarded text
			// can name their paths.
			narratorId={narratorId}
		/>
	);
}
