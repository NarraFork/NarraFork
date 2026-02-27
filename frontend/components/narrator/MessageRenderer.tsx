import { Box, Divider, Text } from "@mantine/core";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { MessageBubble } from "./MessageBubble";
import { type MessageContextMenuActions, MessageContextMenuCtx } from "./MessageContextMenuCtx";
import {
	flattenToolRun,
	hasToolUse,
	isToolOnlyMessage,
	resolvePendingPerm,
} from "./narrator-message-helpers";
import type {
	ContentBlock,
	FlatToolItem,
	MessagesPage,
	NarratorMsg,
	PermissionCallbacks,
} from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";
import { SubagentCard } from "./SubagentCard";
import type { ToolCallData } from "./ToolCallCard";
import { ToolCallCard } from "./ToolCallCard";

// ---------------------------------------------------------------------------
// renderToolRun — renders a group of tool-bearing messages
// ---------------------------------------------------------------------------

export function renderToolRun(
	run: NarratorMsg[],
	narratorId: string,
	permCb: PermissionCallbacks,
	expandedToolUseId?: string | null,
	highlightedId?: string | null,
	editExpandOverride?: boolean | null,
	onForkFromMessage?: (uuid: string) => void,
	onDeleteMessage?: (messageId: string) => void,
	onBranchFromMessage?: (messageId: string) => void,
	onCompactBeforeMessage?: (messageId: string) => void,
) {
	const matchPermission = (tc: ToolCallData) =>
		resolvePendingPerm(tc, permCb.pendingPermission, permCb.pendingPermsMap);
	const items = flattenToolRun(run);
	if (items.length === 0) return null;

	const taskCount = items.filter((it) => it.isSubagent).length;
	const soleSubagent = taskCount === 1;

	const renderItem = (item: FlatToolItem, idx: number, total: number) => {
		const key = item.tc.toolUseId ?? `${item.msg.id}-${idx}`;
		const hlStyle =
			highlightedId === item.msg.id
				? {
						animation: "highlight-blink 1.5s ease",
						borderRadius: "var(--mantine-radius-sm)",
					}
				: undefined;

		// Build context menu actions for this tool call's parent message
		const ctxActions: MessageContextMenuActions = {};
		const msgUuid = item.msg.messageUuid;
		const msgId = item.msg.id;
		if (msgId && onBranchFromMessage) {
			ctxActions.onBranchFromMessage = () => onBranchFromMessage(msgId);
		}
		if (msgUuid && onForkFromMessage) {
			ctxActions.onForkFromMessage = () => onForkFromMessage(msgUuid);
		}
		if (msgId && onCompactBeforeMessage) {
			ctxActions.onCompactBeforeMessage = () => onCompactBeforeMessage(msgId);
		}
		if (msgId && onDeleteMessage) {
			ctxActions.onDeleteMessage = () => onDeleteMessage(msgId);
		}

		if (item.isSubagent) {
			return (
				<MessageContextMenuCtx.Provider key={key} value={ctxActions}>
					<div
						id={item.tc.toolUseId ? `tool-use-${item.tc.toolUseId}` : `msg-${item.msg.id}`}
						style={hlStyle}
					>
						<SubagentCard
							toolCall={item.tc}
							childMessages={item.children ?? []}
							narratorId={narratorId}
							inRun={total >= 2}
							isLast={idx === total - 1}
							isSoleInRun={soleSubagent}
							permCb={permCb}
							editExpandOverride={editExpandOverride}
							onBgAgentRetry={permCb?.onBgAgentRetry}
						/>
					</div>
				</MessageContextMenuCtx.Provider>
			);
		}
		return (
			<MessageContextMenuCtx.Provider key={key} value={ctxActions}>
				<div
					id={item.tc.toolUseId ? `tool-use-${item.tc.toolUseId}` : `msg-${item.msg.id}`}
					style={hlStyle}
				>
					<ToolCallCard
						toolCall={item.tc}
						narratorId={narratorId}
						inRun={total >= 2}
						isLast={idx === total - 1}
						pendingPermission={matchPermission(item.tc)}
						onPermissionDecision={permCb.onPermissionDecision}
						onQuestionSubmit={permCb.onQuestionSubmit}
						onQuestionDeny={permCb.onQuestionDeny}
						forceExpand={expandedToolUseId === item.tc.toolUseId}
						editExpandOverride={editExpandOverride}
					/>
				</div>
			</MessageContextMenuCtx.Provider>
		);
	};

	if (items.length >= 2) {
		return (
			<Box
				key={`tool-run-${run[0].id}`}
				style={{
					border: "1px solid var(--mantine-color-default-border)",
					borderRadius: "var(--mantine-radius-sm)",
					overflow: "hidden",
				}}
			>
				{items.map((item, idx) => renderItem(item, idx, items.length))}
			</Box>
		);
	}

	return renderItem(items[0], 0, 1);
}

// ---------------------------------------------------------------------------
// renderTreeMessages — renders a flat message list, grouping tool runs
// ---------------------------------------------------------------------------

export function renderTreeMessages(
	messages: NarratorMsg[],
	narratorId: string,
	onForkFromMessage: ((uuid: string) => void) | undefined,
	highlightedId: string | null,
	permCb: PermissionCallbacks,
	expandedToolUseId?: string | null,
	editExpandOverride?: boolean | null,
	showTokenUsage?: boolean,
	onDeleteMessage?: (messageId: string) => void,
	onBranchFromMessage?: (messageId: string) => void,
	pruneBoundaryMessageId?: string | null,
	pruneDividerLabel?: string,
	onCompactBeforeMessage?: (messageId: string) => void,
): { elements: React.ReactNode[] } {
	// Messages are already tree-structured from the backend (children nested).
	// Group consecutive assistant messages with tool_use blocks into visual "runs".
	// A message with text + tool_use renders its text first, then its tool calls
	// merge forward with subsequent tool-bearing messages.
	const elements: React.ReactNode[] = [];
	let i = 0;

	while (i < messages.length) {
		const msg = messages[i];

		// Skip deferred streaming chunks — they are rendered after the StreamingBubble
		if (msg._noMerge && msg.id === STREAMING_CHUNKS_MSG_ID) {
			i++;
			continue;
		}

		if (hasToolUse(msg)) {
			// Render leading text (non-tool blocks) of this message if it's not tool-only
			if (!isToolOnlyMessage(msg)) {
				const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
				const textBlocks = blocks.filter((b: ContentBlock) => b.type !== "tool_use");
				if (textBlocks.some((b: ContentBlock) => b.type === "text" && b.text?.trim())) {
					elements.push(
						<Box
							key={`${msg.id}-text`}
							id={`msg-${msg.id}`}
							style={{
								borderRadius: "var(--mantine-radius-md)",
								animation: highlightedId === msg.id ? "highlight-blink 1.5s ease" : undefined,
							}}
						>
							{showTokenUsage && msg.tokensIn != null && (
								<Text size="xs" c="dimmed" ta="right" pr="sm" mb={2}>
									↑ {(msg.tokensIn as number).toLocaleString()}
								</Text>
							)}
							<MessageBubble
								narratorId={narratorId}
								message={{
									...msg,
									contentJson: textBlocks,
									toolCalls: [],
								}}
								onForkFromMessage={onForkFromMessage}
								onBranchFromMessage={onBranchFromMessage}
								resolvePerm={(tc) =>
									resolvePendingPerm(tc, permCb.pendingPermission, permCb.pendingPermsMap)
								}
								onPermissionDecision={permCb.onPermissionDecision}
								onQuestionSubmit={permCb.onQuestionSubmit}
								onQuestionDeny={permCb.onQuestionDeny}
								onCompactBeforeMessage={onCompactBeforeMessage}
								onDeleteMessage={onDeleteMessage}
							/>
						</Box>,
					);
				}
			}

			// Collect this message and subsequent tool-bearing messages into a run.
			// Respect _noMerge flag on synthetic streaming messages — when the model
			// emitted text before these tool chunks, they should render separately.
			const run: NarratorMsg[] = [msg];
			let j = i + 1;
			while (
				j < messages.length &&
				hasToolUse(messages[j]) &&
				isToolOnlyMessage(messages[j]) &&
				!messages[j]._noMerge
			) {
				run.push(messages[j]);
				j++;
			}
			const el = renderToolRun(
				run,
				narratorId,
				permCb,
				expandedToolUseId,
				highlightedId,
				editExpandOverride,
				onForkFromMessage,
				onDeleteMessage,
				onBranchFromMessage,
				onCompactBeforeMessage,
			);
			if (el) elements.push(el);

			// Insert prune divider if any message in this run is the boundary
			if (pruneBoundaryMessageId && run.some((m) => m.id === pruneBoundaryMessageId)) {
				elements.push(
					<Divider
						key="prune-boundary"
						my="xs"
						label={pruneDividerLabel}
						labelPosition="center"
						color="yellow.7"
						styles={{ label: { color: "var(--mantine-color-yellow-5)", fontSize: 11 } }}
					/>,
				);
			}

			i = j;
		} else {
			elements.push(
				<Box
					key={msg.id}
					id={`msg-${msg.id}`}
					style={{
						borderRadius: "var(--mantine-radius-md)",
						animation: highlightedId === msg.id ? "highlight-blink 1.5s ease" : undefined,
					}}
				>
					{showTokenUsage && msg.role === "assistant" && msg.tokensIn != null && (
						<Text size="xs" c="dimmed" ta="right" pr="sm" mb={2}>
							↑ {(msg.tokensIn as number).toLocaleString()}
						</Text>
					)}
					<MessageBubble
						narratorId={narratorId}
						message={msg}
						onForkFromMessage={onForkFromMessage}
						onBranchFromMessage={onBranchFromMessage}
						resolvePerm={(tc) =>
							resolvePendingPerm(tc, permCb.pendingPermission, permCb.pendingPermsMap)
						}
						onPermissionDecision={permCb.onPermissionDecision}
						onQuestionSubmit={permCb.onQuestionSubmit}
						onQuestionDeny={permCb.onQuestionDeny}
						onCompactBeforeMessage={onCompactBeforeMessage}
						onDeleteMessage={onDeleteMessage}
					/>
					{showTokenUsage && msg.turnUsageJson != null && (
						<Text size="xs" c="dimmed" ta="right" pr="sm" mt={2}>
							Σ {((msg.turnUsageJson as Record<string, number>).input_tokens ?? 0).toLocaleString()}{" "}
							in ·{" "}
							{((msg.turnUsageJson as Record<string, number>).output_tokens ?? 0).toLocaleString()}{" "}
							out
							{msg.costUsd != null &&
								(msg.costUsd as number) > 0 &&
								` · $${(msg.costUsd as number).toFixed(4)}`}
						</Text>
					)}
				</Box>,
			);

			// Insert prune divider after the boundary message
			if (pruneBoundaryMessageId && msg.id === pruneBoundaryMessageId) {
				elements.push(
					<Divider
						key="prune-boundary"
						my="xs"
						label={pruneDividerLabel}
						labelPosition="center"
						color="yellow.7"
						styles={{ label: { color: "var(--mantine-color-yellow-5)", fontSize: 11 } }}
					/>,
				);
			}

			i++;
		}
	}

	return { elements };
}

// ---------------------------------------------------------------------------
// MemoizedPageElements — per-page memoized rendering
// ---------------------------------------------------------------------------

interface PageElementsProps {
	page: MessagesPage;
	narratorId: string;
	onForkFromMessage: ((uuid: string) => void) | undefined;
	onBranchFromMessage: ((messageId: string) => void) | undefined;
	highlightedId: string | null;
	permCb: PermissionCallbacks;
	expandedToolUseId?: string | null;
	editExpandOverride?: boolean | null;
	showTokenUsage?: boolean;
	/** When set, only render the last N messages of this page (for progressive rendering). */
	maxMessages?: number;
	onDeleteMessage?: (messageId: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	pruneBoundaryMessageId?: string | null;
}

export const MemoizedPageElements = memo(
	function PageElements({
		page,
		narratorId,
		onForkFromMessage,
		onBranchFromMessage,
		highlightedId,
		permCb,
		expandedToolUseId,
		editExpandOverride,
		showTokenUsage,
		maxMessages,
		onDeleteMessage,
		onCompactBeforeMessage,
		pruneBoundaryMessageId,
	}: PageElementsProps) {
		const msgs =
			maxMessages != null && maxMessages < page.messages.length
				? page.messages.slice(page.messages.length - maxMessages)
				: page.messages;
		const { t } = useTranslation("narrator");
		const { elements } = renderTreeMessages(
			msgs,
			narratorId,
			onForkFromMessage,
			highlightedId,
			permCb,
			expandedToolUseId,
			editExpandOverride,
			showTokenUsage,
			onDeleteMessage,
			onBranchFromMessage,
			pruneBoundaryMessageId,
			t("pruneBoundaryLabel"),
			onCompactBeforeMessage,
		);
		return <>{elements}</>;
	},
	(prev, next) =>
		prev.page === next.page &&
		prev.narratorId === next.narratorId &&
		prev.onForkFromMessage === next.onForkFromMessage &&
		prev.onBranchFromMessage === next.onBranchFromMessage &&
		prev.permCb.pendingPermsMap === next.permCb.pendingPermsMap &&
		prev.permCb.bgRetryDismissedIds === next.permCb.bgRetryDismissedIds &&
		prev.expandedToolUseId === next.expandedToolUseId &&
		prev.editExpandOverride === next.editExpandOverride &&
		prev.showTokenUsage === next.showTokenUsage &&
		prev.maxMessages === next.maxMessages &&
		prev.pruneBoundaryMessageId === next.pruneBoundaryMessageId,
);

// ---------------------------------------------------------------------------
// RenderProgress — thin progress bar for progressive rendering / fetch
// ---------------------------------------------------------------------------

export function RenderProgress({
	value,
	indeterminate,
}: {
	value?: number;
	indeterminate?: boolean;
}) {
	const pct = value != null ? Math.round(Math.min(value, 1) * 100) : 0;
	return (
		<div
			style={{
				height: 2,
				width: "100%",
				background: "var(--mantine-color-dark-5)",
				overflow: "hidden",
			}}
		>
			<div
				style={{
					height: "100%",
					width: indeterminate ? "30%" : `${pct}%`,
					background: "var(--mantine-color-blue-6)",
					transition: indeterminate ? undefined : "width 80ms linear",
					animation: indeterminate ? "indeterminate-slide 1.2s ease-in-out infinite" : undefined,
				}}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// StreamingBubble — isolated component to avoid re-rendering the entire panel
// ---------------------------------------------------------------------------

export const StreamingBubble = memo(
	function StreamingBubble({
		narratorId,
		streamingRef,
		version,
	}: {
		narratorId: string;
		streamingRef: React.RefObject<string>;
		version: number;
	}) {
		// Read ref directly during render — version change triggers re-render
		// which picks up the latest accumulated text without an extra useEffect cycle.
		void version;
		const text = streamingRef.current;
		if (!text) return null;
		return (
			<MessageBubble
				narratorId={narratorId}
				message={{
					role: "assistant",
					contentJson: [{ type: "text", text }],
				}}
			/>
		);
	},
	(prev, next) => prev.version === next.version,
);
