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

import { Box, Button, Group, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { chatKeys, useNarratorChatRoom } from "../../hooks/useChat";
import { ApiError, getAuthSnapshot } from "../../lib/api/client";
import { invalidateCachedPretextDocument } from "../../lib/pretext-document-cache-invalidation";
import { useNarratorDockContext } from "../narrator/dock/NarratorDockContext";
import { useEditorPanelVisible } from "../narrator/narrator-panel-visibility";
import { ChatRoomView } from "./ChatRoomView";

export interface NarratorUserChatPanelProps {
	narratorId: string;
	/**
	 * Submit handler supplied by a host without dock context — the mobile Drawer
	 * host passes the chat panel's own composer submit here.
	 *
	 * Takes precedence over the dock bridge for the same reason as the search
	 * panel's jump handler: forwarding a message to the narrator is the point of
	 * having this room beside a session, and on mobile the bridge does not exist.
	 */
	onForwardToNarrator?: (text: string) => void;
}

export function NarratorUserChatPanel({
	narratorId,
	onForwardToNarrator,
}: NarratorUserChatPanelProps) {
	const { t } = useTranslation("chat");
	const queryClient = useQueryClient();
	const dock = useNarratorDockContext();
	const active = useEditorPanelVisible();
	const {
		data: room,
		error,
		isSuccess,
		isFetching,
		refetch,
	} = useNarratorChatRoom(narratorId, active);
	// The room hook subscribes to auth changes; keep denial state in that same generation.
	const { generation } = getAuthSnapshot();
	const scope = JSON.stringify([narratorId, generation]);
	const [revokedScope, setRevokedScope] = useState<string | null>(null);
	// This resolver deliberately uses 404 for both missing narrators and denied canRead.
	const denied =
		error instanceof ApiError &&
		(error.status === 401 || error.status === 403 || error.status === 404);
	useEffect(() => {
		if (getAuthSnapshot().generation !== generation) return;
		if (denied) setRevokedScope(scope);
		else if (isSuccess) setRevokedScope(null);
	}, [denied, generation, isSuccess, scope]);
	// Once denied, another transient failure must not resurrect cached private content.
	// Only a successful resolver for the current generation restores access.
	const authorizationLost = denied || (revokedScope === scope && !isSuccess);
	const roomId = room?.id;
	useEffect(() => {
		if (!authorizationLost || !roomId || getAuthSnapshot().generation !== generation) return;
		// Passive child teardown can publish its last window on unmount. Purge after
		// that cleanup, not during render or a layout effect that it could overwrite.
		invalidateCachedPretextDocument(roomId);
		queryClient.removeQueries({ queryKey: chatKeys.messages(roomId) });
	}, [authorizationLost, generation, roomId, queryClient]);

	const submitToNarrator = onForwardToNarrator ?? dock?.submitToNarrator;
	const forward = useCallback(
		(text: string) => {
			submitToNarrator?.(text);
		},
		[submitToNarrator],
	);

	const failureNotice = (
		<Group wrap="nowrap" gap="xs" role={authorizationLost || !roomId ? "alert" : "status"}>
			<Text size="sm" c={authorizationLost || !roomId ? "red" : "yellow"} style={{ flex: 1 }}>
				{error instanceof Error ? error.message : t("roomLoadFailed")}
			</Text>
			<Button
				size="compact-xs"
				variant="subtle"
				disabled={!active}
				loading={isFetching}
				onClick={() => {
					void refetch();
				}}
			>
				{t("common:retry")}
			</Button>
		</Group>
	);
	if (authorizationLost || (error && !roomId)) return <Box p="md">{failureNotice}</Box>;

	return (
		<Box h="100%" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
			<Box style={{ flex: 1, minHeight: 0 }}>
				{/* Keep this slot/key unchanged while a resolver revalidation fails or retries.
				    Only a real room change should remount its coordinator/draft/reply state. */}
				<ChatRoomView
					key={roomId ?? "pending"}
					roomId={roomId}
					suspended={!active}
					// Only offer forwarding when a narrator composer is actually mounted to receive it.
					onForwardToNarrator={submitToNarrator ? forward : undefined}
					// Forwarded attachments require the narrator's worktree, not just its composer.
					narratorId={narratorId}
				/>
			</Box>
			{error ? (
				<Box p="xs" style={{ flexShrink: 0 }}>
					{failureNotice}
				</Box>
			) : null}
		</Box>
	);
}
