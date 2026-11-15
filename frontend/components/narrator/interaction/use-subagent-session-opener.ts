import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

/** Both tool rows and inline references use the same responsive session navigation. */
export function useSubagentSessionOpener(
	onViewSubagentSession?: (narratorId: string, messageId?: string) => void,
) {
	const navigate = useNavigate();
	return useCallback(
		(narratorId: string, messageId?: string) => {
			if (onViewSubagentSession) {
				onViewSubagentSession(narratorId, messageId);
				return;
			}
			void navigate({
				to: "/narrators/$narratorId",
				params: { narratorId },
				search: messageId ? { scrollTo: messageId } : undefined,
			});
		},
		[onViewSubagentSession, navigate],
	);
}
