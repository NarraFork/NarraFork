import { useEffect } from "react";
import type { ChatGroupMessage } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";

/**
 * Subscribe to live `group_message` WS events for a chat group.
 *
 * Group messages are broadcast over the narrator WS channel keyed by each
 * narrator member's id, so we subscribe to all member narrator ids and listen
 * for the `group_message` type, filtering by groupId.
 */
export function useChatGroupWS(
	groupId: string | undefined,
	memberNarratorIds: string[],
	onMessage: (message: ChatGroupMessage) => void,
): void {
	useEffect(() => {
		if (!groupId || memberNarratorIds.length === 0) return;

		const sub = narratorWSManager.subscribe(memberNarratorIds);
		const listener = narratorWSManager.addListener(
			{ narratorIds: memberNarratorIds, types: ["group_message"] },
			(data) => {
				if (data.type !== "group_message") return;
				if (data.groupId !== groupId) return;
				const message = data.message as ChatGroupMessage | undefined;
				if (message) onMessage(message);
			},
		);

		return () => {
			narratorWSManager.removeListener(listener);
			narratorWSManager.unsubscribe(sub);
		};
	}, [groupId, memberNarratorIds, onMessage]);
}
