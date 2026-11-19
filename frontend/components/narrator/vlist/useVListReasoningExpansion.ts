import { useLocalPref } from "@frontend/hooks/useLocalPref";
import { useCallback } from "react";
import { isVListReasoningRowExpanded, type VListInteractionState } from "./vlist-interaction-state";

/** Height-affecting reasoning policy shared by initial layout and live document rebuilds. */
export function useVListReasoningExpansion(state: VListInteractionState) {
	const [expandReasoning] = useLocalPref("narrafork_expand_reasoning");
	const isReasoningRowExpanded = useCallback(
		(key: string, rowKey: string | number) => isVListReasoningRowExpanded(state, key, rowKey),
		[state],
	);
	return { expandReasoning, isReasoningRowExpanded };
}
