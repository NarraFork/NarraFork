import { OutlineQuestionsForm } from "@frontend/components/outline/OutlineQuestions";
import { type ReactNode, useMemo } from "react";
import type { MeasuredToolCall } from "./measure/measure-tool-call";
import { toolUseIdFromSpecKey } from "./vlist-permission-match";
import type { VListItem } from "./vlist-pipeline";
import type { VListToolMeta } from "./vlist-tool-meta";

/**
 * Independent of permissions: Ask has already succeeded and its form is ordinary,
 * collapsible card detail. Public transcripts never opt into private question APIs.
 * Only mounted rows fetch; building a slot node itself does not issue a request.
 */
export function useOutlineAskSlots({
	renderItems,
	tools,
	enabled = false,
}: {
	renderItems: readonly VListItem[];
	tools: ReadonlyMap<string, VListToolMeta>;
	enabled?: boolean;
}): ReadonlyMap<string, ReactNode> {
	return useMemo(() => {
		const slots = new Map<string, ReactNode>();
		if (!enabled) return slots;
		for (const item of renderItems) {
			if (item?.spec.kind !== "tool-call") continue;
			if (!(item.measured as MeasuredToolCall).effectiveOpened) continue;
			const toolUseId = toolUseIdFromSpecKey(item.spec.key);
			const source = toolUseId ? tools.get(toolUseId)?.outlineAsk : undefined;
			if (!source) continue;
			const blockId = source.questionRootIds[0];
			if (!blockId) continue;
			slots.set(
				item.spec.key,
				<OutlineQuestionsForm
					blockId={blockId}
					questionRootIds={source.questionRootIds}
					questionIds={source.questionIds}
					showOpenLink
				/>,
			);
		}
		return slots;
	}, [renderItems, tools, enabled]);
}
