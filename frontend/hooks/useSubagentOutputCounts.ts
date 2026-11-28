import {
	replaceSubagentOutputCounts,
	retainSubagentOutputCounts,
	setSubagentOutputCount,
} from "@frontend/components/narrator/subagent-output-count-store";
import { useEffect } from "react";
import { useNarratorWS } from "./useNarratorWS";

/** Background children keep emitting while the owner narrator itself is idle. */
export function useSubagentOutputCounts(narratorId: string | undefined): void {
	// Retain before installing the socket listener: the first snapshot may arrive
	// before a virtualized card has mounted its keyed subscription.
	useEffect(() => (narratorId ? retainSubagentOutputCounts(narratorId) : undefined), [narratorId]);
	useNarratorWS(narratorId, {
		onToolOutput: (_toolUseId, _output, _parentToolUseId, meta) => {
			if (narratorId && meta?.subagentOutputCount) {
				setSubagentOutputCount(narratorId, meta.subagentOutputCount);
			}
		},
		onStreamingSnapshot: (snapshot) => {
			if (narratorId && snapshot.subagentOutputCounts !== undefined) {
				replaceSubagentOutputCounts(narratorId, snapshot.subagentOutputCounts);
			}
		},
	});
}
